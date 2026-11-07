/**
 * CAD (v3): parametric solids, 2D drawings, and mesh export.
 *
 * The tools this file registers:
 *
 * - `cad_model`    build a solid from a part list (primitives, booleans,
 *                  transforms, arrays, mirrors, drilled holes) and export it
 *                  as binary STL / OBJ / GLB / PLY.
 * - `cad_drawing`  render front / top / right / isometric views as PNG, and
 *                  write an SVG sheet with dimension lines worked out from the
 *                  model's bounding box.
 * - `cad_export`   regenerate the same model in another format (STL / OBJ /
 *                  GLB / PLY / DXF / SVG) from the same part list. There is no
 *                  hidden state: the part list is the model, so an export is
 *                  deterministic.
 *
 * Two backends, one model:
 *
 * - JavaScript. The part list is tessellated here into a triangle mesh, which
 *   is written as binary STL or OBJ. This path needs no external program, so
 *   `cad_model` works on a machine without Blender as long as the model is a
 *   plain union of primitives.
 * - Blender (headless, `cad_blender.py`). Boolean operations and GLB / PLY
 *   export and PNG views need Blender. The very same triangle meshes are
 *   handed to Blender, so both backends see identical geometry; only the CSG
 *   evaluation and the rendering differ.
 *
 * Units are millimetres everywhere. Every primitive is built centred on the
 * origin of its own local frame, so `position` is the centre of the shape and
 * the bounding box of the finished solid is easy to predict.
 *
 * `index.js` owns the plugin; this module never imports it. The small tools it
 * needs (session directory resolution, byte formatting, output directory
 * clamping) arrive through `helpers`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProcess } from './video.js';

// #region Tables

/** Every coordinate in this module is a millimetre. */
export const CAD_UNITS = 'mm';

/** Primitives `cad_model` understands. */
export const CAD_PRIMITIVES = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'prism'];

/** Boolean operations, applied in the order the parts are given. */
export const CAD_OPERATIONS = ['union', 'difference', 'intersect'];

/** Formats the mesh writer understands, plus the two 2D formats. */
export const CAD_SOLID_FORMATS = ['stl', 'obj', 'glb', 'ply'];
export const CAD_DRAWING_FORMATS_2D = ['dxf', 'svg'];
export const CAD_FORMATS = [...CAD_SOLID_FORMATS, ...CAD_DRAWING_FORMATS_2D];

/** Orthographic views the drawing tool renders. */
export const CAD_VIEWS = ['front', 'top', 'right', 'iso'];

/** What `cad_drawing` should produce. */
export const CAD_DRAWING_FORMATS = ['png', 'svg', 'both'];

/** Render engines `cad_drawing` can ask Blender for. */
export const CAD_ENGINES = ['workbench', 'freestyle'];

/** Defaults, overridden by the `cad` section of the row config. */
export const CAD_DEFAULTS = {
  segments: 48,
  drawingWidth: 1600,
  drawingHeight: 1200,
  timeoutMs: 300000,
  maxParts: 256,
  maxArray: 200,
  maxVertices: 600000,
  engine: 'workbench',
  lineWidth: 1.6,
};

/** Media types for the files this module writes. */
const MEDIA_TYPES = {
  stl: 'model/stl',
  obj: 'model/obj',
  glb: 'model/gltf-binary',
  ply: 'model/ply',
  svg: 'image/svg+xml',
  dxf: 'image/vnd.dxf',
  png: 'image/png',
};

/** View label drawn on the sheet, and which model axis is horizontal / vertical. */
const VIEW_GEOMETRY = {
  front: { axes: [0, 2], label: '正面図' },
  top: { axes: [0, 1], label: '平面図' },
  right: { axes: [1, 2], label: '右側面図' },
  iso: { axes: [0, 2], label: 'アイソメ' },
};

/** Axis name to index, for mirror and drill axes. */
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** Extra Euler rotation that points a Z-axis cylinder down another axis. */
const DRILL_ROTATION = { x: [0, 90, 0], y: [-90, 0, 0], z: [0, 0, 0] };

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// #endregion

// #region Geometry

/**
 * A rotation matrix for XYZ Euler angles in degrees.
 *
 * @param {number[]} degrees - rotation about X, Y and Z.
 * @returns {number[][]} a 3×3 matrix.
 */
export function rotationMatrix(degrees) {
  const [rx, ry, rz] = degrees.map((value) => value * DEG);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return [
    [cz * cy, -sz * cx + cz * sy * sx, sz * sx + cz * sy * cx],
    [sz * cy, cz * cx + sz * sy * sx, -cz * sx + sz * sy * cx],
    [-sy, cy * sx, cy * cx],
  ];
}

/** A ring of points around the Z axis. */
function ring(radius, height, segments, phase = 0) {
  const points = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * TAU + phase;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle), height]);
  }
  return points;
}

/** A closed box centred on the origin. */
function boxMesh([w, d, h]) {
  const x = w / 2;
  const y = d / 2;
  const z = h / 2;
  const vertices = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const triangles = [
    [0, 3, 2], [0, 2, 1],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  return { vertices, triangles };
}

/** A cylinder (or a frustum / cone, when `top` is smaller) centred on the origin. */
function cylinderMesh(radius, height, segments, top = radius) {
  const bottom = -height / 2;
  const upper = height / 2;
  const vertices = [];
  const triangles = [];
  const bottomRing = ring(radius, bottom, segments);
  const topRadius = Math.max(0, top);
  if (topRadius === 0) {
    // A cone: one apex vertex instead of a top ring.
    for (const point of bottomRing) vertices.push(point);
    vertices.push([0, 0, upper]);
    const apex = vertices.length - 1;
    for (let index = 0; index < segments; index += 1) {
      const a = index;
      const b = (index + 1) % segments;
      triangles.push([a, b, apex]);
    }
    // Bottom cap, facing down.
    const centre = vertices.length;
    vertices.push([0, 0, bottom]);
    for (let index = 0; index < segments; index += 1) {
      triangles.push([centre, (index + 1) % segments, index]);
    }
    return { vertices, triangles };
  }
  for (const point of bottomRing) vertices.push(point);
  const topRing = ring(topRadius, upper, segments).map((point) => point);
  for (const point of topRing) vertices.push(point);
  for (let index = 0; index < segments; index += 1) {
    const a = index;
    const b = (index + 1) % segments;
    const c = segments + ((index + 1) % segments);
    const d = segments + index;
    triangles.push([a, b, c], [a, c, d]);
  }
  const capBottom = vertices.length;
  vertices.push([0, 0, bottom]);
  const capTop = vertices.length;
  vertices.push([0, 0, upper]);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    triangles.push([capBottom, next, index]);
    triangles.push([capTop, segments + index, segments + next]);
  }
  return { vertices, triangles };
}

/** A UV sphere centred on the origin. */
function sphereMesh(radius, segments, rings) {
  const vertices = [];
  const triangles = [];
  const south = 0;
  vertices.push([0, 0, -radius]);
  for (let row = 1; row < rings; row += 1) {
    const phi = -Math.PI / 2 + (row / rings) * Math.PI;
    const r = radius * Math.cos(phi);
    const z = radius * Math.sin(phi);
    const points = ring(r, z, segments);
    for (const point of points) vertices.push(point);
  }
  const north = vertices.length;
  vertices.push([0, 0, radius]);
  const rowStart = (row) => 1 + (row - 1) * segments;
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    triangles.push([south, 1 + next, 1 + index]);
  }
  for (let row = 1; row < rings - 1; row += 1) {
    const low = rowStart(row);
    const high = rowStart(row + 1);
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      const a = low + index;
      const b = low + next;
      const c = high + next;
      const d = high + index;
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  const last = rowStart(rings - 1);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    triangles.push([north, last + index, last + next]);
  }
  return { vertices, triangles };
}

