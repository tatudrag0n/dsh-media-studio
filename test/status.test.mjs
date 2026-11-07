/**
 * `studio_status` — the text version of the media panel.
 *
 * The point of these tests is the promise the tool makes: with
 * `checkBackends: false` it answers from configuration alone and starts no
 * process at all. So `collectStatus` is called with fake dependencies, and one
 * dependency throws if it is ever asked to spawn.
 */

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  BACKENDS,
  PROBE_TIMEOUT_MS,
  backendCommands,
  bytesText,
  collectStatus,
  describeLimits,
  describeMaterials,
  describeParameters,
  describeProviders,
  describeTools,
  formatStatusText,
  lookupTool,
  parseVersion,
  probeBackends,
  registerStatusTools,
  requiredOf,
  runVersion,
  statusTool,
  toolsRegistry,
} from '../status.js';
import { STUDIO_TOOLS } from '../tools-list.js';

/** A tool registry with the required arguments of one tool. */
function fakeRegistry(entries) {
  const map = new Map(Object.entries(entries));
  return { get: (name) => map.get(name) };
}

/** Dependencies that never touch the machine. */
function fakeDeps(overrides = {}) {
  return {
    run: async (command) => {
      if (command === 'ffmpeg') return { ok: true, stdout: 'ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright', stderr: '' };
      if (command === 'ffprobe') return { ok: true, stdout: 'ffprobe version 9.0.2-full_build\nCopyright', stderr: '' };
      if (command === 'blender') return { ok: true, stdout: 'Blender 5.2.0\n\tbuild date: 2026-01-01', stderr: '' };
      return { ok: false, error: 'spawn python ENOENT' };
    },
    listAssets: async () => [
      { id: 'a1', name: 'cover.png', kind: 'image', bytes: 100 },
      { id: 'a2', name: 'bed.wav', kind: 'audio', bytes: 200 },
      { id: 'a3', name: 'bed2.wav', kind: 'audio', bytes: 300 },
    ],
    soundFontAvailable: () => true,
    soundFontPresets: async () => new Array(287).fill({ name: 'preset' }),
    fileSize: async () => 33554432,
    now: (() => {
      let value = 1000;
      return () => {
        value += 250;
        return value;
      };
    })(),
    ...overrides,
  };
}

