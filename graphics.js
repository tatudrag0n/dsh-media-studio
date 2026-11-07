/**
 * Graphics core for the Media Studio plugin.
 *
 * Two jobs, both deterministic and offline:
 *
 *   - `renderChart` turns data into a finished PNG: bars, lines, areas, pie
 *     and donut charts, horizontal bars, stacked bars, and scatter plots. The
 *     drawing happens in the bundled Python renderer (`graphics_render.py`),
 *     which uses Pillow only. No model, no API key, no GPU: a chart costs
 *     about a second.
 *   - `editImage` resizes, rotates, flips, recolours, and converts an existing
 *     picture with ffmpeg, which the plugin already needs for video.
 *
 * The module is dependency-free on purpose: it runs inside the Harness Host.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFfmpeg, resolvePython, runProcess } from './video.js';

/** Chart kinds the renderer knows. */
export const CHART_TYPES = ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked'];

/** Colour themes the renderer knows. */
export const CHART_THEMES = ['light', 'dark'];

/** Output formats the image editor can write. */
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];

/** Default canvas of a chart. */
export const DEFAULT_CHART_WIDTH = 1200;

/** Default canvas height of a chart. */
export const DEFAULT_CHART_HEIGHT = 675;

/** Longest data text one chart request accepts. */
export const DEFAULT_MAX_CHART_DATA = 20000;

/** Longest chart title one request accepts. */
export const DEFAULT_MAX_CHART_TITLE = 200;

/** Media type per output format. */
const FORMAT_MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** File extension per output format. */
const FORMAT_EXTENSIONS = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

/** Picture extensions the image editor accepts. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

/**
 * Read a chart request into one normalized spec.
 *
 * The request may be structured (labels plus series) or a raw data block:
 * JSON, CSV, or TSV. The raw form is what the panel sends; the structured
 * form is what an agent sends.
 */
export function parseChartSpec(input) {
  const type = CHART_TYPES.includes(input.type) ? input.type : 'bar';
  const theme = CHART_THEMES.includes(input.theme) ? input.theme : 'light';
  const title = clip(input.title, DEFAULT_MAX_CHART_TITLE);
  const subtitle = clip(input.subtitle, DEFAULT_MAX_CHART_TITLE);
  const unit = clip(input.unit, 40);
  const width = clampSize(input.width, DEFAULT_CHART_WIDTH);
  const height = clampSize(input.height, DEFAULT_CHART_HEIGHT);

  let parsed = structuredChart(input);
  if (parsed === undefined) {
    if (Array.isArray(input.labels) && input.series === undefined) {
      throw new Error('グラフに系列がありません。series に値を追加してください。');
    }
    const raw = typeof input.data === 'string' ? input.data.trim() : '';
    if (raw === '') throw new Error('グラフのデータがありません。labels と series、または CSV / TSV / JSON のデータを渡してください。');
    parsed = parseRawData(raw);
  }

  if (parsed.labels.length === 0) throw new Error('グラフにラベルがありません。');
  if (parsed.series.length === 0) throw new Error('グラフに系列がありません。');

  // Every series needs one value per label.
  const series = parsed.series.map((entry) => {
    const values = [];
    for (let index = 0; index < parsed.labels.length; index += 1) {
      const value = entry.values[index];
      values.push(Number.isFinite(value) ? value : 0);
    }
    return { name: entry.name, values };
  });

  return { type, theme, title, subtitle, unit, width, height, labels: parsed.labels, series };
}

/** Read the structured form, when the request carries one. */
function structuredChart(input) {
  const labels = Array.isArray(input.labels) ? input.labels.map((entry) => String(entry)) : undefined;
  const series = Array.isArray(input.series) ? input.series : undefined;
  if (labels === undefined || series === undefined) return undefined;
  const normalized = series.map((entry, index) => ({
    name: String(entry?.name ?? `Series ${index + 1}`),
    values: Array.isArray(entry?.values) ? entry.values.map((value) => toNumber(value)) : [],
  }));
  return { labels, series: normalized };
}

/** Read a JSON, CSV, or TSV data block. */
function parseRawData(raw) {
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return parseJsonData(JSON.parse(raw));
    } catch {
      // Not JSON after all: fall through to the delimited reader.
    }
  }
  return parseDelimitedData(raw);
}

