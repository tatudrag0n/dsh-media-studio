import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RECIPE,
  LOCAL_RECIPES,
  VIDEO_ASPECTS,
  encodeFrames,
  fillPlaceholders,
  firstMeaningfulLine,
  framesVideo,
  isMp4,
  parseRunnerReport,
  resolveFfmpeg,
  resolveFrameCount,
  resolveRecipe,
  resolveVideoSize,
  runProcess,
} from '../video.js';

/** Options shaped like the ones `resolveOptions` builds. */
function options(overrides = {}) {
  return {
    video: {
      provider: 'local',
      baseURL: 'http://127.0.0.1:8188',
      apiKeyEnv: 'OPENAI_API_KEY',
      apiKey: undefined,
      model: undefined,
      recipe: DEFAULT_RECIPE,
      pythonPath: undefined,
      ffmpegPath: undefined,
      seconds: 4,
      fps: 8,
      width: 1024,
      height: 576,
      steps: 25,
      workflowPath: undefined,
      timeoutMs: 600000,
      ...overrides,
    },
  };
}

test('the aspect list and the recipe table stay in step', () => {
  assert.deepEqual(VIDEO_ASPECTS, ['landscape', 'portrait', 'square']);
  assert.ok(Object.keys(LOCAL_RECIPES).length >= 4);
  for (const recipe of Object.values(LOCAL_RECIPES)) {
    assert.ok(recipe.id !== '');
    assert.ok(['text', 'image'].includes(recipe.mode));
    assert.ok(recipe.model.includes('/'));
    assert.ok(recipe.frames > 0);
    assert.ok(recipe.fps > 0);
  }
});

test('resolveRecipe falls back to the default recipe', () => {
  assert.equal(resolveRecipe('wan21').id, 'wan21');
  assert.equal(resolveRecipe('nope').id, DEFAULT_RECIPE);
  assert.equal(resolveRecipe(undefined).id, DEFAULT_RECIPE);
});

test('resolveVideoSize maps the aspect names onto frame shapes', () => {
  assert.deepEqual(resolveVideoSize('landscape', undefined, undefined), { width: 1024, height: 576 });
  assert.deepEqual(resolveVideoSize('portrait', undefined, undefined), { width: 576, height: 1024 });
  assert.deepEqual(resolveVideoSize('square', undefined, undefined), { width: 640, height: 640 });
  assert.deepEqual(resolveVideoSize('landscape', 320, 240), { width: 320, height: 240 });
});

test('resolveFrameCount keeps the 4k+1 shape the video models want', () => {
  for (const [seconds, fps] of [[4, 8], [3, 8], [5, 16], [2, 24], [1, 4]]) {
    const count = resolveFrameCount(seconds, fps, LOCAL_RECIPES.svd);
    assert.ok(count >= 4, `${count} frames is too few`);
    assert.equal((count - 1) % 4, 0, `${count} frames is not 4k+1`);
  }
  assert.ok(resolveFrameCount(1000, 8, LOCAL_RECIPES.svd) <= 300);
  assert.equal(resolveFrameCount(1000, 8, LOCAL_RECIPES.svd) - 1, 4 * Math.floor((300 - 1) / 4));
});

test('parseRunnerReport reads the last JSON line the runner prints', () => {
  const report = parseRunnerReport('loading weights\n{"ok": true, "frames": 25, "width": 1024, "height": 576, "fps": 8}\n');
  assert.equal(report.frames, 25);
  assert.equal(report.width, 1024);
  assert.equal(parseRunnerReport('nothing here'), undefined);
  assert.equal(parseRunnerReport('{"broken":'), undefined);
});

test('fillPlaceholders rewrites every string of a workflow', () => {
  const filled = fillPlaceholders(
    { '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', width: '{{width}}' } }, note: '{{image}}' },
    { prompt: 'a cat', width: 832, image: 'first-frame.jpg' },
  );
  assert.equal(filled['1'].inputs.text, 'a cat');
  assert.equal(filled['1'].inputs.width, '832');
  assert.equal(filled.note, 'first-frame.jpg');
});

test('firstMeaningfulLine skips warnings', () => {
  assert.equal(firstMeaningfulLine('WARNING: slow\nreal failure\n'), 'real failure');
  assert.equal(firstMeaningfulLine(''), undefined);
});

test('isMp4 recognises a video container', () => {
  const header = new Uint8Array(16);
  header.set([0x00, 0x00, 0x00, 0x18], 0);
  header.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.equal(isMp4(header), true);
  assert.equal(isMp4(new Uint8Array(4)), false);
});

/** Paint one solid PNG with ffmpeg, so the test needs no image fixture. */
async function paintPng(options, target) {
  const ffmpeg = await resolveFfmpeg(options);
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=teal:s=96x64',
    '-frames:v', '1',
    target,
  ], { timeoutMs: 60000 });
  assert.equal(run.code, 0, run.stderr);
  return target;
}

test('the frames backend writes a playable MP4 from a still picture', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const source = await paintPng(options(), join(directory, 'still.png'));
  const result = await framesVideo(options(), { imagePath: source, seconds: 1, fps: 8, width: 64, height: 64 });
  assert.equal(result.provider, 'frames');
  assert.equal(result.mediaType, 'video/mp4');
  assert.ok(result.data.byteLength > 0);
  assert.equal(isMp4(result.data), true);
  assert.equal(result.seconds, 1);
});

test('the frames backend needs a picture or a frame folder', async () => {
  await assert.rejects(() => framesVideo(options(), {}), /framesDirectory|imagePath/);
});

test('encodeFrames reports a missing frame sequence instead of writing nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-test-'));
  try {
    await assert.rejects(() => encodeFrames(options(), { directory, pattern: 'frame_%05d.jpg', fps: 8 }), /ffmpeg/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the bytes of a written MP4 start with an ftyp box', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const source = await paintPng(options(), join(directory, 'still.png'));
  const result = await framesVideo(options(), { imagePath: source, seconds: 1, fps: 8, width: 32, height: 32 });
  assert.equal(result.data[4], 0x66);
  assert.equal(result.data[5], 0x74);
  assert.equal(result.data[6], 0x79);
  assert.equal(result.data[7], 0x70);
});
