/**
 * 何ができるかをテキストで返す (`studio_status`).
 *
 * The media panel below the composer is going away. The panel used to answer
 * three questions by showing things: what the studio can make, which backend
 * is actually alive (ffmpeg, ffprobe, Blender, Python, the SoundFont), and
 * what the configured limits are. This module answers the same three
 * questions with text, so a chat turn alone can decide what to ask for.
 *
 * Two rules shape the code:
 *
 * - `checkBackends: false` starts **no external process at all**. The tests
 *   and a sandbox use it; only `execute()` ever spawns anything.
 * - The tool catalogue comes from `tools-list.js`, but the required arguments
 *   come from the registry (`ctx.get('tools')`), because that is what the
 *   agent will actually be charged for. A tool that is not registered says so
 *   instead of disappearing.
 *
 * Every formatter here is a pure function and exported, so the shape of the
 * text can be tested without a harness.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

import { assetDirectory, listAssets } from './assets.js';
import { soundFontAvailable, soundFontPresets } from './soundfont.js';
import { STUDIO_GROUPS, STUDIO_TOOLS } from './tools-list.js';

/** How long one backend version probe may take, in milliseconds. */
export const PROBE_TIMEOUT_MS = 5000;

/** How long reading the SoundFont preset list may take, in milliseconds. */
export const SOUNDFONT_TIMEOUT_MS = 30000;

/**
 * The backends the panel used to draw as indicator lights.
 *
 * `commands` is tried in order: Windows installs Python as `python`, other
 * machines may only have `python3`. The first one that exists wins.
 */
export const BACKENDS = [
  { name: 'ffmpeg', label: 'ffmpeg', commands: ['ffmpeg'], args: ['-version'] },
  { name: 'ffprobe', label: 'ffprobe', commands: ['ffprobe'], args: ['-version'] },
  { name: 'blender', label: 'Blender', commands: ['blender'], args: ['--version'] },
  { name: 'python', label: 'Python', commands: ['python', 'python3'], args: ['--version'] },
];

/** Japanese labels for the catalogue groups. */
const GROUP_LABELS = {
  image: '画像',
  video: '動画',
  editing: '編集',
  graphics: 'グラフ',
  audio: '音声',
  music: '音楽',
  writing: '文章',
  cad: 'CAD',
  library: 'ライブラリ',
};

/** Labels for the provider sections the panel showed. */
const PROVIDER_LABELS = {
  image: '画像',
  video: '動画',
  speech: '読み上げ',
  transcription: '文字起こし',
};

/** Upper bounds worth showing, in the order the panel showed them. */
const LIMIT_LABELS = {
  maxAudioBytes: '音声ファイルの上限',
  maxSpeechText: '読み上げの文字数',
  maxImagePrompt: '画像プロンプトの文字数',
  maxVideoPrompt: '動画プロンプトの文字数',
  maxNegativePrompt: 'ネガティブプロンプトの文字数',
  maxChartData: 'グラフのデータ文字数',
};

/** Limits counted in bytes rather than characters. */
const BYTE_LIMITS = new Set(['maxAudioBytes', 'maxAssetBytes']);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** A readable size for the status text. */
export function bytesText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '不明';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * The version line of a `--version` run.
 *
 * Only the first non-empty line is kept: Blender prints a build block, ffmpeg
 * prints every codec it was compiled with. The text is clipped so one odd
 * backend cannot flood the answer.
 */
export function parseVersion(text) {
  const source = typeof text === 'string' ? text : '';
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }
  return undefined;
}

/** The required argument names of a registered tool, or an empty list. */
export function requiredOf(spec) {
  const required = spec?.parameters?.required;
  if (!Array.isArray(required)) return [];
  return required.filter((name) => typeof name === 'string' && name !== '');
}

/** The registry that holds the registered tools, or undefined. */
export function toolsRegistry(ctx) {
  try {
    const fromGet = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
    if (fromGet !== undefined && fromGet !== null) return fromGet;
  } catch {
    // The tools service is not mounted (tests, a partial harness): carry on.
  }
  return ctx?.tools;
}