/** Read a JSON data block. */
function parseJsonData(value) {
  if (Array.isArray(value)) {
    // [{ "label": "A", "value": 1 }, …]
    if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'label' in value[0]) {
      return {
        labels: value.map((entry) => String(entry.label)),
        series: [{ name: 'value', values: value.map((entry) => toNumber(entry.value)) }],
      };
    }
    // [1, 2, 3]
    if (value.every((entry) => typeof entry === 'number')) {
      return { labels: value.map((_entry, index) => String(index + 1)), series: [{ name: 'value', values: value }] };
    }
    throw new Error('JSON の形式を解釈できません。labels と series のオブジェクトか、{ label, value } の配列にしてください。');
  }
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.labels) && Array.isArray(value.series)) {
      return {
        labels: value.labels.map((entry) => String(entry)),
        series: value.series.map((entry, index) => ({
          name: String(entry?.name ?? `Series ${index + 1}`),
          values: Array.isArray(entry?.values) ? entry.values.map((item) => toNumber(item)) : [],
        })),
      };
    }
    // { "A": 1, "B": 2 }
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([, item]) => typeof item === 'number')) {
      return {
        labels: entries.map(([key]) => key),
        series: [{ name: 'value', values: entries.map(([, item]) => item) }],
      };
    }
  }
  throw new Error('JSON の形式を解釈できません。labels と series のオブジェクトか、{ label, value } の配列にしてください。');
}

/** Read a CSV or TSV data block, with or without a header row. */
function parseDelimitedData(raw) {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('グラフのデータが空です。');
  const separator = lines.some((line) => line.includes('\t')) ? '\t' : ',';
  const rows = lines.map((line) => line.split(separator).map((cell) => stripQuotes(cell.trim())));

  const header = rows[0];
  const hasHeader = header.length >= 2 && !header.slice(1).every((cell) => isNumber(cell));
  const body = hasHeader ? rows.slice(1) : rows;
  if (body.length === 0) throw new Error('グラフにデータ行がありません。');

  const labels = body.map((row) => String(row[0] ?? ''));
  const seriesCount = Math.max(...body.map((row) => Math.max(0, row.length - 1)));
  const series = [];
  for (let index = 0; index < seriesCount; index += 1) {
    series.push({
      name: hasHeader ? String(header[index + 1] ?? `Series ${index + 1}`) : (index === 0 ? 'value' : `Series ${index + 1}`),
      values: body.map((row) => toNumber(row[index + 1])),
    });
  }
  return { labels, series };
}

/** Read one number, tolerating thousands separators and percent signs. */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').replace(/[%,\s]/gu, '');
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True when the cell reads as a number. */
function isNumber(value) {
  const text = String(value ?? '').replace(/[%,\s]/gu, '');
  return text !== '' && Number.isFinite(Number.parseFloat(text));
}

/** Remove one pair of surrounding quotes. */
function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Trim and cut a text to a limit. */
function clip(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= limit ? text : text.slice(0, limit);
}

/** Keep a canvas dimension inside sane bounds. */
function clampSize(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(4000, Math.max(240, Math.round(number)));
}

/**
 * Render one chart and return the PNG bytes.
 */
