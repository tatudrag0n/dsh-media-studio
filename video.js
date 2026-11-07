/**
 * Video generation core for the Media Studio plugin.
 *
 * Four backends, all reached through one entry point (`generateVideo`):
 *
 *   - `local`    diffusers on this machine, driven by the bundled Python runner
 *                (`video_local.py`). Text→video and image→video recipes.
 *   - `comfyui`  a ComfyUI workflow JSON (Wan / Hunyuan / LTX …) submitted to a
 *                local ComfyUI server. Placeholders in the workflow are filled
 *                with the request values.
 *   - `openai`   an OpenAI-compatible `/videos` endpoint (Sora and friends):
 *                create a job, poll it, download the finished MP4.
 *   - `frames`   no model at all: encode PNG frames (or one still image with a
 *                slow zoom) into an MP4 with ffmpeg.
 *
 * Encoding always goes through ffmpeg, so the plugin never depends on a Python
 * video stack. The diffusers runner only paints frames; this module muxes them.
 *
 * The module is dependency-free on purpose: it runs inside the Harness Host,
 * which ships no native video codec of its own.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Media type every backend produces. */
export const VIDEO_MEDIA_TYPE = 'video/mp4';

/** Container extension every backend produces. */
export const VIDEO_EXTENSION = 'mp4';

/** Frame shapes the panel and the tool accept. */
export const VIDEO_ASPECTS = ['landscape', 'portrait', 'square'];

/** Longest prompt one video request accepts. */
export const DEFAULT_MAX_VIDEO_PROMPT = 2000;

/** Longest negative prompt one video request accepts. */
export const DEFAULT_MAX_NEGATIVE_PROMPT = 1000;

/** Default frame rate when neither the caller nor the recipe picks one. */
export const DEFAULT_VIDEO_FPS = 8;

/** Frames-per-second choices the panel offers. */
export const VIDEO_FPS_CHOICES = [4, 8, 12, 16, 24];

/**
 * Local diffusers recipes.
 *
 * `mode` says what the recipe consumes: `text` for a text-to-video pipeline,
 * `image` for an image-to-video pipeline. An `image` recipe can still serve a
 * text request: the caller paints a keyframe with the image provider first.
 */
export const LOCAL_RECIPES = {
  svd: {
    id: 'svd',
    label: 'Stable Video Diffusion (image → video)',
    mode: 'image',
    model: 'stabilityai/stable-video-diffusion-img2vid-xt',
    width: 1024,
    height: 576,
    frames: 25,
    fps: 8,
    steps: 25,
    note: 'Animate one picture. For a text request the plugin paints a keyframe with the image provider first.',
  },
  wan21: {
    id: 'wan21',
    label: 'Wan 2.1 T2V 1.3B (text → video)',
    mode: 'text',
    model: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
    width: 832,
    height: 480,
    frames: 81,
    fps: 16,
    steps: 30,
    note: 'Native text-to-video. The first run downloads roughly 27 GB of weights.',
  },
  cogvideox: {
    id: 'cogvideox',
    label: 'CogVideoX 2B (text → video)',
    mode: 'text',
    model: 'THUDM/CogVideoX-2b',
    width: 480,
    height: 320,
    frames: 49,
    fps: 16,
    steps: 20,
    note: 'Native text-to-video, smaller download than Wan.',
  },
  ltx: {
    id: 'ltx',
    label: 'LTX-Video 2B (text → video)',
    mode: 'text',
    model: 'Lightricks/LTX-Video',
    width: 768,
    height: 512,
    frames: 97,
    fps: 24,
    steps: 30,
    note: 'Native text-to-video, fast on recent GPUs.',
  },
};

/** Recipe used when the row names none. */
export const DEFAULT_RECIPE = 'svd';

/** Python interpreters tried, in order, when the row names none. */
export const PYTHON_CANDIDATES = [
  'python',
  'python3',
  'py',
  'C:\\Users\\tatud\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  'C:\\Python312\\python.exe',
  'C:\\Python311\\python.exe',
];

