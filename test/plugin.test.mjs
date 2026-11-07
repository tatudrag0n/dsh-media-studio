import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { parseScoreText } from '../score.js';

import { Config, apply } from '../index.js';

/** Minimal Host context: records registrations and serves optional services. */
function fakeCtx(services = {}) {
  const tools = [];
  const routes = [];
  const unloads = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
      unloads.push(dispose);
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
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {
            routes.splice(routes.indexOf(route), 1);
          };
        },
      },
    },
  };
  return { ctx, tools, routes, unloads };
}

/** The bank fetched into the workspace; SoundFont assertions skip without it. */
const SOUNDFONT_PATH = 'C:\\root\\instrument-data\\GeneralUser-GS.sf2';

const BASE_CONFIG = {
  speech: { provider: 'openai', apiKey: 'test-key' },
  transcription: { provider: 'openai', apiKey: 'test-key' },
  soundfont: { path: SOUNDFONT_PATH },
};

test('Config accepts an empty row and partial provider objects', () => {
  assert.doesNotThrow(() => Config({}));
  assert.doesNotThrow(() => Config({ image: { provider: 'openai' } }));
  assert.doesNotThrow(() => Config({ image: { provider: 'local' }, speech: { provider: 'system' } }));
});

test('apply registers the model tools and the panel routes', () => {
  const { ctx, tools, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['asset_info', 'attach_material', 'cad_drawing', 'cad_export', 'cad_model', 'compose_music', 'daw_arrange', 'edit_image', 'edit_video', 'export_daw_project', 'export_timeline', 'generate_image', 'generate_music', 'generate_sfx', 'generate_speech', 'generate_video', 'import_midi', 'list_assets', 'list_media', 'make_motion_graphic', 'make_subtitles', 'media_create', 'probe_video', 'produce_video', 'remove_asset', 'render_chart', 'render_project', 'studio_status', 'transcribe_audio', 'write_article', 'write_lyrics', 'write_novel']);
  assert.deepEqual(routes.map((route) => route.path.split('/').pop()).sort(), ['asset-delete', 'asset-file', 'assets', 'audio', 'capabilities', 'chart', 'compose', 'edit-image', 'image', 'motion', 'music', 'production', 'prompt', 'run', 'score', 'speech', 'tool', 'transcribe', 'video', 'video-file']);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
  }
});

test('capabilities reports the configured providers and the available voices', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const capabilities = routes.find((route) => route.path.endsWith('/capabilities'));
  const response = await capabilities.fetch(new Request('http://local/api/media-studio/capabilities'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.image.provider, 'local');
  assert.equal(body.speech.provider, 'openai');
  assert.ok(Array.isArray(body.speech.voices));
  assert.ok(body.speech.voices.length > 0);
  assert.equal(body.transcription.provider, 'openai');
  assert.ok(body.music.styles.includes('pop'));
  assert.ok(body.music.scales.includes('major'));
  assert.ok(body.music.keys.includes('C'));
  assert.equal(body.music.defaultInstrument, 'gm:0');
  assert.equal(typeof body.music.soundFont, 'object');
  if (existsSync(SOUNDFONT_PATH)) {
    assert.equal(body.music.soundFont.available, true);
    assert.ok(body.music.soundFont.presets.length > 200);
    assert.ok(body.music.soundFont.presets.some((preset) => preset.name === 'Grand Piano'));
  } else {
    assert.equal(body.music.soundFont.available, false);
  }
  assert.equal(body.limits.maxAudioBytes, 8 * 1024 * 1024);
  assert.equal(body.video.provider, 'local');
  assert.equal(body.video.recipe, 'svd');
  assert.ok(Array.isArray(body.video.recipes));
  assert.ok(body.video.recipes.some((recipe) => recipe.id === 'svd'));
  assert.ok(body.video.recipes.some((recipe) => recipe.mode === 'text'));
  assert.ok(body.video.aspects.includes('landscape'));
  assert.ok(Array.isArray(body.graphics.chartTypes));
  assert.ok(body.graphics.chartTypes.includes('bar'));
  assert.ok(body.graphics.chartTypes.includes('donut'));
  assert.ok(body.graphics.themes.includes('dark'));
  assert.ok(body.graphics.imageFormats.includes('webp'));
  assert.equal(body.graphics.defaultWidth, 1200);
  assert.equal(body.graphics.defaultHeight, 675);
  assert.ok(Array.isArray(body.motion.templates));
  assert.ok(body.motion.templates.includes('title'));
  assert.ok(body.motion.templates.includes('lower_third'));
  assert.ok(body.motion.templates.includes('ident'));
  assert.ok(body.motion.templates.includes('chart'));
  assert.ok(body.motion.templates.includes('shapes'));
  assert.ok(body.motion.templates.includes('stinger'));
  assert.ok(body.motion.styles.includes('smooth'));
  assert.ok(body.motion.formats.includes('mp4'));
  assert.equal(body.motion.defaultSeconds, 4);
  assert.equal(body.motion.defaultFps, 30);
  assert.equal(body.motion.defaultWidth, 1280);
  assert.equal(body.motion.defaultHeight, 720);
  assert.ok(Array.isArray(body.production.sceneTypes));
  assert.ok(body.production.sceneTypes.includes('template'));
  assert.ok(body.production.sceneTypes.includes('image'));
  assert.ok(body.production.sceneTypes.includes('clip'));
  assert.ok(body.production.transitions.includes('cut'));
  assert.ok(body.production.transitions.includes('fade'));
  assert.equal(body.production.maxScenes, 12);
  assert.equal(body.production.defaultWidth, 1280);
  assert.equal(body.production.defaultHeight, 720);
  assert.equal(body.production.defaultFps, 30);
  assert.equal(typeof body.assets.maxBytes, 'number');
});