/** A torus lying in the XY plane, centred on the origin. */
function torusMesh(majorRadius, tubeRadius, segments, tubeSegments) {
  const vertices = [];
  const triangles = [];
  for (let index = 0; index < segments; index += 1) {
    const u = (index / segments) * TAU;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let line = 0; line < tubeSegments; line += 1) {
      const v = (line / tubeSegments) * TAU;
      const radius = majorRadius + tubeRadius * Math.cos(v);
      vertices.push([radius * cu, radius * su, tubeRadius * Math.sin(v)]);
    }
  }
  const at = (index, line) => (index % segments) * tubeSegments + (line % tubeSegments);
  for (let index = 0; index < segments; index += 1) {
    for (let line = 0; line < tubeSegments; line += 1) {
      const a = at(index, line);
      const b = at(index + 1, line);
      const c = at(index + 1, line + 1);
      const d = at(index, line + 1);
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return { vertices, triangles };
}

/** A right-triangular prism (a ramp) centred on the origin. */
function wedgeMesh([w, d, h]) {
  const x = w / 2;
  const y = d / 2;
  const z = h / 2;
  const vertices = [
    [-x, -y, -z], [x, -y, -z], [x, -y, z],
    [-x, y, -z], [x, y, -z], [x, y, z],
  ];
  const triangles = [
    [0, 1, 2],
    [3, 5, 4],
    [0, 3, 4], [0, 4, 1],
    [1, 5, 2], [1, 4, 5],
    [0, 2, 5], [0, 5, 3],
  ];
  return { vertices, triangles };
}

/**
 * Tessellate one normalised part into a local triangle mesh.
 *
 * @param {object} part - a part returned by {@link normalizeCadSpec}.
 * @returns {{ vertices: number[][], triangles: number[][] }}
 */
export function primitiveMesh(part) {
  const segments = part.segments;
  switch (part.type) {
    case 'box':
      return boxMesh(part.params.size);
    case 'wedge':
      return wedgeMesh(part.params.size);
    case 'cylinder':
      return cylinderMesh(part.params.radius, part.params.height, segments);
    case 'cone':
      return cylinderMesh(part.params.radius, part.params.height, segments, part.params.radiusTop);
    case 'sphere':
      return sphereMesh(part.params.radius, segments, part.params.rings);
    case 'torus':
      return torusMesh(part.params.radius, part.params.tube, segments, part.params.tubeSegments);
    case 'prism':
      return cylinderMesh(part.params.radius, part.params.height, Math.max(3, part.params.sides));
    default:
      throw new Error(`未対応のプリミティブです: ${String(part.type)}`);
  }
}

/**
 * Place a part's local mesh in world space (scale, then rotate, then move).
 *
 * @param {object} part - a normalised part.
 * @returns {{ vertices: number[][], triangles: number[][] }}
 */
export function partMesh(part) {
  const local = primitiveMesh(part);
  const matrix = rotationMatrix(part.rotation);
  const [sx, sy, sz] = part.scale;
  const [tx, ty, tz] = part.position;
  const vertices = local.vertices.map(([x, y, z]) => {
    const px = x * sx;
    const py = y * sy;
    const pz = z * sz;
    return [
      matrix[0][0] * px + matrix[0][1] * py + matrix[0][2] * pz + tx,
      matrix[1][0] * px + matrix[1][1] * py + matrix[1][2] * pz + ty,
      matrix[2][0] * px + matrix[2][1] * py + matrix[2][2] * pz + tz,
    ];
  });
  return { vertices, triangles: local.triangles };
}

/**
 * Reflect a mesh across a plane through the origin, keeping its outward normals.
 *
 * @param {{ vertices: number[][], triangles: number[][] }} mesh - the mesh.
 * @param {number} axis - 0, 1 or 2.
 * @returns {{ vertices: number[][], triangles: number[][] }}
 */
export function reflectMesh(mesh, axis) {
  const vertices = mesh.vertices.map((point) => {
    const copy = point.slice();
    copy[axis] = -copy[axis];
    return copy;
  });
  const triangles = mesh.triangles.map(([a, b, c]) => [a, c, b]);
  return { vertices, triangles };
}

/** The bounding box of one or more meshes, or `undefined` when empty. */
export function boundingBox(meshes) {
  let min;
  let max;
  for (const mesh of meshes) {
    if (mesh === undefined) continue;
    for (const point of mesh.vertices) {
      if (min === undefined) {
        min = point.slice();
        max = point.slice();
        continue;
      }
      for (let axis = 0; axis < 3; axis += 1) {
        if (point[axis] < min[axis]) min[axis] = point[axis];
        if (point[axis] > max[axis]) max[axis] = point[axis];
      }
    }
  }
  if (min === undefined) return undefined;
  return { min, max };
}

/** Number a human can check: per-axis min / max / size, plus the size vector. */
export function bboxReport(box) {
  if (box === undefined) {
    return {
      x: { min: 0, max: 0, size: 0 },
      y: { min: 0, max: 0, size: 0 },
      z: { min: 0, max: 0, size: 0 },
      size: [0, 0, 0],
      center: [0, 0, 0],
    };
  }
  const round = (value) => Math.round(value * 1000) / 1000;
  const axis = (index) => ({
    min: round(box.min[index]),
    max: round(box.max[index]),
    size: round(box.max[index] - box.min[index]),
  });
  return {
    x: axis(0),
    y: axis(1),
    z: axis(2),
    size: [0, 1, 2].map((index) => round(box.max[index] - box.min[index])),
    center: [0, 1, 2].map((index) => round((box.min[index] + box.max[index]) / 2)),
  };
}

/** Total triangle count over a list of meshes. */
export function triangleCount(meshes) {
  return meshes.reduce((total, mesh) => total + (mesh === undefined ? 0 : mesh.triangles.length), 0);
}

/** Total vertex count over a list of meshes. */
export function vertexCount(meshes) {
  return meshes.reduce((total, mesh) => total + (mesh === undefined ? 0 : mesh.vertices.length), 0);
}

// #endregion

// #region Part list normalisation

/** A finite number, or the fallback. */
function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** A three-element vector, validated. */
function triple(value, fallback, name) {
  if (value === undefined || value === null) return fallback.slice();
  const list = Array.isArray(value) ? value : undefined;
  if (list === undefined || list.length !== 3) throw new Error(`${name} は 3 つの数値の配列で指定してください。`);
  const numbers = list.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) throw new Error(`${name} に数値でない値が入っています。`);
  return numbers;
}

/** A positive length, validated. */
function lengthOf(value, fallback, name) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error(`${name} を指定してください。`);
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} は 0 より大きい mm の数値で指定してください。`);
  return number;
}

/** A positive integer, clamped. */
function integerOf(value, fallback, name, min, max) {
  const number = Math.round(finite(value, fallback));
  if (!Number.isFinite(number)) throw new Error(`${name} は整数で指定してください。`);
  return Math.min(max, Math.max(min, number));
}

/** Radius from `radius`, `diameter`, or the fallback. */
function radiusOf(entry, fallback) {
  if (entry.radius !== undefined) return lengthOf(entry.radius, undefined, 'radius');
  if (entry.diameter !== undefined) return lengthOf(entry.diameter, undefined, 'diameter') / 2;
  if (fallback === undefined) throw new Error('radius か diameter を指定してください。');
  return fallback;
}

/** Shape parameters for one primitive. */
function shapeParams(entry, type, index, segments) {
  const at = `parts[${index}]`;
  switch (type) {
    case 'box':
    case 'wedge': {
      const size = triple(entry.size, [10, 10, 10], `${at}.size`);
      if (size.some((value) => value <= 0)) throw new Error(`${at}.size は 0 より大きい mm で指定してください。`);
      return { size };
    }
    case 'cylinder':
      return { radius: radiusOf(entry), height: lengthOf(entry.height, 10, `${at}.height`) };
    case 'sphere':
      return {
        radius: radiusOf(entry),
        rings: integerOf(entry.rings, Math.max(8, Math.round(segments / 2)), `${at}.rings`, 4, 128),
      };
    case 'cone':
      return {
        radius: radiusOf(entry),
        radiusTop: entry.radiusTop === undefined ? 0 : Math.max(0, finite(entry.radiusTop, 0)),
        height: lengthOf(entry.height, 10, `${at}.height`),
      };
    case 'torus':
      return {
        radius: radiusOf(entry, 20),
        tube: lengthOf(entry.tube, 5, `${at}.tube`),
        tubeSegments: integerOf(entry.tubeSegments, 24, `${at}.tubeSegments`, 6, 192),
      };
    case 'prism':
      return {
        sides: integerOf(entry.sides, 6, `${at}.sides`, 3, 192),
        radius: radiusOf(entry),
        height: lengthOf(entry.height, 10, `${at}.height`),
      };
    default:
      throw new Error(`${at}.type が未対応です: ${String(entry.type)}（${[...CAD_PRIMITIVES, 'hole'].join(' / ')}）`);
  }
}

/** The array description of one part, if it repeats. */
function arrayOf(entry, index, settings) {
  if (entry.array === undefined || entry.array === null) return undefined;
  const at = `parts[${index}].array`;
  if (typeof entry.array !== 'object') throw new Error(`${at} はオブジェクトで指定してください。`);
  const count = integerOf(entry.array.count, 2, `${at}.count`, 2, settings.maxArray);
  let offset;
  if (entry.array.offset !== undefined) {
    offset = triple(entry.array.offset, [0, 0, 0], `${at}.offset`);
  } else if (entry.array.direction !== undefined) {
    const direction = triple(entry.array.direction, [1, 0, 0], `${at}.direction`);
    const magnitude = Math.hypot(...direction);
    if (magnitude === 0) throw new Error(`${at}.direction がゼロベクトルです。`);
    const spacing = finite(entry.array.spacing, 10);
    offset = direction.map((value) => (value / magnitude) * spacing);
  } else {
    offset = [0, 0, 0];
  }
  if (offset.every((value) => value === 0)) throw new Error(`${at} の offset か direction + spacing を指定してください（間隔 0 では重なります）。`);
  return { count, offset };
}

/** One part, validated and normalised. */
function normalizePart(entry, index, settings) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`parts[${index}] はオブジェクトで指定してください。`);
  }
  const at = `parts[${index}]`;
  const declared = String(entry.type ?? '').trim().toLowerCase();
  const isHole = declared === 'hole';
  const type = isHole ? 'cylinder' : declared;
  if (!CAD_PRIMITIVES.includes(type)) {
    throw new Error(`${at}.type が未対応です: ${declared === '' ? '（未指定）' : declared}（${[...CAD_PRIMITIVES, 'hole'].join(' / ')}）`);
  }
  const segments = integerOf(entry.segments, settings.segments, `${at}.segments`, 3, 192);
  const operation = String(entry.operation ?? (isHole ? 'difference' : 'union')).trim().toLowerCase();
  if (!CAD_OPERATIONS.includes(operation)) {
    throw new Error(`${at}.operation は ${CAD_OPERATIONS.join(' / ')} のいずれかです。`);
  }
  const mirror = entry.mirror === undefined || entry.mirror === null ? undefined : String(entry.mirror).trim().toLowerCase();
  if (mirror !== undefined && AXIS_INDEX[mirror] === undefined) throw new Error(`${at}.mirror は x / y / z のいずれかです。`);
  const scaleValue = entry.scale === undefined
    ? [1, 1, 1]
    : (Array.isArray(entry.scale) ? triple(entry.scale, [1, 1, 1], `${at}.scale`) : [1, 1, 1].map(() => finite(entry.scale, 1)));
  if (scaleValue.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${at}.scale は 0 より大きい数値で指定してください（鏡像は mirror を使ってください）。`);
  }
  const rotation = triple(entry.rotation, [0, 0, 0], `${at}.rotation`);
  let params;
  if (isHole) {
    const axis = String(entry.axis ?? 'z').trim().toLowerCase();
    if (AXIS_INDEX[axis] === undefined) throw new Error(`${at}.axis は x / y / z のいずれかです。`);
    const depth = entry.depth === undefined && entry.height === undefined
      ? undefined
      : lengthOf(entry.depth ?? entry.height, undefined, `${at}.depth`);
    const extra = DRILL_ROTATION[axis];
    params = { radius: radiusOf(entry, 5), height: depth ?? 0 };
    return {
      type,
      params,
      operation,
      position: triple(entry.position, [0, 0, 0], `${at}.position`),
      rotation: [rotation[0] + extra[0], rotation[1] + extra[1], rotation[2] + extra[2]],
      scale: scaleValue,
      mirror,
      segments,
      through: depth === undefined,
      axis,
      source: 'hole',
    };
  }
  params = shapeParams(entry, type, index, segments);
  return {
    type,
    params,
    operation,
    position: triple(entry.position, [0, 0, 0], `${at}.position`),
    rotation,
    scale: scaleValue,
    mirror,
    segments,
    through: false,
    source: type,
  };
}