/** Directories scanned for an installed interpreter, before PATH lookups. */
export const PYTHON_SEARCH_ROOTS = [
  join(homedir(), '.dsh', 'dsh-runtimes'),
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Python'),
  'C:\\',
  'C:\\Program Files',
];

/** Interpreter that satisfied one module set, so later calls skip probing. */
const pythonCache = new Map();

/** ffmpeg executables tried, in order, when the row names none. */
export const FFMPEG_CANDIDATES = [
  'C:\\ProgramData\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\ffmpeg.exe',
];

/** Frame file name pattern the diffusers runner writes. */
const FRAME_PATTERN = 'frame_%05d.jpg';

/** Image extensions the local runner accepts as a first frame. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/** Accepted configuration; every field is optional and normalized by the caller. */
export const Config = {
  provider: { type: 'string' },
  baseURL: { type: 'string' },
  apiKeyEnv: { type: 'string' },
  apiKey: { type: 'string' },
  model: { type: 'string' },
  recipe: { type: 'string' },
  pythonPath: { type: 'string' },
  ffmpegPath: { type: 'string' },
  seconds: { type: 'number' },
  fps: { type: 'number' },
  width: { type: 'number' },
  height: { type: 'number' },
  steps: { type: 'number' },
  workflowPath: { type: 'string' },
  timeoutMs: { type: 'number' },
  maxVideoPrompt: { type: 'number' },
  maxNegativePrompt: { type: 'number' },
};

/** Resolve one recipe by id, falling back to the default. */
export function resolveRecipe(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  return LOCAL_RECIPES[key] ?? LOCAL_RECIPES[DEFAULT_RECIPE];
}

/** Frame shape for one aspect, in pixels. */
export function resolveVideoSize(aspect, width, height) {
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const shape = typeof aspect === 'string' && aspect !== '' ? aspect : 'landscape';
  if (shape === 'portrait') return { width: 576, height: 1024 };
  if (shape === 'square') return { width: 640, height: 640 };
  return { width: 1024, height: 576 };
}

/** Frames one video should hold for a requested duration. */
export function resolveFrameCount(seconds, fps, recipe) {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : (recipe?.fps ?? DEFAULT_VIDEO_FPS);
  const wanted = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * rate) : (recipe?.frames ?? 25);
  const minimum = 4;
  const maximum = 300;
  const clamped = Math.min(maximum, Math.max(minimum, wanted));
  // Diffusers video models want a 4k+1 frame count, and never fewer than five.
  const rounded = clamped - ((clamped - 1) % 4);
  return Math.max(5, rounded);
}

/** True when the bytes look like an MP4 container. */
export function isMp4(bytes) {
  if (bytes === undefined || bytes === null || bytes.byteLength < 12) return false;
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
}

/**
 * Run one video backend and return the finished MP4.
 *
 * `input` carries the request: `prompt`, `negativePrompt`, `imageBytes`,
 * `imagePath`, `width`, `height`, `seconds`, `fps`, `frames`, `steps`, `seed`,
 * `model`, `recipe`, and `signal`.
 */
export async function generateVideo(ctx, options, input) {
  const provider = options.video.provider;
  if (provider === 'openai') return openAiVideo(ctx, options, input);
  if (provider === 'comfyui') return comfyUiVideo(options, input);
  if (provider === 'frames') return framesVideo(options, input);
  return localVideo(options, input);
}

// #region Local (diffusers)

// #endregion

/**
 * Generate with the bundled diffusers runner, then mux the frames with ffmpeg.
 *
 * The runner paints frames into a temporary directory and reports its settings
 * on stdout; this function turns those frames into an MP4.
 */
