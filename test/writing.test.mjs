import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pieceLengthBeats, pieceNoteCount, parseScoreText } from '../score.js';
import {
  ARTICLE_FORMATS,
  CLICHE_WORDS,
  LYRIC_STRUCTURES,
  analyzeLyrics,
  buildArticlePrompt,
  buildLyricsPrompt,
  buildNovelPrompt,
  buildOutlinePrompt,
  composeMelodySketch,
  describeWritingCapabilities,
  extractJson,
  generateText,
  midiToName,
  moraCount,
  normalizeJapaneseTypography,
  parseLyricsSections,
  readingTime,
  resolveStructure,
  resolveWritingRoute,
  rhymeKey,
  syllableCount,
} from '../writing.js';

/** A fake context exposing only the services one test needs. */
function fakeContext({ selection, llm } = {}) {
  return {
    get(name) {
      if (name === 'agentDefaultModel' && selection !== undefined) return { currentSelection: () => selection };
      if (name === 'llm') return llm;
      return undefined;
    },
  };
}

/** A fake llm service that yields the given chunks. */
function fakeLlm(chunks, { onPrepare } = {}) {
  return {
    async prepareCall(config) {
      onPrepare?.(config);
      return {
        stream() {
          return (async function* emit() {
            for (const chunk of chunks) yield chunk;
          })();
        },
      };
    },
  };
}

test('mora counting follows Japanese prosody', () => {
  assert.equal(moraCount('きょう'), 2);
  assert.equal(moraCount('がっこう'), 4);
  assert.equal(moraCount('きゃく'), 2);
  assert.equal(moraCount('コーヒー'), 4);
  assert.equal(moraCount('さくら'), 3);
  assert.equal(moraCount('しんぶん'), 4);
  assert.equal(moraCount('あー'), 2);
  assert.equal(moraCount('東京'), 2);
  assert.equal(moraCount(''), 0);
  assert.equal(moraCount('Hello world'), 3, 'Latin words fall back to syllables');
});

test('syllable counting handles common English shapes', () => {
  assert.equal(syllableCount('hello'), 2);
  assert.equal(syllableCount('beautiful'), 3);
  assert.equal(syllableCount('the'), 1);
  assert.equal(syllableCount('table'), 2);
  assert.equal(syllableCount('loved'), 1);
  assert.equal(syllableCount(''), 0);
});

test('rhyme keys compare sound rather than spelling', () => {
  assert.equal(rhymeKey('さくらが咲く', 'ja'), 'aau');
  assert.equal(rhymeKey('きみと歩く', 'ja'), 'iou');
  assert.equal(rhymeKey('I am going home', 'en'), rhymeKey('please let me roam', 'en'));
  assert.notEqual(rhymeKey('I am going home', 'en'), rhymeKey('I am going home', 'ja'));
  assert.equal(rhymeKey('', 'ja'), '');
});

test('tagged lyrics split into sections in performance order', () => {
  const sections = parseLyricsSections('[Verse 1]\nline one\nline two\n\n[Chorus]\nline three\n');
  assert.deepEqual(sections.map((section) => section.tag), ['Verse 1', 'Chorus']);
  assert.deepEqual(sections[0].lines, ['line one', 'line two']);
  assert.deepEqual(sections[1].lines, ['line three']);
  assert.deepEqual(parseLyricsSections(''), []);
});

test('analysis names concrete violations in a weak lyric', () => {
  const report = analyzeLyrics('[Verse 1]\n永遠の奇跡\n[Chorus]\nあ\n', {
    language: 'ja',
    syllablesPerLine: 7,
    rhyme: 'tight',
    hook: '永遠の奇跡',
  });
  assert.equal(report.lineCount, 2);
  assert.equal(report.hookFound, true);
  assert.equal(report.hookPosition, 'elsewhere', 'the hook sits in a verse, not the chorus');
  assert.ok(report.warnings.some((warning) => warning.includes('予算')), 'length warning');
  assert.ok(report.warnings.some((warning) => warning.includes('陳腐')), 'cliché warning');
  assert.ok(report.warnings.some((warning) => warning.includes('フック')), 'hook warning');
  for (const cliche of ['永遠', '奇跡']) {
    assert.ok(report.warnings.some((warning) => warning.includes(cliche)), `${cliche} should be flagged`);
  }
});