/**
 * Validate and normalise a part list, expanding arrays into single parts.
 *
 * The first part must be a union: there is nothing to subtract from yet.
 *
 * @param {{ parts: object[] }} input - the tool argument.
 * @param {object} [defaults] - tessellation defaults, usually {@link CAD_DEFAULTS}.
 * @returns {{ parts: object[], segments: number }}
 */
export function normalizeCadSpec(input, defaults = {}) {
  const settings = { ...CAD_DEFAULTS, ...(defaults ?? {}) };
  const raw = Array.isArray(input?.parts) ? input.parts : [];
  if (raw.length === 0) throw new Error('parts を 1 つ以上指定してください。');
  if (raw.length > settings.maxParts) throw new Error(`parts は最大 ${settings.maxParts} 個までです。`);
  const parts = [];
  raw.forEach((entry, index) => {
    const part = normalizePart(entry, index, settings);
    const array = arrayOf(entry, index, settings);
    const copies = array === undefined ? 1 : array.count;
    for (let copy = 0; copy < copies; copy += 1) {
      const offset = array === undefined ? [0, 0, 0] : array.offset.map((value) => value * copy);
      parts.push({
        ...part,
        params: { ...part.params },
        position: [part.position[0] + offset[0], part.position[1] + offset[1], part.position[2] + offset[2]],
        rotation: part.rotation.slice(),
        scale: part.scale.slice(),
      });
    }
  });
  if (parts.length > settings.maxParts) throw new Error(`array を展開すると ${parts.length} パーツになります。最大 ${settings.maxParts} 個までです。`);
  if (parts[0].operation !== 'union') {
    throw new Error('最初のパーツの operation は union にしてください（まだ何も無い所から削り出すことはできません）。');
  }
  const vertices = parts.reduce((total, part) => total + estimatedVertices(part), 0);
  if (vertices > settings.maxVertices) {
    throw new Error(`頂点数が多すぎます（約 ${vertices} 点, 上限 ${settings.maxVertices}）。segments を減らすかパーツを減らしてください。`);
  }
  return { parts, segments: settings.segments };
}

/** A cheap upper bound on the vertices of one part. */
function estimatedVertices(part) {
  switch (part.type) {
    case 'sphere':
      return 2 + part.segments * part.params.rings;
    case 'torus':
      return part.segments * part.params.tubeSegments;
    default:
      return part.segments * 2 + 4;
  }
}

/**
 * The solid operations a part list means, in order, with holes sized to cut
 * right through the rest of the model.
 *
 * @param {{ parts: object[] }} spec - a normalised spec.
 * @returns {{ operation: string, mesh: { vertices: number[][], triangles: number[][] } }[]}
 */
export function buildSolidOps(spec) {
  const built = spec.parts.map((part) => ({ part, mesh: part.through ? undefined : partMesh(part) }));
  const box = boundingBox(built.map((entry) => entry.mesh).filter((mesh) => mesh !== undefined));
  const ops = [];
  for (const entry of built) {
    let mesh = entry.mesh;
    if (mesh === undefined) {
      // A hole without a depth drills all the way through the model.
      const index = AXIS_INDEX[entry.part.axis ?? 'z'];
      const span = box === undefined ? 0 : box.max[index] - box.min[index];
      const height = Math.max(20, span * 4 + 20);
      mesh = partMesh({ ...entry.part, params: { ...entry.part.params, height } });
    }
    ops.push({ operation: entry.part.operation, mesh });
    if (entry.part.mirror !== undefined) {
      ops.push({ operation: entry.part.operation, mesh: reflectMesh(mesh, AXIS_INDEX[entry.part.mirror]) });
    }
  }
  return ops;
}

/**
 * The bounding box a drawing should dimension: the union parts only.
 *
 * A drilled hole is modelled as a long cylinder, so measuring every operation
 * would report the drill's length instead of the plate's thickness.
 *
 * @param {{ operation: string, mesh: object }[]} ops - the solid operations.
 * @returns {{ min: number[], max: number[] } | undefined}
 */
export function modelBoundingBox(ops) {
  const solid = ops.filter((op) => op.operation === 'union');
  const base = solid.length > 0 ? solid : ops;
  return boundingBox(base.map((op) => op.mesh));
}

/**
 * Whether the model needs Blender to be evaluated.
 *
 * A pure union of primitives is written by the JavaScript backend; anything
 * that subtracts or intersects needs a CSG engine, which is Blender.
 *
 * @param {{ operation: string }[]} ops - the solid operations.
 * @returns {boolean} true when Blender is required.
 */
export function needsBlender(ops) {
  return ops.some((op) => op.operation !== 'union');
}

/**
 * The payload `cad_blender.py` consumes: world-space triangle meshes.
 *
 * @param {{ operation: string, mesh: object }[]} ops - the solid operations.
 * @returns {{ operation: string, vertices: number[][], faces: number[][] }[]}
 */
export function solidPayload(ops) {
  return ops.map((op) => ({
    operation: op.operation,
    vertices: op.mesh.vertices.map((point) => point.map((value) => Math.round(value * 1e4) / 1e4)),
    faces: op.mesh.triangles,
  }));
}

// #endregion

// #region Mesh writers

/** Per-triangle outward normal. Degenerate triangles report a zero vector. */
export function triangleNormal(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return [0, 0, 0];
  return [nx / length, ny / length, nz / length];
}

/**
 * Binary STL for one or more meshes. Coordinates stay in millimetres.
 *
 * @param {{ vertices: number[][], triangles: number[][] }[]} meshes - the meshes.
 * @returns {Buffer} the file bytes.
 */
export function encodeBinaryStl(meshes) {
  const total = triangleCount(meshes);
  const buffer = Buffer.alloc(84 + total * 50);
  buffer.fill(0);
  buffer.write('DSH Media Studio CAD (mm)', 0, 80, 'utf8');
  buffer.writeUInt32LE(total, 80);
  let offset = 84;
  for (const mesh of meshes) {
    for (const [i, j, k] of mesh.triangles) {
      const a = mesh.vertices[i];
      const b = mesh.vertices[j];
      const c = mesh.vertices[k];
      if (a === undefined || b === undefined || c === undefined) throw new Error('三角形が存在しない頂点を参照しています。');
      const normal = triangleNormal(a, b, c);
      buffer.writeFloatLE(normal[0], offset);
      buffer.writeFloatLE(normal[1], offset + 4);
      buffer.writeFloatLE(normal[2], offset + 8);
      let cursor = offset + 12;
      for (const point of [a, b, c]) {
        buffer.writeFloatLE(point[0], cursor);
        buffer.writeFloatLE(point[1], cursor + 4);
        buffer.writeFloatLE(point[2], cursor + 8);
        cursor += 12;
      }
      buffer.writeUInt16LE(0, offset + 48);
      offset += 50;
    }
  }
  return buffer;
}

/**
 * Read a binary STL back, for verification and for tests.
 *
 * @param {Buffer} data - the file bytes.
 * @returns {{ triangles: number, bbox: { min: number[], max: number[] }, zeroNormals: number, degenerate: number, ascii: boolean }}
 */
export function readStlBinary(data) {
  if (data.length < 84) throw new Error('STL が短すぎます（84 バイト未満）。');
  const declared = data.readUInt32LE(80);
  const ascii = declared === 0 || data.length !== 84 + declared * 50;
  if (ascii) throw new Error(`バイナリ STL ではありません（申告三角形数 ${declared}, 実サイズ ${data.length}）。`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let zeroNormals = 0;
  let degenerate = 0;
  for (let index = 0; index < declared; index += 1) {
    const base = 84 + index * 50;
    const nx = data.readFloatLE(base);
    const ny = data.readFloatLE(base + 4);
    const nz = data.readFloatLE(base + 8);
    if (nx === 0 && ny === 0 && nz === 0) zeroNormals += 1;
    const points = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const at = base + 12 + corner * 12;
      const point = [data.readFloatLE(at), data.readFloatLE(at + 4), data.readFloatLE(at + 8)];
      points.push(point);
      for (let axis = 0; axis < 3; axis += 1) {
        if (point[axis] < min[axis]) min[axis] = point[axis];
        if (point[axis] > max[axis]) max[axis] = point[axis];
      }
    }
    const normal = triangleNormal(points[0], points[1], points[2]);
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) degenerate += 1;
  }
  return { triangles: declared, bbox: { min, max }, zeroNormals, degenerate, ascii: false };
}

/**
 * Wavefront OBJ for one or more meshes, in millimetres.
 *
 * @param {{ vertices: number[][], triangles: number[][] }[]} meshes - the meshes.
 * @param {string} [name] - object name written into the file.
 * @returns {string} the file text.
 */
