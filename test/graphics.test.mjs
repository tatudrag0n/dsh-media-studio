import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePython, runProcess } from '../video.js';
import {
  CHART_THEMES,
  CHART_TYPES,
  DEFAULT_CHART_HEIGHT,
  DEFAULT_CHART_WIDTH,
  IMAGE_FORMATS,
  editImage,
  parseChartSpec,
  renderChart,
} from '../graphics.js';

const OPTIONS = {
  video: { pythonPath: undefined, ffmpegPath: 'C:\\ProgramData\\ffmpeg.exe' },
  graphics: { pythonPath: undefined, ffmpegPath: 'C:\\ProgramData\\ffmpeg.exe', theme: 'light', width: DEFAULT_CHART_WIDTH, height: DEFAULT_CHART_HEIGHT, timeoutMs: 120000 },
};

/** True when this machine can draw charts. */
function hasPython() {
  return process.platform === 'win32';
}

test('the chart table and the format table stay in step', () => {
  assert.ok(CHART_TYPES.includes('bar'));
  assert.ok(CHART_TYPES.includes('donut'));
  assert.ok(CHART_TYPES.includes('stacked'));
  assert.deepEqual(CHART_THEMES, ['light', 'dark']);
  assert.deepEqual(IMAGE_FORMATS, ['png', 'jpeg', 'webp']);
});

test('parseChartSpec reads the structured form', () => {
  const spec = parseChartSpec({
    type: 'line',
    title: 'Sales',
    labels: ['Jan', 'Feb'],
    series: [{ name: 'Revenue', values: [10, 20] }],
  });
  assert.equal(spec.type, 'line');
  assert.equal(spec.title, 'Sales');
  assert.deepEqual(spec.labels, ['Jan', 'Feb']);
  assert.equal(spec.series.length, 1);
  assert.deepEqual(spec.series[0].values, [10, 20]);
  assert.equal(spec.width, DEFAULT_CHART_WIDTH);
  assert.equal(spec.height, DEFAULT_CHART_HEIGHT);
});

test('parseChartSpec reads a CSV block with a header row', () => {
  const spec = parseChartSpec({ type: 'bar', data: 'month,sales,cost\nJan,120,90\nFeb,148,95' });
  assert.deepEqual(spec.labels, ['Jan', 'Feb']);
  assert.equal(spec.series.length, 2);
  assert.equal(spec.series[0].name, 'sales');
  assert.deepEqual(spec.series[0].values, [120, 148]);
  assert.deepEqual(spec.series[1].values, [90, 95]);
});

test('parseChartSpec reads a TSV block without a header row', () => {
  const spec = parseChartSpec({ data: 'Jan\t12\nFeb\t15\nMar\t9' });
  assert.deepEqual(spec.labels, ['Jan', 'Feb', 'Mar']);
  assert.equal(spec.series.length, 1);
  assert.deepEqual(spec.series[0].values, [12, 15, 9]);
});

test('parseChartSpec reads JSON blocks in three shapes', () => {
  const wide = parseChartSpec({ data: JSON.stringify({ labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] }) });
  assert.deepEqual(wide.labels, ['a', 'b']);
  assert.deepEqual(wide.series[0].values, [1, 2]);

  const rows = parseChartSpec({ data: JSON.stringify([{ label: 'a', value: 3 }]) });
  assert.deepEqual(rows.labels, ['a']);
  assert.deepEqual(rows.series[0].values, [3]);

  const map = parseChartSpec({ data: JSON.stringify({ a: 4, b: 6 }) });
  assert.deepEqual(map.labels, ['a', 'b']);
  assert.deepEqual(map.series[0].values, [4, 6]);
});

test('parseChartSpec pads short rows and refuses empty data', () => {
  const spec = parseChartSpec({ data: 'a,1\nb' });
  assert.deepEqual(spec.series[0].values, [1, 0]);
  assert.throws(() => parseChartSpec({ data: '   ' }), /データ/);
  assert.throws(() => parseChartSpec({ labels: ['a'] }), /系列/);
});

test('parseChartSpec falls back to the default theme and type', () => {
  const spec = parseChartSpec({ type: 'nope', theme: 'nope', labels: ['a'], series: [{ values: [1] }] });
  assert.equal(spec.type, 'bar');
  assert.equal(spec.theme, 'light');
});

