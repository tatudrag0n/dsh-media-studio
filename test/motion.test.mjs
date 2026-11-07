import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import { resolvePython, runProcess } from '../video.js';
import {
  DEFAULT_MOTION_FPS,
  DEFAULT_MOTION_HEIGHT,
  DEFAULT_MOTION_SECONDS,
  DEFAULT_MOTION_WIDTH,
  MOTION_FORMATS,
  MOTION_STYLES,
  MOTION_TEMPLATES,
  parseMotionSpec,
  renderMotionGraphic,
} from '../motion.js';

const PYTHON = 'C:\\Users\\tatud\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const FFMPEG = 'C:\\ProgramData\\ffmpeg.exe';

const OPTIONS = {
  video: { pythonPath: PYTHON, ffmpegPath: FFMPEG, timeoutMs: 300000 },
  motion: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 640, height: 360, seconds: 1, fps: 12, timeoutMs: 300000 },
};

/** Minimal Host context: records the tools the plugin registers. */
function fakeCtx(services = {}) {
  const tools = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    get(name) {
      return services[name];
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          tools.splice(tools.indexOf(definition), 1);
        };
      },
    },
    connection: { fetch: { register: () => async () => {} } },
  };
  return { ctx, tools };
}

/** True when this machine can draw frames. */
function hasPython() {
  return process.platform === 'win32';
}

/** Count the pixels that differ between two pictures. */
const DIFFERENCE_SCRIPT = [
  'import json, sys',
  'from PIL import Image',
  'first = Image.open(sys.argv[1]).convert("RGB")',
  'second = Image.open(sys.argv[2]).convert("RGB")',
  'a, b = first.load(), second.load()',
  'width, height = first.size',
  'changed = sum(1 for y in range(0, height, 3) for x in range(0, width, 3) if a[x, y] != b[x, y])',
  'print(json.dumps({"changed": changed, "total": (width // 3) * (height // 3)}))',
].join('\n');

test('the template table matches the deliverable types a motion designer makes', () => {
  assert.deepEqual(MOTION_TEMPLATES, ['title', 'lower_third', 'ident', 'chart', 'shapes', 'stinger']);
  assert.deepEqual(MOTION_STYLES, ['smooth', 'snappy', 'dramatic']);
  assert.deepEqual(MOTION_FORMATS, ['mp4', 'webm', 'gif']);
});

test('parseMotionSpec keeps the request and fills the defaults', () => {
  const spec = parseMotionSpec({ template: 'title', text: '  Movie Night  ' });
  assert.equal(spec.template, 'title');
  assert.equal(spec.text, 'Movie Night');
  assert.equal(spec.style, 'smooth');
  assert.equal(spec.format, 'mp4');
  assert.equal(spec.width, DEFAULT_MOTION_WIDTH);
  assert.equal(spec.height, DEFAULT_MOTION_HEIGHT);
  assert.equal(spec.fps, DEFAULT_MOTION_FPS);
  assert.equal(spec.duration, DEFAULT_MOTION_SECONDS);
});

test('parseMotionSpec falls back to a title card and clamps the numbers', () => {
  const spec = parseMotionSpec({ template: 'nope', text: 'x', width: 99999, height: 10, fps: 400, duration: 900 });
  assert.equal(spec.template, 'title');
  assert.equal(spec.width, 1920);
  assert.equal(spec.height, 240);
  assert.equal(spec.fps, 60);
  assert.equal(spec.duration, 20);
});

test('parseMotionSpec wants text for the type templates and data for the chart', () => {
  assert.throws(() => parseMotionSpec({ template: 'title' }), /text/);
  assert.throws(() => parseMotionSpec({ template: 'lower_third' }), /text/);
  assert.throws(() => parseMotionSpec({ template: 'ident' }), /text/);
  assert.throws(() => parseMotionSpec({ template: 'chart' }), /labels/);
  // The abstract templates need no text.
  const shapes = parseMotionSpec({ template: 'shapes' });
  assert.equal(shapes.text, '');
  const chart = parseMotionSpec({
    template: 'chart',
    labels: ['a', 'b'],
    series: [{ name: 's', values: [1] }],
  });
  assert.deepEqual(chart.chart.labels, ['a', 'b']);
  // A short series is padded so the chart stays square.
  assert.deepEqual(chart.chart.series[0].values, [1, 0]);
});