export function encodeObj(meshes, name = 'cad') {
  const lines = ['# DSH Media Studio CAD (mm)', `o ${name}`];
  const round = (value) => {
    const fixed = value.toFixed(4);
    return fixed.includes('.') ? fixed.replace(/0+$/u, '').replace(/\.$/u, '') : fixed;
  };
  let offset = 0;
  for (const [index, mesh] of meshes.entries()) {
    if (meshes.length > 1) lines.push(`g part${index + 1}`);
    for (const point of mesh.vertices) lines.push(`v ${round(point[0])} ${round(point[1])} ${round(point[2])}`);
    for (const [a, b, c] of mesh.triangles) lines.push(`f ${offset + a + 1} ${offset + b + 1} ${offset + c + 1}`);
    offset += mesh.vertices.length;
  }
  lines.push('');
  return lines.join('\n');
}

// #endregion

// #region 2D drawing

/**
 * Convex hull of 2D points, counter-clockwise (Andrew's monotone chain).
 *
 * @param {number[][]} points - `[a, b]` pairs.
 * @returns {number[][]} hull points, without a repeated first point.
 */
export function convexHull(points) {
  const unique = [];
  const seen = new Set();
  for (const [a, b] of points) {
    const key = `${Math.round(a * 1e4)}:${Math.round(b * 1e4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([a, b]);
  }
  if (unique.length <= 2) return unique;
  unique.sort((left, right) => (left[0] - right[0]) || (left[1] - right[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Clip a polygon to an axis-aligned rectangle (Sutherland–Hodgman).
 *
 * A drilled hole is modelled as a long cylinder, so its own outline sticks out
 * of the part. Clipping to the silhouette of the solid keeps the drawing
 * honest: a hidden line only ever appears inside the material.
 *
 * @param {number[][]} points - polygon points as `[a, b]` pairs.
 * @param {{ minA: number, maxA: number, minB: number, maxB: number }} rect - the clip window.
 * @returns {number[][]} the clipped polygon, possibly empty.
 */
export function clipPolygonToRect(points, rect) {
  if (points.length < 3) return [];
  const edges = [
    { inside: (point) => point[0] >= rect.minA, cross: (a, b) => crossingX(a, b, rect.minA) },
    { inside: (point) => point[0] <= rect.maxA, cross: (a, b) => crossingX(a, b, rect.maxA) },
    { inside: (point) => point[1] >= rect.minB, cross: (a, b) => crossingY(a, b, rect.minB) },
    { inside: (point) => point[1] <= rect.maxB, cross: (a, b) => crossingY(a, b, rect.maxB) },
  ];
  let output = points;
  for (const edge of edges) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = edge.inside(current);
      const previousInside = edge.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(edge.cross(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(edge.cross(previous, current));
      }
    }
  }
  return output;
}

/** Where a segment crosses the vertical line `a = value`. */
function crossingX(a, b, value) {
  const span = b[0] - a[0];
  const t = span === 0 ? 0 : (value - a[0]) / span;
  return [value, a[1] + (b[1] - a[1]) * t];
}

/** Where a segment crosses the horizontal line `b = value`. */
function crossingY(a, b, value) {
  const span = b[1] - a[1];
  const t = span === 0 ? 0 : (value - a[1]) / span;
  return [a[0] + (b[0] - a[0]) * t, value];
}

/** Build the projected outlines of a model per view: `{ a, b }` silhouette per operation. */
export function buildDrawingViews(ops, views = ['front', 'top', 'right']) {
  const wanted = views.filter((view) => VIEW_GEOMETRY[view] !== undefined && view !== 'iso');
  const list = wanted.length === 0 ? ['front', 'top', 'right'] : wanted;
  return list.map((view) => {
    const [horizontal, vertical] = VIEW_GEOMETRY[view].axes;
    const outlines = ops.map((op) => ({
      operation: op.operation,
      points: convexHull(op.mesh.vertices.map((point) => [point[horizontal], point[vertical]])),
    }));
    const solid = outlines.filter((outline) => outline.operation === 'union');
    const base = solid.length > 0 ? solid.flatMap((outline) => outline.points) : outlines.flatMap((outline) => outline.points);
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [a, b] of base) {
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const window = { minA, maxA, minB, maxB };
    const visible = outlines.map((outline) => (outline.operation === 'union'
      ? outline
      : { operation: outline.operation, points: clipPolygonToRect(outline.points, window) }));
    return {
      view,
      label: VIEW_GEOMETRY[view].label,
      outlines: visible.filter((outline) => outline.points.length >= 2),
      extents: { minA, maxA, minB, maxB, width: maxA - minA, height: maxB - minB },
    };
  });
}

/** Trim trailing zeros so a dimension reads `100` rather than `100.00`. */
export function mm(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** Escape text for SVG / XML. */
function xml(text) {
  return String(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * A dimensioned SVG sheet: front / top / right views, mm dimensions taken from
 * the bounding box of each view, and a title block.
 *
 * @param {object} input - `{ ops, views, title, width, height, date }`.
 * @returns {{ svg: string, scale: number, views: object[] }}
 */
export function buildDrawingSvg(input) {
  const width = Math.max(320, Math.round(finite(input.width, CAD_DEFAULTS.drawingWidth)));
  const height = Math.max(240, Math.round(finite(input.height, CAD_DEFAULTS.drawingHeight)));
  const views = buildDrawingViews(input.ops, input.views);
  const margin = Math.round(Math.min(width, height) * 0.05);
  const gap = Math.round(margin * 0.6);
  const titleHeight = 138;
  const titleWidth = width - margin * 2;
  const cellWidth = (width - margin * 2 - gap * (views.length - 1)) / views.length;
  const cellHeight = height - margin * 2 - titleHeight - gap;

  // One scale for every view, so the sheet reads like a real drawing.
  let scale = Infinity;
  for (const view of views) {
    const { width: viewWidth, height: viewHeight } = view.extents;
    if (Number.isFinite(viewWidth) && viewWidth > 0) scale = Math.min(scale, (cellWidth * 0.52) / viewWidth);
    if (Number.isFinite(viewHeight) && viewHeight > 0) scale = Math.min(scale, (cellHeight * 0.56) / viewHeight);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<rect x="${margin / 2}" y="${margin / 2}" width="${width - margin}" height="${height - margin}" fill="none" stroke="#22252b" stroke-width="1.6"/>`);

  views.forEach((view, index) => {
    const cellX = margin + index * (cellWidth + gap);
    const cellY = margin;
    const drawWidth = Math.max(0, view.extents.width) * scale;
    const drawHeight = Math.max(0, view.extents.height) * scale;
    const left = cellX + (cellWidth - drawWidth) / 2;
    const top = cellY + (cellHeight - drawHeight) / 2;
    const mapX = (a) => left + (a - view.extents.minA) * scale;
    const mapY = (b) => top + (view.extents.maxB - b) * scale;

    parts.push('<g>');
    for (const outline of view.outlines) {
      if (outline.points.length < 2) continue;
      const projected = outline.points.map(([a, b]) => [mapX(a), mapY(b)]);
      const points = projected.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      if (projected.length === 2) {
        parts.push(`<line x1="${projected[0][0].toFixed(2)}" y1="${projected[0][1].toFixed(2)}" x2="${projected[1][0].toFixed(2)}" y2="${projected[1][1].toFixed(2)}" stroke="${outline.operation === 'union' ? '#22252b' : '#7a808c'}" stroke-width="1.6" ${outline.operation === 'union' ? '' : 'stroke-dasharray="6 4"'}/>`);
      } else {
        const closed = `${points} ${projected[0][0].toFixed(2)},${projected[0][1].toFixed(2)}`;
        parts.push(`<polygon points="${closed}" fill="none" stroke="${outline.operation === 'union' ? '#22252b' : '#7a808c'}" stroke-width="1.6" stroke-linejoin="round" ${outline.operation === 'union' ? '' : 'stroke-dasharray="6 4"'}/>`);
      }
    }

    // Centre lines, so a round part reads as round.
    parts.push(`<line x1="${(left - 8).toFixed(2)}" y1="${(top + drawHeight / 2).toFixed(2)}" x2="${(left + drawWidth + 8).toFixed(2)}" y2="${(top + drawHeight / 2).toFixed(2)}" stroke="#b7bcc6" stroke-width="0.8" stroke-dasharray="12 3 2 3"/>`);
    parts.push(`<line x1="${(left + drawWidth / 2).toFixed(2)}" y1="${(top - 8).toFixed(2)}" x2="${(left + drawWidth / 2).toFixed(2)}" y2="${(top + drawHeight + 8).toFixed(2)}" stroke="#b7bcc6" stroke-width="0.8" stroke-dasharray="12 3 2 3"/>`);

    // Horizontal dimension under the view.
    const dimY = top + drawHeight + 30;
    parts.push(`<line x1="${left.toFixed(2)}" y1="${(top + drawHeight + 4).toFixed(2)}" x2="${left.toFixed(2)}" y2="${(dimY + 6).toFixed(2)}" stroke="#22252b" stroke-width="0.9"/>`);
    parts.push(`<line x1="${(left + drawWidth).toFixed(2)}" y1="${(top + drawHeight + 4).toFixed(2)}" x2="${(left + drawWidth).toFixed(2)}" y2="${(dimY + 6).toFixed(2)}" stroke="#22252b" stroke-width="0.9"/>`);
    parts.push(`<line x1="${left.toFixed(2)}" y1="${dimY.toFixed(2)}" x2="${(left + drawWidth).toFixed(2)}" y2="${dimY.toFixed(2)}" stroke="#22252b" stroke-width="0.9" marker-start="url(#tick)" marker-end="url(#tick)"/>`);
    parts.push(`<text x="${(left + drawWidth / 2).toFixed(2)}" y="${(dimY - 7).toFixed(2)}" font-family="Segoe UI, Meiryo, sans-serif" font-size="15" fill="#14161a" text-anchor="middle">${xml(mm(view.extents.width))}</text>`);

    // Vertical dimension to the right of the view.
    const dimX = left + drawWidth + 30;
    parts.push(`<line x1="${(left + drawWidth + 4).toFixed(2)}" y1="${top.toFixed(2)}" x2="${(dimX + 6).toFixed(2)}" y2="${top.toFixed(2)}" stroke="#22252b" stroke-width="0.9"/>`);
    parts.push(`<line x1="${(left + drawWidth + 4).toFixed(2)}" y1="${(top + drawHeight).toFixed(2)}" x2="${(dimX + 6).toFixed(2)}" y2="${(top + drawHeight).toFixed(2)}" stroke="#22252b" stroke-width="0.9"/>`);
    parts.push(`<line x1="${dimX.toFixed(2)}" y1="${top.toFixed(2)}" x2="${dimX.toFixed(2)}" y2="${(top + drawHeight).toFixed(2)}" stroke="#22252b" stroke-width="0.9"/>`);
    parts.push(`<text x="${(dimX + 8).toFixed(2)}" y="${(top + drawHeight / 2 + 5).toFixed(2)}" font-family="Segoe UI, Meiryo, sans-serif" font-size="15" fill="#14161a">${xml(mm(view.extents.height))}</text>`);

    // View label under the dimensions.
    parts.push(`<text x="${(left + drawWidth / 2).toFixed(2)}" y="${(dimY + 34).toFixed(2)}" font-family="Segoe UI, Meiryo, sans-serif" font-size="17" font-weight="600" fill="#22252b" text-anchor="middle">${xml(view.label)}</text>`);
    parts.push('</g>');
  });

  // Title block, bottom right.
  const boxX = width - margin - titleWidth;
  const boxY = height - margin - titleHeight;
  const lines = [
    `図名: ${input.title ?? 'CAD モデル'}`,
    `単位: mm　尺度: 1:${(1 / scale).toFixed(2)}`,
    `外形: ${mm(input.size?.[0] ?? 0)} × ${mm(input.size?.[1] ?? 0)} × ${mm(input.size?.[2] ?? 0)} mm`,
    `パーツ: ${input.partCount ?? 0}　三角形: ${input.triangles ?? 0}`,
    `作成: DSH Media Studio CAD　${input.date ?? ''}`.trimEnd(),
  ];
  parts.push(`<rect x="${boxX.toFixed(2)}" y="${boxY.toFixed(2)}" width="${titleWidth}" height="${titleHeight}" fill="#f6f7f9" stroke="#22252b" stroke-width="1.6"/>`);
  lines.forEach((line, index) => {
    parts.push(`<text x="${(boxX + 16).toFixed(2)}" y="${(boxY + 26 + index * 22).toFixed(2)}" font-family="Segoe UI, Meiryo, sans-serif" font-size="15" fill="#14161a">${xml(line)}</text>`);
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(input.title ?? 'CAD 図面')}">`,
    '<defs><marker id="tick" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 5 0 L 5 10" stroke="#22252b" stroke-width="1.4"/></marker></defs>',
    ...parts,
    '</svg>',
    '',
  ].join('\n');
  return { svg, scale, views };
}

