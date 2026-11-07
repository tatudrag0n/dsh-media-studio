/**
 * Production core for the Media Studio plugin.
 *
 * A production is not a generated clip: it is an edit. The user drops
 * materials into the library, lays out a sequence of scenes, and the plugin
 * cuts them into one finished video with transitions, a voice-over and a
 * music bed.
 *
 *   1. `parseProductionSpec` reads the request into one normalized spec.
 *   2. `renderProduction` renders every scene into a segment:
 *        - a template scene is drawn frame by frame by the motion renderer,
 *        - a picture scene becomes a slow Ken Burns move,
 *        - a clip scene is trimmed and scaled to the canvas.
 *   3. The segments are joined with the transition the user chose, the
 *      voice-over and the music are mixed in, and the result is written.
 *
 * Everything runs locally: Python draws, ffmpeg cuts.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeFrames, resolveFfmpeg, resolvePython, runProcess } from './video.js';

import { MOTION_STYLES, MOTION_TEMPLATES } from './motion.js';

/** The kinds of scene a production can hold. */
export const PRODUCTION_SCENE_TYPES = ['template', 'image', 'clip'];

/** How one scene hands over to the next. */
export const PRODUCTION_TRANSITIONS = ['cut', 'fade'];

/** The containers a production can be written in. */
export const PRODUCTION_FORMATS = ['mp4', 'webm'];

/** Default canvas of a production. */
export const DEFAULT_PRODUCTION_WIDTH = 1280;

/** Default canvas height. */
export const DEFAULT_PRODUCTION_HEIGHT = 720;

/** Default frame rate. */
export const DEFAULT_PRODUCTION_FPS = 30;

/** Default length of one scene, in seconds. */
export const DEFAULT_SCENE_SECONDS = 3;

/** Most scenes one production can hold. */
export const MAX_PRODUCTION_SCENES = 12;

/** Longest production, in seconds. */
export const MAX_PRODUCTION_SECONDS = 180;

/** Longest one scene can last, in seconds. */
export const MAX_SCENE_SECONDS = 30;

/** How long a cross dissolve lasts, in seconds. */
export const FADE_SECONDS = 0.5;

/** Media type per container format. */
const FORMAT_MEDIA_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** File extension per container format. */
const FORMAT_EXTENSIONS = {
  mp4: 'mp4',
  webm: 'webm',
};

/**
 * Read a production request into one normalized spec.
 */
export function parseProductionSpec(input) {
  const width = clampSize(input.width, DEFAULT_PRODUCTION_WIDTH);
  const height = clampSize(input.height, DEFAULT_PRODUCTION_HEIGHT);
  const fps = clampFps(input.fps);
  const format = PRODUCTION_FORMATS.includes(input.format) ? input.format : 'mp4';
  const style = MOTION_STYLES.includes(input.style) ? input.style : 'smooth';

  const rawScenes = Array.isArray(input.scenes) ? input.scenes : [];
  if (rawScenes.length === 0) {
    throw new Error('シーンが 1 つもありません。Add at least one scene.');
  }
  if (rawScenes.length > MAX_PRODUCTION_SCENES) {
    throw new Error(`シーンは最大 ${MAX_PRODUCTION_SCENES} 個までです。Too many scenes.`);
  }

  const scenes = rawScenes.map((scene, index) => parseScene(scene, index, { width, height, fps, style }));
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (total > MAX_PRODUCTION_SECONDS) {
    throw new Error(`合計が長すぎます (${Math.round(total)} 秒)。上限は ${MAX_PRODUCTION_SECONDS} 秒です。`);
  }

  return {
    width,
    height,
    fps,
    format,
    style,
    scenes,
    seconds: Math.round(total * 100) / 100,
    seed: Number.isFinite(Number(input.seed)) ? Math.abs(Math.trunc(Number(input.seed))) || 1 : 1,
  };
}

