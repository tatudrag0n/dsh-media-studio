import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectMedia, mediaKindOf } from '../extra.js';
import { MEDIA_STUDIO_HINT, mediaCreateTool, runPrompt } from '../frontdoor.js';

test('file names are classified by what they are', () => {
  assert.equal(mediaKindOf('雨.wav'), 'audio');
  assert.equal(mediaKindOf('track.MP3'), 'audio');
  assert.equal(mediaKindOf('poster.png'), 'image');
  assert.equal(mediaKindOf('clip.mp4'), 'video');
  assert.equal(mediaKindOf('灯りを消す夜.ch01.md'), 'text');
  assert.equal(mediaKindOf('score.msx'), 'text');
  assert.equal(mediaKindOf('notes.bible.json'), 'text');
  assert.equal(mediaKindOf('archive.zip'), 'other');
  assert.equal(mediaKindOf('no-extension'), 'other');
});

test('a missing directory is empty rather than an error', async () => {
  const missing = join(tmpdir(), `dsh-media-missing-${Date.now()}`);
  const result = await collectMedia(missing);
  assert.deepEqual(result, { dir: missing, count: 0, total: 0, entries: [] });
});

test('the listing filters by kind and name, newest first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-list-'));
  try {
    await writeFile(join(directory, 'rain.wav'), Buffer.alloc(64));
    await writeFile(join(directory, 'impact.wav'), Buffer.alloc(32));
    await writeFile(join(directory, 'poster.png'), Buffer.alloc(16));
    await writeFile(join(directory, 'chapter.md'), '# text');
    await writeFile(join(directory, '.hidden'), 'skip me');

    const all = await collectMedia(directory);
    assert.equal(all.total, 4, 'hidden files are skipped');
    assert.equal(all.entries.length, 4);
    assert.ok(all.entries.every((entry) => entry.name !== '.hidden'));
    for (let index = 1; index < all.entries.length; index += 1) {
      assert.ok(all.entries[index - 1].modifiedAt >= all.entries[index].modifiedAt, 'newest first');
    }

    const audio = await collectMedia(directory, { kind: 'audio' });
    assert.deepEqual(audio.entries.map((entry) => entry.name).sort(), ['impact.wav', 'rain.wav']);

    const named = await collectMedia(directory, { query: 'rai' });
    assert.deepEqual(named.entries.map((entry) => entry.name), ['rain.wav']);

    const limited = await collectMedia(directory, { limit: 2 });
    assert.equal(limited.count, 2);
    assert.equal(limited.total, 4, 'the total is reported even when the page is short');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an entry carries the metadata a caller needs to reuse it', async () => {  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-meta-'));
  try {
    await writeFile(join(directory, '雨.wav'), Buffer.alloc(100));
    const result = await collectMedia(directory);
    const [entry] = result.entries;
    assert.equal(entry.name, '雨.wav');
    assert.equal(entry.kind, 'audio');
    assert.equal(entry.bytes, 100);
    assert.match(entry.modifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the front door tells the caller where the result is', () => {
  const inner = { output: { render: () => [{ type: 'text', text: '効果音を生成しました' }] } };
  const ctx = { get: (name) => (name === 'tools' ? { get: () => inner } : undefined) };
  const tool = mediaCreateTool(ctx, {}, {});
  const blocks = tool.output.render({}, {
    summary: '効果音 / rain / 10 秒',
    tool: 'generate_sfx',
    args: { kind: 'rain' },
    value: { path: 'media-studio/雨.wav' },
    asset: { path: 'media-studio/雨.wav', name: '雨.wav', kind: 'audio', bytes: 1024 },
  });
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /解釈: 効果音 \/ rain \/ 10 秒/u);
  assert.match(blocks[0].text, /media-studio\/雨\.wav/u, 'the reuse path is stated');
});

test('the standing guidance names the discovery tool and reuse', () => {
  assert.match(MEDIA_STUDIO_HINT, /media_create/u);
  assert.match(MEDIA_STUDIO_HINT, /list_media/u);
  assert.match(MEDIA_STUDIO_HINT, /attach_material/u);
  // v3 で動画編集・CAD・DTM の 3 領域が増えたぶんだけ上限を上げる。1 行にまとめて
  // あるので、増えたコストは約 240 文字に収まっている。
  assert.ok(MEDIA_STUDIO_HINT.length < 1400, 'the hint stays short enough for every prompt');
});

test('a panel request carries the session into the tool', async () => {
  const seen = {};
  const inner = {
    parameters: { properties: { kind: {} }, required: ['kind'] },
    output: { render: () => [] },
    async execute(args, exec) {
      seen.exec = exec;
      return { path: 'media-studio/雨.wav', name: '雨.wav', kind: 'sfx' };
    },
  };
  const ctx = {
    get(name) {
      if (name === 'tools') return { get: () => inner };
      if (name === 'agents') return { roots: () => [{ session: { id: 'sess-1' } }] };
      return undefined;
    },
  };
  const result = await runPrompt(ctx, {}, { resolveSessionCwd: async () => '/tmp' }, { prompt: '雨の効果音を3秒' });
  assert.equal(seen.exec.sessionId, 'sess-1', 'the model route needs a session');
  assert.equal(result.capability, 'sfx');
  assert.equal(result.asset.path, 'media-studio/雨.wav');
});