test('analysis stays quiet on a lyric that meets its brief', () => {
  const report = analyzeLyrics('[Verse 1]\nさくらが咲く\n[Chorus]\nきみと歩く\n', {
    language: 'ja',
    syllablesPerLine: 5,
    rhyme: 'loose',
    hook: 'きみと歩く',
    readings: ['さくらがさく', 'きみとあるく'],
  });
  assert.deepEqual(report.warnings, []);
  assert.equal(report.hookPosition, 'chorus-first');
  assert.equal(report.rhymes.length >= 0, true);
});

test('a kana reading is what actually gets counted', () => {
  const line = '[Chorus]\n終電はもうない';
  const approximate = analyzeLyrics(line, { language: 'ja' });
  const exact = analyzeLyrics(line, { language: 'ja', readings: ['しゅうでんはもうない'] });
  assert.equal(approximate.morae[0].measuredBy, 'text');
  assert.equal(exact.morae[0].measuredBy, 'reading');
  assert.equal(exact.morae[0].count, 9, 'しゅ う で ん は も う な い');
  assert.ok(exact.morae[0].count > approximate.morae[0].count, 'kanji-only counting understates');
  assert.ok(approximate.warnings.some((warning) => warning.includes('概算')), 'the approximation is disclosed');
});

test('Japanese typesetting fixes ellipses, dashes, marks and indentation', () => {
  const typeset = normalizeJapaneseTypography('...そう言った--そして!? 歩いた。');
  assert.ok(typeset.includes('……'), 'ellipsis normalised');
  assert.ok(typeset.includes('——'), 'dash normalised');
  assert.ok(typeset.includes('！？'), 'marks are full width');
  assert.ok(typeset.includes('！？\u3000'), 'a full-width space follows the marks');
  assert.ok(typeset.startsWith('\u3000'), 'paragraph is indented one full-width space');
  assert.ok(!typeset.includes('...'), 'no ASCII ellipsis remains');
});

test('Japanese typesetting collapses blank runs and hangs prohibited characters', () => {
  const collapsed = normalizeJapaneseTypography('一行目\n\n\n\n二行目');
  assert.ok(!collapsed.includes('\n\n\n'), 'blank runs collapse');
  const hung = normalizeJapaneseTypography('あいうえお\n、かきくけこ');
  assert.ok(hung.includes('あいうえお、'), 'the comma hangs onto the previous line');
  assert.ok(!/\n、/u.test(hung), 'no line starts with a comma');
  const indented = normalizeJapaneseTypography('# 見出し\n\n本文');
  assert.ok(indented.includes('# 見出し'), 'markdown headings are left alone');
});

test('Japanese typesetting is idempotent', () => {
  const once = normalizeJapaneseTypography('...彼は言った--そうだ!? そして\n\n\n歩き出した。');
  assert.equal(normalizeJapaneseTypography(once), once);
});

test('JSON extraction survives fences, prose and braces inside strings', () => {
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('前置き {"b": "}"} 後書き'), { b: '}' });
  assert.deepEqual(extractJson('[{"c":1}]'), [{ c: 1 }]);
  assert.equal(extractJson('no json here'), undefined);
  assert.equal(extractJson('{broken'), undefined);
});

test('the melody sketch is a score the music engine can play', () => {
  const msx = composeMelodySketch({ lines: ['さくらが咲く', 'きみと歩く'], key: 'D', tempo: 96 });
  assert.match(msx, /^title /mu);
  assert.match(msx, /^tempo 96$/mu);
  const piece = parseScoreText(msx);
  assert.equal(piece.tracks.length, 2, 'melody and bass');
  assert.ok(pieceNoteCount(piece) >= 10, 'one note per mora plus the bass line');
  assert.ok(pieceLengthBeats(piece) >= 8, 'two four-beat phrases');
});

test('the melody sketch accepts plain strings and line objects alike', () => {
  const fromStrings = composeMelodySketch({ lines: ['あ', 'い'] });
  const fromObjects = composeMelodySketch({ lines: [{ text: 'あ', morae: 1 }, { text: 'い', morae: 1 }] });
  assert.equal(fromStrings, fromObjects);
  assert.equal(composeMelodySketch({ lines: [] }).includes('track melody'), true);
});

test('reading time is at least one minute and scales with length', () => {
  assert.equal(readingTime('短い', 'ja'), 1);
  const long = 'あ'.repeat(2000);
  assert.ok(readingTime(long, 'ja') >= 5);
  assert.ok(readingTime('word '.repeat(500), 'en') >= 2);
});

