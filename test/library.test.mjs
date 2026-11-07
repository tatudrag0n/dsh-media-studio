import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { listAssets, saveAsset } from '../assets.js';
import { ASSET_KIND_NAMES, registerLibraryTools } from '../library.js';

const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;

/** A plugin context that registers tools into a Map, synchronously. */
function fakeContext() {
  const registered = new Map();
  const ctx = {
    effect(callback) {
      callback();
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
      },
    },
  };
  return { ctx, registered };
}

/** The helpers `index.js` hands to every v3 module. */
const helpers = {
  resolveSessionCwd: async () => process.cwd(),
  formatBytes: (bytes) => `${bytes} B`,
  safeRelativeDir: (value) => value,
};

/** Options shaped the way `index.js` resolves them. */
function optionsFor(directory) {
  return { assets: { maxBytes: 256 * 1024 * 1024, directory } };
}

/** Register the library tools and hand back the tool objects by name. */
function register(config, options = optionsFor(join(tmpdir(), 'unused-library-dir'))) {
  const { ctx, registered } = fakeContext();
  registerLibraryTools(ctx, options, config, helpers);
  return registered;
}

/** A temporary library directory, cleaned up by the test that made it. */
async function temporaryLibrary() {
  return mkdtemp(join(tmpdir(), 'dsh-library-'));
}

/** Run a render and flatten it into the text the user sees. */
function renderText(tool, args, value) {
  return tool.output
    .render(args, value)
    .map((block) => block.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('the three library tools are registered synchronously', () => {
  const registered = register({});
  assert.deepEqual([...registered.keys()], ['list_assets', 'asset_info', 'remove_asset']);
  for (const tool of registered.values()) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} executes`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} renders`);
    assert.equal(tool.output.schema.type, 'object', `${tool.name} describes its output`);
  }
});

test('descriptions are English and renders are Japanese', () => {
  const registered = register({});
  for (const tool of registered.values()) {
    assert.ok(/[A-Za-z]{3}/u.test(tool.description), `${tool.name} description is prose`);
    assert.ok(!JAPANESE.test(tool.description), `${tool.name} description is English`);
    for (const parameter of Object.values(tool.parameters.properties)) {
      assert.ok(!JAPANESE.test(parameter.description), `${tool.name} parameter description is English`);
    }
  }
  assert.ok(JAPANESE.test(registered.get('list_assets').output.render({}, { dir: '/x', count: 0, total: 0, entries: [] })[0].text));
  assert.ok(JAPANESE.test(registered.get('asset_info').output.render({}, {
    name: 'a.png', kind: 'image', id: 'i', bytes: 1, mediaType: 'image/png', path: '/x', createdAt: '2026-01-01T00:00:00.000Z',
  })[0].text));
  assert.ok(JAPANESE.test(registered.get('remove_asset').output.render({}, {
    name: 'a.png', kind: 'image', id: 'i', bytes: 1, path: '/x', removed: true, dryRun: false,
  })[0].text));
});

test('the kind enum is the vocabulary of assets.js, plus `other`', () => {
  const tool = register({}).get('list_assets');
  assert.deepEqual(tool.parameters.properties.kind.enum, ASSET_KIND_NAMES);
  assert.deepEqual(ASSET_KIND_NAMES, ['image', 'video', 'audio', 'other']);
});

// ---------------------------------------------------------------------------
// list_assets
// ---------------------------------------------------------------------------