/** One registered tool spec by name, or undefined. */
export function lookupTool(registry, name) {
  if (registry === undefined || registry === null || typeof name !== 'string') return undefined;
  try {
    if (typeof registry.get === 'function') return registry.get(name);
    if (typeof registry.list === 'function') {
      const list = registry.list();
      if (Array.isArray(list)) return list.find((tool) => tool?.name === name);
    }
  } catch {
    // An unknown name may throw instead of returning undefined; treat it as absent.
  }
  return undefined;
}

/** The catalogue entries, with what the registry knows about each one. */
export function describeTools(registry, options = {}) {
  const verbose = options.verbose === true;
  return STUDIO_TOOLS.map((entry) => {
    const spec = lookupTool(registry, entry.name);
    const described = {
      name: entry.name,
      group: entry.group,
      summary: entry.summary,
      required: requiredOf(spec),
      registered: spec !== undefined && spec !== null,
    };
    if (verbose) {
      const description = typeof spec?.description === 'string' ? spec.description.trim() : '';
      if (description !== '') described.description = description;
      described.parameters = describeParameters(spec);
    }
    return described;
  });
}

/** One tool's parameters, as `{ name, type, required, enum? }`. */
export function describeParameters(spec) {
  const properties = spec?.parameters?.properties;
  if (properties === undefined || properties === null || typeof properties !== 'object') return [];
  const required = requiredOf(spec);
  const described = [];
  for (const [name, schema] of Object.entries(properties)) {
    const parameter = {
      name,
      type: typeof schema?.type === 'string' ? schema.type : 'string',
      required: required.includes(name),
    };
    if (Array.isArray(schema?.enum)) parameter.enum = schema.enum.slice(0, 20);
    described.push(parameter);
  }
  return described;
}

/**
 * The commands to probe, with any configured path taking precedence.
 *
 * A row may point at a private ffmpeg build (`ffmpegPath`, `blenderPath`, or a
 * `backends` map). A configured command is tried before the bare name, so the
 * status reflects the binary the tools would really run.
 */
export function backendCommands(options = {}, config = {}) {
  const sections = ['', 'video', 'editing', 'cad', 'audio', 'image'];
  return BACKENDS.map((backend) => {
    const configured = [];
    for (const section of sections) {
      const scope = section === '' ? config : config?.[section];
      const value = scope?.[`${backend.name}Path`];
      if (typeof value === 'string' && value.trim() !== '') configured.push(value.trim());
      const mapped = scope?.backends?.[backend.name];
      if (typeof mapped === 'string' && mapped.trim() !== '') configured.push(mapped.trim());
    }
    const fromOptions = options?.backends?.[backend.name];
    if (typeof fromOptions === 'string' && fromOptions.trim() !== '') configured.push(fromOptions.trim());
    const commands = [...new Set([...configured, ...backend.commands])];
    return { name: backend.name, label: backend.label, commands, args: backend.args };
  });
}

/** The providers the panel showed as a badge, as plain text. */
export function describeProviders(options = {}) {
  const providers = {};
  for (const key of Object.keys(PROVIDER_LABELS)) {
    const value = options?.[key]?.provider;
    if (typeof value === 'string' && value !== '') providers[key] = value;
  }
  return providers;
}