/** Options that look like a resolved plugin row. */
function fakeOptions() {
  return {
    outputDir: 'media-studio',
    image: { provider: 'openai', model: 'gpt-image-1' },
    video: { provider: 'local', ffmpegPath: 'C:/tools/ffmpeg.exe' },
    speech: { provider: 'system' },
    transcription: { provider: 'harness' },
    soundfont: { path: 'C:/root/instrument-data/GeneralUser-GS.sf2' },
    assets: { maxBytes: 268435456, directory: 'C:/tmp/assets' },
    maxAudioBytes: 26214400,
    maxSpeechText: 2000,
    maxImagePrompt: 2000,
    maxVideoPrompt: 2000,
    maxNegativePrompt: 500,
    maxChartData: 20000,
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('describeTools reports every catalogue tool even without a registry', () => {
  const tools = describeTools(undefined);
  assert.equal(tools.length, STUDIO_TOOLS.length);
  assert.equal(tools.every((tool) => tool.registered === false), true);
  assert.deepEqual(tools.every((tool) => Array.isArray(tool.required) && tool.required.length === 0), true);
});

test('describeTools keeps the catalogue order, name, group and summary', () => {
  const tools = describeTools(undefined);
  assert.deepEqual(tools.map((tool) => tool.name), STUDIO_TOOLS.map((entry) => entry.name));
  const probe = tools.find((tool) => tool.name === 'probe_video');
  assert.equal(probe.group, 'editing');
  assert.equal(probe.summary, '動画/音声の実体を調べる（ffprobe）');
});

test('describeTools takes required arguments from the registry', () => {
  const registry = fakeRegistry({
    generate_image: { parameters: { required: ['prompt', 'aspect'] } },
    write_lyrics: { parameters: { required: ['theme'] }, description: 'Write lyrics.' },
  });
  const tools = describeTools(registry);
  const image = tools.find((tool) => tool.name === 'generate_image');
  assert.deepEqual(image.required, ['prompt', 'aspect']);
  assert.equal(image.registered, true);
  const lyrics = tools.find((tool) => tool.name === 'write_lyrics');
  assert.deepEqual(lyrics.required, ['theme']);
  const untouched = tools.find((tool) => tool.name === 'cad_model');
  assert.deepEqual(untouched.required, []);
  assert.equal(untouched.registered, false);
});

test('describeTools survives a registry that throws for unknown names', () => {
  const registry = {
    get: () => {
      throw new Error('unknown tool');
    },
  };
  const tools = describeTools(registry);
  
  assert.equal(tools.every((tool) => tool.registered === false), true);
});

test('describeTools verbose adds the description and every parameter', () => {
  const registry = fakeRegistry({
    generate_sfx: {
      description: 'Synthesise a sound effect locally.',
      parameters: {
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['rain', 'thunder', 'click'] },
          duration: { type: 'number' },
        },
      },
    },
  });
  const verbose = describeTools(registry, { verbose: true });
  const tool = verbose.find((entry) => entry.name === 'generate_sfx');
  assert.equal(tool.description, 'Synthesise a sound effect locally.');
  assert.deepEqual(tool.parameters, [
    { name: 'kind', type: 'string', required: true, enum: ['rain', 'thunder', 'click'] },
    { name: 'duration', type: 'number', required: false },
  ]);
  const concise = describeTools(registry).find((entry) => entry.name === 'generate_sfx');
  assert.equal(concise.description, undefined);
  assert.equal(concise.parameters, undefined);
});

test('describeParameters returns nothing for a tool without a parameter object', () => {
  assert.deepEqual(describeParameters(undefined), []);
  assert.deepEqual(describeParameters({ parameters: {} }), []);
});

test('requiredOf ignores a malformed required list', () => {
  assert.deepEqual(requiredOf({ parameters: { required: 'prompt' } }), []);
  assert.deepEqual(requiredOf({ parameters: { required: ['ok', '', 7, 'fine'] } }), ['ok', 'fine']);
  assert.deepEqual(requiredOf(undefined), []);
});

test('lookupTool and toolsRegistry find the registry through the context', () => {
  const instance = fakeRegistry({ cad_model: { parameters: { required: ['parts'] } } });
  assert.equal(toolsRegistry({ get: (name) => (name === 'tools' ? instance : undefined) }), instance);
  assert.equal(toolsRegistry({ tools: instance }), instance);
  assert.equal(toolsRegistry({}), undefined);
  assert.equal(toolsRegistry({ get: () => { throw new Error('no service'); } }), undefined);
  assert.equal(lookupTool(instance, 'cad_model').parameters.required[0], 'parts');
  assert.equal(lookupTool(instance, 'nope'), undefined);
});

// ---------------------------------------------------------------------------
// Version parsing and backend probe
// ---------------------------------------------------------------------------

test('parseVersion keeps only the first non-empty line', () => {
  assert.equal(parseVersion('ffmpeg version 9.0.2-full_build\nCopyright (c) 2000-2026'), 'ffmpeg version 9.0.2-full_build');
  assert.equal(parseVersion('\n\nBlender 5.2.0\nbuild date'), 'Blender 5.2.0');
  assert.equal(parseVersion('   '), undefined);
  assert.equal(parseVersion(undefined), undefined);
  assert.equal(parseVersion(42), undefined);
});

test('parseVersion clips a pathological first line', () => {
  const long = `ffmpeg ${'x'.repeat(400)}`;
  const parsed = parseVersion(long);
  assert.equal(parsed.length, 120);
  assert.equal(parsed.endsWith('...'), true);
});