/** Read one scene of a production. */
function parseScene(scene, index, context) {
  const type = PRODUCTION_SCENE_TYPES.includes(scene?.type) ? scene.type : 'template';
  const duration = clampSeconds(scene?.duration, DEFAULT_SCENE_SECONDS);
  const transition = PRODUCTION_TRANSITIONS.includes(scene?.transition) ? scene.transition : 'cut';

  if (type === 'template') {
    const template = MOTION_TEMPLATES.includes(scene?.template) ? scene.template : 'title';
    const text = clip(scene?.text, 300);
    if (template !== 'shapes' && template !== 'stinger' && text === '') {
      throw new Error(`シーン ${index + 1}: ${template} には text が必要です。Scene ${index + 1} needs text.`);
    }
    const chart = readChart(scene?.chart);
    if (template === 'chart' && chart === undefined) {
      throw new Error(`シーン ${index + 1}: グラフには labels と series が必要です。Scene ${index + 1} needs chart data.`);
    }
    return {
      index,
      type,
      template,
      text,
      subtitle: clip(scene?.subtitle, 200),
      duration,
      transition,
      style: MOTION_STYLES.includes(scene?.style) ? scene.style : context.style,
      seed: Number.isFinite(Number(scene?.seed)) ? Math.abs(Math.trunc(Number(scene?.seed))) || context.seed : context.seed,
      colors: readColors(scene),
      chart,
      backgroundImageId: clip(scene?.backgroundImageId, 80),
      logoId: clip(scene?.logoId, 80),
    };
  }

  const materialId = clip(scene?.materialId, 80);
  if (materialId === '') {
    throw new Error(`シーン ${index + 1}: ${type} には素材が必要です。Scene ${index + 1} needs a material.`);
  }
  return {
    index,
    type,
    materialId,
    duration,
    transition,
    text: clip(scene?.text, 300),
    subtitle: clip(scene?.subtitle, 200),
  };
}

/** Read the chart data of a scene. */
function readChart(chart) {
  if (chart === undefined || chart === null) return undefined;
  const labels = Array.isArray(chart.labels) ? chart.labels.map((entry) => String(entry)) : [];
  const series = Array.isArray(chart.series)
    ? chart.series.map((entry, index) => ({
      name: String(entry?.name ?? `Series ${index + 1}`),
      values: Array.isArray(entry?.values) ? entry.values.map((value) => toNumber(value)) : [],
    }))
    : [];
  if (labels.length === 0 || series.length === 0) return undefined;
  return {
    type: ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked'].includes(chart.type) ? chart.type : 'bar',
    labels,
    series: series.map((entry) => ({
      name: entry.name,
      values: labels.map((_label, position) => (Number.isFinite(entry.values[position]) ? entry.values[position] : 0)),
    })),
  };
}

/** Read the colour choices of a scene. */
function readColors(scene) {
  const colors = {};
  const background = color(scene?.background);
  const foreground = color(scene?.foreground);
  const accent = color(scene?.accent);
  if (background !== undefined) colors.background = background;
  if (foreground !== undefined) colors.foreground = foreground;
  if (accent !== undefined) colors.accent = accent;
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
  if (!Number.isFinite(number)) return DEFAULT_PRODUCTION_FPS;
  return Math.min(60, Math.max(12, Math.round(number)));
}

/** Keep one scene inside sane bounds. */
function clampSeconds(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_SCENE_SECONDS, Math.max(0.5, Math.round(number * 100) / 100));
}

/** Read one number. */
function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Produce the finished production.
 *
 * `extras.assets` maps a material id to its absolute path, `extras.audio` is
 * the voice-over and `extras.music` the path of a music bed.
 */
