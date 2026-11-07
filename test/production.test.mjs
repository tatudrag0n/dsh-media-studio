import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import { assetDirectory, assetKind, listAssets, removeAsset, saveAsset } from '../assets.js';
import {
  DEFAULT_PRODUCTION_FPS,
  DEFAULT_PRODUCTION_HEIGHT,
  DEFAULT_PRODUCTION_WIDTH,
  MAX_PRODUCTION_SCENES,
  PRODUCTION_FORMATS,
  PRODUCTION_SCENE_TYPES,
  PRODUCTION_TRANSITIONS,
  parseProductionSpec,
  renderProduction,
} from '../production.js';

const PYTHON = 'C:\\Users\\tatud\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const FFMPEG = 'C:\\ProgramData\\ffmpeg.exe';

const OPTIONS = {
  video: { pythonPath: PYTHON, ffmpegPath: FFMPEG, timeoutMs: 300000 },
  motion: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, seconds: 1, fps: 12, timeoutMs: 300000 },
  production: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, fps: 12, timeoutMs: 300000 },
};

/** Minimal Host context: records the tools the plugin registers. */
function fakeCtx(services = {}) {
  const tools = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
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
    connection: { fetch: { register: () => async () => {} } },
  };
  return { ctx, tools };
}

/** True when this machine can draw frames. */
function hasPython() {
  return process.platform === 'win32';
}

/** A small PNG made with Pillow, used as a material. */
async function writePicture(path, colour) {
  const script = [
    'import sys',
    'from PIL import Image',
    'image = Image.new("RGB", (320, 180), eval(sys.argv[2]))',
    'image.save(sys.argv[1])',
  ].join('\n');
  const { runProcess } = await import('../video.js');
  const run = await runProcess(PYTHON, ['-c', script, path, colour], { timeoutMs: 60000 });
  assert.equal(run.code, 0, run.stderr);
  return path;
}

test('the production tables name the kinds of scene a cut can hold', () => {
  assert.deepEqual(PRODUCTION_SCENE_TYPES, ['template', 'image', 'clip']);
  assert.deepEqual(PRODUCTION_TRANSITIONS, ['cut', 'fade']);
  assert.deepEqual(PRODUCTION_FORMATS, ['mp4', 'webm']);
  assert.equal(MAX_PRODUCTION_SCENES, 12);
});

test('parseProductionSpec fills the defaults and keeps the scene order', () => {
  const spec = parseProductionSpec({
    scenes: [
      { type: 'template', template: 'title', text: 'First' },
      { type: 'template', template: 'lower_third', text: 'Second', duration: 2, transition: 'fade' },
    ],
  });
  assert.equal(spec.scenes.length, 2);
  assert.equal(spec.scenes[0].template, 'title');
  assert.equal(spec.scenes[0].duration, 3);
  assert.equal(spec.scenes[0].transition, 'cut');
  assert.equal(spec.scenes[1].duration, 2);
  assert.equal(spec.width, DEFAULT_PRODUCTION_WIDTH);
  assert.equal(spec.height, DEFAULT_PRODUCTION_HEIGHT);
  assert.equal(spec.fps, DEFAULT_PRODUCTION_FPS);
});

test('parseProductionSpec refuses an empty or unknown scene list', () => {
  assert.throws(() => parseProductionSpec({ scenes: [] }));
  assert.throws(() => parseProductionSpec({ scenes: [{ type: 'hologram' }] }));
  assert.throws(() => parseProductionSpec({ scenes: [{ type: 'template', template: 'nope' }] }));
  const many = Array.from({ length: MAX_PRODUCTION_SCENES + 1 }, () => ({ type: 'template', template: 'title' }));
  assert.throws(() => parseProductionSpec({ scenes: many }));
});

test('the material library keeps a file, lists it and removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assets-'));
  try {
    const directory = assetDirectory({ assets: { directory: join(root, 'assets') } });
    const record = await saveAsset(directory, { name: 'logo.png', data: new Uint8Array([1, 2, 3, 4]) });
    assert.equal(record.kind, 'image');
    assert.equal(record.bytes, 4);
    assert.match(record.fileName, /^.+_logo\.png$/u);
    const listed = await listAssets(directory);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, record.id);
    assert.equal(await removeAsset(directory, record.id), true);
    assert.equal((await listAssets(directory)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the material kind follows the file name', () => {
  assert.equal(assetKind('photo.png'), 'image');
  assert.equal(assetKind('clip.mp4'), 'video');
  assert.equal(assetKind('bed.mp3'), 'audio');
  assert.equal(assetKind('notes.txt'), 'other');
});