/** DXF header + tables for a millimetre drawing. */
function dxfPreamble(box) {
  const number = (value) => (Math.round(value * 1e4) / 1e4).toString();
  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '9', '$EXTMIN', '10', number(box.min[0]), '20', number(box.min[1]), '30', '0.0',
    '9', '$EXTMAX', '10', number(box.max[0]), '20', number(box.max[1]), '30', '0.0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LTYPE', '70', '2',
    '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed __ __', '72', '65', '73', '2', '40', '6.0', '49', '4.0', '49', '-2.0',
    '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '70', '4',
    '0', 'LAYER', '2', 'OUTLINE', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'HIDDEN', '70', '0', '62', '8', '6', 'DASHED',
    '0', 'LAYER', '2', 'DIM', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'TEXT', '70', '0', '62', '3', '6', 'CONTINUOUS',
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ].join('\n');
}

/**
 * A DXF R12 drawing: orthographic views laid out at 1:1 in millimetres, with
 * outlines, dashed hidden features and dimension text.
 *
 * @param {object} input - `{ ops, views, title, date }`.
 * @returns {{ dxf: string, lines: number, texts: number, box: { min: number[], max: number[] } }}
 */
export function buildDxf(input) {
  const views = buildDrawingViews(input.ops, input.views);
  const number = (value) => (Math.round(value * 1e4) / 1e4).toString();
  const all = views.flatMap((view) => view.outlines.flatMap((outline) => outline.points));
  if (all.length === 0) throw new Error('図面にする形状がありません。');
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const [a, b] of all) {
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  const span = Math.max(maxA - minA, maxB - minB, 1);
  const textHeight = Math.min(10, Math.max(2.5, span * 0.03));
  const entities = [];
  const bounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  let lineCount = 0;
  let textCount = 0;
  const track = (x, y) => {
    if (x < bounds.min[0]) bounds.min[0] = x;
    if (y < bounds.min[1]) bounds.min[1] = y;
    if (x > bounds.max[0]) bounds.max[0] = x;
    if (y > bounds.max[1]) bounds.max[1] = y;
  };
  const line = (layer, x1, y1, x2, y2) => {
    lineCount += 1;
    track(x1, y1);
    track(x2, y2);
    entities.push('0', 'LINE', '8', layer, '10', number(x1), '20', number(y1), '30', '0.0', '11', number(x2), '21', number(y2), '31', '0.0');
  };
  const label = (layer, x, y, value, size = textHeight, centred = false) => {
    textCount += 1;
    track(x, y);
    entities.push(
      '0', 'TEXT', '8', layer, '10', number(x), '20', number(y), '30', '0.0',
      '40', number(size), '1', String(value).replace(/[\r\n]+/gu, ' '), '7', 'STANDARD',
      ...(centred ? ['72', '1', '11', number(x), '21', number(y), '31', '0.0'] : []),
    );
  };
  let offsetX = 0;
  for (const view of views) {
    let viewMinA = Infinity;
    let viewMaxA = -Infinity;
    for (const outline of view.outlines) {
      for (const [a] of outline.points) {
        if (a < viewMinA) viewMinA = a;
        if (a > viewMaxA) viewMaxA = a;
      }
    }
    if (!Number.isFinite(viewMinA)) {
      viewMinA = 0;
      viewMaxA = 0;
    }
    const dx = offsetX - viewMinA;
    for (const outline of view.outlines) {
      const layer = outline.operation === 'union' ? 'OUTLINE' : 'HIDDEN';
      const points = outline.points;
      if (points.length === 1) continue;
      if (points.length === 2) {
        line(layer, points[0][0] + dx, points[0][1], points[1][0] + dx, points[1][1]);
        continue;
      }
      for (let index = 0; index < points.length; index += 1) {
        const [a1, b1] = points[index];
        const [a2, b2] = points[(index + 1) % points.length];
        line(layer, a1 + dx, b1, a2 + dx, b2);
      }
    }
    // Width under the view, with extension lines.
    const bottom = view.extents.minB;
    const dimY = bottom - textHeight * 3;
    line('DIM', viewMinA + dx, dimY, viewMaxA + dx, dimY);
    line('DIM', viewMinA + dx, bottom - textHeight * 0.6, viewMinA + dx, dimY - textHeight * 0.6);
    line('DIM', viewMaxA + dx, bottom - textHeight * 0.6, viewMaxA + dx, dimY - textHeight * 0.6);
    label('DIM', (viewMinA + viewMaxA) / 2 + dx, dimY + textHeight * 0.5, mm(view.extents.width), textHeight, true);
    // Height to the right of the view.
    const dimX = viewMaxA + dx + textHeight * 3;
    line('DIM', dimX, view.extents.minB, dimX, view.extents.maxB);
    line('DIM', view.extents.maxA + dx + textHeight * 0.6, view.extents.minB, dimX + textHeight * 0.6, view.extents.minB);
    line('DIM', view.extents.maxA + dx + textHeight * 0.6, view.extents.maxB, dimX + textHeight * 0.6, view.extents.maxB);
    label('DIM', dimX + textHeight * 0.5, (view.extents.minB + view.extents.maxB) / 2, mm(view.extents.height), textHeight);
    // View label under the dimensions.
    label('TEXT', (viewMinA + viewMaxA) / 2 + dx, bottom - textHeight * 6, view.label, textHeight * 1.2, true);
    offsetX = viewMaxA + dx + Math.max(span * 0.2, textHeight * 10);
  }
  const box = {
    min: [Number.isFinite(bounds.min[0]) ? bounds.min[0] : 0, Number.isFinite(bounds.min[1]) ? bounds.min[1] : 0],
    max: [Number.isFinite(bounds.max[0]) ? bounds.max[0] : 0, Number.isFinite(bounds.max[1]) ? bounds.max[1] : 0],
  };
  const dxf = [
    dxfPreamble(box),
    entities.join('\n'),
    '0', 'ENDSEC',
    '0', 'EOF',
    '',
  ].join('\n');
  return { dxf, lines: lineCount, texts: textCount, box };
}

/**
 * Read a DXF back into entity records, for verification and for tests.
 *
 * @param {string} input - the DXF file text.
 * @returns {{ entities: object[], version: string | undefined, units: number | undefined, sections: string[] }}
 */
