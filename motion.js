/**
 * Motion graphics core for the Media Studio plugin.
 *
 * Motion graphics are animated graphic elements - type, shapes, logos, charts
 * and broadcast name straps - choreographed over time and usually cut to
 * audio. This module turns a request into a finished video:
 *
 *   1. `parseMotionSpec` reads the request into one normalized spec.
 *   2. `renderMotionGraphic` asks the bundled Python renderer
 *      (`motion_render.py`) for a numbered frame sequence.
 *   3. ffmpeg encodes that sequence, optionally muxes a voice-over, and
 *      writes MP4, WebM or GIF.
 *
 * The templates follow the deliverable types a motion designer is asked for:
 * a kinetic-typography title card, a broadcast lower third, a logo ident, an
 * animated infographic, an abstract motion bed, and a short stinger.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeFrames, resolveFfmpeg, resolvePython, runProcess } from './video.js';

/** The deliverable types the renderer can draw. */
export const MOTION_TEMPLATES = ['title', 'lower_third', 'ident', 'chart', 'shapes', 'stinger'];

/** Timing presets: the easing curve and how long the elements take. */
export const MOTION_STYLES = ['smooth', 'snappy', 'dramatic'];

/** Container formats the animation can be written in. */
export const MOTION_FORMATS = ['mp4', 'webm', 'gif'];

/** Default canvas of a motion graphic. */
export const DEFAULT_MOTION_WIDTH = 1280;

/** Default canvas height. */
export const DEFAULT_MOTION_HEIGHT = 720;

/** Default length in seconds. */
export const DEFAULT_MOTION_SECONDS = 4;

/** Default frame rate. */
export const DEFAULT_MOTION_FPS = 30;

/** Longest text one motion graphic accepts. */
export const DEFAULT_MAX_MOTION_TEXT = 300;

/** Longest subtitle one motion graphic accepts. */
export const DEFAULT_MAX_MOTION_SUBTITLE = 200;

/** Media type per container format. */
const FORMAT_MEDIA_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};

/** File extension per container format. */
const FORMAT_EXTENSIONS = {
  mp4: 'mp4',
  webm: 'webm',
  gif: 'gif',
};

/**
 * Read a motion-graphics request into one normalized spec.
 */
export function parseMotionSpec(input) {
  const template = MOTION_TEMPLATES.includes(input.template) ? input.template : 'title';
  const style = MOTION_STYLES.includes(input.style) ? input.style : 'smooth';
  const format = MOTION_FORMATS.includes(input.format) ? input.format : 'mp4';
  const width = clampSize(input.width, DEFAULT_MOTION_WIDTH);
  const height = clampSize(input.height, DEFAULT_MOTION_HEIGHT);
  const fps = clampFps(input.fps);
  const duration = clampSeconds(input.duration);
  const text = clip(input.text, DEFAULT_MAX_MOTION_TEXT);
  const subtitle = clip(input.subtitle, DEFAULT_MAX_MOTION_SUBTITLE);

  if (template === 'chart') {
    const labels = Array.isArray(input.labels) ? input.labels.map((entry) => String(entry)) : [];
    const series = Array.isArray(input.series)
      ? input.series.map((entry, index) => ({
        name: String(entry?.name ?? `Series ${index + 1}`),
        values: Array.isArray(entry?.values) ? entry.values.map((value) => toNumber(value)) : [],
      }))
      : [];
    if (labels.length === 0 || series.length === 0) {
      throw new Error('chart テンプレートには labels と series が必要です。Infographic templates need labels and series.');
    }
    const filled = series.map((entry) => ({
      name: entry.name,
      values: labels.map((_label, index) => (Number.isFinite(entry.values[index]) ? entry.values[index] : 0)),
    }));
    return {
      template,
      style,
      format,
      width,
      height,
      fps,
      duration,
      text,
      subtitle,
      seed: Math.floor(toNumber(input.seed)) || 1,
      colors: readColors(input),
      chart: {
        type: ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked'].includes(input.chartType) ? input.chartType : 'bar',
        labels,
        series: filled,
        title: subtitle,
      },
    };
  }

  if (template !== 'shapes' && template !== 'stinger' && text === '') {
    throw new Error(`${template} テンプレートには text が必要です。Use text for the ${template} template.`);
  }

  return {
    template,
    style,
    format,
    width,
    height,
    fps,
    duration,
    text,
    subtitle,
    seed: Math.floor(toNumber(input.seed)) || 1,
    colors: readColors(input),
  };
}