/** The configured upper bounds, in bytes or characters as they are. */
export function describeLimits(options = {}) {
  const limits = {};
  if (typeof options?.outputDir === 'string' && options.outputDir !== '') limits.outputDir = options.outputDir;
  for (const key of Object.keys(LIMIT_LABELS)) {
    const value = Number(options?.[key]);
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  const maxAssetBytes = Number(options?.assets?.maxBytes);
  if (Number.isFinite(maxAssetBytes) && maxAssetBytes > 0) limits.maxAssetBytes = maxAssetBytes;
  return limits;
}

/** How many materials the library holds, by kind. */
export function describeMaterials(entries, directory = '') {
  const list = Array.isArray(entries) ? entries : [];
  const byKind = {};
  for (const entry of list) {
    const kind = typeof entry?.kind === 'string' && entry.kind !== '' ? entry.kind : 'other';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const described = { total: list.length, byKind };
  if (typeof directory === 'string' && directory !== '') described.directory = directory;
  return described;
}

/** Resolve with the promise's value, or `{ timedOut: true }` after `ms`. */
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Backend probing (the only place a process is started)
// ---------------------------------------------------------------------------

/**
 * Run one command and collect its output.
 *
 * Never rejects and never throws: a missing binary, a timeout and a crash all
 * come back as `{ ok: false, error }`, because a status tool must not fail the
 * turn just because Blender is not installed.
 *
 * @param {string} command - executable name or path.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - how long to wait before the process is killed.
 * @returns {Promise<{ ok: boolean, stdout?: string, stderr?: string, code?: number, error?: string }>}
 */
export function runVersion(command, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
      finish({ ok: false, error: `タイムアウト (${timeoutMs} ms) で打ち切りました。` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 8192) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, code, stdout, stderr });
      } else {
        finish({ ok: false, code, stdout, stderr, error: `終了コード ${code}` });
      }
    });
  });
}

/** Version text for one candidate command, or the reason it did not work. */
async function probeCommand(candidate, backend, run, timeoutMs) {
  let result;
  try {
    result = await run(candidate, backend.args, timeoutMs);
  } catch (error) {
    return { found: false, command: candidate, error: error instanceof Error ? error.message : String(error) };
  }
  const version = parseVersion(result?.stdout) ?? parseVersion(result?.stderr);
  if (result?.ok === true) return { found: true, command: candidate, version };
  return { found: false, command: candidate, error: result?.error ?? '起動できませんでした。' };
}

/**
 * Probe every backend.
 *
 * Each command in a backend's list is tried in order, each with its own
 * timeout. The result keeps a record per backend, whether or not it exists.
 *
 * @param {ReturnType<typeof backendCommands>} commands - from `backendCommands()`.
 * @param {{ timeoutMs?: number, run?: Function }} [options] - `run` is injectable for tests.
 */