export function parseDxf(input) {
  const lines = String(input).split(/\r?\n/u);
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index]);
    if (!Number.isFinite(code)) break;
    pairs.push([code, lines[index + 1]]);
  }
  const result = { entities: [], version: undefined, units: undefined, sections: [] };
  let section;
  let current;
  const flush = () => {
    if (current !== undefined && ['LINE', 'TEXT'].includes(current.type)) result.entities.push(current);
    current = undefined;
  };
  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index];
    if (code === 0) {
      flush();
      if (value === 'SECTION') {
        section = pairs[index + 1]?.[1];
        if (section !== undefined) result.sections.push(section);
        continue;
      }
      if (value === 'ENDSEC' || value === 'EOF') {
        section = undefined;
        continue;
      }
      current = { type: value, layer: '', x: 0, y: 0 };
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$ACADVER') {
      result.version = pairs[index + 1]?.[1];
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') {
      result.units = Number(pairs[index + 1]?.[1]);
      continue;
    }
    if (current === undefined) continue;
    if (code === 8) current.layer = value;
    else if (code === 10) current.x = Number(value);
    else if (code === 20) current.y = Number(value);
    else if (code === 11) current.x2 = Number(value);
    else if (code === 21) current.y2 = Number(value);
    else if (code === 1) current.text = value;
    else if (code === 40) current.height = Number(value);
  }
  flush();
  return result;
}

// #endregion

// #region Backend: find Blender, run it

/** Directories Blender installs into on Windows, best first. */
export function blenderRoots() {
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Blender Foundation'),
    'C:\\Program Files\\Blender Foundation',
  ];
  return roots.filter((root) => root !== '' && existsSync(root));
}

/**
 * Newest `blender.exe` under each Blender install root.
 *
 * @returns {Promise<string[]>} candidate executables, newest version first.
 */
export async function blenderExecutables() {
  const found = [];
  for (const root of blenderRoots()) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && /^Blender /u.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names) {
      const executable = join(root, name, 'blender.exe');
      if (existsSync(executable)) found.push(executable);
    }
  }
  return found;
}

/** Truth from `blender --version`, with a short timeout. */
async function blenderAnswers(executable) {
  try {
    const run = await runProcess(executable, ['--version'], { timeoutMs: 20000 });
    return run.code === 0 && /Blender/u.test(run.stdout);
  } catch {
    return false;
  }
}

/**
 * Resolve the Blender executable: configured path, then `BLENDER_PATH`, then
 * the usual install folders, then `blender` on PATH.
 *
 * @param {string} [configured] - `cad.blenderPath` from the row config.
 * @returns {Promise<string | undefined>} the executable, or undefined.
 */
export async function findBlender(configured) {
  const explicit = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined;
  try {
    if (explicit !== undefined) {
      if (explicit.includes('/') || explicit.includes('\\')) return existsSync(explicit) ? explicit : undefined;
      return (await blenderAnswers(explicit)) ? explicit : undefined;
    }
    const fromEnv = process.env.BLENDER_PATH;
    if (fromEnv !== undefined && fromEnv.trim() !== '' && existsSync(fromEnv.trim())) return fromEnv.trim();
    for (const executable of await blenderExecutables()) {
      if (await blenderAnswers(executable)) return executable;
    }
    if (await blenderAnswers('blender')) return 'blender';
    return undefined;
  } catch {
    return undefined;
  }
}

/** Path of the Python file that runs inside Blender. */
export function blenderScriptPath() {
  return fileURLToPath(new URL('./cad_blender.py', import.meta.url));
}

/** The last `limit` characters of a stream, for an error message. */
export function tail(text, limit = 2048) {
  const value = String(text ?? '');
  return value.length <= limit ? value : value.slice(-limit);
}

/**
 * Run `cad_blender.py` once and read back its result JSON.
 *
 * @param {object} input - `{ blender, script, payload, timeoutMs, signal, directory }`.
 * @returns {Promise<object>} the result object the script wrote.
 */
export async function runCadBlender(input) {
  const { directory } = input;
  const specPath = join(directory, 'spec.json');
  const resultPath = join(directory, 'result.json');
  const payload = { ...input.payload, resultPath };
  await writeFile(specPath, JSON.stringify(payload), 'utf8');
  const run = await runProcess(input.blender, ['-b', '--factory-startup', '--python', input.script, '--', specPath], {
    timeoutMs: input.timeoutMs ?? CAD_DEFAULTS.timeoutMs,
    cwd: directory,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let result;
  try {
    result = JSON.parse(await readFile(resultPath, 'utf8'));
  } catch {
    const message = tail(`${run.stderr}\n${run.stdout}`);
    throw new Error(`Blender の実行に失敗しました（終了コード ${run.code}）。${message.trim() === '' ? '' : `\n${message}`}`);
  }
  if (result?.ok !== true) {
    const message = tail(`${result?.error ?? ''}\n${result?.traceback ?? ''}`);
    throw new Error(`Blender で形状を作れませんでした: ${message.trim()}`);
  }
  return result;
}

// #endregion

// #region Options

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A positive integer, or the fallback. */
function positive(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Normalise the `cad` section of the row config.
 *
 * @param {object} config - the raw row config.
 * @param {object} options - resolved plugin options.
 * @param {object} helpers - `{ safeRelativeDir }` from `index.js`.
 * @returns {object} the cad options.
 */
export function resolveCadOptions(config, options, helpers) {
  const source = config?.cad ?? {};
  const outputFallback = nonEmpty(options?.outputDir) ?? 'media-studio';
  const outputDir = typeof helpers?.safeRelativeDir === 'function'
    ? helpers.safeRelativeDir(nonEmpty(source.outputDir) ?? outputFallback)
    : (nonEmpty(source.outputDir) ?? outputFallback);
  const engine = nonEmpty(source.engine);
  return {
    blenderPath: nonEmpty(source.blenderPath),
    outputDir,
    timeoutMs: positive(source.timeoutMs, CAD_DEFAULTS.timeoutMs),
    width: positive(source.width, CAD_DEFAULTS.drawingWidth, 320, 8192),
    height: positive(source.height, CAD_DEFAULTS.drawingHeight, 240, 8192),
    segments: positive(source.segments, CAD_DEFAULTS.segments, 3, 192),
    engine: engine !== undefined && CAD_ENGINES.includes(engine) ? engine : CAD_DEFAULTS.engine,
    lineWidth: Number.isFinite(Number(source.lineWidth)) && Number(source.lineWidth) > 0
      ? Number(source.lineWidth)
      : CAD_DEFAULTS.lineWidth,
  };
}

/** Resolve the session working directory, without trusting `helpers`. */
async function sessionCwd(helpers, ctx, exec) {
  if (typeof helpers?.resolveSessionCwd === 'function') return await helpers.resolveSessionCwd(ctx, exec);
  return process.cwd();
}

/** `formatBytes`, with a local fallback for tests. */
function bytesLabel(helpers, value) {
  if (typeof helpers?.formatBytes === 'function') return helpers.formatBytes(value);
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

/** A path as the tool result shows it: relative to the session, forward slashes. */
export function displayPath(cwd, file) {
  const rel = relative(cwd, file);
  if (rel === '' || rel.startsWith('..')) return file.split(sep).join('/');
  return rel.split(sep).join('/');
}

/** A timestamp for file names. */
export function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** A file-safe stem from a user-supplied name. */
export function safeStem(value, fallback = 'cad') {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  const cleaned = text.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned === '' ? fallback : cleaned.slice(0, 60);
}

/** The media type for an extension. */
export function mediaTypeFor(extension) {
  return MEDIA_TYPES[String(extension).toLowerCase()] ?? 'application/octet-stream';
}

// #endregion

// #region Tools

const AXIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['min', 'max', 'size'],
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
    size: { type: 'number' },
  },
};

const BBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'z', 'size', 'center'],
  properties: {
    x: AXIS_SCHEMA,
    y: AXIS_SCHEMA,
    z: AXIS_SCHEMA,
    size: { type: 'array', items: { type: 'number' } },
    center: { type: 'array', items: { type: 'number' } },
  },
};

const PART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      enum: [...CAD_PRIMITIVES, 'hole'],
      description: 'Primitive to build. box, wedge take size; cylinder, cone, prism take radius and height; sphere takes radius; torus takes radius and tube. hole is a cylinder drilled through the solid.',
    },
    operation: { type: 'string', enum: CAD_OPERATIONS, description: 'How this part combines with the solid so far: union (default), difference to cut it away, or intersect to keep only the overlap. The first part must be a union.' },
    size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Width, depth and height in mm, for box and wedge.' },
    radius: { type: 'number', description: 'Radius in mm. Cone and prism use it at the base / as the circumradius, torus as the ring radius.' },
    diameter: { type: 'number', description: 'Diameter in mm; an alternative to radius.' },
    height: { type: 'number', description: 'Height in mm, for cylinder, cone and prism.' },
    radiusTop: { type: 'number', description: 'Top radius in mm for a truncated cone. Defaults to 0, a point.' },
    tube: { type: 'number', description: 'Tube radius in mm for torus.' },
    tubeSegments: { type: 'integer', description: 'Tessellation around the tube of a torus.' },
    sides: { type: 'integer', description: 'Number of sides for prism (3 or more).' },
    segments: { type: 'integer', description: 'Tessellation of the rounded direction. Defaults to the plugin config, 48.' },
    rings: { type: 'integer', description: 'Tessellation of a sphere from pole to pole.' },
    position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Centre of the shape in mm, [x, y, z].' },
    rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'XYZ Euler rotation in degrees.' },
    scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Scale applied before rotation. Use mirror for reflections.' },
    mirror: { type: 'string', enum: ['x', 'y', 'z'], description: 'Also add a copy reflected across this axis, for symmetric parts and hole patterns.' },
    axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Drill axis for hole. Defaults to z.' },
    depth: { type: 'number', description: 'Drilled depth in mm for hole. Omit to drill all the way through.' },
    array: {
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: {
        count: { type: 'integer', description: 'Number of copies, including the first one.' },
        offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Offset in mm from one copy to the next.' },
        direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Direction the copies march in.' },
        spacing: { type: 'number', description: 'Distance in mm between copies, used with direction.' },
      },
    },
  },
};

