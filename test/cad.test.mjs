/**
 * Tests for the v3 CAD module.
 *
 * Two kinds of test:
 *
 * - pure ones, which need nothing but Node: the part-list normaliser, the
 *   triangle meshes, the STL / OBJ writers, the DXF and SVG drawings;
 * - Blender ones, which are skipped when this machine has no Blender but do
 *   run here: a plate with four drilled holes, a drawn view, a GLB export.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CAD_DEFAULTS,
  CAD_ENGINES,
  CAD_FORMATS,
  CAD_OPERATIONS,
  CAD_PRIMITIVES,
  CAD_SOLID_FORMATS,
  CAD_UNITS,
  CAD_VIEWS,
  bboxReport,
  blenderScriptPath,
  boundingBox,
  buildDrawingSvg,
  buildDrawingViews,
  buildDxf,
  buildSolidOps,
  clipPolygonToRect,
  convexHull,
  displayPath,
  encodeBinaryStl,
  encodeObj,
  findBlender,
  mediaTypeFor,
  needsBlender,
  normalizeCadSpec,
  parseDxf,
  primitiveMesh,
  readStlBinary,
  registerCadTools,
  resolveCadOptions,
  safeStem,
  solidPayload,
  triangleCount,
  triangleNormal,
} from '../cad.js';

/** The plate every example in the documentation uses. */
const PLATE = [
  { type: 'box', size: [100, 60, 6] },
  { type: 'hole', diameter: 10, position: [30, 20, 0] },
  { type: 'hole', diameter: 10, position: [-30, 20, 0] },
  { type: 'hole', diameter: 10, position: [30, -20, 0] },
  { type: 'hole', diameter: 10, position: [-30, -20, 0] },
];

/** A temp session directory, and the helpers the plugin would pass in. */
async function session() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cad-test-'));
  const helpers = {
    resolveSessionCwd: async () => directory,
    formatBytes: (bytes) => `${bytes} B`,
    safeRelativeDir: (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'media-studio'),
  };
  return { directory, helpers };
}

/** A context that records the tools a module registers. */
function recordingContext() {
  const tools = [];
  return {
    tools,
    ctx: {
      effect(run) {
        run();
      },
      tools: {
        register(tool) {
          tools.push(tool);
        },
      },
    },
  };
}