test('the motion route rejects a chart template without data', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const motion = routes.find((route) => route.path.endsWith('/motion'));
  const response = await motion.fetch(new Request('http://local/api/media-studio/motion', {
    method: 'POST',
    body: JSON.stringify({ template: 'chart' }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /labels/);
});

test('the motion route rejects a title template without text', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const motion = routes.find((route) => route.path.endsWith('/motion'));
  const response = await motion.fetch(new Request('http://local/api/media-studio/motion', {
    method: 'POST',
    body: JSON.stringify({ template: 'title' }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /text/);
});

test('the chart route rejects a request without data', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const chart = routes.find((route) => route.path.endsWith('/chart'));
  const response = await chart.fetch(new Request('http://local/api/media-studio/chart', {
    method: 'POST',
    body: JSON.stringify({ type: 'bar' }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /データ/);
});

test('image and speech routes reject bad input instead of throwing', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const image = routes.find((route) => route.path.endsWith('/image'));
  const notJson = await image.fetch(new Request('http://local/api/media-studio/image', { method: 'POST', body: 'nope' }));
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, 'MEDIA_STUDIO_ERROR');

  const empty = await image.fetch(new Request('http://local/api/media-studio/image', { method: 'POST', body: JSON.stringify({}) }));
  assert.equal(empty.status, 400);
});

test('the music route rejects an empty score', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const music = routes.find((route) => route.path.endsWith('/music'));
  const empty = await music.fetch(new Request('http://local/api/media-studio/music', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
  assert.equal(empty.status, 400);
});

test('the music route renders a SoundFont preset when the bank is present', async (t) => {
  if (!existsSync(SOUNDFONT_PATH)) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const music = routes.find((route) => route.path.endsWith('/music'));
  const response = await music.fetch(new Request('http://local/api/media-studio/music', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 'C4:1 E4:1 G4:1', tempo: 120, instrument: 'gm:0' }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /audio\/wav/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let peak = 0;
  for (let index = 44; index < bytes.byteLength - 1; index += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(index, true)));
  }
  assert.ok(peak > 100, `expected audible SoundFont output, peak was ${peak}`);
});

test('a gm: selection without a bank fails with an actionable message', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ...BASE_CONFIG, soundfont: { path: 'C:\\definitely\\missing.sf2' } });
  const music = routes.find((route) => route.path.endsWith('/music'));
  const response = await music.fetch(new Request('http://local/api/media-studio/music', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 'C4:1', instrument: 'gm:0' }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /SoundFont/);
});

test('the compose route returns a grid whose score renders through the music route', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const compose = routes.find((route) => route.path.endsWith('/compose'));
  const response = await compose.fetch(new Request('http://local/api/media-studio/compose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ style: 'pop', key: 'C', scale: 'major', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 7 }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.steps.length, 16);
  assert.equal(body.stepsPerBar, 8);
  assert.equal(typeof body.score, 'string');
  assert.ok(body.score.length > 0);
  assert.ok(body.steps.some((column) => column.length > 0));
  // The panel fills its step grid from `steps`, so every track must carry one.
  assert.equal(body.tracks.length, 3);
  for (const track of body.tracks) {
    assert.equal(track.steps.length, body.steps.length, `${track.name} needs a step grid`);
    assert.ok(Array.isArray(track.notes) && track.notes.length > 0);
  }

  const music = routes.find((route) => route.path.endsWith('/music'));
  const rendered = await music.fetch(new Request('http://local/api/media-studio/music', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: body.score, tempo: 120 }),
  }));
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-type'), /audio\/wav/);
});