export async function probeBackends(commands, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  const run = typeof options.run === 'function' ? options.run : runVersion;
  const backends = [];
  for (const backend of commands) {
    let record;
    for (const candidate of backend.commands) {
      const probed = await probeCommand(candidate, backend, run, timeoutMs);
      if (probed.found) {
        record = { name: backend.name, found: true, command: candidate };
        if (probed.version !== undefined) record.version = probed.version;
        break;
      }
      record = { name: backend.name, found: false, command: candidate, error: probed.error };
    }
    if (record === undefined) {
      record = { name: backend.name, found: false, error: '確認するコマンドがありません。' };
    }
    backends.push(record);
  }
  return backends;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `name (a, b)` — the argument list the agent has to fill in. */
function toolHeadline(tool) {
  const required = Array.isArray(tool?.required) ? tool.required : [];
  return required.length === 0 ? tool.name : `${tool.name} (${required.join(', ')})`;
}

/** The grouped, Japanese status text. */
export function formatStatusText(status, options = {}) {
  const verbose = options.verbose === true;
  const tools = Array.isArray(status?.tools) ? status.tools : [];
  const registered = tools.filter((tool) => tool.registered === true).length;
  const lines = [];

  lines.push('# スタジオの状態');
  lines.push('');
  lines.push(`できること: ${tools.length} 件 (登録済み ${registered} 件)`);
  if (Number.isFinite(Number(status?.seconds))) lines.push(`所要: ${Number(status.seconds).toFixed(2)} 秒`);

  lines.push('', '## できること');
  const groups = [...STUDIO_GROUPS, 'other'];
  for (const group of groups) {
    const inGroup = tools.filter((tool) => tool.group === group);
    if (inGroup.length === 0) continue;
    lines.push(`### ${GROUP_LABELS[group] ?? group}`);
    for (const tool of inGroup) {
      const suffix = tool.registered === false ? ' — 未登録' : '';
      lines.push(verbose ? `- ${toolHeadline(tool)} — ${tool.summary}${suffix}` : `- ${toolHeadline(tool)}${suffix}`);
      if (verbose && typeof tool.description === 'string' && tool.description !== '') {
        lines.push(`  - ${tool.description}`);
      }
      if (verbose && Array.isArray(tool.parameters) && tool.parameters.length > 0) {
        const parameters = tool.parameters.map((parameter) => {
          const bits = [parameter.name, parameter.type];
          if (parameter.required) bits.push('必須');
          if (Array.isArray(parameter.enum)) bits.push(parameter.enum.join('|'));
          return bits.join(': ');
        });
        lines.push(`  - 引数: ${parameters.join(' / ')}`);
      }
    }
  }

  lines.push('', '## バックエンド');
  if (status?.checkedBackends === true) {
    const backends = Array.isArray(status?.backends) ? status.backends : [];
    for (const backend of backends) {
      if (backend.found === true) {
        lines.push(`- ${backend.name}: ${backend.version ?? 'あり'}`);
      } else {
        lines.push(`- ${backend.name}: 見つかりません (${backend.error ?? '起動できません'}${verbose && backend.command !== undefined ? `, ${backend.command}` : ''})`);
      }
    }
  } else {
    lines.push('未確認です (checkBackends: false)。実体を確かめるには checkBackends: true で呼んでください。');
  }
  const soundFont = status?.soundFont ?? {};
  const soundFontPath = typeof soundFont.path === 'string' && soundFont.path !== '' ? soundFont.path : '未設定';
  if (soundFont.available === true) {
    const presets = Number.isFinite(Number(soundFont.presets)) ? `${Number(soundFont.presets)} プリセット` : 'プリセット未確認';
    const size = Number.isFinite(Number(soundFont.bytes)) ? `, ${bytesText(soundFont.bytes)}` : '';
    lines.push(`- SoundFont: あり (${presets}${size}) ${soundFontPath}`);
    if (soundFont.error !== undefined) lines.push(`  - ${soundFont.error}`);
  } else {
    lines.push(`- SoundFont: なし ${soundFontPath}`);
  }

  const providers = status?.providers ?? {};
  const providerLines = Object.keys(PROVIDER_LABELS)
    .filter((key) => typeof providers[key] === 'string')
    .map((key) => `- ${PROVIDER_LABELS[key]}: ${providers[key]}`);
  if (providerLines.length > 0) {
    lines.push('', '## プロバイダー', ...providerLines);
  }

  const limits = status?.limits ?? {};
  const limitLines = [];
  if (typeof limits.outputDir === 'string') limitLines.push(`- 出力先: ${limits.outputDir}`);
  for (const key of Object.keys(LIMIT_LABELS)) {
    const value = limits[key];
    if (value === undefined) continue;
    limitLines.push(`- ${LIMIT_LABELS[key]}: ${BYTE_LIMITS.has(key) ? bytesText(value) : `${value} 文字`}`);
  }
  if (limits.maxAssetBytes !== undefined) limitLines.push(`- 素材 1 件の上限: ${bytesText(limits.maxAssetBytes)}`);
  if (limitLines.length > 0) {
    lines.push('', '## 上限', ...limitLines);
  }

  const materials = status?.materials ?? {};
  const byKind = materials.byKind ?? {};
  const kindText = Object.entries(byKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(' / ');
  const where = typeof materials.directory === 'string' && materials.directory !== '' ? `${materials.directory} に ` : '';
  lines.push('', '## 素材ライブラリ');
  lines.push(`${where}${Number(materials.total ?? 0)} 件${kindText === '' ? '' : ` (${kindText})`}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Collecting the state
// ---------------------------------------------------------------------------

/** The dependencies `collectStatus` uses; tests replace all of them. */
function defaultDeps() {
  return {
    run: runVersion,
    listAssets,
    soundFontAvailable,
    soundFontPresets,
    fileSize: async (path) => (await stat(path)).size,
    now: () => Date.now(),
  };
}

/**
 * Read everything `studio_status` reports.
 *
 * Exported because it is the interesting half: the tests call it with fake
 * dependencies to prove that `checkBackends: false` never starts a process.
 *
 * @param {{ ctx?: object, options?: object, config?: object, helpers?: object, args?: object, deps?: object }} input
 * @returns {Promise<object>} the tool result (lossless JSON, no `undefined` values).
 */
export async function collectStatus(input = {}) {
  const options = input.options ?? {};
  const config = input.config ?? {};
  const args = input.args ?? {};
  const deps = { ...defaultDeps(), ...(input.deps ?? {}) };
  const started = deps.now();
  const checkBackends = args.checkBackends !== false;

  const tools = describeTools(toolsRegistry(input.ctx), { verbose: args.verbose === true });
  const soundFontPath = options?.soundfont?.path ?? config?.soundfont?.path;
  const soundFont = { available: false };
  if (typeof soundFontPath === 'string' && soundFontPath !== '') {
    soundFont.path = soundFontPath;
    soundFont.available = deps.soundFontAvailable(soundFontPath) === true;
  }
  if (soundFont.available === true) {
    try {
      soundFont.bytes = await deps.fileSize(soundFont.path);
    } catch {
      // The file vanished between the check and the stat; the size is optional.
    }
    if (checkBackends) {
      const loaded = await withTimeout(deps.soundFontPresets(soundFont.path), SOUNDFONT_TIMEOUT_MS);
      if (loaded?.timedOut === true) {
        soundFont.error = `SoundFont の読み込みが ${SOUNDFONT_TIMEOUT_MS} ms を超えました。`;
      } else if (loaded?.error !== undefined) {
        soundFont.error = loaded.error;
      } else if (Array.isArray(loaded?.value)) {
        soundFont.presets = loaded.value.length;
      }
    }
  }

  let backends = [];
  if (checkBackends) {
    backends = await probeBackends(backendCommands(options, config), { run: deps.run });
  }

  const directory = assetDirectory(options);
  let entries = [];
  try {
    const listed = await deps.listAssets(directory);
    entries = Array.isArray(listed) ? listed : [];
  } catch {
    // An unreadable library is reported as empty rather than failing the call.
  }

  const status = {
    checkedBackends: checkBackends,
    tools,
    backends,
    soundFont,
    providers: describeProviders(options),
    limits: describeLimits(options),
    materials: describeMaterials(entries, directory),
  };
  status.seconds = Number(((deps.now() - started) / 1000).toFixed(2));
  return status;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** The `studio_status` tool definition. */
export function statusTool(ctx, options, config, helpers) {
  return {
    name: 'studio_status',
    description: [
      'Report what this studio can do, as text: every tool a project file may name (with the arguments it requires),',
      'which external backend is actually installed (ffmpeg, ffprobe, Blender, Python) and which version it is,',
      'whether the SoundFont is present and how many presets it holds, the configured providers, limits and output directory,',
      'and how many materials the library holds.',
      'Use it when the user asks what is possible, why a render failed, or which backend is missing.',
      'Pass `checkBackends: false` to answer from configuration alone without starting any process.',
      'Pass `verbose: true` for each tool\'s description, parameters and allowed values.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verbose: { type: 'boolean', description: 'Include each tool description, every parameter and its allowed values. Defaults to false: names, groups and required arguments only.' },
        checkBackends: { type: 'boolean', description: 'Run `<backend> --version` (5 s each) to prove ffmpeg, ffprobe, Blender and Python exist, and read the SoundFont presets. Defaults to true. `false` starts no process at all.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          checkedBackends: { type: 'boolean' },
          tools: { type: 'array', items: { type: 'object' } },
          backends: { type: 'array', items: { type: 'object' } },
          soundFont: { type: 'object' },
          providers: { type: 'object' },
          limits: { type: 'object' },
          materials: { type: 'object' },
          seconds: { type: 'number' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: formatStatusText(value, { verbose: _args?.verbose === true }) }];
      },
      presentationMeta() {
        return { name: 'status' };
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return collectStatus({ ctx, options, config, helpers, args: args ?? {} });
    },
  };
}

/**
 * Register the status tool.
 *
 * Synchronous on purpose: `apply()` must not await anything, so this only
 * defines the tool. Processes start inside `execute()` only.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {object} config - the raw row config.
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers - utilities owned by `index.js`.
 * @returns {void}
 */
export function registerStatusTools(ctx, options, config, helpers) {
  const tool = statusTool(ctx, options ?? {}, config ?? {}, helpers ?? {});
  ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
}