export async function localVideo(options, input) {
  const recipe = resolveRecipe(input.recipe ?? options.video.recipe);
  const model = nonEmpty(input.model) ?? options.video.model ?? recipe.model;
  const width = Number.isFinite(input.width) ? Math.round(input.width) : (options.video.width ?? recipe.width);
  const height = Number.isFinite(input.height) ? Math.round(input.height) : (options.video.height ?? recipe.height);
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : (options.video.fps ?? recipe.fps);
  const frames = Number.isFinite(input.frames) && input.frames > 0
    ? Math.round(input.frames)
    : resolveFrameCount(options.video.seconds, fps, recipe);
  const steps = Number.isFinite(input.steps) && input.steps > 0 ? Math.round(input.steps) : (options.video.steps ?? recipe.steps);
  const seed = Number.isFinite(input.seed) ? Math.round(input.seed) : Math.floor(Math.random() * 2 ** 31);

  const python = await resolvePython(options);
  const script = fileURLToPath(new URL('./video_local.py', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-video-'));
  const framesDirectory = join(directory, 'frames');
  try {
    const args = [
      script,
      '--recipe', recipe.id,
      '--model', model,
      '--out', framesDirectory,
      '--width', String(width),
      '--height', String(height),
      '--frames', String(frames),
      '--fps', String(fps),
      '--steps', String(steps),
      '--seed', String(seed),
    ];
    if (nonEmpty(input.prompt) !== undefined) args.push('--prompt', input.prompt);
    if (nonEmpty(input.negativePrompt) !== undefined) args.push('--negative', input.negativePrompt);
    const firstFrame = await materializeImage(input, directory);
    if (firstFrame !== undefined) args.push('--image', firstFrame);

    const run = await runProcess(python, args, { timeoutMs: options.video.timeoutMs, signal: input.signal, cwd: directory });
    if (run.code !== 0) {
      throw new Error(`ローカル動画生成が失敗しました (exit ${run.code}): ${firstMeaningfulLine(run.stderr) ?? run.stderr.trim()}`);
    }
    const report = parseRunnerReport(run.stdout);
    const encoded = await encodeFrames(options, {
      directory: framesDirectory,
      pattern: FRAME_PATTERN,
      fps: report?.fps ?? fps,
      width: report?.width ?? width,
      height: report?.height ?? height,
    });
    return {
      data: encoded,
      mediaType: VIDEO_MEDIA_TYPE,
      provider: 'local',
      model,
      recipe: recipe.id,
      width: report?.width ?? width,
      height: report?.height ?? height,
      frames: report?.frames ?? frames,
      fps: report?.fps ?? fps,
      seconds: (report?.frames ?? frames) / (report?.fps ?? fps),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Parse the JSON report the Python runner prints on its last stdout line. */
export function parseRunnerReport(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // Not the report line; keep looking.
    }
  }
  return undefined;
}

// #endregion

// #region ffmpeg

/**
 * Encode a numbered frame sequence into an MP4.
 *
 * The frames must be `pattern`-named files (`frame_%05d.jpg`) inside
 * `directory`; the sequence is read in order and encoded with libx264.
 */
export async function encodeFrames(options, { directory, pattern = FRAME_PATTERN, fps = DEFAULT_VIDEO_FPS, width, height }) {
  const ffmpeg = await resolveFfmpeg(options);
  const output = join(directory, 'output.mp4');
  const args = [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', join(directory, pattern),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-movflags', '+faststart',
    output,
  ];
  if (Number.isFinite(width) && Number.isFinite(height)) {
    args.splice(args.length - 1, 0, '-vf', `scale=${Math.round(width)}:${Math.round(height)}:force_original_aspect_ratio=decrease:out_range=tv,pad=${Math.round(width)}:${Math.round(height)}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`);
  }
  const run = await runProcess(ffmpeg, args, { timeoutMs: options.video.timeoutMs });
  if (run.code !== 0) {
    throw new Error(`ffmpeg がフレームの書き出しに失敗しました (exit ${run.code}): ${firstMeaningfulLine(run.stderr) ?? run.stderr.trim()}`);
  }
  const bytes = new Uint8Array(await readFile(output));
  if (bytes.byteLength === 0) throw new Error('ffmpeg が空の MP4 を書き出しました。');
  return bytes;
}

/**
 * Encode one still image into a short MP4 with a slow zoom.
 *
 * Used by the `frames` backend when the caller has a picture but no model.
 */
export async function encodeStillImage(options, { imagePath, seconds = 4, fps = DEFAULT_VIDEO_FPS, width = 1024, height = 576 }) {
  const ffmpeg = await resolveFfmpeg(options);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-still-'));
  try {
    const output = join(directory, 'output.mp4');
    const total = Math.max(1, Math.round(seconds * fps));
    const filter = [
      `scale=${Math.round(width)}:${Math.round(height)}:force_original_aspect_ratio=increase:out_range=tv`,
      `crop=${Math.round(width)}:${Math.round(height)}`,
      `zoompan=z='min(zoom+0.0008,1.4)':d=${total}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${Math.round(width)}x${Math.round(height)}:fps=${fps}`,
      'format=yuv420p',
    ].join(',');
    const run = await runProcess(ffmpeg, [
      '-y',
      '-loglevel', 'error',
      '-loop', '1',
      '-i', imagePath,
      '-vf', filter,
      '-t', String(seconds),
      '-frames:v', String(total),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-movflags', '+faststart',
      output,
    ], { timeoutMs: options.video.timeoutMs });
    if (run.code !== 0) {
      throw new Error(`ffmpeg が画像の書き出しに失敗しました (exit ${run.code}): ${firstMeaningfulLine(run.stderr) ?? run.stderr.trim()}`);
    }
    const bytes = new Uint8Array(await readFile(output));
    if (bytes.byteLength === 0) throw new Error('ffmpeg が空の MP4 を書き出しました。');
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Find a usable ffmpeg executable, or throw a message that says what to do. */
export async function resolveFfmpeg(options) {
  const configured = nonEmpty(options.video.ffmpegPath);
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`ffmpeg が見つかりません: ${configured}`);
    return configured;
  }
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    await runProcess('ffmpeg', ['-version'], { timeoutMs: 15000 });
    return 'ffmpeg';
  } catch {
    throw new Error('ffmpeg が見つかりません。ffmpeg を PATH に追加するか、cordis.patch.yml の video.ffmpegPath にパスを指定してください。ffmpeg is required to write MP4 files.');
  }
}

// #endregion

// #region OpenAI-compatible video endpoint

/**
 * Create a video job on an OpenAI-compatible endpoint, poll it, and download
 * the finished MP4.
 */
export async function openAiVideo(ctx, options, input) {
  const credential = await resolveVideoCredential(ctx, options);
  if (credential === undefined) {
    throw new Error(`動画生成には ${options.video.apiKeyEnv} が必要です（video.provider: openai）。Video generation needs the ${options.video.apiKeyEnv} credential.`);
  }
  const model = nonEmpty(input.model) ?? options.video.model ?? 'sora-2';
  const size = `${input.width ?? options.video.width ?? 1280}x${input.height ?? options.video.height ?? 720}`;
  const seconds = String(Math.round(input.seconds ?? options.video.seconds ?? 4));
  const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json' };

  const created = await fetchJson(`${options.video.baseURL}/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, prompt: String(input.prompt ?? ''), seconds, size }),
  }, options.video.timeoutMs, input.signal);
  const id = nonEmpty(created?.id);
  if (id === undefined) throw new Error('動画エンドポイントの応答に job id がありませんでした。');

  const deadline = Date.now() + options.video.timeoutMs;
  let status = created?.status;
  while (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    if (Date.now() > deadline) throw new Error('動画生成がタイムアウトしました。');
    await delay(3000, input.signal);
    const job = await fetchJson(`${options.video.baseURL}/videos/${encodeURIComponent(id)}`, { method: 'GET', headers }, 30000, input.signal);
    status = job?.status;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`動画生成が ${status} しました: ${nonEmpty(job?.error?.message) ?? '詳細なし'}`);
    }
  }
  if (status !== 'completed') throw new Error(`動画生成が完了しませんでした (status: ${status ?? 'unknown'})。`);

  const response = await fetchWithTimeout(`${options.video.baseURL}/videos/${encodeURIComponent(id)}/content`, {
    method: 'GET',
    headers: { authorization: `Bearer ${credential}`, accept: 'video/mp4' },
  }, options.video.timeoutMs, input.signal);
  if (!response.ok) throw new Error(`動画データの取得が HTTP ${response.status} で失敗しました。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('動画エンドポイントが空の応答を返しました。');
  return {
    data: bytes,
    mediaType: VIDEO_MEDIA_TYPE,
    provider: 'openai',
    model,
    width: Number.parseInt(size, 10),
    height: Number.parseInt(size.split('x')[1] ?? '720', 10),
    frames: undefined,
    fps: undefined,
    seconds: Number.parseInt(seconds, 10),
  };
}

// #endregion

// #region ComfyUI

/**
 * Submit a ComfyUI workflow, wait for it, and download the produced video.
 *
 * The workflow JSON comes from the row configuration. String values may hold
 * `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`,
 * `{{frames}}`, `{{fps}}` and `{{image}}` placeholders.
 */
export async function comfyUiVideo(options, input) {
  const workflowPath = nonEmpty(options.video.workflowPath);
  if (workflowPath === undefined) {
    throw new Error('ComfyUI を使うには cordis.patch.yml の video.workflowPath に ComfyUI のワークフロー JSON を指定してください。');
  }
  if (!existsSync(workflowPath)) throw new Error(`ComfyUI のワークフローが見つかりません: ${workflowPath}`);
  const template = JSON.parse(await readFile(workflowPath, 'utf8'));
  const values = {
    prompt: String(input.prompt ?? ''),
    negative: String(input.negativePrompt ?? ''),
    seed: String(input.seed ?? Math.floor(Math.random() * 2 ** 31)),
    width: String(input.width ?? options.video.width ?? 832),
    height: String(input.height ?? options.video.height ?? 480),
    frames: String(input.frames ?? 81),
    fps: String(input.fps ?? options.video.fps ?? 16),
    image: String(input.imagePath ?? ''),
  };
  const workflow = fillPlaceholders(template, values);
  const base = options.video.baseURL.replace(/\/+$/u, '');

  if (input.imageBytes !== undefined && input.imageBytes !== null) {
    values.image = await uploadComfyImage(base, input.imageBytes, options.video.timeoutMs, input.signal);
    const filled = fillPlaceholders(template, values);
    return await runComfyWorkflow(base, filled, options, input);
  }

  return await runComfyWorkflow(base, workflow, options, input);
}

/** Upload one picture to a ComfyUI server and return the stored file name. */
export async function uploadComfyImage(base, bytes, timeoutMs, signal) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'first-frame.jpg');
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const response = await fetchWithTimeout(`${base}/upload/image`, { method: 'POST', body: form }, timeoutMs, signal);
  if (!response.ok) throw new Error(`ComfyUI への画像アップロードが HTTP ${response.status} で失敗しました。`);
  const payload = await response.json().catch(() => undefined);
  const name = nonEmpty(payload?.name);
  if (name === undefined) throw new Error('ComfyUI の応答にアップロードしたファイル名がありませんでした。');
  return name;
}

/** Submit one ComfyUI workflow, wait for it, and download the produced video. */
async function runComfyWorkflow(base, workflow, options, input) {
  const submitted = await fetchJson(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  }, options.video.timeoutMs, input.signal);
  const promptId = nonEmpty(submitted?.prompt_id);
  if (promptId === undefined) throw new Error('ComfyUI の応答に prompt_id がありませんでした。');

  const deadline = Date.now() + options.video.timeoutMs;
  let filename;
  let subfolder = '';
  let type = 'output';
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error('キャンセルされました。');
    const history = await fetchJson(`${base}/history/${promptId}`, { method: 'GET', headers: { accept: 'application/json' } }, 30000, input.signal).catch(() => undefined);
    if (history !== undefined) {
      const entry = history?.[promptId];
      const outputs = entry?.outputs ?? {};
      for (const node of Object.values(outputs)) {
        const videos = node?.videos ?? node?.gifs ?? node?.images;
        if (Array.isArray(videos) && videos.length > 0) {
          filename = videos[0].filename;
          subfolder = videos[0].subfolder ?? '';
          type = videos[0].type ?? 'output';
          break;
        }
      }
      if (filename !== undefined) break;
      if (entry?.status?.status_str === 'error') throw new Error('ComfyUI の生成がエラーで終了しました。');
    }
    await delay(2000, input.signal);
  }
  if (filename === undefined) throw new Error('ComfyUI の生成がタイムアウトしました。');

  const viewUrl = `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const response = await fetchWithTimeout(viewUrl, { method: 'GET' }, options.video.timeoutMs, input.signal);
  if (!response.ok) throw new Error(`ComfyUI の動画取得が HTTP ${response.status} で失敗しました。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('ComfyUI が空の動画を返しました。');
  return {
    data: bytes,
    mediaType: VIDEO_MEDIA_TYPE,
    provider: 'comfyui',
    model: nonEmpty(input.model) ?? options.video.model ?? 'comfyui',
    width: input.width ?? options.video.width,
    height: input.height ?? options.video.height,
    frames: input.frames,
    fps: input.fps ?? options.video.fps,
    seconds: undefined,
  };
}