test('bytesText formats sizes for the status text', () => {
  assert.equal(bytesText(512), '512 B');
  assert.equal(bytesText(2048), '2.0 KB');
  assert.equal(bytesText(26214400), '25.0 MB');
  assert.equal(bytesText(33554432), '32.0 MB');
  assert.equal(bytesText(-1), '不明');
  assert.equal(bytesText(undefined), '不明');
});

test('backendCommands probes the four backends with python3 as a fallback', () => {
  const commands = backendCommands({}, {});
  assert.deepEqual(commands.map((entry) => entry.name), BACKENDS.map((entry) => entry.name));
  assert.deepEqual(commands.map((entry) => entry.name), ['ffmpeg', 'ffprobe', 'blender', 'python']);
  const python = commands.find((entry) => entry.name === 'python');
  assert.deepEqual(python.commands, ['python', 'python3']);
  assert.deepEqual(python.args, ['--version']);
  assert.deepEqual(commands.find((entry) => entry.name === 'ffmpeg').args, ['-version']);
});

test('backendCommands prefers a configured path over the bare name', () => {
  const commands = backendCommands({}, { video: { ffmpegPath: 'C:/tools/ffmpeg.exe' } });
  const ffmpeg = commands.find((entry) => entry.name === 'ffmpeg');
  assert.deepEqual(ffmpeg.commands, ['C:/tools/ffmpeg.exe', 'ffmpeg']);
  const fromBackends = backendCommands({ backends: { blender: 'C:/blender/blender.exe' } }, {});
  assert.deepEqual(fromBackends.find((entry) => entry.name === 'blender').commands, ['C:/blender/blender.exe', 'blender']);
});

test('probeBackends records a version per backend', async () => {
  const backends = await probeBackends(backendCommands({}, {}), { run: fakeDeps().run });
  assert.equal(backends.length, 4);
  const ffmpeg = backends.find((entry) => entry.name === 'ffmpeg');
  assert.deepEqual(ffmpeg, { name: 'ffmpeg', found: true, command: 'ffmpeg', version: 'ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright' });
  const python = backends.find((entry) => entry.name === 'python');
  assert.equal(python.found, false);
  assert.equal(python.error, 'spawn python ENOENT');
  assert.equal(python.command, 'python3');
});

test('probeBackends falls through to the next candidate command', async () => {
  const asked = [];
  const run = async (command) => {
    asked.push(command);
    if (command === 'python') return { ok: false, error: 'spawn python ENOENT' };
    if (command === 'python3') return { ok: true, stdout: 'Python 3.13.1' };
    return { ok: true, stdout: `${command} 1.0` };
  };
  const backends = await probeBackends(backendCommands({}, {}), { run });
  const python = backends.find((entry) => entry.name === 'python');
  assert.equal(python.found, true);
  assert.equal(python.command, 'python3');
  assert.equal(python.version, 'Python 3.13.1');
  assert.deepEqual(asked, ['ffmpeg', 'ffprobe', 'blender', 'python', 'python3']);
});

test('probeBackends never rejects when a backend cannot be started', async () => {
  const backends = await probeBackends(backendCommands({}, {}), {
    run: async () => {
      throw new Error('EPERM');
    },
    timeoutMs: 10,
  });
  assert.equal(backends.length, 4);
  assert.equal(backends.every((entry) => entry.found === false), true);
});