const PARTS_PARAMETER = {
  type: 'array',
  minItems: 1,
  maxItems: CAD_DEFAULTS.maxParts,
  description: 'The parts of the model, combined in order. Every primitive is centred on its position; units are mm.',
  items: PART_SCHEMA,
};

/** The JSON Schema of a mesh file result. */
function fileSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'path', 'bytes', 'mediaType'],
    properties: {
      name: { type: 'string' },
      path: { type: 'string' },
      bytes: { type: 'integer' },
      mediaType: { type: 'string' },
      ...extra,
    },
  };
}

/** Shared geometry fields of a model result. */
function modelOutputSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'path', 'bytes', 'mediaType', 'format', 'triangles', 'vertices', 'bbox', 'backend', 'parts'],
    properties: {
      name: { type: 'string' },
      path: { type: 'string' },
      bytes: { type: 'integer' },
      mediaType: { type: 'string' },
      format: { type: 'string' },
      triangles: { type: 'integer' },
      vertices: { type: 'integer' },
      parts: { type: 'integer' },
      backend: { type: 'string' },
      bbox: BBOX_SCHEMA,
      ...extra,
    },
  };
}

/** Write bytes into the session's output directory and describe the file. */
async function saveFile(cwd, directory, name, data) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, data);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return {
    name,
    path: displayPath(cwd, file),
    file,
    bytes: Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data)),
    mediaType: mediaTypeFor(extension),
  };
}

/** Describe exported bytes: `{ name, path, bytes, mediaType }`, without `file`. */
function describeFile(saved) {
  return { name: saved.name, path: saved.path, bytes: saved.bytes, mediaType: saved.mediaType };
}

/**
 * Build a solid and write it in one mesh format.
 *
 * Options: `{ spec, ops, format, name, cwd, directory, cad, helpers, ctx, exec }`.
 */