/** Read the width and height out of a PNG header. */
function pngSize(data) {
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG', 'not a PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** True when this machine can run Blender; resolved once. */
let blenderPromise;
function blenderPath() {
  blenderPromise ??= findBlender(undefined);
  return blenderPromise;
}

// #region Part list

test('the CAD tables stay in step with the documentation', () => {
  assert.equal(CAD_UNITS, 'mm');
  assert.deepEqual(CAD_PRIMITIVES, ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism']);
  assert.deepEqual(CAD_OPERATIONS, ['union', 'difference', 'intersect']);
  assert.deepEqual(CAD_SOLID_FORMATS, ['stl', 'obj', 'glb', 'ply']);
  assert.deepEqual(CAD_FORMATS, ['stl', 'obj', 'glb', 'ply', 'dxf', 'svg']);
  assert.deepEqual(CAD_VIEWS, ['front', 'top', 'right', 'iso']);
  assert.deepEqual(CAD_ENGINES, ['workbench', 'freestyle']);
});

test('a part list normalises into centred primitives in millimetres', () => {
  const spec = normalizeCadSpec({
    parts: [
      { type: 'box', size: [100, 60, 6] },
      { type: 'cylinder', radius: 5, height: 20, position: [10, 0, 0] },
    ],
  });
  assert.equal(spec.parts.length, 2);
  assert.equal(spec.parts[0].type, 'box');
  assert.deepEqual(spec.parts[0].params.size, [100, 60, 6]);
  assert.deepEqual(spec.parts[0].position, [0, 0, 0]);
  assert.deepEqual(spec.parts[0].rotation, [0, 0, 0]);
  assert.deepEqual(spec.parts[0].scale, [1, 1, 1]);
  assert.equal(spec.parts[0].operation, 'union');
  assert.deepEqual(spec.parts[1].position, [10, 0, 0]);
  assert.equal(spec.parts[1].params.radius, 5);
});

test('a hole is a through cylinder subtracted from the solid', () => {
  const spec = normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', diameter: 8 }] });
  const hole = spec.parts[1];
  assert.equal(hole.type, 'cylinder');
  assert.equal(hole.operation, 'difference');
  assert.equal(hole.params.radius, 4);
  assert.equal(hole.through, true);
  assert.deepEqual(hole.rotation, [0, 0, 0]);
  const alongX = normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', diameter: 8, axis: 'x' }] });
  assert.deepEqual(alongX.parts[1].rotation, [0, 90, 0]);
  const alongY = normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', diameter: 8, axis: 'y' }] });
  assert.deepEqual(alongY.parts[1].rotation, [-90, 0, 0]);
  const measured = normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', diameter: 8, depth: 4 }] });
  assert.equal(measured.parts[1].through, false);
  assert.equal(measured.parts[1].params.height, 4);
});

test('arrays expand into single parts and mirrors stay with their part', () => {
  const spec = normalizeCadSpec({
    parts: [
      { type: 'box', size: [80, 20, 4] },
      {
        type: 'hole',
        diameter: 4,
        position: [-30, 0, 0],
        array: { count: 3, offset: [30, 0, 0] },
        mirror: 'y',
      },
    ],
  });
  assert.equal(spec.parts.length, 4);
  assert.deepEqual(spec.parts.slice(1).map((part) => part.position), [[-30, 0, 0], [0, 0, 0], [30, 0, 0]]);
  assert.equal(spec.parts[1].mirror, 'y');
});

test('array direction and spacing are the same thing as an offset', () => {
  const diagonal = normalizeCadSpec({
    parts: [
      { type: 'box' },
      { type: 'sphere', radius: 2, array: { count: 2, direction: [0, 0, 2], spacing: 8 } },
    ],
  });
  assert.equal(diagonal.parts.length, 3);
  assert.deepEqual(diagonal.parts[1].position, [0, 0, 0]);
  assert.deepEqual(diagonal.parts[2].position, [0, 0, 8]);
});

test('a bad part list says what is wrong', () => {
  assert.throws(() => normalizeCadSpec({ parts: [] }), /parts を 1 つ以上/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'blob' }] }), /type が未対応/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'hole', diameter: 4 }] }), /最初のパーツの operation は union/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'box', size: [1, 2] }] }), /3 つの数値/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'box', size: [0, 2, 3] }] }), /0 より大きい/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'box', scale: [-1, 1, 1] }] }), /mirror/u);
  assert.throws(() => normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', mirror: 'w' }] }), /mirror は x \/ y \/ z/u);
  assert.throws(
    () => normalizeCadSpec({ parts: [{ type: 'box' }, { type: 'hole', array: { count: 3, offset: [0, 0, 0] } }] }),
    /offset か direction/u,
  );
});

// #endregion

// #region Meshes