test('MIDI note numbers become pitch names', () => {
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(69), 'A4');
  assert.equal(midiToName(61), 'C#4');
});

test('structures resolve from presets or a custom list', () => {
  assert.deepEqual(resolveStructure(''), LYRIC_STRUCTURES['jpop-standard']);
  assert.deepEqual(resolveStructure('aaba'), LYRIC_STRUCTURES.aaba);
  assert.deepEqual(resolveStructure('Intro > Verse > Chorus'), ['Intro', 'Verse', 'Chorus']);
});

test('the route prefers the configured model, then the session default', async () => {
  const configured = await resolveWritingRoute(fakeContext(), { writing: { provider: 'p', model: 'm' } });
  assert.deepEqual(configured, { provider: 'p', model: 'm' });
  const inherited = await resolveWritingRoute(fakeContext({ selection: { provider: 'sp', model: 'sm', reasoningEffort: 'low' } }), {});
  assert.deepEqual(inherited, { provider: 'sp', model: 'sm', reasoningEffort: 'low' });
  await assert.rejects(() => resolveWritingRoute(fakeContext(), {}), /モデル/);
});

test('generateText concatenates deltas and reports usage', async () => {
  let prepared;
  const llm = fakeLlm(
    [
      { type: 'text-delta', index: 0, text: 'こん' },
      { type: 'text-delta', index: 0, text: 'にちは' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    { onPrepare: (config) => (prepared = config) },
  );
  const result = await generateText(fakeContext({ llm }), { provider: 'p', model: 'm' }, {
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 128,
  });
  assert.equal(result.text, 'こんにちは');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
  assert.equal(prepared.model, 'm');
  assert.equal(prepared.maxTokens, 128);
});

test('generateText refuses a failed, aborted or truncated finish', async () => {
  for (const kind of ['error', 'aborted', 'max-tokens']) {
    const llm = fakeLlm([
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'finish', reason: { kind, failure: { message: 'boom', code: 'x' } } },
    ]);
    await assert.rejects(
      () => generateText(fakeContext({ llm }), { provider: 'p', model: 'm' }, { messages: [] }),
      /モデル|上限|中断/u,
      `finish ${kind} must reject`,
    );
  }
});

test('generateText refuses an empty reply and a missing llm service', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
  await assert.rejects(() => generateText(fakeContext({ llm }), { provider: 'p', model: 'm' }, { messages: [] }), /空/);
  await assert.rejects(() => generateText(fakeContext(), { provider: 'p', model: 'm' }, { messages: [] }), /llm/);
});

test('prompt builders carry the craft rules and the brief', () => {
  const lyrics = buildLyricsPrompt({ brief: '夏の終わり', genre: 'jpop', syllablesPerLine: 8, hook: 'まだ夏だ' });
  assert.match(lyrics.system, /lyricist/u);
  assert.match(lyrics.system, /HOOK:/u);
  assert.match(lyrics.system, /8 morae/u);
  assert.equal(lyrics.messages.length, 1);
  assert.match(lyrics.messages[0].content[0].text, /夏の終わり/u);
  for (const cliche of CLICHE_WORDS.slice(0, 3)) assert.ok(lyrics.system.includes(cliche), 'clichés are banned by name');

  const outline = buildOutlinePrompt({ brief: '灯台守', genre: 'mystery' });
  assert.match(outline.system, /strict JSON/u);
  assert.match(outline.system, /"characters"/u);

  const novel = buildNovelPrompt({ mode: 'draft', brief: '灯台守', targetLength: 1200 });
  assert.match(novel.system, /goal, an obstacle, and a turn/u);
  assert.match(novel.system, /1200 characters/u);
  assert.match(buildNovelPrompt({ mode: 'outline', brief: 'x' }).system, /story bible/u);

  const article = buildArticlePrompt({ mode: 'draft', topic: '気候', format: 'howto' });
  assert.match(article.system, /inverted pyramid|numbered steps/u);
  assert.match(article.system, /\[要出典\]/u);
  const seo = buildArticlePrompt({ mode: 'seo', topic: '気候' });
  assert.match(seo.system, /"metaDescription"/u);
});

test('every documented format and genre has a definition', () => {
  const capabilities = describeWritingCapabilities();
  assert.ok(capabilities.formats.length >= 10);
  assert.ok(capabilities.structures.length >= 5);
  assert.equal(Object.keys(ARTICLE_FORMATS).length, capabilities.formats.length);
  assert.ok(capabilities.cliches > 20);
});