/** Read the colour choices of a request. */
function readColors(input) {
  const colors = {};
  const background = color(input.background);
  const foreground = color(input.foreground);
  const accent = color(input.accent);
  if (background !== undefined) colors.background = background;
  if (foreground !== undefined) colors.foreground = foreground;
  if (accent !== undefined) colors.accent = accent;
  const surface = color(input.surface);
  if (surface !== undefined) colors.surface = surface;
  const muted = color(input.muted);
  if (muted !== undefined) colors.muted = muted;
  if (Array.isArray(input.palette)) {
    const palette = input.palette.map((entry) => color(entry)).filter((entry) => entry !== undefined);
    if (palette.length > 0) colors.palette = palette;
  }
  return colors;
}

/** Keep a hex colour, or drop it. */
function color(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^#[0-9a-fA-F]{6}$/u.test(text)) return text.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/u.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return undefined;
}

/** Trim and cut a text to a limit. */
function clip(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= limit ? text : text.slice(0, limit);
}

/** Keep the canvas inside sane bounds. */
function clampSize(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1920, Math.max(240, Math.round(number)));
}

/** Keep the frame rate in the range browsers and codecs like. */
function clampFps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MOTION_FPS;
  return Math.min(60, Math.max(12, Math.round(number)));
}

/** Keep the length inside sane bounds. */
function clampSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MOTION_SECONDS;
  return Math.min(20, Math.max(0.5, Math.round(number * 100) / 100));
}

/** Read one number. */
function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Draw one composed frame, for a keyframe that is not animated.
 *
 * The video backend needs a first frame for a text request. Painting it here
 * keeps the whole video path local: no image provider, no network.
 */