test('list_assets returns the library newest first, with ids', async () => {
  const directory = await temporaryLibrary();
  try {
    const poster = await saveAsset(directory, { name: 'poster.png', data: Buffer.alloc(16) });
    const track = await saveAsset(directory, { name: 'rain.wav', data: Buffer.alloc(64) });
    const clip = await saveAsset(directory, { name: 'night.mp4', data: Buffer.alloc(32) });

    const tool = register({}, optionsFor(directory)).get('list_assets');
    const value = await tool.execute({}, {});

    assert.equal(value.dir, resolve(directory), 'the directory comes from assetDirectory()');
    assert.equal(value.total, 3);
    assert.equal(value.count, 3);
    assert.deepEqual(
      value.entries.map((entry) => entry.name).sort(),
      ['night.mp4', 'poster.png', 'rain.wav'],
    );
    for (const entry of value.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'id', 'kind', 'modifiedAt', 'name']);
      assert.ok(typeof entry.id === 'string' && entry.id.length > 0);
      assert.ok(!Number.isNaN(Date.parse(entry.modifiedAt)), 'modifiedAt is an ISO timestamp');
    }
    const byName = new Map(value.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('poster.png').kind, 'image');
    assert.equal(byName.get('rain.wav').kind, 'audio');
    assert.equal(byName.get('night.mp4').kind, 'video');
    assert.equal(byName.get('poster.png').bytes, 16);
    assert.equal(byName.get('rain.wav').id, track.id);
    assert.equal(byName.get('poster.png').id, poster.id);
    assert.equal(byName.get('night.mp4').id, clip.id);

    // Newest first: timestamps never go up as we walk the list.
    for (let index = 1; index < value.entries.length; index += 1) {
      assert.ok(value.entries[index - 1].modifiedAt >= value.entries[index].modifiedAt);
    }

    // The listing is what the library itself reports, order included.
    assert.deepEqual(
      value.entries.map((entry) => entry.id),
      (await listAssets(directory)).map((entry) => entry.id),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('list_assets filters by kind and honours limit', async () => {
  const directory = await temporaryLibrary();
  try {
    await saveAsset(directory, { name: 'poster.png', data: Buffer.alloc(8) });
    await saveAsset(directory, { name: 'logo.jpg', data: Buffer.alloc(8) });
    await saveAsset(directory, { name: 'rain.wav', data: Buffer.alloc(8) });
    await saveAsset(directory, { name: 'notes.zip', data: Buffer.alloc(8) });

    const tool = register({}, optionsFor(directory)).get('list_assets');

    const images = await tool.execute({ kind: 'image' }, {});
    assert.equal(images.total, 2);
    assert.deepEqual(images.entries.map((entry) => entry.kind), ['image', 'image']);

    const audio = await tool.execute({ kind: 'audio' }, {});
    assert.deepEqual(audio.entries.map((entry) => entry.name), ['rain.wav']);

    const other = await tool.execute({ kind: 'other' }, {});
    assert.deepEqual(other.entries.map((entry) => entry.name), ['notes.zip']);

    const none = await tool.execute({ kind: 'video' }, {});
    assert.equal(none.total, 0);
    assert.deepEqual(none.entries, []);

    const limited = await tool.execute({ limit: 2 }, {});
    assert.equal(limited.total, 4, 'total counts everything that matched');
    assert.equal(limited.count, 2);

    const overLimit = await tool.execute({ limit: 9999 }, {});
    assert.equal(overLimit.count, 4);

    const byConfig = register({ library: { limit: 1 } }, optionsFor(directory)).get('list_assets');
    assert.equal((await byConfig.execute({}, {})).count, 1);
    assert.equal((await byConfig.execute({ limit: 3 }, {})).count, 3, 'the argument wins over the config');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('list_assets refuses a kind it does not know', async () => {
  const directory = await temporaryLibrary();
  try {
    const tool = register({}, optionsFor(directory)).get('list_assets');
    await assert.rejects(() => tool.execute({ kind: 'exe' }, {}), /kind は image \/ video \/ audio \/ other/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing library directory is empty rather than an error', async () => {
  const missing = join(tmpdir(), `dsh-library-missing-${Date.now()}`);
  const tool = register({}, optionsFor(missing)).get('list_assets');
  const value = await tool.execute({}, {});
  assert.equal(value.total, 0);
  assert.deepEqual(value.entries, []);
  assert.match(renderText(tool, {}, value), /空です/u);
});

test('the directory is decided by assetDirectory(), not by this module', async () => {
  const directory = await temporaryLibrary();
  const previous = process.env.DSH_HOME;
  try {
    // 1. options.assets.directory wins when it is set.
    const explicit = register({}, optionsFor(directory)).get('list_assets');
    assert.equal((await explicit.execute({}, {})).dir, resolve(directory));

    // 2. with no directory configured, the harness home decides — and that
    //    decision lives in assets.js.
    process.env.DSH_HOME = directory;
    const derived = register({}, { assets: { maxBytes: 1024, directory: '' } }).get('list_assets');
    assert.equal((await derived.execute({}, {})).dir, resolve(join(directory, 'media-studio', 'assets')));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// asset_info
// ---------------------------------------------------------------------------

test('asset_info reports where one material is, without its bytes', async () => {
  const directory = await temporaryLibrary();
  try {
    const saved = await saveAsset(directory, { name: 'poster.png', data: Buffer.alloc(16, 7) });
    const tool = register({}, optionsFor(directory)).get('asset_info');
    const value = await tool.execute({ id: saved.id }, {});

    assert.equal(value.id, saved.id);
    assert.equal(value.name, 'poster.png');
    assert.equal(value.kind, 'image');
    assert.equal(value.bytes, 16);
    assert.equal(value.mediaType, 'image/png');
    assert.equal(value.path, saved.path);
    assert.equal(value.fileName, saved.fileName);
    assert.equal(value.dir, resolve(directory));
    assert.equal(value.data, undefined, 'the bytes are not returned');
    assert.ok(!Object.keys(value).includes('data'));

    const text = renderText(tool, { id: saved.id }, value);
    assert.match(text, /poster\.png/u);
    assert.match(text, /image\/png/u);
    assert.ok(text.includes(saved.path), 'the reply names the path');
    assert.match(text, /中身は返していません/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('asset_info rejects an unknown id and an empty id', async () => {
  const directory = await temporaryLibrary();
  try {
    const tool = register({}, optionsFor(directory)).get('asset_info');
    await assert.rejects(() => tool.execute({ id: 'nope' }, {}), /ライブラリにありません/u);
    await assert.rejects(() => tool.execute({}, {}), /id が必要です/u);
    await assert.rejects(() => tool.execute({ id: '   ' }, {}), /id が必要です/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('asset_info survives a file deleted behind its back', async () => {
  const directory = await temporaryLibrary();
  try {
    const saved = await saveAsset(directory, { name: 'gone.wav', data: Buffer.alloc(4) });
    await unlink(saved.path);
    const tool = register({}, optionsFor(directory)).get('asset_info');
    await assert.rejects(() => tool.execute({ id: saved.id }, {}), /ライブラリにありません/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// remove_asset
// ---------------------------------------------------------------------------

test('remove_asset deletes the material and says so', async () => {
  const directory = await temporaryLibrary();
  try {
    const keep = await saveAsset(directory, { name: 'keep.png', data: Buffer.alloc(8) });
    const drop = await saveAsset(directory, { name: 'drop.wav', data: Buffer.alloc(24) });
    const tool = register({}, optionsFor(directory)).get('remove_asset');

    const value = await tool.execute({ id: drop.id }, {});
    assert.equal(value.id, drop.id);
    assert.equal(value.removed, true);
    assert.equal(value.dryRun, false);
    assert.equal(value.name, 'drop.wav');
    assert.equal(value.path, drop.path);

    const left = await listAssets(directory);
    assert.deepEqual(left.map((entry) => entry.id), [keep.id], 'only the named material is gone');

    const text = renderText(tool, { id: drop.id }, value);
    assert.match(text, /消しました/u, 'the reply says plainly that it was deleted');
    assert.match(text, /取り消せません/u);
    assert.ok(text.includes('drop.wav'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remove_asset with dryRun reports the plan and deletes nothing', async () => {
  const directory = await temporaryLibrary();
  try {
    const saved = await saveAsset(directory, { name: 'keeper.png', data: Buffer.alloc(12) });
    const tool = register({}, optionsFor(directory)).get('remove_asset');

    const value = await tool.execute({ id: saved.id, dryRun: true }, {});
    assert.equal(value.removed, false);
    assert.equal(value.dryRun, true);
    assert.equal(value.id, saved.id);
    assert.equal(value.name, 'keeper.png');
    assert.equal(value.bytes, 12);
    assert.deepEqual((await listAssets(directory)).map((entry) => entry.id), [saved.id], 'the file is still there');

    const text = renderText(tool, { id: saved.id, dryRun: true }, value);
    assert.match(text, /まだ消していません/u);
    assert.match(text, /消す予定/u);
    assert.ok(!/消しました/u.test(text), 'a dry run never claims a delete happened');

    // The dry run and the real run describe the same material.
    const real = await tool.execute({ id: saved.id }, {});
    assert.equal(real.path, value.path);
    assert.equal(real.removed, true);
    assert.deepEqual(await listAssets(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remove_asset refuses an unknown id and leaves the library alone', async () => {
  const directory = await temporaryLibrary();
  try {
    const saved = await saveAsset(directory, { name: 'safe.png', data: Buffer.alloc(8) });
    const tool = register({}, optionsFor(directory)).get('remove_asset');

    await assert.rejects(() => tool.execute({ id: 'does-not-exist' }, {}), /ライブラリにありません/u);
    await assert.rejects(() => tool.execute({}, {}), /id が必要です/u);
    assert.deepEqual((await listAssets(directory)).map((entry) => entry.id), [saved.id]);

    // A dry run on a missing id is an error too: "nothing would happen" would
    // read like a successful plan.
    await assert.rejects(
      () => tool.execute({ id: 'does-not-exist', dryRun: true }, {}),
      /ライブラリにありません/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remove_asset is not concurrency safe, the readers are', () => {
  const registered = register({});
  assert.equal(registered.get('remove_asset').isConcurrencySafe(), false);
  assert.equal(registered.get('list_assets').isConcurrencySafe(), true);
  assert.equal(registered.get('asset_info').isConcurrencySafe(), true);
});

test('reading an empty library does not create the directory', async () => {
  const root = await temporaryLibrary();
  try {
    const nested = join(root, 'not', 'yet', 'there');
    const tool = register({}, optionsFor(nested)).get('list_assets');
    const value = await tool.execute({}, {});
    assert.equal(value.total, 0);
    await assert.rejects(() => stat(nested), /ENOENT/u, 'the reader never writes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