export async function renderProduction(options, spec, extras = {}) {
  const resolved = {
    video: {
      pythonPath: options.production?.pythonPath ?? options.motion?.pythonPath ?? options.graphics?.pythonPath ?? options.video?.pythonPath,
      ffmpegPath: options.production?.ffmpegPath ?? options.motion?.ffmpegPath ?? options.graphics?.ffmpegPath ?? options.video?.ffmpegPath,
      timeoutMs: options.production?.timeoutMs ?? options.motion?.timeoutMs ?? options.video?.timeoutMs,
    },
  };
  const ffmpeg = await resolveFfmpeg(resolved);
  const assets = extras.assets ?? {};
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-production-'));
  try {
    const segments = [];
    for (const scene of spec.scenes) {
      segments.push(await renderScene(resolved, ffmpeg, spec, scene, directory, assets));
    }

    const joined = await joinSegments(resolved, ffmpeg, segments, directory);
    const total = await probeDuration(ffmpeg, joined) ?? spec.seconds;
    const finished = await mixAudio(resolved, ffmpeg, joined, directory, total, extras);
    const converted = await convertFormat(resolved, ffmpeg, finished, join(directory, `production.${FORMAT_EXTENSIONS[spec.format]}`), spec.format);
    const data = new Uint8Array(await readFile(converted));
    if (data.byteLength === 0) throw new Error('ffmpeg が空のファイルを書き出しました。');
    return {
      data,
      mediaType: FORMAT_MEDIA_TYPES[spec.format],
      format: spec.format,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      seconds: Math.round(total * 100) / 100,
      scenes: spec.scenes.length,
      narrated: extras.audio !== undefined,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Render one scene into a segment file. */
async function renderScene(resolved, ffmpeg, spec, scene, directory, assets) {
  if (scene.type === 'template') {
    return renderTemplateScene(resolved, spec, scene, directory, assets);
  }
  if (scene.type === 'image') {
    return renderImageScene(resolved, ffmpeg, spec, scene, directory, assets);
  }
  return renderClipScene(resolved, ffmpeg, spec, scene, directory, assets);
}

/** Draw a template scene with the motion renderer, then encode it. */
async function renderTemplateScene(resolved, spec, scene, directory, assets) {
  const python = await resolvePython(resolved, ['PIL']);
  const script = fileURLToPath(new URL('./motion_render.py', import.meta.url));
  const framesDirectory = join(directory, `scene-${scene.index}`);
  const specPath = join(directory, `scene-${scene.index}.json`);
  const motionSpec = {
    template: scene.template,
    style: scene.style,
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    duration: scene.duration,
    text: scene.text,
    subtitle: scene.subtitle,
    seed: scene.seed,
    colors: scene.colors,
    ...(scene.chart === undefined ? {} : { chart: scene.chart }),
  };
  const backgroundImage = resolveAsset(assets, scene.backgroundImageId);
  if (backgroundImage !== undefined) motionSpec.backgroundImage = backgroundImage;
  const logo = resolveAsset(assets, scene.logoId);
  if (logo !== undefined) motionSpec.logo = logo;

  await writeFile(specPath, JSON.stringify(motionSpec), 'utf8');
  const run = await runProcess(python, [script, '--spec', specPath, '--out', framesDirectory], {
    timeoutMs: resolved.video.timeoutMs ?? 300000,
  });
  if (run.code !== 0) {
    throw new Error(`シーン ${scene.index + 1} の描画に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  await encodeFrames(resolved, {
    directory: framesDirectory,
    fps: spec.fps,
    width: spec.width,
    height: spec.height,
  });
  // encodeFrames writes its MP4 inside the frame directory.
  return { path: join(framesDirectory, 'output.mp4'), transition: scene.transition };
}

/** Turn a picture into a slow move, the way an editor holds a still. */
async function renderImageScene(resolved, ffmpeg, spec, scene, directory, assets) {
  const source = resolveAsset(assets, scene.materialId);
  if (source === undefined) throw new Error(`シーン ${scene.index + 1}: 素材が見つかりません (${scene.materialId})。`);
  const target = join(directory, `scene-${scene.index}.mp4`);
  const frames = Math.max(1, Math.round(scene.duration * spec.fps));
  const filter = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase:out_range=tv`,
    `crop=${spec.width}:${spec.height}`,
    `zoompan=z='min(zoom+0.0006,1.25)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${spec.width}x${spec.height}:fps=${spec.fps}`,
    'format=yuv420p',
  ].join(',');
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-loop', '1',
    '-i', source,
    '-vf', filter,
    '-t', String(scene.duration),
    '-frames:v', String(frames),
    '-r', String(spec.fps),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    target,
  ], { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`シーン ${scene.index + 1} の書き出しに失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return { path: target, transition: scene.transition };
}

/** Trim and scale a recorded clip to the canvas. */
async function renderClipScene(resolved, ffmpeg, spec, scene, directory, assets) {
  const source = resolveAsset(assets, scene.materialId);
  if (source === undefined) throw new Error(`シーン ${scene.index + 1}: 素材が見つかりません (${scene.materialId})。`);
  const target = join(directory, `scene-${scene.index}.mp4`);
  const filter = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease:out_range=tv`,
    `pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${spec.fps}`,
    'format=yuv420p',
  ].join(',');
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-i', source,
    '-vf', filter,
    '-t', String(scene.duration),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    target,
  ], { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`シーン ${scene.index + 1} の書き出しに失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return { path: target, transition: scene.transition };
}

/**
 * Join the segments with the transitions the user chose.
 *
 * Scenes that hand over with a cut stay in separate groups; scenes that
 * dissolve are merged with the ffmpeg `xfade` filter. The groups are then
 * concatenated.
 */
async function joinSegments(resolved, ffmpeg, segments, directory) {
  if (segments.length === 1) return segments[0].path;

  const groups = [];
  let current = [segments[0]];
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index - 1].transition === 'fade') {
      current.push(segments[index]);
    } else {
      groups.push(current);
      current = [segments[index]];
    }
  }
  groups.push(current);

  const groupFiles = [];
  for (const [index, group] of groups.entries()) {
    if (group.length === 1) {
      groupFiles.push(group[0].path);
      continue;
    }
    const target = join(directory, `group-${index}.mp4`);
    await crossfadeGroup(resolved, ffmpeg, group, target);
    groupFiles.push(target);
  }

  if (groupFiles.length === 1) return groupFiles[0];
  const joined = join(directory, 'joined.mp4');
  await concatFiles(resolved, ffmpeg, groupFiles, joined);
  return joined;
}

/** Merge a group of segments with cross dissolves. */
async function crossfadeGroup(resolved, ffmpeg, group, target) {
  const durations = [];
  for (const segment of group) {
    durations.push(await probeDuration(ffmpeg, segment.path) ?? 0);
  }
  const shortest = Math.min(...durations.filter((value) => value > 0));
  const fade = Math.max(0.1, Math.min(FADE_SECONDS, shortest / 2));
  const steps = [];
  // The first input of a merge is everything before it, minus the dissolve.
  let accumulated = durations[0] ?? 0;
  for (let index = 1; index < group.length; index += 1) {
    const offset = Math.max(0, accumulated - fade);
    // The first input of a merge is everything before it, minus the dissolve.
    const head = index === 1 ? '0:v' : `v${index - 1}`;
    steps.push(`[${head}][${index}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[v${index}]`);
    accumulated += (durations[index] ?? 0) - fade;
  }
  const args = ['-y', '-loglevel', 'error'];
  group.forEach((segment) => args.push('-i', segment.path));
  args.push(
    '-filter_complex', `${steps.join(';')}`,
    '-map', `[v${group.length - 1}]`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    target,
  );
  const run = await runProcess(ffmpeg, args, { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`つなぎ合わせに失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
}

/** Concatenate the groups without re-encoding. */
async function concatFiles(resolved, ffmpeg, files, target) {
  const listPath = join(dirname(target), 'concat.txt');
  const list = files.map((file) => `file '${file.replace(/'/gu, "'\\''")}'`).join('\n');
  await writeFile(listPath, list, 'utf8');
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    target,
  ], { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`連結に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
}

/** Mix the voice-over and the music bed into the picture. */
async function mixAudio(resolved, ffmpeg, videoPath, directory, totalSeconds, extras) {
  const narration = extras.audio?.data;
  const music = extras.music;
  if ((narration === undefined || narration === null) && (music === undefined || music === null)) {
    return videoPath;
  }

  const inputs = [];
  const filters = [];
  const sources = [];
  let index = 1;
  if (narration !== undefined && narration !== null) {
    const narrationPath = join(directory, 'narration.' + (extras.audio.extension === 'mp3' ? 'mp3' : 'wav'));
    await writeFile(narrationPath, narration);
    inputs.push('-i', narrationPath);
    sources.push(`${index}:a`);
    index += 1;
  }
  if (music !== undefined && music !== null) {
    inputs.push('-i', music);
    sources.push(`${index}:a`);
    index += 1;
  }

  if (sources.length === 1) {
    filters.push(`[${sources[0]}]apad[a]`);
  } else {
    // The voice-over stays in front; the music bed sits under it.
    filters.push(`[${sources[0]}][${sources[1]}]amix=inputs=2:duration=longest:weights='1 0.4',apad[a]`);
  }

  const target = join(directory, 'with-audio.mp4');
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-i', videoPath,
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-t', String(Math.max(0.1, totalSeconds)),
    '-movflags', '+faststart',
    target,
  ], { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`音声のミックスに失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return target;
}

/** Write the production in the container the user asked for. */
async function convertFormat(resolved, ffmpeg, source, target, format) {
  if (format === 'mp4') {
    if (source !== target) {
      await writeFile(target, await readFile(source));
    }
    return target;
  }
  const run = await runProcess(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-i', source,
    '-c:v', 'libvpx-vp9',
    '-b:v', '1M',
    '-cpu-used', '4',
    '-row-mt', '1',
    '-pix_fmt', 'yuv420p',
    target,
  ], { timeoutMs: resolved.video.timeoutMs ?? 600000 });
  if (run.code !== 0) {
    throw new Error(`書き出しに失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
  }
  return target;
}

/** Ask ffmpeg how long a file is. */
export async function probeDuration(ffmpeg, path) {
  const run = await runProcess(ffmpeg, ['-hide_banner', '-i', path], { timeoutMs: 120000 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(String(run.stderr ?? ''));
  if (match === null) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** The path of a material, when the library knows it. */
function resolveAsset(assets, id) {
  if (typeof id !== 'string' || id === '') return undefined;
  const value = assets[id];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The first line of an error message that says something. */
function firstLine(text) {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  return lines.find((line) => !line.startsWith('[')) ?? lines[0];
}