test('the chart renderer really draws a PNG', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const spec = parseChartSpec({
    type: 'bar',
    title: '月別売上',
    labels: ['1月', '2月', '3月'],
    series: [{ name: '売上', values: [120, 148, 131] }],
    width: 600,
    height: 400,
  });
  const result = await renderChart(OPTIONS, spec);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.width, 600);
  assert.equal(result.height, 400);
  assert.equal(result.labels, 3);
  assert.equal(result.series, 1);
  assert.ok(result.data.byteLength > 2000);
  // PNG signature.
  assert.deepEqual([...result.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('the drawn bars are proportional to the values', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const spec = parseChartSpec({
    type: 'bar',
    labels: ['a', 'b', 'c', 'd'],
    series: [{ name: 's', values: [120, 148, 131, 175] }],
    width: 800,
    height: 500,
  });
  const result = await renderChart(OPTIONS, spec);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-graphics-measure-'));
  try {
    const path = join(directory, 'chart.png');
    await writeFile(path, result.data);
    const python = await resolvePython({ video: { pythonPath: undefined } }, ['PIL']);
    // Measure the palette-coloured bars: one run per bar, one height per run.
    const script = [
      'import json, sys',
      'from PIL import Image',
      'image = Image.open(sys.argv[1]).convert("RGB")',
      'width, height = image.size',
      'pixels = image.load()',
      'target = (37, 99, 235)',
      'def is_bar(x, y):',
      '    colour = pixels[x, y]',
      '    return all(abs(colour[i] - target[i]) <= 8 for i in range(3))',
      'columns = [any(is_bar(x, y) for y in range(0, height, 2)) for x in range(width)]',
      'runs = []',
      'start = None',
      'for x, filled in enumerate(columns):',
      '    if filled and start is None:',
      '        start = x',
      '    elif not filled and start is not None:',
      '        runs.append((start, x - 1))',
      '        start = None',
      'if start is not None:',
      '    runs.append((start, width - 1))',
      'heights = []',
      'for left, right in runs:',
      '    top = None',
      '    bottom = None',
      '    for y in range(height):',
      '        if any(is_bar(x, y) for x in range(left, right + 1)):',
      '            if top is None:',
      '                top = y',
      '            bottom = y',
      '    if top is not None and bottom is not None:',
      '        heights.append(bottom - top + 1)',
      'print(json.dumps(heights))',
    ].join('\n');
    const run = await runProcess(python, ['-c', script, path], { timeoutMs: 60000 });
    assert.equal(run.code, 0, run.stderr);
    const heights = JSON.parse(String(run.stdout).trim());
    assert.equal(heights.length, 4, 'the chart must hold one bar per label');
    const values = [120, 148, 131, 175];
    const ratios = heights.map((value, index) => value / values[index]);
    const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    for (const ratio of ratios) {
      assert.ok(Math.abs(ratio - mean) / mean < 0.06, `the bars must be proportional: ${JSON.stringify(ratios)}`);
    }
    assert.ok(heights[3] > heights[0], 'the tallest value must draw the tallest bar');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every chart type draws a picture with something on it', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const python = await resolvePython({ video: { pythonPath: undefined } }, ['PIL']);
  const script = [
    'import json, sys',
    'from PIL import Image',
    'image = Image.open(sys.argv[1]).convert("RGB")',
    'width, height = image.size',
    'pixels = image.load()',
    'background = pixels[2, 2]',
    'ink = sum(1 for y in range(0, height, 2) for x in range(0, width, 2) if pixels[x, y] != background)',
    'print(json.dumps({"ink": ink, "total": (width // 2) * (height // 2)}))',
  ].join('\n');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-graphics-types-'));
  try {
    for (const type of CHART_TYPES) {
      const spec = parseChartSpec({
        type,
        title: `Chart ${type}`,
        labels: ['one', 'two', 'three'],
        series: [
          { name: 'first', values: [12, 18, 9] },
          { name: 'second', values: [6, 11, 14] },
        ],
        width: 640,
        height: 400,
      });
      const result = await renderChart(OPTIONS, spec);
      assert.equal(result.mediaType, 'image/png', type);
      assert.ok(result.data.byteLength > 1500, `${type} must not be an empty picture`);
      const path = join(directory, `${type}.png`);
      await writeFile(path, result.data);
      const run = await runProcess(python, ['-c', script, path], { timeoutMs: 60000 });
      assert.equal(run.code, 0, run.stderr);
      const { ink, total } = JSON.parse(String(run.stdout).trim());
      assert.ok(ink / total > 0.01, `${type} must draw more than 1% of the canvas`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the image editor resizes and converts a picture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-graphics-test-'));
  try {
    const source = join(directory, 'source.png');
    // Paint a small picture with ffmpeg: a 64x48 red rectangle.
    const painted = await runProcess('C:\\ProgramData\\ffmpeg.exe', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', source,
    ], { timeoutMs: 60000 });
    assert.equal(painted.code, 0, painted.stderr);
    const result = await editImage(OPTIONS, { path: source, width: 32, format: 'jpeg' });
    assert.equal(result.mediaType, 'image/jpeg');
    assert.equal(result.format, 'jpeg');
    assert.equal(result.width, 32);
    assert.ok(result.height > 0);
    assert.ok(result.data.byteLength > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the image editor refuses a missing picture', async () => {
  await assert.rejects(() => editImage(OPTIONS, { path: 'C:\\definitely\\missing.png' }), /見つかりません/);
});