test('runVersion reports a missing binary instead of throwing', async () => {
  const result = await runVersion('definitely-not-a-real-binary-xyz', ['--version'], 2000);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

test('runVersion kills a command that overstays its timeout', async () => {
  const result = await runVersion(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], 200);
  assert.equal(result.ok, false);
  assert.match(result.error, /タイムアウト/u);
});

test('the default probe timeout is five seconds', () => {
  assert.equal(PROBE_TIMEOUT_MS, 5000);
});

// ---------------------------------------------------------------------------
// Providers, limits, materials
// ---------------------------------------------------------------------------

test('describeProviders reads the four provider badges', () => {
  assert.deepEqual(describeProviders(fakeOptions()), {
    image: 'openai',
    video: 'local',
    speech: 'system',
    transcription: 'harness',
  });
  assert.deepEqual(describeProviders({}), {});
});

test('describeLimits keeps the numeric bounds and the output directory', () => {
  const limits = describeLimits(fakeOptions());
  assert.equal(limits.outputDir, 'media-studio');
  assert.equal(limits.maxAudioBytes, 26214400);
  assert.equal(limits.maxSpeechText, 2000);
  assert.equal(limits.maxAssetBytes, 268435456);
  assert.equal(limits.maxNegativePrompt, 500);
  assert.equal(describeLimits({}).maxAudioBytes, undefined);
});

test('describeMaterials counts the library by kind', () => {
  const materials = describeMaterials(
    [
      { kind: 'image' },
      { kind: 'audio' },
      { kind: 'audio' },
      { kind: 'other' },
      {},
    ],
    'C:/assets',
  );
  assert.deepEqual(materials, { total: 5, byKind: { image: 1, audio: 2, other: 2 }, directory: 'C:/assets' });
  assert.deepEqual(describeMaterials(undefined), { total: 0, byKind: {} });
});

test('assetDirectory-like directory is reported without touching the filesystem', async () => {
  let listed = undefined;
  const status = await collectStatus({
    options: fakeOptions(),
    args: { checkBackends: false },
    deps: fakeDeps({
      listAssets: async (directory) => {
        listed = directory;
        return [];
      },
    }),
  });
  assert.equal(listed, resolve('C:/tmp/assets'));
  assert.equal(status.materials.directory, resolve('C:/tmp/assets'));
  assert.equal(status.materials.total, 0);
});

// ---------------------------------------------------------------------------
// collectStatus: the checkBackends promise
// ---------------------------------------------------------------------------

test('collectStatus with checkBackends: false starts no process', async () => {
  let started = 0;
  const status = await collectStatus({
    options: fakeOptions(),
    args: { checkBackends: false },
    deps: fakeDeps({
      run: async () => {
        started += 1;
        throw new Error('a process must not be started');
      },
    }),
  });
  assert.equal(started, 0);
  assert.equal(status.checkedBackends, false);
  assert.deepEqual(status.backends, []);
  assert.equal(status.soundFont.available, true);
  assert.equal(status.soundFont.presets, undefined);
});

test('collectStatus with checkBackends: true probes every backend and reads the presets', async () => {
  const asked = [];
  const status = await collectStatus({
    options: fakeOptions(),
    args: {},
    deps: fakeDeps({
      run: async (command, args, timeoutMs) => {
        asked.push({ command, args, timeoutMs });
        return { ok: command !== 'python', stdout: command === 'blender' ? 'Blender 5.2.0' : `${command} 9.0.2`, error: 'spawn ENOENT' };
      },
    }),
  });
  assert.equal(status.checkedBackends, true);
  assert.equal(status.backends.length, 4);
  assert.equal(asked.length, 5);
  assert.equal(asked.every((entry) => entry.timeoutMs === PROBE_TIMEOUT_MS), true);
  assert.equal(status.backends.find((entry) => entry.name === 'blender').version, 'Blender 5.2.0');
  assert.equal(status.soundFont.presets, 287);
  assert.equal(status.soundFont.bytes, 33554432);
});

test('collectStatus survives a SoundFont that cannot be read', async () => {
  const status = await collectStatus({
    options: fakeOptions(),
    args: {},
    deps: fakeDeps({
      soundFontPresets: async () => {
        throw new Error('broken bank');
      },
    }),
  });
  assert.equal(status.soundFont.available, true);
  assert.equal(status.soundFont.presets, undefined);
  assert.equal(status.soundFont.error, 'broken bank');
});

test('collectStatus reports a missing SoundFont without failing', async () => {
  const status = await collectStatus({
    options: { ...fakeOptions(), soundfont: { path: 'C:/nope.sf2' } },
    args: { checkBackends: false },
    deps: fakeDeps({ soundFontAvailable: () => false }),
  });
  assert.deepEqual(status.soundFont, { path: 'C:/nope.sf2', available: false });
});

test('collectStatus reports an unreadable library as empty', async () => {
  const status = await collectStatus({
    options: fakeOptions(),
    args: { checkBackends: false },
    deps: fakeDeps({
      listAssets: async () => {
        throw new Error('EACCES');
      },
    }),
  });
  assert.equal(status.materials.total, 0);
});

test('collectStatus takes the required arguments from ctx.get("tools")', async () => {
  const ctx = {
    get: (name) => (name === 'tools' ? fakeRegistry({ cad_model: { parameters: { required: ['parts'] } } }) : undefined),
  };
  const status = await collectStatus({ ctx, options: fakeOptions(), args: { checkBackends: false }, deps: fakeDeps() });
  const tool = status.tools.find((entry) => entry.name === 'cad_model');
  assert.equal(tool.registered, true);
  assert.deepEqual(tool.required, ['parts']);
});

test('collectStatus listens to neither a broken registry nor a broken asset directory', async () => {
  const ctx = {
    get: () => {
      throw new Error('service unavailable');
    },
  };
  const status = await collectStatus({
    ctx,
    options: {},
    args: { verbose: true, checkBackends: false },
    deps: fakeDeps({ soundFontAvailable: () => false }),
  });
  assert.equal(status.tools.length, STUDIO_TOOLS.length);
  assert.equal(status.checkedBackends, false);
  assert.deepEqual(status.providers, {});
  assert.deepEqual(status.limits, {});
});

test('collectStatus returns lossless JSON without undefined values', async () => {
  const status = await collectStatus({ options: fakeOptions(), args: {}, deps: fakeDeps() });
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        assert.notEqual(inner, undefined, `${path}.${key} is undefined`);
        walk(inner, `${path}.${key}`);
      }
    }
  };
  walk(status, 'status');
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  assert.equal(typeof status.seconds, 'number');
});