/** Replace `{{name}}` placeholders in every string of a workflow. */
export function fillPlaceholders(value, values) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/gu, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
  }
  if (Array.isArray(value)) return value.map((entry) => fillPlaceholders(entry, values));
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = fillPlaceholders(entry, values);
    return output;
  }
  return value;
}

// #endregion

// #region Frames

/**
 * Encode PNG frames into an MP4 without any model.
 *
 * The caller supplies either a directory of images (`framesDirectory`) or one
 * still image (`imagePath`), which becomes a slow zoom.
 */
export async function framesVideo(options, input) {
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : (options.video.fps ?? DEFAULT_VIDEO_FPS);
  const seconds = Number.isFinite(input.seconds) && input.seconds > 0 ? input.seconds : (options.video.seconds ?? 4);
  const width = Number.isFinite(input.width) ? Math.round(input.width) : (options.video.width ?? 1024);
  const height = Number.isFinite(input.height) ? Math.round(input.height) : (options.video.height ?? 576);

  if (nonEmpty(input.framesDirectory) !== undefined) {
    const directory = input.framesDirectory;
    const files = (await readdir(directory)).filter((file) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase())).sort();
    if (files.length === 0) throw new Error(`フレームフォルダに画像がありません: ${directory}`);
    const staged = await mkdtemp(join(tmpdir(), 'dsh-media-studio-frames-'));
    try {
      for (let index = 0; index < files.length; index += 1) {
        const bytes = await readFile(join(directory, files[index]));
        await writeFile(join(staged, `frame_${String(index).padStart(5, '0')}.jpg`), bytes);
      }
      const data = await encodeFrames(options, { directory: staged, pattern: 'frame_%05d.jpg', fps, width, height });
      return {
        data,
        mediaType: VIDEO_MEDIA_TYPE,
        provider: 'frames',
        model: 'ffmpeg',
        width,
        height,
        frames: files.length,
        fps,
        seconds: files.length / fps,
      };
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (nonEmpty(input.imagePath) !== undefined || input.imageBytes !== undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-still-'));
    try {
      const imagePath = await materializeImage(input, directory);
      const data = await encodeStillImage(options, { imagePath, seconds, fps, width, height });
      return {
        data,
        mediaType: VIDEO_MEDIA_TYPE,
        provider: 'frames',
        model: 'ffmpeg',
        width,
        height,
        frames: Math.round(seconds * fps),
        fps,
        seconds,
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error('フレーム指定的動画生成には framesDirectory か imagePath が必要です。');
}

// #endregion

// #region Helpers

/**
 * Write the request's first frame into `directory` and return its path.
 *
 * The caller may hand over a path that already exists, or the raw bytes of a
 * picture it just generated. Bytes win, because that is the keyframe path.
 */
export async function materializeImage(input, directory) {
  if (input.imageBytes !== undefined && input.imageBytes !== null) {
    const target = join(directory, 'first-frame.jpg');
    await writeFile(target, input.imageBytes);
    return target;
  }
  const path = nonEmpty(input.imagePath);
  if (path !== undefined) return path;
  return undefined;
}

/** Resolve one credential: literal config, then the credential store, then env. */export async function resolveVideoCredential(ctx, options) {
  const literal = nonEmpty(options.video.apiKey);
  if (literal !== undefined) return literal;
  const credentials = ctx?.get?.('credentials');
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(options.video.apiKeyEnv);
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
      if (value !== '') return value;
    } catch {
      // Fall through to the process environment.
    }
  }
  const fromEnv = process.env[options.video.apiKeyEnv];
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined;
}

/**
 * Interpreters this machine actually has, most specific first: an explicit
 * `DSH_PYTHON`, the runtime Python this harness ships (it carries Pillow and
 * numpy), then every Python installed for the current user or machine.
 */
export function pythonCandidates() {
  const found = [];
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text !== '' && !found.includes(text)) found.push(text);
  };
  add(process.env.DSH_PYTHON);
  // The runtime Python this harness ships carries Pillow and numpy, so it is
  // tried before any interpreter that merely happens to be on PATH.
  for (const base of [join(homedir(), '.dsh', 'dsh-runtimes')]) {
    for (const entry of readDirectories(base)) {
      add(join(base, entry, 'dependencies', 'python', 'python.exe'));
      add(join(base, entry, 'dependencies', 'python', 'bin', 'python3'));
    }
  }
  for (const base of PYTHON_SEARCH_ROOTS) {
    for (const entry of readDirectories(base)) {
      if (!/^Python\d/u.test(entry)) continue;
      add(join(base, entry, 'python.exe'));
    }
  }
  for (const bare of PYTHON_CANDIDATES) add(bare);
  return found;
}