export async function renderMotionStill(options, spec) {
  const resolved = {
    video: {
      pythonPath: options.motion?.pythonPath ?? options.graphics?.pythonPath ?? options.video?.pythonPath,
      ffmpegPath: options.motion?.ffmpegPath ?? options.graphics?.ffmpegPath ?? options.video?.ffmpegPath,
      timeoutMs: options.motion?.timeoutMs ?? options.video?.timeoutMs,
    },
  };
  const python = await resolvePython(resolved, ['PIL']);
  const script = fileURLToPath(new URL('./motion_render.py', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-still-'));
  try {
    const specPath = join(directory, 'motion.json');
    const stillPath = join(directory, 'still.jpg');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const run = await runProcess(python, [script, '--spec', specPath, '--out', directory, '--still', stillPath], {
      timeoutMs: resolved.video.timeoutMs ?? 300000,
    });
    if (run.code !== 0) {
      throw new Error(`キーフレームの描画に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
    }
    const data = new Uint8Array(await readFile(stillPath));
    if (data.byteLength === 0) throw new Error('キーフレームが空です。');
    return { data, mediaType: 'image/jpeg' };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Draw the animation and return the finished video.
 */
export async function renderMotionGraphic(options, spec, extras = {}) {
  // The video helpers read the `video` block, so build one that points at
  // the motion settings first and falls back to the shared ones.
  const resolved = {
    video: {
      pythonPath: options.motion?.pythonPath ?? options.graphics?.pythonPath ?? options.video?.pythonPath,
      ffmpegPath: options.motion?.ffmpegPath ?? options.graphics?.ffmpegPath ?? options.video?.ffmpegPath,
      timeoutMs: options.motion?.timeoutMs ?? options.video?.timeoutMs,
    },
  };
  const python = await resolvePython(resolved, ['PIL']);
  const script = fileURLToPath(new URL('./motion_render.py', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-motion-'));
  try {
    const framesDirectory = join(directory, 'frames');
    const specPath = join(directory, 'motion.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');

    const run = await runProcess(python, [script, '--spec', specPath, '--out', framesDirectory], {
      timeoutMs: resolved.video.timeoutMs ?? 300000,
    });
    if (run.code !== 0) {
      throw new Error(`モーショングラフィックスの描画に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
    }

    const encoded = await encodeFrames(resolved, {
      directory: framesDirectory,
      fps: spec.fps,
      width: spec.width,
      height: spec.height,
    });
    // encodeFrames writes its MP4 inside the frame directory.
    const videoPath = join(framesDirectory, 'output.mp4');

    const narrated = await muxAudio(resolved, directory, videoPath, encoded, extras.audio);
    const finished = await convertFormat(resolved, directory, videoPath, narrated, spec.format, spec.width);
    return {
      data: finished.data,
      mediaType: finished.mediaType,
      template: spec.template,
      format: spec.format,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      seconds: spec.duration,
      frames: Math.round(spec.duration * spec.fps),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Lay a voice-over under the animation.
 */
async function muxAudio(options, directory, videoPath, video, audio) {
  if (audio === undefined || audio?.data === undefined) {
    return { data: video, mediaType: 'video/mp4' };
  }
  const ffmpeg = await resolveFfmpeg(options);
  const extension = audio.extension === 'mp3' ? 'mp3' : 'wav';
  const audioPath = join(directory, `voice.${extension}`);
  await writeFile(audioPath, audio.data);
  const outputPath = join(directory, `narrated.${FORMAT_EXTENSIONS.mp4}`);
  const run = await runProcess(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-shortest',
    outputPath,
  ], { timeoutMs: options.video?.timeoutMs ?? 300000 });
  if (run.code !== 0) {
    throw new Error(`音声の合成に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return { data: new Uint8Array(await readFile(outputPath)), mediaType: 'video/mp4' };
}

/**
 * Convert the encoded MP4 into the requested container.
 */
async function convertFormat(options, directory, videoPath, video, format, width) {
  if (format === 'mp4') {
    return { data: video.data, mediaType: FORMAT_MEDIA_TYPES.mp4 };
  }
  const ffmpeg = await resolveFfmpeg(options);
  if (format === 'webm') {
    const outputPath = join(directory, 'output.webm');
    const run = await runProcess(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-i', videoPath,
      '-c:v', 'libvpx-vp9',
      '-b:v', '1M',
      '-cpu-used', '4',
      '-row-mt', '1',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ], { timeoutMs: options.video?.timeoutMs ?? 600000 });
    if (run.code !== 0) {
      throw new Error(`WebM への変換に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
    }
    return { data: new Uint8Array(await readFile(outputPath)), mediaType: FORMAT_MEDIA_TYPES.webm };
  }

  // GIF: a smaller frame rate and a palette keeps the file small.
  const outputPath = join(directory, 'output.gif');
  const filter = [
    'fps=15',
    `scale=${Math.min(width, 480)}:-1:flags=lanczos`,
    'split[a][b]',
    '[a]palettegen=max_colors=128[p]',
    '[b][p]paletteuse=dither=bayer:bayer_scale=3',
  ].join(',');
  const run = await runProcess(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', videoPath,
    '-filter_complex', filter,
    '-loop', '0',
    outputPath,
  ], { timeoutMs: options.video?.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`GIF への変換に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return { data: new Uint8Array(await readFile(outputPath)), mediaType: FORMAT_MEDIA_TYPES.gif };
}

/** The first meaningful line of a process log. */
function firstLine(text) {
  if (typeof text !== 'string') return undefined;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('WARNING')) return trimmed;
  }
  return undefined;
}