// ---------------------------------------------------------------------------
// The rendered text
// ---------------------------------------------------------------------------

/** A status value shaped exactly like `collectStatus` returns. */
async function collectedStatus(args = {}) {
  return collectStatus({ options: fakeOptions(), args, deps: fakeDeps() });
}

test('formatStatusText is Japanese, Markdown-ish and names every group', async () => {
  const text = formatStatusText(await collectedStatus({ checkBackends: false }));
  assert.match(text, /^# スタジオの状態/u);
  assert.match(text, /## できること/u);
  assert.match(text, /### 画像/u);
  assert.match(text, /### 動画/u);
  assert.match(text, /### 音楽/u);
  assert.match(text, /### ライブラリ/u);
  assert.match(text, /## バックエンド/u);
  assert.match(text, /## プロバイダー/u);
  assert.match(text, /## 上限/u);
  assert.match(text, /## 素材ライブラリ/u);
  assert.match(text, /- 音声ファイルの上限: 25\.0 MB/u);
  assert.match(text, /- 画像: openai/u);
  assert.match(text, /3 件 \(image 1 \/ audio 2\)/u);
});

test('formatStatusText says the backends are unchecked when no process was started', async () => {
  const text = formatStatusText(await collectedStatus({ checkBackends: false }));
  assert.match(text, /未確認です \(checkBackends: false\)/u);
  assert.doesNotMatch(text, /ffmpeg: 9/u);
  assert.match(text, /- SoundFont: あり \(プリセット未確認, 32\.0 MB\)/u);
});

test('formatStatusText shows the versions it measured', async () => {
  const text = formatStatusText(await collectedStatus({}));
  assert.match(text, /- ffmpeg: ffmpeg version 9\.0\.2/u);
  assert.match(text, /- blender: Blender 5\.2\.0/u);
  assert.match(text, /- python: 見つかりません/u);
  assert.match(text, /- SoundFont: あり \(287 プリセット, 32\.0 MB\)/u);
});

test('formatStatusText keeps the non-verbose answer to names and required arguments', async () => {
  const registry = {
    get: (name) => (name === 'generate_image'
      ? { description: 'Make an image.', parameters: { required: ['prompt'], properties: { prompt: { type: 'string' } } } }
      : undefined),
  };
  const ctx = { get: () => registry };
  const status = await collectStatus({ ctx, options: fakeOptions(), args: { checkBackends: false, verbose: true }, deps: fakeDeps() });
  const concise = formatStatusText(status);
  assert.match(concise, /- generate_image \(prompt\)/u);
  assert.doesNotMatch(concise, /画像を生成する/u);
  assert.doesNotMatch(concise, /Make an image\./u);
  assert.ok(concise.length < 4000, `concise text was ${concise.length} characters`);
  const verbose = formatStatusText(status, { verbose: true });
  assert.match(verbose, /- generate_image \(prompt\) — 画像を生成する/u);
  assert.match(verbose, /Make an image\./u);
  assert.match(verbose, /引数: prompt: string: 必須/u);
  assert.ok(verbose.length > concise.length);
});

test('formatStatusText marks a tool that is not registered', async () => {
  const status = await collectStatus({ options: fakeOptions(), args: { checkBackends: false }, deps: fakeDeps() });
  const text = formatStatusText(status);
  assert.match(text, /- probe_video — 未登録/u);
});

test('formatStatusText handles an empty status without throwing', () => {
  const text = formatStatusText({});
  assert.match(text, /できること: 0 件/u);
  assert.match(text, /未確認です/u);
});

// ---------------------------------------------------------------------------
// The tool definition and registration
// ---------------------------------------------------------------------------

test('statusTool describes itself in English and returns Japanese text', async () => {
  const tool = statusTool({ get: () => undefined }, fakeOptions(), {}, {});
  assert.equal(tool.name, 'studio_status');
  assert.match(tool.description, /^Report what this studio can do/u);
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['checkBackends', 'verbose']);
  assert.equal(tool.parameters.required, undefined);
  assert.equal(tool.parameters.properties.checkBackends.type, 'boolean');
  assert.equal(tool.output.schema.properties.checkedBackends.type, 'boolean');
  assert.deepEqual(tool.output.presentationMeta(), { name: 'status' });
  assert.equal(tool.isConcurrencySafe(), true);
  const rendered = tool.output.render({ checkBackends: false }, { tools: [], checkedBackends: false, materials: { total: 0 } });
  assert.equal(Array.isArray(rendered), true);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /スタジオの状態/u);
});

test('studio_status runs end to end with checkBackends: false', async () => {
  const tool = statusTool({ get: () => undefined }, fakeOptions(), {}, {});
  const value = await tool.execute({ checkBackends: false, verbose: false });
  assert.equal(value.checkedBackends, false);
  assert.equal(value.tools.length, STUDIO_TOOLS.length);
  assert.deepEqual(value.backends, []);
  assert.equal(value.providers.image, 'openai');
  assert.equal(value.limits.outputDir, 'media-studio');
});

test('registerStatusTools registers synchronously through ctx.effect', () => {
  const registered = [];
  const ctx = {
    effect(effect, label) {
      assert.equal(typeof label, 'string');
      effect();
      return () => {};
    },
    tools: { register: (tool) => registered.push(tool) },
    get: () => undefined,
  };
  const result = registerStatusTools(ctx, fakeOptions(), {}, {});
  assert.equal(result, undefined);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'studio_status');
});