/** Directory names under one path, or none when it is absent or unreadable. */
function readDirectories(base) {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Find a Python interpreter that can run the bundled diffusers runner. */
export async function resolvePython(options, modules = ['torch', 'diffusers']) {
  const configured = nonEmpty(options.video.pythonPath);
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`Python が見つかりません: ${configured}`);
    return configured;
  }
  const key = modules.join(',');
  const cached = pythonCache.get(key);
  if (cached !== undefined && (cached.includes('\\') === false || existsSync(cached))) return cached;
  const check = `import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(name) for name in ${JSON.stringify(modules)}) else 1)`;
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    try {
      // Look for the packages without importing them: importing torch costs
      // seconds, and this runs on every video request.
      // runProcess resolves whatever the exit code was, so the probe has to
      // read it: otherwise an interpreter without the modules looks fine.
      const probe = await runProcess(candidate, ['-c', check], { timeoutMs: 20000 });
      if (probe.code !== 0) continue;
      pythonCache.set(key, candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Python（${modules.join(' と ')} 入り）が見つかりません。cordis.patch.yml の pythonPath に Python のフルパスを指定してください。Python with ${modules.join(' and ')} is required for the local backend.`);
}

/** Spawn one process and collect its output. */
export function runProcess(executable, args, { timeoutMs = 600000, signal, cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(executable, args, { windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error(`${basename(executable)} が ${Math.round(timeoutMs / 1000)} 秒でタイムアウトしました。`));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectPromise(new Error('キャンセルされました。'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      rejectPromise(cause);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolvePromise({
        code: code ?? 0,
        stdout: Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))).toString('utf8'),
        stderr: Buffer.concat(stderr.map((chunk) => Buffer.from(chunk))).toString('utf8'),
      });
    });
  });
}

/** The first line of a stream that carries something other than a warning. */
export function firstMeaningfulLine(text) {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  return lines.find((line) => !line.startsWith('WARNING') && !line.startsWith('Warning')) ?? lines[0];
}

/** POST or GET JSON with a timeout and an optional abort signal. */
export async function fetchJson(url, init, timeoutMs, signal) {
  const response = await fetchWithTimeout(url, init, timeoutMs, signal);
  if (!response.ok) throw new Error(`動画エンドポイントが HTTP ${response.status} を返しました: ${(await response.text()).slice(0, 200)}`);
  return await response.json().catch(() => undefined);
}

/** One HTTP request with a timeout and an optional abort signal. */
export async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Wait for a while, honouring an abort signal. */
export function delay(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new Error('キャンセルされました。'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** A trimmed non-empty string, or undefined. */
export function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// #endregion
