import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPABILITIES, EXAMPLES, describeIntent, parseIntent, planIntent, readSfxKind } from '../intent.js';
import { repairJapaneseScript } from '../writing.js';

test('a sentence reaches the right capability', () => {
  const cases = [
    ['雨の効果音を30秒、ループで', 'sfx'],
    ['波の音を1分', 'sfx'],
    ['夜のドライブ向けのシティポップ、92 BPM、C マイナー', 'music'],
    ['ピアノのBGMを2分で', 'music'],
    ['終電を逃した二人の歌詞。サビのフックは「まだ帰らないで」', 'lyrics'],
    ['離島の灯台守が、灯りを消してはいけない理由を知る小説の第1章', 'novel'],
    ['効果音を自作してゲームに組み込む手順を、1200字の記事で', 'article'],
    ['夜明けの海辺に立つ灯台、横長、静かな色調', 'image'],
    ['ロゴの画像を作って', 'image'],
    ['この案内文を落ち着いた声で読み上げて', 'speech'],
    ['タイトルカード「MEDIA STUDIO」を4秒', 'motion'],
    ['売上の棒グラフを作って', 'chart'],
    ['議事録を動画にして', 'video'],
    ['write me a blog post about sound design', 'article'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(parseIntent(prompt).capability, expected, prompt);
  }
});

test('the head noun wins over an earlier object noun', () => {
  // "効果音を作る記事" is an article about sound effects, not a sound effect.
  const intent = parseIntent('効果音を作る記事を書いて');
  assert.equal(intent.capability, 'article');
  assert.ok(intent.alternatives.includes('sfx'));
});

test('numbers and musical controls are read out of the sentence', () => {
  const sound = parseIntent('雨の効果音を30秒、ループで');
  assert.equal(sound.params.duration, 30);
  assert.equal(sound.params.kind, 'rain');
  assert.equal(sound.subject, '雨');

  const music = parseIntent('夜のドライブ向けのシティポップ、92 BPM、C マイナー');
  assert.equal(music.params.tempo, 92);
  assert.equal(music.params.key, 'C');
  assert.equal(music.params.scale, 'minor');
  assert.equal(music.subject, '夜のドライブ向け');

  const image = parseIntent('夜明けの海辺に立つ灯台、横長、静かな色調');
  assert.equal(image.params.aspect, 'landscape');

  assert.equal(parseIntent('波の音を1分').params.duration, 60);
  assert.equal(parseIntent('雨の効果音を30秒').params.language, 'ja');
  assert.equal(parseIntent('a soft rain sound effect').params.language, 'en');
});

test('BGM is not read as the key G', () => {
  const intent = parseIntent('ピアノのBGMを2分で');
  assert.equal(intent.capability, 'music');
  assert.equal(intent.params.key, undefined);
  assert.equal(intent.params.duration, 120);
});

test('a clicked chip forces its capability', () => {
  const forced = parseIntent('なんかいい感じのやつ', { hint: 'music' });
  assert.equal(forced.capability, 'music');
  assert.equal(forced.confidence, 1);
  assert.equal(parseIntent('雨の音', { hint: 'nonsense' }).capability, 'sfx', 'an unknown hint is ignored');
});

test('an empty prompt is refused', () => {
  assert.throws(() => parseIntent('   '), /プロンプトが空/);
});

test('every capability has a label, a tool and an icon', () => {
  for (const [key, entry] of Object.entries(CAPABILITIES)) {
    assert.ok(entry.label.length > 0, key);
    assert.match(entry.tool, /^[a-z_]+$/u, key);
    assert.ok(entry.icon.length > 0, key);
  }
  assert.ok(EXAMPLES.length >= 8);
  for (const example of EXAMPLES) assert.ok(CAPABILITIES[example.hint] !== undefined);
});

test('a plan names a registered tool and only declared arguments', () => {
  const sfx = planIntent(parseIntent('雨の効果音を30秒'));
  assert.equal(sfx.tool, 'generate_sfx');
  assert.equal(sfx.args.kind, 'rain');
  assert.equal(sfx.args.duration, 30);

  assert.equal(planIntent(parseIntent('ピアノのBGM')).tool, 'compose_music');
  assert.equal(planIntent(parseIntent('歌詞を書いて')).tool, 'write_lyrics');
  assert.equal(planIntent(parseIntent('小説を書いて')).tool, 'write_novel');
  assert.equal(planIntent(parseIntent('記事を書いて')).tool, 'write_article');
  assert.equal(planIntent(parseIntent('読み上げて')).tool, 'generate_speech');
  assert.equal(planIntent(parseIntent('モーションを作って')).tool, 'make_motion_graphic');
  assert.equal(planIntent(parseIntent('グラフを作って')).tool, 'render_chart');
  // 動画はコード（Pillow + ffmpeg）で描く。
  assert.equal(planIntent(parseIntent('動画を作って')).tool, 'make_motion_graphic');
  assert.equal(planIntent(parseIntent('画像を作って')).tool, 'generate_image');
});

test('a chart prompt can carry its own numbers', () => {
  const intent = parseIntent('売上の棒グラフ: 一月 120、二月 90、三月 150');
  assert.equal(intent.capability, 'chart');
  assert.deepEqual(intent.params.values, [120, 90, 150]);
  assert.deepEqual(intent.params.labels, ['一月', '二月', '三月']);
});

test('the description a person checks names the reading', () => {
  assert.equal(
    describeIntent(parseIntent('雨の効果音を30秒')),
    '効果音 / rain / 30 秒 として 「雨」 を作ります',
  );
  assert.match(describeIntent(parseIntent('夜のドライブ向けのシティポップ、92 BPM、C マイナー')), /音楽 \/ 92 BPM \/ Cm/u);
});

test('sound words map to concrete effects', () => {
  assert.equal(readSfxKind('雨の音'), 'rain');
  assert.equal(readSfxKind('雷と爆発'), 'explosion');
  assert.equal(readSfxKind('カメラのシャッター'), 'camera-shutter');
  assert.equal(readSfxKind('特に何も'), undefined);
});

test('simplified characters are repaired and reported', () => {
  const repaired = repairJapaneseScript('一つは热い、门を开けた');
  assert.equal(repaired.text, '一つは熱い、門を开けた');
  assert.deepEqual(repaired.repairs, [
    { from: '热', to: '熱', count: 1 },
    { from: '门', to: '門', count: 1 },
  ]);
  assert.equal(repaired.repairs.length, 2);
});

test('repair leaves correct Japanese alone', () => {
  const original = '熱いコーヒーを飲む。叶うなら、また会おう。';
  const repaired = repairJapaneseScript(original);
  assert.equal(repaired.text, original);
  assert.deepEqual(repaired.repairs, []);
});