export async function renderChart(options, spec) {
  const python = await resolvePython(
    { video: { pythonPath: options.graphics?.pythonPath ?? options.video?.pythonPath } },
    ['PIL'],
  );
  const script = fileURLToPath(new URL('./graphics_render.py', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-chart-'));
  try {
    const specPath = join(directory, 'spec.json');
    const outputPath = join(directory, 'chart.png');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const run = await runProcess(python, [script, '--spec', specPath, '--out', outputPath], {
      timeoutMs: options.graphics?.timeoutMs ?? 120000,
    });
    if (run.code !== 0) {
      throw new Error(`グラフの描画に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
    }
    const data = new Uint8Array(await readFile(outputPath));
    if (data.byteLength === 0) throw new Error('グラフの描画が空でした。');
    return {
      data,
      mediaType: 'image/png',
      width: spec.width,
      height: spec.height,
      type: spec.type,
      labels: spec.labels.length,
      series: spec.series.length,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resize, rotate, flip, or convert one picture with ffmpeg.
 */
export async function editImage(options, input) {
  const source = input.path;
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('対象の画像パスを指定してください。');
  }
  if (!existsSync(source)) throw new Error(`画像が見つかりません: ${source}`);
  if (!IMAGE_EXTENSIONS.has(extname(source).toLowerCase())) {
    throw new Error(`対応していない画像形式です: ${extname(source) || source}`);
  }

  const format = IMAGE_FORMATS.includes(input.format) ? input.format : 'png';
  const width = Number.isFinite(input.width) && input.width > 0 ? Math.round(input.width) : undefined;
  const height = Number.isFinite(input.height) && input.height > 0 ? Math.round(input.height) : undefined;
  const rotate = [0, 90, 180, 270].includes(Number(input.rotate)) ? Number(input.rotate) : 0;
  const flip = input.flip === 'h' || input.flip === 'v' ? input.flip : undefined;
  const grayscale = input.grayscale === true;

  const filters = [];
  if (rotate === 90) filters.push('transpose=1');
  if (rotate === 180) filters.push('transpose=1,transpose=1');
  if (rotate === 270) filters.push('transpose=2');
  if (flip === 'h') filters.push('hflip');
  if (flip === 'v') filters.push('vflip');
  if (width !== undefined && height !== undefined) {
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${cleanColor(input.background)}`);
  } else if (width !== undefined) {
    filters.push(`scale=${width}:-2`);
  } else if (height !== undefined) {
    filters.push(`scale=-2:${height}`);
  }
  if (grayscale) filters.push('format=gray');

  const ffmpeg = await resolveFfmpeg({
    video: { ffmpegPath: options.graphics?.ffmpegPath ?? options.video?.ffmpegPath },
  });
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-edit-'));
  try {
    const outputPath = join(directory, `output.${FORMAT_EXTENSIONS[format]}`);
    const args = ['-y', '-loglevel', 'error', '-i', source];
    if (filters.length > 0) args.push('-vf', filters.join(','));
    if (format === 'png') {
      args.push('-c:v', 'png');
    } else if (format === 'jpeg') {
      args.push('-c:v', 'mjpeg', '-q:v', String(qualityValue(input.quality)));
    } else {
      args.push('-c:v', 'libwebp', '-quality', String(qualityValue(input.quality, 80)));
    }
    args.push(outputPath);
    const run = await runProcess(ffmpeg, args, { timeoutMs: options.graphics?.timeoutMs ?? 120000 });
    if (run.code !== 0) {
      throw new Error(`画像の加工に失敗しました (exit ${run.code}): ${firstLine(run.stderr) ?? run.stderr.trim()}`);
    }
    const data = new Uint8Array(await readFile(outputPath));
    if (data.byteLength === 0) throw new Error('画像の書き出しが空でした。');
    const size = await readSize(ffmpeg, outputPath);
    return {
      data,
      mediaType: FORMAT_MEDIA_TYPES[format],
      format,
      width: size?.width,
      height: size?.height,
      name: basename(source),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read the pixel size of a written picture.
 *
 * ffmpeg prints the stream size on its log, so one probe run is enough; the
 * exit code is non-zero because the probe writes no output file.
 */
async function readSize(ffmpeg, path) {
  try {
    const run = await runProcess(ffmpeg, ['-hide_banner', '-i', path], { timeoutMs: 30000 });
    const match = /\b(\d{2,5})x(\d{2,5})\b/u.exec(run.stderr ?? '');
    if (match === null) return undefined;
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/** Map a 1-100 quality request onto the encoder scale. */
function qualityValue(value, fallback = 90) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(100, Math.max(1, Math.round(number)));
  return fallback === 80 ? clamped : Math.max(2, Math.round((100 - clamped) * 0.29) + 2);
}

/** Keep only characters ffmpeg's color parser accepts. */
function cleanColor(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'white';
  const text = value.trim();
  if (/^#[0-9a-fA-F]{6}$/u.test(text)) return text;
  if (/^[a-zA-Z]+$/u.test(text)) return text;
  return 'white';
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