test('compose_music renders a deterministic piece without note input', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'compose_music');
  const result = await tool.execute({ style: 'ambient', key: 'D', scale: 'minor', bars: 2, tempo: 100, instrument: 'pad', seed: 3 }, { signal: undefined });
  assert.equal(result.style, 'ambient');
  assert.equal(result.key, 'D');
  assert.equal(result.scale, 'minor');
  assert.equal(result.bars, 2);
  assert.equal(result.seed, 3);
  assert.ok(result.bytes > 44);
  assert.ok(typeof result.name === 'string' && result.name.endsWith('.wav'));
  assert.match(result.score, /:/);
});

test('the prompt route reads a plain-language request into a piece', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const prompt = routes.find((route) => route.path.endsWith('/prompt'));
  const response = await prompt.fetch(new Request('http://local/api/media-studio/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'dark ambient piano in D minor, slow, 4 bars', seed: 2 }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.style, 'ambient');
  assert.equal(body.plan.key, 'D');
  assert.equal(body.plan.scale, 'minor');
  assert.ok(body.plan.summary.includes('D minor'));
  assert.equal(body.style, 'ambient');
  assert.equal(body.key, 'D');
  assert.ok(body.tracks.length >= 3);
  for (const track of body.tracks) {
    assert.equal(track.steps.length, body.steps.length, `${track.name} needs a step grid`);
    assert.ok(Array.isArray(track.notes) && track.notes.length > 0);
  }
  assert.ok(body.text.includes('track melody'));
});

test('the prompt route refuses an empty prompt', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const prompt = routes.find((route) => route.path.endsWith('/prompt'));
  const response = await prompt.fetch(new Request('http://local/api/media-studio/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' }),
  }));
  assert.equal(response.status, 400);
});

test('compose_music follows a prompt and reports what it read', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'compose_music');
  const result = await tool.execute({ prompt: 'epic cinematic strings with drums, 90 bpm', bars: 2, seed: 5 }, { signal: undefined });
  assert.equal(result.style, 'cinematic');
  assert.equal(result.tempo, 90);
  assert.equal(result.mood, 'epic');
  assert.equal(result.drums, true);
  assert.ok(result.plan.includes('cinematic'));
  assert.ok(result.cues.includes('mood:epic'));
  assert.ok(result.text.includes('instrument gm:128:0'));
  assert.ok(result.bytes > 44);
});

test('an explicit argument wins over the prompt', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'compose_music');
  const result = await tool.execute({ prompt: 'jazz in G major', style: 'boss', key: 'A', output: 'text' }, { signal: undefined });
  assert.equal(result.style, 'boss');
  assert.equal(result.key, 'A');
});

test('a three-minute prompt really renders three minutes of music', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'compose_music');
  const result = await tool.execute({ prompt: 'epic cinematic strings, 3 minutes, 100 bpm', seed: 5 }, { signal: undefined });
  assert.equal(result.bars, 75);
  assert.equal(result.tempo, 100);
  // 75 bars at 100 BPM is 180 seconds, plus the release tail.
  assert.ok(result.seconds > 175 && result.seconds < 190, `expected about 3 minutes, got ${result.seconds}s`);
  assert.ok(result.bytes > 44);
});