/** Signed volume of a closed mesh: positive when the normals face outwards. */
function signedVolume(mesh) {
  let total = 0;
  for (const [a, b, c] of mesh.triangles) {
    const p = mesh.vertices[a];
    const q = mesh.vertices[b];
    const r = mesh.vertices[c];
    total += p[0] * (q[1] * r[2] - q[2] * r[1])
      - p[1] * (q[0] * r[2] - q[2] * r[0])
      + p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  return total / 6;
}

/** True when every directed edge has exactly one opposite: a closed surface. */
function isClosed(mesh) {
  const edges = new Map();
  for (const [a, b, c] of mesh.triangles) {
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${from}:${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    if (count !== 1) return false;
    const [from, to] = key.split(':');
    if ((edges.get(`${to}:${from}`) ?? 0) !== 1) return false;
  }
  return true;
}

test('every primitive is a closed mesh with outward-facing normals', () => {
  const cases = [
    [{ type: 'box', size: [10, 20, 30] }, 12],
    [{ type: 'wedge', size: [10, 20, 30] }, 8],
    [{ type: 'cylinder', radius: 5, height: 10, segments: 16 }, 4 * 16],
    [{ type: 'cone', radius: 5, height: 10, segments: 16 }, 2 * 16],
    [{ type: 'sphere', radius: 5, segments: 24, rings: 12 }, 2 * 24 * (12 - 2) + 2 * 24],
    [{ type: 'torus', radius: 20, tube: 5, segments: 24, tubeSegments: 12 }, 2 * 24 * 12],
    [{ type: 'prism', sides: 6, radius: 10, height: 10 }, 24],
  ];
  for (const [part, expected] of cases) {
    const spec = normalizeCadSpec({ parts: [part] });
    const mesh = primitiveMesh(spec.parts[0]);
    assert.equal(mesh.triangles.length, expected, `${part.type}: triangle count`);
    assert.equal(isClosed(mesh), true, `${part.type}: the surface has a hole in it`);
    for (const [a, b, c] of mesh.triangles) {
      const normal = triangleNormal(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
      assert.notDeepEqual(normal, [0, 0, 0], `${part.type}: degenerate triangle`);
    }
    assert.ok(signedVolume(mesh) > 0, `${part.type}: the normals point inwards`);
  }
});

test('a primitive sits centred on its position', () => {
  const spec = normalizeCadSpec({
    parts: [{ type: 'box', size: [20, 10, 4], position: [5, -5, 100] }],
  });
  const ops = buildSolidOps(spec);
  const box = bboxReport(boundingBox(ops.map((op) => op.mesh)));
  assert.deepEqual(box.size, [20, 10, 4]);
  assert.deepEqual(box.center, [5, -5, 100]);
});

test('rotation and scale act before the part is moved', () => {
  const spec = normalizeCadSpec({
    parts: [{ type: 'box', size: [20, 10, 4], rotation: [0, 0, 90], position: [0, 0, 0] }],
  });
  const box = bboxReport(boundingBox(buildSolidOps(spec).map((op) => op.mesh)));
  assert.ok(Math.abs(box.size[0] - 10) < 1e-6, 'x became the short side');
  assert.ok(Math.abs(box.size[1] - 20) < 1e-6, 'y became the long side');
});

test('a through hole is long enough to cut the whole model', () => {
  const spec = normalizeCadSpec({ parts: PLATE });
  const ops = buildSolidOps(spec);
  const holes = ops.filter((op) => op.operation === 'difference');
  assert.equal(holes.length, 4);
  for (const hole of holes) {
    const box = boundingBox([hole.mesh]);
    assert.ok(box.min[2] < -3 && box.max[2] > 3, `hole from ${box.min[2]} to ${box.max[2]} does not pass through ±3`);
  }
  assert.equal(needsBlender(ops), true);
  assert.equal(needsBlender(buildSolidOps(normalizeCadSpec({ parts: [{ type: 'box' }] }))), false);
});

test('a mirror adds the reflected copy, with outward normals kept', () => {
  const spec = normalizeCadSpec({
    parts: [
      { type: 'box', size: [40, 10, 4] },
      { type: 'sphere', radius: 3, position: [15, 0, 0], mirror: 'x' },
    ],
  });
  const ops = buildSolidOps(spec);
  assert.equal(ops.length, 3);
  const left = bboxReport(boundingBox([ops[2].mesh]));
  assert.deepEqual(left.center, [-15, 0, 0]);
  const mesh = ops[2].mesh;
  const normal = triangleNormal(mesh.vertices[0], mesh.vertices[1], mesh.vertices[2]);
  const corner = mesh.vertices[mesh.triangles[0][0]];
  const outward = normal[0] * corner[0] + normal[1] * corner[1] + normal[2] * corner[2];
  assert.ok(outward > 0, 'the reflected mesh still faces outwards');
});

test('the payload handed to Blender is plain JSON with rounded coordinates', () => {
  const spec = normalizeCadSpec({ parts: [{ type: 'cylinder', radius: 1, height: 2, segments: 3 }] });
  const payload = solidPayload(buildSolidOps(spec));
  assert.equal(payload.length, 1);
  assert.equal(payload[0].operation, 'union');
  assert.equal(payload[0].faces.length, 12);
  assert.equal(JSON.parse(JSON.stringify(payload[0].vertices)).length, payload[0].vertices.length);
});

// #endregion

// #region Mesh files

test('a binary STL round-trips: count, size and bounding box', () => {
  const spec = normalizeCadSpec({ parts: [{ type: 'box', size: [20, 10, 4] }] });
  const meshes = buildSolidOps(spec).map((op) => op.mesh);
  const data = encodeBinaryStl(meshes);
  assert.equal(triangleCount(meshes), 12);
  assert.equal(data.length, 84 + 12 * 50);
  assert.match(data.subarray(0, 80).toString('utf8'), /^DSH Media Studio CAD/u);
  const read = readStlBinary(data);
  assert.equal(read.triangles, 12);
  assert.equal(read.zeroNormals, 0);
  assert.equal(read.degenerate, 0);
  assert.deepEqual(read.bbox.min.map((value) => Math.round(value * 1000) / 1000), [-10, -5, -2]);
  assert.deepEqual(read.bbox.max.map((value) => Math.round(value * 1000) / 1000), [10, 5, 2]);
});

test('readStlBinary refuses something that is not a binary STL', () => {
  assert.throws(() => readStlBinary(Buffer.alloc(10)), /短すぎます/u);
  const ascii = Buffer.from(`solid x${' '.repeat(100)}endsolid x`, 'ascii');
  assert.throws(() => readStlBinary(ascii), /バイナリ STL ではありません/u);
});

test('the OBJ writer keeps millimetres and one-based faces', () => {
  const spec = normalizeCadSpec({ parts: [{ type: 'box', size: [20, 10, 4] }] });
  const text = encodeObj(buildSolidOps(spec).map((op) => op.mesh), 'plate');
  const lines = text.split('\n');
  assert.equal(lines[1], 'o plate');
  assert.equal(lines.filter((line) => line.startsWith('v ')).length, 8);
  assert.equal(lines.filter((line) => line.startsWith('f ')).length, 12);
  assert.ok(lines.includes('v -10 -5 -2'), 'a corner vertex in millimetres');
  assert.ok(lines.includes('f 1 4 3'), 'faces are one-based and keep their winding');
});

// #endregion

// #region Drawings

test('the convex hull drops interior points', () => {
  const square = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
  assert.equal(square.length, 4);
  assert.deepEqual(square, [[0, 0], [10, 0], [10, 10], [0, 10]]);
  const circle = convexHull(Array.from({ length: 32 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2;
    return [10 * Math.cos(angle), 10 * Math.sin(angle)];
  }));
  assert.ok(circle.length >= 16, `a circle hull keeps its outline, got ${circle.length}`);
  assert.deepEqual(convexHull([[1, 1]]), [[1, 1]]);
});

test('the drawing views project the axes a workshop expects', () => {
  const spec = normalizeCadSpec({ parts: [{ type: 'box', size: [100, 60, 6] }] });
  const views = buildDrawingViews(buildSolidOps(spec), ['front', 'top', 'right']);
  const byView = Object.fromEntries(views.map((view) => [view.view, view.extents]));
  assert.deepEqual([byView.front.width, byView.front.height], [100, 6]);
  assert.deepEqual([byView.top.width, byView.top.height], [100, 60]);
  assert.deepEqual([byView.right.width, byView.right.height], [60, 6]);
  assert.equal(views[0].label, '正面図');
});

test('a polygon clips down to the outline of the solid', () => {
  const square = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const clipped = clipPolygonToRect(square, { minA: -10, maxA: 10, minB: -2, maxB: 2 });
  assert.equal(clipped.length, 4);
  assert.deepEqual(clipped.map((point) => point[1]).sort((left, right) => left - right), [-2, -2, 2, 2]);
  assert.deepEqual(clipped.map((point) => point[0]).sort((left, right) => left - right), [-5, -5, 5, 5]);
  const outside = clipPolygonToRect([[20, 20], [30, 20], [30, 30]], { minA: -10, maxA: 10, minB: -10, maxB: 10 });
  assert.deepEqual(outside, []);
});

test('a drilled hole draws its hidden line only inside the material', () => {
  const spec = normalizeCadSpec({ parts: PLATE });
  const views = buildDrawingViews(buildSolidOps(spec), ['front']);
  const holes = views[0].outlines.filter((outline) => outline.operation === 'difference');
  assert.equal(holes.length, 4);
  for (const hole of holes) {
    for (const [, vertical] of hole.points) {
      assert.ok(vertical >= -3 - 1e-6 && vertical <= 3 + 1e-6, `hidden line at ${vertical} mm is outside the 6 mm plate`);
    }
  }
});

test('the SVG sheet carries three views, dimensions and a title block', () => {
  const spec = normalizeCadSpec({ parts: PLATE });
  const ops = buildSolidOps(spec);
  const drawing = buildDrawingSvg({
    ops,
    views: ['front', 'top', 'right'],
    title: 'テスト板',
    width: 1400,
    height: 1000,
    size: [100, 60, 6],
    partCount: spec.parts.length,
    triangles: 0,
    date: '2026-11-03',
  });
  assert.ok(drawing.scale > 0);
  assert.match(drawing.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(drawing.svg, /viewBox="0 0 1400 1000"/u);
  for (const label of ['正面図', '平面図', '右側面図']) assert.ok(drawing.svg.includes(label), `missing ${label}`);
  assert.match(drawing.svg, />100</u, 'the width dimension');
  assert.match(drawing.svg, />60</u, 'the depth dimension');
  assert.match(drawing.svg, /stroke-dasharray="6 4"/u, 'the holes are drawn dashed');
  assert.match(drawing.svg, /テスト板/u);
  assert.match(drawing.svg, /単位: mm/u);
  assert.equal(drawing.views.length, 3);
  assert.ok(drawing.svg.endsWith('</svg>\n'));
});

test('the DXF drawing reads back with the entities and units it wrote', () => {
  const spec = normalizeCadSpec({ parts: PLATE });
  const ops = buildSolidOps(spec);
  const dxf = buildDxf({ ops, views: ['front', 'top'] });
  const read = parseDxf(dxf.dxf);
  assert.equal(read.version, 'AC1009');
  assert.equal(read.units, 4, 'millimetres');
  assert.ok(read.sections.includes('TABLES') && read.sections.includes('ENTITIES'));
  const lines = read.entities.filter((entity) => entity.type === 'LINE');
  const texts = read.entities.filter((entity) => entity.type === 'TEXT');
  assert.equal(lines.length, dxf.lines);
  assert.equal(texts.length, dxf.texts);
  assert.ok(dxf.lines > 20, `expected the outlines of two views, got ${dxf.lines} lines`);
  assert.ok(lines.some((line) => line.layer === 'OUTLINE'));
  assert.ok(lines.some((line) => line.layer === 'HIDDEN'), 'the holes are on the hidden layer');
  assert.ok(texts.some((text) => text.text === '100'), 'the width dimension');
  assert.ok(texts.some((text) => text.text === '60'), 'the depth dimension');
  assert.ok(texts.some((text) => text.text === '正面図'));
  for (const line of lines) {
    assert.ok(Number.isFinite(line.x) && Number.isFinite(line.y), 'a line with real coordinates');
  }
  assert.ok(dxf.dxf.startsWith('0\nSECTION\n2\nHEADER'));
  assert.ok(dxf.dxf.trimEnd().endsWith('EOF'));
});

// #endregion

// #region Options and helpers

test('the cad section of the row config is normalised', () => {
  const options = resolveCadOptions(
    { cad: { blenderPath: 'C:\\Blender\\blender.exe', outputDir: 'my-cad', width: 900, height: 700, segments: 96, engine: 'freestyle', timeoutMs: 45000 } },
    { outputDir: 'media-studio' },
    { safeRelativeDir: (value) => value },
  );
  assert.equal(options.blenderPath, 'C:\\Blender\\blender.exe');
  assert.equal(options.outputDir, 'my-cad');
  assert.equal(options.width, 900);
  assert.equal(options.height, 700);
  assert.equal(options.segments, 96);
  assert.equal(options.engine, 'freestyle');
  assert.equal(options.timeoutMs, 45000);
  const fallback = resolveCadOptions(undefined, undefined, undefined);
  assert.equal(fallback.outputDir, 'media-studio');
  assert.equal(fallback.engine, CAD_DEFAULTS.engine);
  assert.equal(fallback.blenderPath, undefined);
  assert.equal(resolveCadOptions({ cad: { engine: 'nope' } }, {}, {}).engine, 'workbench');
  assert.equal(blenderScriptPath().endsWith('cad_blender.py'), true);
});

test('file names and media types follow the module conventions', () => {
  assert.equal(safeStem('my plate/v2', 'cad'), 'my-plate-v2');
  assert.equal(safeStem('   ', 'cad'), 'cad');
  assert.equal(mediaTypeFor('stl'), 'model/stl');
  assert.equal(mediaTypeFor('svg'), 'image/svg+xml');
  assert.equal(mediaTypeFor('dxf'), 'image/vnd.dxf');
  assert.equal(mediaTypeFor('png'), 'image/png');
  assert.equal(displayPath('C:\\session', 'C:\\session\\media-studio\\a.stl'), 'media-studio/a.stl');
});

// #endregion

// #region Tools

test('registerCadTools registers the three CAD tools', () => {
  const { ctx, tools } = recordingContext();
  registerCadTools(ctx, { outputDir: 'media-studio' }, {}, {
    resolveSessionCwd: async () => tmpdir(),
    formatBytes: (bytes) => `${bytes} B`,
    safeRelativeDir: (value) => value,
  });
  assert.deepEqual(tools.map((tool) => tool.name), ['cad_model', 'cad_drawing', 'cad_export']);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.match(tool.description, /^[A-Z][\x20-\x7e]+$/u, `${tool.name}: the description is English`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.timeoutMs, 300000);
  }
  const model = tools[0];
  assert.deepEqual(model.parameters.required, ['parts']);
  assert.deepEqual(model.parameters.properties.format.enum, ['stl', 'obj', 'glb', 'ply']);
  assert.equal(model.parameters.properties.parts.items.properties.operation.enum.includes('difference'), true);
  assert.equal(model.output.schema.required.includes('bbox'), true);
  const render = model.output.render({}, {
    name: 'a.stl',
    path: 'media-studio/a.stl',
    bytes: 1234,
    mediaType: 'model/stl',
    format: 'stl',
    triangles: 12,
    vertices: 8,
    parts: 1,
    backend: 'javascript',
    bbox: bboxReport({ min: [-10, -5, -2], max: [10, 5, 2] }),
  });
  assert.match(render[0].text, /3D モデルを作成しました/u);
  assert.match(render[0].text, /20 × 10 × 4 mm/u);
  assert.deepEqual(model.output.presentationMeta({}, { path: 'a.stl' }), { path: 'a.stl' });
  assert.deepEqual(model.output.presentationMeta({}, { name: 'a.stl' }), { name: 'a.stl' });
});

test('cad_model writes a binary STL from a union without Blender', async () => {
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: 'C:\\no-such-blender.exe' } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_model');
    const value = await tool.execute(
      { parts: [{ type: 'box', size: [20, 10, 4] }], format: 'stl', name: 'plate' },
      { signal: undefined },
    );
    assert.equal(value.format, 'stl');
    assert.equal(value.backend, 'javascript');
    assert.equal(value.triangles, 12);
    assert.equal(value.vertices, 8);
    assert.equal(value.parts, 1);
    assert.deepEqual(value.bbox.size, [20, 10, 4]);
    assert.equal(value.mediaType, 'model/stl');
    assert.match(value.path, /^media-studio\/plate-\d{8}-\d{6}-[0-9a-f]{4}\.stl$/u);
    const file = join(directory, value.path);
    const info = await stat(file);
    assert.equal(info.size, value.bytes);
    assert.equal(info.size, 84 + 12 * 50);
    const read = readStlBinary(await readFile(file));
    assert.equal(read.triangles, 12);
    assert.deepEqual(read.bbox.min, [-10, -5, -2]);
    assert.deepEqual(read.bbox.max, [10, 5, 2]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cad_model writes an OBJ and the numbers in it are millimetres', async () => {
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: 'C:\\no-such-blender.exe' } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_model');
    const value = await tool.execute(
      { parts: [{ type: 'cylinder', radius: 10, height: 20, segments: 24 }], format: 'obj', name: 'pin' },
      { signal: undefined },
    );
    assert.equal(value.format, 'obj');
    assert.equal(value.triangles, 96);
    const text = await readFile(join(directory, value.path), 'utf8');
    assert.match(text, /^# DSH Media Studio CAD \(mm\)/u);
    assert.match(text, /^v -?10 /mu);
    assert.equal(text.split('\n').filter((line) => line.startsWith('f ')).length, 96);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a boolean model without Blender explains that Blender is required', async () => {
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: 'C:\\no-such-blender.exe' } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_model');
    await assert.rejects(
      () => tool.execute({ parts: PLATE, format: 'stl' }, { signal: undefined }),
      /ブーリアン演算.*Blender が必要です[\s\S]*cad\.blenderPath/u,
    );
    await assert.rejects(
      () => tool.execute({ parts: [{ type: 'box' }], format: 'glb' }, { signal: undefined }),
      /GLB \/ PLY.*Blender/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cad_export writes a DXF and an SVG without Blender', async () => {
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: 'C:\\no-such-blender.exe' } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_export');
    const dxf = await tool.execute({ parts: PLATE, format: 'dxf', name: 'plate' }, { signal: undefined });
    assert.equal(dxf.format, 'dxf');
    assert.equal(dxf.mediaType, 'image/vnd.dxf');
    assert.match(dxf.path, /\.dxf$/u);
    const parsed = parseDxf(await readFile(join(directory, dxf.path), 'utf8'));
    assert.equal(parsed.version, 'AC1009');
    assert.ok(parsed.entities.length > 10);

    const svg = await tool.execute({ parts: PLATE, format: 'svg', name: 'plate' }, { signal: undefined });
    assert.equal(svg.mediaType, 'image/svg+xml');
    const text = await readFile(join(directory, svg.path), 'utf8');
    assert.match(text, /<svg /u);
    assert.match(text, /正面図/u);
    assert.equal(svg.bytes, Buffer.byteLength(text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cad_drawing writes the SVG sheet without Blender', async () => {
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: 'C:\\no-such-blender.exe' } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_drawing');
    const value = await tool.execute(
      { parts: PLATE, format: 'svg', views: ['front', 'top'], title: '穴あき板' },
      { signal: undefined },
    );
    assert.equal(value.files.length, 1);
    assert.equal(value.files[0].mediaType, 'image/svg+xml');
    assert.equal(value.files[0].view, 'sheet');
    assert.deepEqual(value.bbox.size, [100, 60, 6]);
    assert.equal(value.parts, 5);
    const text = await readFile(join(directory, value.path), 'utf8');
    assert.match(text, /穴あき板/u);
    assert.match(text, /外形: 100 × 60 × 6 mm/u);
    await assert.rejects(
      () => tool.execute({ parts: [{ type: 'box' }], format: 'png' }, { signal: undefined }),
      /PNG.*Blender/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// #endregion

// #region Blender

test('Blender cuts the four holes and the STL measures up', async (t) => {
  const blender = await blenderPath();
  if (blender === undefined) {
    t.skip('Blender is not installed');
    return;
  }
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: blender, timeoutMs: 180000 } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_model');
    const value = await tool.execute({ parts: PLATE, format: 'stl', name: 'plate' }, { signal: undefined });
    assert.equal(value.backend, 'blender');
    assert.ok(value.triangles > 12, `a drilled plate needs more than a box's 12 triangles, got ${value.triangles}`);
    assert.deepEqual(value.bbox.size, [100, 60, 6]);
    assert.deepEqual([value.bbox.x.min, value.bbox.x.max], [-50, 50]);
    assert.deepEqual([value.bbox.y.min, value.bbox.y.max], [-30, 30]);
    assert.deepEqual([value.bbox.z.min, value.bbox.z.max], [-3, 3]);
    const data = await readFile(join(directory, value.path));
    const read = readStlBinary(data);
    assert.equal(read.triangles, value.triangles);
    assert.equal(read.degenerate, 0);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(Math.abs(read.bbox.min[axis] - value.bbox[['x', 'y', 'z'][axis]].min) < 0.001);
      assert.ok(Math.abs(read.bbox.max[axis] - value.bbox[['x', 'y', 'z'][axis]].max) < 0.001);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Blender renders a drawn view as a non-empty PNG', async (t) => {
  const blender = await blenderPath();
  if (blender === undefined) {
    t.skip('Blender is not installed');
    return;
  }
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: blender, timeoutMs: 180000 } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_drawing');
    const value = await tool.execute(
      { parts: PLATE, format: 'png', views: ['front', 'top'], width: 640, height: 480, engine: 'freestyle' },
      { signal: undefined },
    );
    assert.equal(value.backend, 'blender');
    const pngs = value.files.filter((file) => file.mediaType === 'image/png');
    assert.deepEqual(pngs.map((file) => file.view), ['front', 'top']);
    for (const file of pngs) {
      const data = await readFile(join(directory, file.path));
      assert.ok(data.length > 1000, `${file.view} is empty`);
      assert.deepEqual(pngSize(data), { width: 640, height: 480 });
      assert.equal(data.length, file.bytes);
    }
    assert.deepEqual(value.bbox.size, [100, 60, 6]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Blender writes a GLB that starts with the glTF magic', async (t) => {
  const blender = await blenderPath();
  if (blender === undefined) {
    t.skip('Blender is not installed');
    return;
  }
  const { directory, helpers } = await session();
  try {
    const { ctx, tools } = recordingContext();
    registerCadTools(ctx, { outputDir: 'media-studio' }, { cad: { blenderPath: blender, timeoutMs: 180000 } }, helpers);
    const tool = tools.find((entry) => entry.name === 'cad_export');
    const value = await tool.execute({ parts: PLATE, format: 'glb', name: 'plate' }, { signal: undefined });
    assert.equal(value.backend, 'blender');
    assert.equal(value.mediaType, 'model/gltf-binary');
    const data = await readFile(join(directory, value.path));
    assert.equal(data.subarray(0, 4).toString('ascii'), 'glTF');
    assert.ok(data.length > 1000);
    assert.equal(data.length, value.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// #endregion