test('a production cuts the scenes into one playable MP4', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-production-'));
  try {
    const picture = await writePicture(join(root, 'photo.png'), '(120,80,40)');
    const spec = parseProductionSpec({
      scenes: [
        { type: 'template', template: 'title', text: 'Opening', duration: 1, transition: 'fade' },
        { type: 'image', materialId: 'photo', duration: 1, transition: 'cut' },
      ],
      width: 480,
      height: 270,
      fps: 12,
    });
    const result = await renderProduction(OPTIONS, spec, { assets: { photo: picture } });
    assert.equal(result.mediaType, 'video/mp4');
    assert.equal(result.format, 'mp4');
    assert.equal(result.width, 480);
    assert.equal(result.height, 270);
    assert.equal(result.scenes, 2);
    assert.ok(result.seconds > 1, 'the two scenes must last more than one second');
    assert.ok(result.data.byteLength > 5000, 'the video must hold real frames');
    assert.equal(String.fromCharCode(...result.data.subarray(4, 8)), 'ftyp');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the agent tool produces a video and reports the file', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const saved = [];
  const { ctx, tools } = fakeCtx({
    attachments: {
      async saveFile({ data, name }) {
        saved.push({ bytes: data.byteLength, name });
        return { attachmentId: 'att-production-1' };
      },
    },
  });
  apply(ctx, {
    motion: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, seconds: 1, fps: 12, timeoutMs: 300000 },
    production: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, fps: 12, timeoutMs: 300000 },
  });
  const tool = tools.find((entry) => entry.name === 'produce_video');
  assert.ok(tool !== undefined, 'the plugin must register produce_video');
  const result = await tool.execute({
    scenes: [
      { type: 'template', template: 'title', text: 'ハーネス映画夜', duration: 1 },
      { type: 'template', template: 'lower_third', text: '第 12 回', duration: 1, transition: 'fade' },
    ],
    width: 480,
    height: 270,
    fps: 12,
  }, { signal: undefined });
  assert.equal(result.scenes, 2);
  assert.equal(result.width, 480);
  assert.equal(result.height, 270);
  assert.equal(result.mediaType, 'video/mp4');
  assert.ok(result.bytes > 5000);
  assert.match(result.name, /^production-.*\.mp4$/u);
  assert.equal(result.attachmentId, 'att-production-1');
  assert.equal(saved.length, 1);
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'file');
});

test('a scene that names a missing material is refused with a clear message', async () => {
  const { ctx, tools } = fakeCtx({});
  apply(ctx, { production: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, fps: 12, timeoutMs: 300000 } });
  const tool = tools.find((entry) => entry.name === 'produce_video');
  await assert.rejects(
    () => tool.execute({ scenes: [{ type: 'image', materialId: 'nope', duration: 1 }] }, { signal: undefined }),
    /素材が見つかりません/u,
  );
});

test('the material tool copies a workspace file into the library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-material-'));
  try {
    const source = join(root, 'picture.png');
    await writeFile(source, new Uint8Array([9, 9, 9]));
    const { ctx, tools } = fakeCtx({
      workingDirectory: {
        ensure: async () => root,
        get: async () => root,
      },
    });
    apply(ctx, { assets: { maxBytes: 1024 * 1024, directory: join(root, 'assets') } });
    const tool = tools.find((entry) => entry.name === 'attach_material');
    assert.ok(tool !== undefined, 'the plugin must register attach_material');
    const result = await tool.execute({ path: source }, { signal: undefined, agent: { id: 'agent-1' } });
    assert.equal(result.kind, 'image');
    assert.equal(result.bytes, 3);
    assert.ok(result.id !== '');
    const library = await listAssets(assetDirectory({ assets: { directory: join(root, 'assets') } }));
    assert.equal(library.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the panel routes keep the library and cut a production', { skip: hasPython() ? false : 'needs Python with Pillow' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
  try {
    const routes = [];
    const ctx = {
      effect(factory) {
        const dispose = factory();
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      get(name) {
        if (name === 'workingDirectory') {
          return {
            ensure: async () => root,
            get: async () => root,
          };
        }
        return undefined;
      },
      tools: { register: () => () => {} },
      connection: {
        fetch: {
          register(route) {
            routes.push(route);
            return async () => {};
          },
        },
      },
    };
    apply(ctx, {
      motion: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, seconds: 1, fps: 12, timeoutMs: 300000 },
      production: { pythonPath: PYTHON, ffmpegPath: FFMPEG, width: 480, height: 270, fps: 12, timeoutMs: 300000 },
      assets: { maxBytes: 1024 * 1024, directory: join(root, 'assets') },
    });
    const find = (suffix) => routes.find((route) => route.path.endsWith(suffix));

    // The panel uploads a material.
    const upload = find('/assets');
    assert.ok(upload !== undefined, 'the plugin must serve the asset library');
    const uploaded = await upload.fetch(new Request('http://local/api/media-studio/assets', {
      method: 'POST',
      headers: { 'x-file-name': 'photo.png' },
      body: new Uint8Array([1, 2, 3]),
    }));
    assert.equal(uploaded.status, 200);
    const { asset } = await uploaded.json();
    assert.equal(asset.kind, 'image');
    assert.equal(asset.bytes, 3);

    // The panel lists the library.
    const listed = await find('/assets').fetch(new Request('http://local/api/media-studio/assets'));
    const payload = await listed.json();
    assert.equal(payload.assets.length, 1);
    assert.equal(payload.assets[0].id, asset.id);

    // The panel can show the material.
    const file = await find('/asset-file').fetch(new Request(`http://local/api/media-studio/asset-file?id=${asset.id}`));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal((await file.arrayBuffer()).byteLength, 3);

    // The panel cuts the production.
    const production = find('/production');
    assert.ok(production !== undefined, 'the plugin must serve the production route');
    const rendered = await production.fetch(new Request('http://local/api/media-studio/production', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenes: [
          { type: 'template', template: 'title', text: 'Opening', duration: 1 },
          { type: 'template', template: 'lower_third', text: 'Second', duration: 1, transition: 'fade' },
        ],
        width: 480,
        height: 270,
        fps: 12,
      }),
    }));
    assert.equal(rendered.status, 200);
    const bytes = new Uint8Array(await rendered.arrayBuffer());
    assert.ok(bytes.byteLength > 5000, 'the route must return a real video');
    assert.equal(String.fromCharCode(...bytes.subarray(4, 8)), 'ftyp');

    // A scene without text is refused with a 400.
    const refused = await find('/production').fetch(new Request('http://local/api/media-studio/production', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenes: [{ type: 'template', template: 'title' }] }),
    }));
    assert.equal(refused.status, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