test('the score route parses and formats multi-track text', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const score = routes.find((route) => route.path.endsWith('/score'));

  const parsed = await score.fetch(new Request('http://local/api/media-studio/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'parse', text: 'tempo 96\ntrack melody\ninstrument gm:40\nC4 0 1\nE4 1 1\n' }),
  }));
  assert.equal(parsed.status, 200);
  const parsedBody = await parsed.json();
  assert.equal(parsedBody.tempo, 96);
  assert.equal(parsedBody.tracks.length, 1);
  assert.equal(parsedBody.tracks[0].instrument, 'gm:40');
  assert.deepEqual(parsedBody.warnings, []);

  const formatted = await score.fetch(new Request('http://local/api/media-studio/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'format', tempo: 96, tracks: parsedBody.tracks }),
  }));
  assert.equal(formatted.status, 200);
  const formattedBody = await formatted.json();
  assert.match(formattedBody.text, /track melody/);
  assert.match(formattedBody.text, /C4 0 1/);

  const unknown = await score.fetch(new Request('http://local/api/media-studio/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  }));
  assert.equal(unknown.status, 400);
});

test('generate_music renders multi-track text across both engines', async (t) => {
  if (!existsSync(SOUNDFONT_PATH)) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'generate_music');
  const text = [
    'tempo 100',
    'track melody',
    'instrument gm:0',
    'C4 0 1',
    'E4 1 1',
    'track bass',
    'instrument gm:33',
    'C2 0 2',
  ].join('\n');
  const result = await tool.execute({ text, title: 'multi' }, { signal: undefined });
  assert.equal(result.trackCount, 2);
  assert.equal(result.noteCount, 3);
  assert.ok(result.instruments.includes('gm:0'));
  assert.ok(result.instruments.includes('gm:33'));
  assert.ok(result.bytes > 44);
  assert.match(result.text, /track bass/);
});

test('compose_music returns the score text without rendering audio', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const tool = tools.find((entry) => entry.name === 'compose_music');
  const result = await tool.execute(
    { style: 'ambient', key: 'A', scale: 'minor', bars: 2, seed: 4, output: 'text' },
    { signal: undefined },
  );
  assert.equal(result.trackCount, 3);
  assert.equal(result.bytes, undefined);
  assert.match(result.text, /track melody/);
  const parsed = parseScoreText(result.text);
  assert.equal(parsed.tracks.length, 3);
  assert.equal(parsed.tracks[0].instrument, 'gm:0');
  assert.equal(parsed.tracks[1].instrument, 'gm:48');
  assert.equal(parsed.tracks[2].instrument, 'gm:33');
});

test('the harness transcription path refuses non-WAV input with an actionable status', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, { transcription: { provider: 'harness' } });
  const transcribe = routes.find((route) => route.path.endsWith('/transcribe'));
  const response = await transcribe.fetch(new Request('http://local/api/media-studio/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm' },
    body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  }));
  assert.equal(response.status, 415);
  assert.match((await response.json()).error.message, /WAV/);
});

test('the audio route reports a missing payload without crashing', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, BASE_CONFIG);
  const audio = routes.find((route) => route.path.endsWith('/audio'));
  const response = await audio.fetch(new Request('http://local/api/media-studio/audio?id=missing'));
  assert.equal(response.status, 404);
});

test('system speech synthesis really produces a PCM16 WAV', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx, { speech: { provider: 'system' }, transcription: { provider: 'openai' } });
  const speech = routes.find((route) => route.path.endsWith('/speech'));
  const response = await speech.fetch(new Request('http://local/api/media-studio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'メディアスタジオの接続テストです。' }),
  }));
  if (response.status === 503) {
    // A Windows host without any installed SAPI voice is a supported
    // degradation; the failure must still be a structured JSON answer.
    const body = await response.json();
    assert.match(body.error.message, /音声/);
    return;
  }
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /audio\/wav/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.ok(bytes.byteLength > 44);
});