async function writeSolid(input) {
  const { format } = input;
  const extension = format;
  const name = `${input.name}-${timestamp()}-${randomBytes(2).toString('hex')}.${extension}`;
  const ops = input.ops;
  const booleans = needsBlender(ops);
  if (format === 'glb' || format === 'ply' || booleans) {
    const blender = await findBlender(input.cad.blenderPath);
    if (blender === undefined) {
      if (booleans) {
        throw new Error([
          'ブーリアン演算（difference / intersect / hole）と GLB / PLY の書き出しには Blender が必要です。',
          'Blender が見つかりませんでした。cordis.patch.yml の cad.blenderPath か環境変数 BLENDER_PATH に blender.exe のフルパスを指定してください。',
          'Boolean operations and GLB / PLY export need Blender; a plain union of primitives can be written as STL or OBJ without it.',
        ].join(' '));
      }
      throw new Error('GLB / PLY の書き出しには Blender が必要です。Blender が見つかりませんでした（cad.blenderPath か BLENDER_PATH を設定してください）。STL / OBJ なら Blender 無しでも書き出せます。');
    }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-media-studio-cad-'));
    try {
      const target = join(directory, `solid.${extension}`);
      const result = await runCadBlender({
        blender,
        script: blenderScriptPath(),
        directory,
        timeoutMs: input.cad.timeoutMs,
        signal: input.exec?.signal,
        payload: {
          mode: 'solid',
          format,
          outputPath: target,
          solids: solidPayload(ops),
        },
      });
      if (!existsSync(target)) {
        throw new Error(`Blender が ${format} を書き出しませんでした（${target}）。`);
      }
      const data = await readFile(target);
      return {
        name,
        file: target,
        bytes: data.byteLength,
        mediaType: mediaTypeFor(extension),
        triangles: Number(result.triangles ?? 0),
        vertices: Number(result.vertices ?? 0),
        bbox: result.bbox,
        backend: 'blender',
        data,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  // JavaScript backend: a plain union of primitives.
  const data = format === 'obj'
    ? Buffer.from(encodeObj(ops.map((op) => op.mesh), input.name), 'utf8')
    : encodeBinaryStl(ops.map((op) => op.mesh));
  const box = modelBoundingBox(ops);
  return {
    name,
    file: undefined,
    bytes: data.byteLength,
    mediaType: mediaTypeFor(extension),
    triangles: triangleCount(ops.map((op) => op.mesh)),
    vertices: vertexCount(ops.map((op) => op.mesh)),
    bbox: box,
    backend: 'javascript',
    data,
  };
}

/** `cad_model`: a parametric solid, written as STL / OBJ / GLB / PLY. */
function cadModelTool(ctx, options, cad, helpers) {
  return {
    name: 'cad_model',
    description: [
      'Build a parametric 3D solid and write it as a mesh file: binary STL (mm), OBJ, GLB or PLY.',
      'A model is a list of parts combined in order: box, cylinder, sphere, cone, torus, wedge and prism',
      'primitives with position / rotation / scale, union / difference / intersect operations, drilling',
      'holes, and array / mirror repetition. Coordinates are millimetres and every primitive is centred',
      'on its position. Use it for a physical part the user wants to print or machine: a plate with holes,',
      'an enclosure, a bracket, a gear blank. The result reports triangles and the bounding box, so the',
      'size can be checked. Boolean operations need Blender; a plain union does not.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['parts'],
      properties: {
        parts: PARTS_PARAMETER,
        format: { type: 'string', enum: CAD_SOLID_FORMATS, description: 'Output format. Defaults to stl (binary, millimetres).' },
        name: { type: 'string', description: 'Base name for the file. Defaults to cad.' },
      },
    },
    output: {
      schema: modelOutputSchema(),
      render(_args, value) {
        const box = value.bbox;
        return [{
          type: 'text',
          text: [
            `3D モデルを作成しました（${value.parts} パーツ, ${value.triangles} 三角形,`,
            `${mm(box.x.size)} × ${mm(box.y.size)} × ${mm(box.z.size)} mm, ${bytesLabel(helpers, value.bytes)}）: ${value.path ?? value.name}`,
          ].join(' '),
        }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const spec = normalizeCadSpec({ parts: args?.parts }, cad);
      const ops = buildSolidOps(spec);
      const format = CAD_SOLID_FORMATS.includes(args?.format) ? args.format : 'stl';
      const stem = safeStem(args?.name, 'cad');
      const cwd = await sessionCwd(helpers, ctx, exec);
      const directory = join(cwd, cad.outputDir);
      const built = await writeSolid({ spec, ops, format, name: stem, cwd, directory, cad, helpers, ctx, exec });
      const saved = await saveFile(cwd, directory, built.name, built.data);
      return {
        name: saved.name,
        path: saved.path,
        bytes: saved.bytes,
        mediaType: saved.mediaType,
        format,
        triangles: built.triangles,
        vertices: built.vertices,
        parts: spec.parts.length,
        backend: built.backend,
        bbox: bboxReport(built.bbox),
      };
    },
    presentCall(args) {
      const count = Array.isArray(args?.parts) ? args.parts.length : 0;
      return { card: 'generic', title: `CAD model: ${count} parts`, kind: 'other' };
    },
  };
}

/** `cad_drawing`: PNG views rendered by Blender, and an SVG sheet in pure JS. */
function cadDrawingTool(ctx, options, cad, helpers) {
  return {
    name: 'cad_drawing',
    description: [
      'Draw a technical drawing of a parametric solid: front, top, right and isometric views, plus a',
      'dimensioned SVG sheet with the measurements taken from the model.',
      'Use it when the user wants to see the shape or needs a drawing for a workshop: a plate with a',
      'hole pattern, a bracket, an enclosure. Views are orthographic and line-drawn (white background,',
      'cavity shading or Blender Freestyle outlines). The SVG sheet works without Blender; the PNG',
      'views need it.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['parts'],
      properties: {
        parts: PARTS_PARAMETER,
        views: {
          type: 'array',
          items: { type: 'string', enum: CAD_VIEWS },
          description: 'Views to render as PNG. Defaults to front, top, right and iso.',
        },
        format: { type: 'string', enum: CAD_DRAWING_FORMATS, description: 'png, svg, or both. Defaults to both.' },
        width: { type: 'integer', description: 'Image width in pixels. Defaults to the plugin config, 1600.' },
        height: { type: 'integer', description: 'Image height in pixels. Defaults to the plugin config, 1200.' },
        engine: { type: 'string', enum: CAD_ENGINES, description: 'workbench (shaded with cavity) or freestyle (pure line art). Defaults to the plugin config.' },
        title: { type: 'string', description: 'Title written in the title block of the SVG sheet.' },
        name: { type: 'string', description: 'Base name for the files. Defaults to drawing.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'bytes', 'mediaType', 'files', 'bbox', 'triangles', 'vertices', 'backend', 'parts'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          files: { type: 'array', items: fileSchema({ view: { type: 'string' } }) },
          triangles: { type: 'integer' },
          vertices: { type: 'integer' },
          parts: { type: 'integer' },
          backend: { type: 'string' },
          bbox: BBOX_SCHEMA,
        },
      },
      render(_args, value) {
        const pngs = value.files.filter((file) => file.mediaType === 'image/png');
        const svg = value.files.find((file) => file.mediaType === 'image/svg+xml');
        const box = value.bbox;
        const parts = [
          `図面を作成しました（${value.parts} パーツ, 外形 ${mm(box.x.size)} × ${mm(box.y.size)} × ${mm(box.z.size)} mm）`,
        ];
        if (pngs.length > 0) parts.push(`PNG ${pngs.length} 枚: ${pngs.map((file) => file.path ?? file.name).join(', ')}`);
        if (svg !== undefined) parts.push(`寸法入り SVG: ${svg.path ?? svg.name}`);
        return [{ type: 'text', text: parts.join('\n') }];
      },
      presentationMeta(_args, value) {
        const first = value.files.find((file) => file.mediaType === 'image/png') ?? value.files[0];
        if (first === undefined) return { name: value.name };
        return first.path === undefined ? { name: first.name } : { path: first.path };
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const spec = normalizeCadSpec({ parts: args?.parts }, cad);
      const ops = buildSolidOps(spec);
      const views = Array.isArray(args?.views) && args.views.length > 0
        ? args.views.filter((view) => CAD_VIEWS.includes(view))
        : CAD_VIEWS.slice();
      const wanted = views.length > 0 ? views : CAD_VIEWS.slice();
      const orthographic = wanted.filter((view) => view !== 'iso');
      const format = CAD_DRAWING_FORMATS.includes(args?.format) ? args.format : 'both';
      const width = positive(args?.width, cad.width, 320, 8192);
      const height = positive(args?.height, cad.height, 240, 8192);
      const engine = CAD_ENGINES.includes(args?.engine) ? args.engine : cad.engine;
      const title = nonEmpty(args?.title) ?? 'CAD 図面';
      const stem = safeStem(args?.name, 'drawing');
      const cwd = await sessionCwd(helpers, ctx, exec);
      const directory = join(cwd, cad.outputDir);
      const box = modelBoundingBox(ops);
      const stamp = timestamp();
      const suffix = randomBytes(2).toString('hex');
      const files = [];
      let backend = 'javascript';
      let triangles = triangleCount(ops.map((op) => op.mesh));
      let vertices = vertexCount(ops.map((op) => op.mesh));
      let measured = box;

      if (format !== 'svg') {
        const blender = await findBlender(cad.blenderPath);
        if (blender === undefined) {
          if (format === 'png') {
            throw new Error('PNG の図面レンダリングには Blender が必要です。Blender が見つかりませんでした（cad.blenderPath か BLENDER_PATH を設定してください）。format を svg にすると Blender 無しでも図面を書き出せます。');
          }
        } else {
          const temporary = await mkdtemp(join(tmpdir(), 'dsh-media-studio-cad-view-'));
          try {
            const result = await runCadBlender({
              blender,
              script: blenderScriptPath(),
              directory: temporary,
              timeoutMs: cad.timeoutMs,
              signal: exec?.signal,
              payload: {
                mode: 'drawing',
                views: wanted,
                outputDir: temporary,
                prefix: 'view',
                width,
                height,
                engine,
                lineWidth: cad.lineWidth,
                solids: solidPayload(ops),
              },
            });
            backend = 'blender';
            triangles = Number(result.triangles ?? triangles);
            vertices = Number(result.vertices ?? vertices);
            if (result.bbox !== undefined) measured = result.bbox;
            for (const rendered of Array.isArray(result.files) ? result.files : []) {
              const data = await readFile(rendered.path);
              const name = `${stem}-${stamp}-${suffix}-${rendered.view}.png`;
              const saved = await saveFile(cwd, directory, name, data);
              files.push({ ...describeFile(saved), view: String(rendered.view) });
            }
          } finally {
            await rm(temporary, { recursive: true, force: true });
          }
        }
      }

      if (format !== 'png') {
        const drawing = buildDrawingSvg({
          ops,
          views: orthographic,
          title,
          width,
          height,
          size: [0, 1, 2].map((axis) => (measured === undefined ? 0 : measured.max[axis] - measured.min[axis])),
          partCount: spec.parts.length,
          triangles,
          date: new Date().toISOString().slice(0, 10),
        });
        const name = `${stem}-${stamp}-${suffix}.svg`;
        const saved = await saveFile(cwd, directory, name, Buffer.from(drawing.svg, 'utf8'));
        files.push({ ...describeFile(saved), view: 'sheet' });
      }

      const primary = files[0];
      if (primary === undefined) throw new Error('図面を 1 枚も作成できませんでした。');
      return {
        name: primary.name,
        path: primary.path,
        bytes: primary.bytes,
        mediaType: primary.mediaType,
        files: files.map((file) => ({
          name: file.name,
          path: file.path,
          bytes: file.bytes,
          mediaType: file.mediaType,
          ...(file.view === undefined ? {} : { view: file.view }),
        })),
        triangles,
        vertices,
        parts: spec.parts.length,
        backend,
        bbox: bboxReport(measured),
      };
    },
    presentCall(args) {
      const count = Array.isArray(args?.parts) ? args.parts.length : 0;
      return { card: 'generic', title: `CAD drawing: ${count} parts`, kind: 'other' };
    },
  };
}

/** `cad_export`: the same part list, written in another format. */
function cadExportTool(ctx, options, cad, helpers) {
  return {
    name: 'cad_export',
    description: [
      'Export a parametric solid in another format, regenerated deterministically from the same part',
      'list: STL, OBJ, GLB, PLY, and the 2D formats DXF and SVG.',
      'The part list is the model, so there is no file to keep between calls: pass the same parts you',
      'gave cad_model. Use it to hand a model to a slicer or CAD program, or to get a DXF for a',
      'laser cutter.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['parts', 'format'],
      properties: {
        parts: PARTS_PARAMETER,
        format: { type: 'string', enum: CAD_FORMATS, description: 'Target format. stl / obj / glb / ply are meshes; dxf / svg are 2D drawings.' },
        views: {
          type: 'array',
          items: { type: 'string', enum: CAD_VIEWS },
          description: 'Views to include for dxf / svg. Defaults to front, top and right.',
        },
        title: { type: 'string', description: 'Title written into a dxf / svg drawing.' },
        name: { type: 'string', description: 'Base name for the file. Defaults to cad.' },
      },
    },
    output: {
      schema: modelOutputSchema(),
      render(_args, value) {
        const box = value.bbox;
        return [{
          type: 'text',
          text: `CAD モデルを ${String(value.format).toUpperCase()} で書き出しました（${value.parts} パーツ, ${value.triangles} 三角形, ${mm(box.x.size)} × ${mm(box.y.size)} × ${mm(box.z.size)} mm, ${bytesLabel(helpers, value.bytes)}）: ${value.path ?? value.name}`,
        }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const spec = normalizeCadSpec({ parts: args?.parts }, cad);
      const ops = buildSolidOps(spec);
      const format = CAD_FORMATS.includes(args?.format) ? args.format : undefined;
      if (format === undefined) throw new Error(`format は ${CAD_FORMATS.join(' / ')} のいずれかです。`);
      const stem = safeStem(args?.name, 'cad');
      const cwd = await sessionCwd(helpers, ctx, exec);
      const directory = join(cwd, cad.outputDir);
      const box = modelBoundingBox(ops);
      const triangles = triangleCount(ops.map((op) => op.mesh));
      const vertices = vertexCount(ops.map((op) => op.mesh));
      const stamp = timestamp();
      const suffix = randomBytes(2).toString('hex');

      if (CAD_SOLID_FORMATS.includes(format)) {
        const built = await writeSolid({ spec, ops, format, name: stem, cwd, directory, cad, helpers, ctx, exec });
        const saved = await saveFile(cwd, directory, built.name, built.data);
        return {
          name: saved.name,
          path: saved.path,
          bytes: saved.bytes,
          mediaType: saved.mediaType,
          format,
          triangles: built.triangles,
          vertices: built.vertices,
          parts: spec.parts.length,
          backend: built.backend,
          bbox: bboxReport(built.bbox),
        };
      }

      const views = Array.isArray(args?.views) && args.views.length > 0
        ? args.views.filter((view) => CAD_VIEWS.includes(view))
        : ['front', 'top', 'right'];
      const title = nonEmpty(args?.title) ?? 'CAD 図面';
      let data;
      if (format === 'dxf') {
        data = Buffer.from(buildDxf({ ops, views, title }).dxf, 'utf8');
      } else {
        const name = `${stem}-${stamp}-${suffix}.svg`;
        const drawing = buildDrawingSvg({
          ops,
          views,
          title,
          width: cad.width,
          height: cad.height,
          size: [0, 1, 2].map((axis) => (box === undefined ? 0 : box.max[axis] - box.min[axis])),
          partCount: spec.parts.length,
          triangles,
          date: new Date().toISOString().slice(0, 10),
        });
        data = Buffer.from(drawing.svg, 'utf8');
        const saved = await saveFile(cwd, directory, name, data);
        return {
          name: saved.name,
          path: saved.path,
          bytes: saved.bytes,
          mediaType: saved.mediaType,
          format,
          triangles,
          vertices,
          parts: spec.parts.length,
          backend: 'javascript',
          bbox: bboxReport(box),
        };
      }
      const name = `${stem}-${stamp}-${suffix}.${format}`;
      const saved = await saveFile(cwd, directory, name, data);
      return {
        name: saved.name,
        path: saved.path,
        bytes: saved.bytes,
        mediaType: saved.mediaType,
        format,
        triangles,
        vertices,
        parts: spec.parts.length,
        backend: 'javascript',
        bbox: bboxReport(box),
      };
    },
    presentCall(args) {
      const count = Array.isArray(args?.parts) ? args.parts.length : 0;
      return { card: 'generic', title: `CAD export: ${count} parts`, kind: 'other' };
    },
  };
}

/**
 * Register the v3 CAD tools on the plugin context.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {object} config - the raw row config; the `cad` section configures this module.
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers - small utilities owned by `index.js`.
 * @returns {void}
 */
export function registerCadTools(ctx, options, config, helpers) {
  const cad = resolveCadOptions(config, options, helpers);
  const tools = [
    cadModelTool(ctx, options, cad, helpers),
    cadDrawingTool(ctx, options, cad, helpers),
    cadExportTool(ctx, options, cad, helpers),
  ];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
  }
}

// #endregion