test('parseMotionSpec keeps only real colours', () => {
  const spec = parseMotionSpec({ template: 'title', text: 'x', accent: '#38BDF8', background: 'not-a-colour' });
  assert.equal(spec.colors.accent, '#38bdf8');
  assert.equal(spec.colors.background, undefined);
});

test('every template draws frames that move', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const python = await resolvePython({ video: { pythonPath: PYTHON } }, ['PIL']);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-motion-frames-'));
  try {
    for (const template of MOTION_TEMPLATES) {
      const spec = parseMotionSpec({
        template,
        text: 'Graphika',
        subtitle: '2026',
        width: 480,
        height: 270,
        duration: 1,
        fps: 15,
        ...(template === 'chart'
          ? { labels: ['a', 'b', 'c'], series: [{ name: 's', values: [4, 7, 5] }] }
          : {}),
      });
      const framesDirectory = join(directory, template);
      const specPath = join(directory, `${template}.json`);
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const run = await runProcess(python, ['motion_render.py', '--spec', specPath, '--out', framesDirectory], {
        timeoutMs: 120000,
      });
      assert.equal(run.code, 0, `${template}: ${run.stderr}`);
      const frames = (await readdir(framesDirectory)).filter((name) => name.endsWith('.jpg')).sort();
      assert.equal(frames.length, 15, `${template} must draw one frame per tick`);
      assert.equal(frames[0], 'frame_00000.jpg');

      // Compare the first frame with a middle one: a transition sweeps
      // through the picture and leaves again, so the ends look alike.
      const middle = frames[Math.floor(frames.length / 2)];
      const difference = await runProcess(python, [
        '-c', DIFFERENCE_SCRIPT,
        join(framesDirectory, frames[0]),
        join(framesDirectory, middle),
      ], { timeoutMs: 60000 });
      assert.equal(difference.code, 0, difference.stderr);
      const { changed, total } = JSON.parse(String(difference.stdout).trim());
      assert.ok(changed / total > 0.01, `${template} must animate: only ${changed} pixels moved`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the chart bars grow with the progress value', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const python = await resolvePython({ video: { pythonPath: PYTHON } }, ['PIL']);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-motion-progress-'));
  const measure = [
    'import json, sys',
    'from PIL import Image',
    'image = Image.open(sys.argv[1]).convert("RGB")',
    'width, height = image.size',
    'pixels = image.load()',
    'target = (37, 99, 235)',
    'def is_bar(x, y):',
    '    colour = pixels[x, y]',
    '    return all(abs(colour[i] - target[i]) <= 8 for i in range(3))',
    'tops = []',
    'for x in range(width):',
    '    if any(is_bar(x, y) for y in range(height)):',
    '        tops.append(x)',
    'heights = []',
    'if tops:',
    '    left, right = min(tops), max(tops)',
    '    for y in range(height):',
    '        if any(is_bar(x, y) for x in range(left, right + 1)):',
    '            heights.append(y)',
    'print(json.dumps({"height": (heights[-1] - heights[0] + 1) if heights else 0}))',
  ].join('\n');
  try {
    const heights = [];
    for (const progress of [0.25, 1]) {
      const spec = {
        type: 'bar',
        labels: ['a', 'b'],
        series: [{ name: 's', values: [100, 100] }],
        width: 600,
        height: 400,
        progress,
      };
      const specPath = join(directory, `spec-${progress}.json`);
      const pngPath = join(directory, `chart-${progress}.png`);
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const run = await runProcess(python, ['graphics_render.py', '--spec', specPath, '--out', pngPath], { timeoutMs: 60000 });
      assert.equal(run.code, 0, run.stderr);
      const measured = await runProcess(python, ['-c', measure, pngPath], { timeoutMs: 60000 });
      assert.equal(measured.code, 0, measured.stderr);
      heights.push(JSON.parse(String(measured.stdout).trim()).height);
    }
    assert.ok(heights[0] > 0, 'a quarter of the progress must still draw a bar');
    const ratio = heights[0] / heights[1];
    assert.ok(ratio > 0.15 && ratio < 0.4, `a quarter progress must draw about a quarter of the bar: ${JSON.stringify(heights)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the motion pipeline writes a playable MP4', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const spec = parseMotionSpec({
    template: 'title',
    text: 'Movie Night',
    subtitle: '第 12 回',
    width: 480,
    height: 270,
    duration: 1,
    fps: 12,
  });
  const result = await renderMotionGraphic(OPTIONS, spec, {});
  assert.equal(result.mediaType, 'video/mp4');
  assert.equal(result.width, 480);
  assert.equal(result.height, 270);
  assert.equal(result.frames, 12);
  assert.ok(result.data.byteLength > 5000, 'the video must hold real frames');
  // An ISO base media file starts with an ftyp box.
  assert.equal(String.fromCharCode(...result.data.subarray(4, 8)), 'ftyp');
});

test('the motion pipeline can write a GIF for the web', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const spec = parseMotionSpec({
    template: 'ident',
    text: 'CHANNEL 4',
    width: 480,
    height: 270,
    duration: 1,
    fps: 12,
    format: 'gif',
  });
  const result = await renderMotionGraphic(OPTIONS, spec, {});
  assert.equal(result.mediaType, 'image/gif');
  assert.equal(String.fromCharCode(...result.data.subarray(0, 3)), 'GIF');
});

test('a voice-over is mixed into the animation', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  // A one second silent WAV: enough to prove the mux runs.
  const sampleRate = 8000;
  const samples = sampleRate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);

  const spec = parseMotionSpec({
    template: 'title',
    text: 'With voice',
    width: 480,
    height: 270,
    duration: 1,
    fps: 12,
  });
  const result = await renderMotionGraphic(OPTIONS, spec, { audio: { data: new Uint8Array(buffer), extension: 'wav' } });
  assert.equal(result.mediaType, 'video/mp4');
  assert.ok(result.data.byteLength > 5000);
});

test('a held title card keeps moving under a slow push-in', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const python = await resolvePython({ video: { pythonPath: PYTHON } }, ['PIL']);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-motion-hold-'));
  try {
    const spec = parseMotionSpec({ template: 'title', text: 'Harness', width: 480, height: 270, duration: 2, fps: 15 });
    const framesDirectory = join(directory, 'frames');
    const specPath = join(directory, 'title.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const run = await runProcess(python, ['motion_render.py', '--spec', specPath, '--out', framesDirectory], { timeoutMs: 120000 });
    assert.equal(run.code, 0, run.stderr);
    // Two frames from the hold, after the type has settled.
    const first = join(framesDirectory, 'frame_00012.jpg');
    const second = join(framesDirectory, 'frame_00024.jpg');
    const difference = await runProcess(python, ['-c', DIFFERENCE_SCRIPT, first, second], { timeoutMs: 60000 });
    assert.equal(difference.code, 0, difference.stderr);
    const { changed, total } = JSON.parse(String(difference.stdout).trim());
    assert.ok(changed / total > 0.02, `a held card must keep moving: only ${changed} pixels changed`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the agent tool draws a motion graphic and reports the file', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const saved = [];
  const { ctx, tools } = fakeCtx({
    attachments: {
      async saveFile({ data, name }) {
        saved.push({ bytes: data.byteLength, name });
        return { attachmentId: 'att-motion-1' };
      },
    },
  });
  apply(ctx, {
    motion: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, seconds: 1, fps: 12, timeoutMs: 300000 },
  });
  const tool = tools.find((entry) => entry.name === 'make_motion_graphic');
  assert.ok(tool !== undefined, 'the plugin must register make_motion_graphic');
  const result = await tool.execute({
    template: 'title',
    text: 'ハーネス映画夜',
    subtitle: '第 12 回',
    width: 480,
    height: 270,
    seconds: 1,
    fps: 12,
  }, { signal: undefined });
  assert.equal(result.template, 'title');
  assert.equal(result.title, 'ハーネス映画夜');
  assert.equal(result.mediaType, 'video/mp4');
  assert.equal(result.format, 'mp4');
  assert.equal(result.width, 480);
  assert.equal(result.height, 270);
  assert.equal(result.frames, 12);
  assert.ok(result.bytes > 5000);
  assert.match(result.name, /^motion-.*\.mp4$/u);
  assert.equal(result.attachmentId, 'att-motion-1');
  assert.equal(saved.length, 1);
  // The chat view needs a file block to play the result inline.
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'file');
  assert.equal(blocks[1].attachment.attachmentId, 'att-motion-1');
});
