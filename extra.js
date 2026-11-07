/**
 * 追加ツール (the creative tools added in v2).
 *
 * 4 つの制作領域をハーネスのツールとして登録する。
 *
 * - `generate_sfx`   ローカル DSP で効果音を作る（外部プロセスなし）
 * - `write_lyrics`   歌詞を書き、モーラ・韻・フックを機械検証する
 * - `write_novel`    小説を書き、日本語組版と連続性を管理する
 * - `write_article`  記事を書き、編集構造と SEO 情報を返す
 *
 * 文章系はハーネスの `llm` サービスに書かせる。どのモデルを使うかは
 * `writing.provider` / `writing.model`、無指定ならセッションの既定モデル。
 *
 * `index.js` から必要な小さな道具（作業ディレクトリ解決・整形）は引数で受け取り、
 * この module は index.js を import しない（循環参照を作らないため）。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { SFX_DEFAULTS, SFX_KINDS, SFX_SAMPLE_RATES, encodeWav, renderSfx } from './sfx.js';
import {
  ARTICLE_FORMATS,
  LYRIC_GENRES,
  LYRIC_STRUCTURES,
  analyzeLyrics,
  buildArticlePrompt,
  buildLyricsPrompt,
  buildNovelPrompt,
  composeMelodySketch,
  extractJson,
  generateText,
  normalizeJapaneseTypography,
  readingTime,
  resolveLanguage,
  resolveWritingRoute,
  repairJapaneseScript,
} from './writing.js';

/** Defaults for the writing tools when the row configures nothing. */
const WRITING_DEFAULTS = {
  maxTokens: 4096,
  temperature: 0.8,
  timeoutMs: 180000,
};

/** Defaults for the effect tool when the row configures nothing. */
const SFX_DEFAULTS_OPTIONS = {
  sampleRate: 44100,
  channels: 2,
};

/** Mode names each writing tool accepts, kept next to their descriptions. */
const NOVEL_MODES = ['outline', 'draft', 'continue', 'revise'];
const ARTICLE_MODES = ['brief', 'outline', 'draft', 'rewrite', 'seo'];

/**
 * Register the v2 tools on the plugin context.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {Map<string, { data: Buffer, mediaType: string, name: string }>} audioCache - audio the Chat player serves.
 * @param {object} config - the raw row config.
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers - small utilities owned by `index.js`.
 * @returns {void}
 */
export function registerExtraTools(ctx, options, audioCache, config, helpers) {
  const writing = resolveWritingOptions(config, options, helpers);
  const sfx = resolveSfxOptions(config, options, helpers);
  const tools = [
    sfxTool(ctx, options, sfx, audioCache, helpers),
    lyricsTool(ctx, options, writing, helpers),
    novelTool(ctx, options, writing, helpers),
    articleTool(ctx, options, writing, helpers),
    listMediaTool(ctx, options, writing, helpers),
  ];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
  }
}

/** Normalise the `writing` section of the row config. */
function resolveWritingOptions(config, options, helpers) {
  const source = config?.writing ?? {};
  const fallbackDir = options?.outputDir ?? 'media-studio';
  return {
    provider: textOrEmpty(source.provider),
    model: textOrEmpty(source.model),
    maxTokens: positive(source.maxTokens, WRITING_DEFAULTS.maxTokens),
    temperature: Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : WRITING_DEFAULTS.temperature,
    timeoutMs: positive(source.timeoutMs, WRITING_DEFAULTS.timeoutMs),
    outputDir: helpers.safeRelativeDir(source.outputDir ?? fallbackDir),
  };
}

/** Normalise the `sfx` section of the row config. */
function resolveSfxOptions(config, options, helpers) {
  const source = config?.sfx ?? {};
  const sampleRate = SFX_SAMPLE_RATES.includes(Number(source.sampleRate)) ? Number(source.sampleRate) : SFX_DEFAULTS_OPTIONS.sampleRate;
  return {
    sampleRate,
    channels: Number(source.channels) === 1 ? 1 : SFX_DEFAULTS_OPTIONS.channels,
    outputDir: helpers.safeRelativeDir(source.outputDir ?? options?.outputDir ?? 'media-studio'),
  };
}

/** Non-empty trimmed string, or an empty string. */
function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Media kind from a file name. */
export function mediaKindOf(name) {
  const extension = String(name).toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? '';
  if (['.wav', '.mp3', '.ogg', '.flac', '.m4a'].includes(extension)) return 'audio';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'].includes(extension)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(extension)) return 'video';
  if (['.md', '.txt', '.json', '.msx', '.csv'].includes(extension)) return 'text';
  return 'other';
}

/**
 * List the media a session has already produced.
 *
 * This is what lets the agent reuse its own work instead of regenerating it:
 * find an earlier track, read the lyric file, then hand the path to a later
 * tool.
 *
 * @param {string} directory - absolute directory to scan.
 * @param {object} [options] - `kind`, `query`, `limit`.
 * @returns {Promise<{ dir: string, count: number, total: number, entries: object[] }>}
 */
export async function collectMedia(directory, options = {}) {
  let names = [];
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch {
    return { dir: directory, count: 0, total: 0, entries: [] };
  }
  const wanted = typeof options.kind === 'string' && options.kind !== '' ? options.kind : undefined;
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const limit = Math.min(200, Math.max(1, Number.isFinite(Number(options.limit)) ? Math.trunc(Number(options.limit)) : 20));
  const entries = [];
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const kind = mediaKindOf(name);
    if (wanted !== undefined && kind !== wanted) continue;
    if (query !== '' && !name.toLowerCase().includes(query)) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info === undefined) continue;
    entries.push({ path: name, name, kind, bytes: info.size, modifiedAt: info.mtime.toISOString() });
  }
  entries.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : left.modifiedAt > right.modifiedAt ? -1 : 0));
  return { dir: directory, count: entries.slice(0, limit).length, total: entries.length, entries: entries.slice(0, limit) };
}

/**
 * An optional member, or nothing at all.
 *
 * A tool result must be lossless JSON, so an optional field with nothing to
 * say is omitted rather than carried as `undefined`.
 */
function optional(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/** A positive integer, or the fallback. */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/** Timestamp stem in the same shape the existing tools use. */
function stamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`,
  ].join('_');
}

/** A file name stem that is safe on Windows and still readable. */
function fileStem(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  const cleaned = text
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 60);
  return cleaned === '' ? fallback : cleaned;
}

/** Absolute path inside the session directory, created on demand. */
async function outputPath(ctx, exec, helpers, directory, name) {
  const cwd = await helpers.resolveSessionCwd(ctx, exec);
  const target = join(cwd, directory);
  await mkdir(target, { recursive: true });
  return { cwd, path: join(target, name), directory: target };
}

/** Path relative to the session directory, for compact display. */
function displayPath(cwd, absolute) {
  return absolute.startsWith(cwd + sep) ? absolute.slice(cwd.length + 1) : absolute;
}

/** Session id of the Agent that called the tool, when the harness exposes one. */
function sessionIdOf(ctx, exec) {
  const carried = exec?.sessionId;
  if (typeof carried === 'string' && carried !== '') return carried;
  const agent = exec?.agent;
  const direct = agent?.session?.id ?? agent?.sessionId ?? agent?.id;
  if (typeof direct === 'string' && direct !== '') return direct;
  const initiator = ctx?.get?.('agents')?.currentInitiator?.();
  const inherited = initiator?.session?.id ?? initiator?.sessionId ?? initiator?.id;
  return typeof inherited === 'string' && inherited !== '' ? inherited : undefined;
}

/** Read a file the caller named, resolving relative names against the session. */
async function readIfPath(ctx, exec, helpers, value) {
  const text = textOrEmpty(value);
  if (text === '') return undefined;
  if (text.includes('\n') || text.length > 400) return text;
  const cwd = await helpers.resolveSessionCwd(ctx, exec);
  const candidate = isAbsolute(text) ? text : resolve(cwd, text);
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return text;
    return await readFile(candidate, 'utf8');
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// list_media
// ---------------------------------------------------------------------------

/**
 * `list_media`: what this session has already made.
 *
 * The agent needs this to reuse its own output: find the track it generated
 * ten steps ago, or the lyric file, and pass the path to another tool instead
 * of paying to generate it again.
 */
function listMediaTool(ctx, options, writing, helpers) {
  return {
    name: 'list_media',
    description: [
      'List media this session already produced: generated sound effects, music, images, videos, lyrics, chapters, articles and their metadata files.',
      'Use it before regenerating anything, and to find a `path` to hand to `attach_material`, `produce_video`, `generate_video` or the file tools.',
      'Text artifacts (.md, .json) can be read directly with the read tool once you know their name.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['audio', 'image', 'video', 'text', 'other'], description: 'Only this kind of file.' },
        query: { type: 'string', description: 'Only files whose name contains this text.' },
        limit: { type: 'integer', description: 'How many to return, newest first. Defaults to 20, at most 200.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          count: { type: 'integer' },
          total: { type: 'integer' },
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
      render(_args, value) {
        if (value.total === 0) {
          return [{ type: 'text', text: `${value.dir} にまだ制作物はありません。Nothing has been produced in ${value.dir} yet.` }];
        }
        const lines = value.entries.map(
          (entry) => `- ${entry.path} (${entry.kind}, ${helpers.formatBytes(entry.bytes)}, ${entry.modifiedAt.slice(0, 16).replace('T', ' ')})`,
        );
        return [
          {
            type: 'text',
            text: [`制作物 ${value.total} 件のうち ${value.count} 件 (新しい順):`, ...lines].join('\n'),
          },
        ];
      },
      presentationMeta() {
        return { name: 'media' };
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await helpers.resolveSessionCwd(ctx, exec);
      const directory = join(cwd, writing.outputDir);
      const found = await collectMedia(directory, args ?? {});
      return {
        dir: writing.outputDir,
        count: found.count,
        total: found.total,
        entries: found.entries.map((entry) => ({ ...entry, path: `${writing.outputDir}/${entry.name}` })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// generate_sfx
// ---------------------------------------------------------------------------

/** `generate_sfx`: synthesise one sound effect locally and write a WAV. */
function sfxTool(ctx, options, sfx, cache, helpers) {
  return {
    name: 'generate_sfx',
    description: [
      'Synthesise a sound effect locally (no network, no model) and write a WAV file.',
      `Kinds: ${SFX_KINDS.join(', ')}.`,
      'Every kind is deterministic for a given seed; use `variation` to get another take of the same family.',
      'Ambience kinds (rain, wind, fire, water, crowd, horror-drone, engine, static) default to a seamless loop.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: SFX_KINDS, description: 'Which effect to synthesise.' },
        duration: { type: 'number', description: 'Length in seconds, 0.05-60. Defaults to the kind\'s natural length.' },
        intensity: { type: 'number', description: '0..1. Level and transient hardness. Defaults to 0.6.' },
        brightness: { type: 'number', description: '0..1. Spectral centre: 0 is dark and heavy, 1 is bright and airy.' },
        seed: { type: 'integer', description: 'Repeatable variation seed. Defaults to 1.' },
        variation: { type: 'number', description: '0..1. Another take of the same kind, with the same identity.' },
        sampleRate: { type: 'integer', enum: SFX_SAMPLE_RATES, description: 'Defaults to the configured rate.' },
        channels: { type: 'integer', enum: [1, 2], description: '1 for mono, 2 for stereo.' },
        loop: { type: 'boolean', description: 'Crossfade the tail into the head for seamless looping.' },
        name: { type: 'string', description: 'File name stem. Defaults to the kind and a timestamp.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          duration: { type: 'number' },
          sampleRate: { type: 'integer' },
          channels: { type: 'integer' },
          peak: { type: 'number' },
          rms: { type: 'number' },
          lufs: { type: 'number' },
          bytes: { type: 'integer' },
          attachmentId: { type: 'string' },
        },
      },
      render(_args, value) {
        const location = value.path ?? value.name;
        return [
          {
            type: 'text',
            text: [
              `効果音を生成しました (${value.kind}, ${value.duration.toFixed(2)}s, ${value.sampleRate} Hz, ${value.channels}ch,`,
              `ピーク ${value.peak.toFixed(3)} / RMS ${value.rms.toFixed(4)} / 約 ${value.lufs.toFixed(1)} LUFS,`,
              `${helpers.formatBytes(value.bytes)}): ${location}`,
            ].join(' '),
          },
          { type: 'file', attachment: { attachmentId: value.attachmentId, name: value.name, bytes: value.bytes } },
        ];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const kind = textOrEmpty(args?.kind);
      const rendered = renderSfx({
        kind,
        duration: args?.duration,
        intensity: args?.intensity,
        brightness: args?.brightness,
        seed: args?.seed,
        variation: args?.variation,
        sampleRate: args?.sampleRate ?? sfx.sampleRate,
        channels: args?.channels ?? sfx.channels,
        loop: args?.loop,
      });
      const wav = encodeWav(rendered.channels, rendered.sampleRate);
      const name = `${fileStem(args?.name, `${kind}-${stamp()}`)}.wav`;
      const target = await outputPath(ctx, exec, helpers, sfx.outputDir, name);
      await writeFile(target.path, wav);
      const attachmentId = randomBytes(16).toString('hex');
      cache.set(attachmentId, { data: wav, mediaType: 'audio/wav', name });
      return {
        path: displayPath(target.cwd, target.path),
        name,
        kind,
        duration: Math.round(rendered.duration * 1000) / 1000,
        sampleRate: rendered.sampleRate,
        channels: rendered.channelCount,
        peak: Math.round(rendered.peak * 1000) / 1000,
        rms: Math.round(rendered.rms * 10000) / 10000,
        lufs: Math.round(rendered.lufs * 10) / 10,
        bytes: wav.length,
        attachmentId,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// write_lyrics
// ---------------------------------------------------------------------------

/** `write_lyrics`: write a lyric, then verify its prosody. */
function lyricsTool(ctx, options, writing, helpers) {
  return {
    name: 'write_lyrics',
    description: [
      'Write song lyrics for a brief, then verify them mechanically: mora or syllable count per line, rhyme groups, and whether the hook lands in the chorus.',
      `Genres: ${LYRIC_GENRES.join(', ')}.`,
      `Structures: ${Object.keys(LYRIC_STRUCTURES).join(', ')} or a custom list like "Intro > Verse > Chorus".`,
      'Returns the tagged lyric, a per-line prosody table, warnings, and an MSX melody sketch that `generate_music` can play.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: {
        brief: { type: 'string', description: 'The subject, emotion and story the song must carry.' },
        language: { type: 'string', enum: ['ja', 'en', 'auto'], description: 'Language to write in. `auto` follows the brief.' },
        genre: { type: 'string', enum: LYRIC_GENRES, description: 'Musical genre, which sets vocabulary and line length.' },
        structure: { type: 'string', description: 'A structure preset name or a custom "A > B > C" list.' },
        mood: { type: 'string', description: 'The emotional register, for example "quietly furious".' },
        perspective: { type: 'string', description: 'Who is singing, for example "first person, addressing the person who left".' },
        rhyme: { type: 'string', enum: ['none', 'loose', 'tight'], description: 'How strictly lines must rhyme.' },
        syllablesPerLine: { type: 'integer', description: 'Mora (Japanese) or syllable (English) budget per line.' },
        hook: { type: 'string', description: 'A phrase the chorus must land on.' },
        bannedWords: { type: 'array', items: { type: 'string' }, description: 'Extra words to avoid.' },
        length: { type: 'string', enum: ['short', 'standard', 'long'], description: 'How many sections to write.' },
        tempo: { type: 'integer', description: 'BPM, used for the melody sketch.' },
        meter: { type: 'string', description: 'Time signature for the melody sketch, for example "4/4".' },
        seed: { type: 'integer', description: 'Seed for the melody sketch.' },
        melody: { type: 'boolean', description: 'Also return an MSX melody sketch. Defaults to true.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          lyrics: { type: 'string' },
          path: { type: 'string' },
          lineCount: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
          melody: { type: 'string' },
        },
      },
      render(_args, value) {
        const summary = [
          `歌詞を書きました (${value.language}, ${value.genre}, ${value.lineCount} 行, ${value.sections} セクション)`,
          value.hookPosition === 'chorus-first' ? 'フックはサビの 1 行目にあります。' : '',
          value.warnings.length === 0 ? '韻律の警告はありません。' : `警告 ${value.warnings.length} 件: ${value.warnings.slice(0, 3).join(' / ')}`,
          value.path === undefined ? '' : `保存先: ${value.path}`,
        ].filter((line) => line !== '');
        return [{ type: 'text', text: `${summary.join('\n')}\n\n${value.lyrics}` }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: 'lyrics' } : { path: value.path };
      },
    },
    timeoutMs: writing.timeoutMs + 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const language = resolveLanguage(args?.language === 'auto' || args?.language === undefined ? detectLanguage(args?.brief) : args?.language);
      const route = await resolveWritingRoute(ctx, { writing });
      const prompt = buildLyricsPrompt({ ...args, language });
      const { text } = await generateText(ctx, route, {
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: writing.maxTokens,
        temperature: writing.temperature,
        timeoutMs: writing.timeoutMs,
        signal: exec?.signal,
        sessionId: sessionIdOf(ctx, exec),
      });
      const split = splitNotes(text);
      // A Japanese model occasionally slips into simplified characters; fix
      // them before anything measures or saves the lyric.
      const repaired = repairJapaneseScript(split.lyric.trim());
      const lyrics = repaired.text;
      const analysis = analyzeLyrics(lyrics, {
        language,
        syllablesPerLine: args?.syllablesPerLine,
        rhyme: args?.rhyme,
        hook: args?.hook ?? split.hook,
        readings: split.readings,
      });
      for (const repair of repaired.repairs) {
        analysis.warnings.push(`簡体字を修正しました: ${repair.from} → ${repair.to} (${repair.count} 箇所)`);
      }
      const melody = args?.melody === false ? undefined : composeMelodySketch({
        lines: analysis.morae.map((line) => ({ text: line.text, morae: line.count })),
        key: args?.key ?? 'C',
        tempo: args?.tempo ?? 120,
        meter: args?.meter ?? '4/4',
        seed: args?.seed ?? 1,
      });
      const name = `${fileStem(args?.title ?? args?.hook ?? 'lyrics', `lyrics-${stamp()}`)}.lyrics.md`;
      const target = await outputPath(ctx, exec, helpers, writing.outputDir, name);
      const body = [
        `# ${args?.hook ?? 'Lyrics'}`,
        '',
        `- genre: ${args?.genre ?? 'jpop'}`,
        `- language: ${language}`,
        `- structure: ${(args?.structure ?? 'jpop-standard')}`,
        `- lines: ${analysis.lineCount}`,
        '',
        '```text',
        lyrics,
        '```',
        '',
        '## Prosody',
        '',
        '| # | section | count | rhyme | line | reading |',
        '| --- | --- | --- | --- | --- | --- |',
        ...analysis.morae.map(
          (line) =>
            `| ${line.index} | ${line.section} | ${line.count} | ${line.rhyme} | ${line.text.replace(/\|/gu, '\\|')} | ${(line.reading ?? '').replace(/\|/gu, '\\|')} |`,
        ),
        '',
        analysis.warnings.length === 0 ? 'No prosody warnings.' : '## Warnings\n\n' + analysis.warnings.map((warning) => `- ${warning}`).join('\n'),
        melody === undefined ? '' : '\n## Melody (MSX)\n\n```text\n' + melody + '\n```',
      ].join('\n');
      await writeFile(target.path, body, 'utf8');
      return {
        lyrics,
        language,
        genre: args?.genre ?? 'jpop',
        lineCount: analysis.lineCount,
        sections: analysis.sections.length,
        morae: analysis.morae,
        rhymes: analysis.rhymes,
        hookFound: analysis.hookFound,
        hookPosition: analysis.hookPosition,
        warnings: analysis.warnings,
        notes: split.notes,
        ...optional('melody', melody),
        path: displayPath(target.cwd, target.path),
      };
    },
  };
}

/** Guess the language of a brief: kana or kanji means Japanese. */
function detectLanguage(value) {
  const text = typeof value === 'string' ? value : '';
  return /[\u3040-\u30ff\u4e00-\u9fff]/u.test(text) ? 'ja' : 'en';
}

/** Split model output into the lyric and the trailing HOOK/IMAGE/YOMI notes. */
function splitNotes(text) {
  const source = typeof text === 'string' ? text : '';
  const parts = source.split(/^-{3,}$/mu);
  const lyric = parts[0] ?? '';
  const tail = parts.slice(1).join('\n');
  const hook = /HOOK:\s*(?<hook>.+)/u.exec(tail)?.groups?.hook?.trim();
  const image = /IMAGE:\s*(?<image>.+)/u.exec(tail)?.groups?.image?.trim();
  const yomi = /YOMI:[ \t]*\n(?<body>[\s\S]*)$/u.exec(tail)?.groups?.body ?? '';
  const readings = yomi
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(HOOK|IMAGE|YOMI):/u.test(line))
    .map((line) => line.replace(/[\s|｜]/gu, ''));
  const notes = [hook === undefined ? '' : `HOOK: ${hook}`, image === undefined ? '' : `IMAGE: ${image}`].filter((line) => line !== '');
  return { lyric, notes: notes.join('\n'), hook, image, readings };
}

// ---------------------------------------------------------------------------
// write_novel
// ---------------------------------------------------------------------------

/** `write_novel`: outline, draft, continue or revise prose. */
function novelTool(ctx, options, writing, helpers) {
  return {
    name: 'write_novel',
    description: [
      'Write fiction: build a story bible, draft a chapter, continue a scene, or revise a passage.',
      'Drafts are typeset for Japanese (行頭禁則, 三点リーダ, 段落頭の全角スペース) and saved next to the story bible so later chapters stay continuous.',
      '`outline` returns strict JSON (logline, characters with want/wound/secret/arc, timeline, beats, foreshadowing) and saves it as a reusable bible.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'brief'],
      properties: {
        mode: { type: 'string', enum: NOVEL_MODES, description: 'What to produce.' },
        brief: { type: 'string', description: 'The premise: who, where, and what goes wrong.' },
        genre: { type: 'string', description: 'Genre, which sets the conventions readers expect.' },
        pov: { type: 'string', enum: ['first', 'third-limited', 'third-omniscient', 'second'], description: 'Narrative point of view.' },
        tense: { type: 'string', enum: ['past', 'present'], description: 'Narrative tense.' },
        style: { type: 'string', description: 'Prose direction, for example "dry and clipped, no interior monologue".' },
        targetLength: { type: 'integer', description: 'Approximate characters for the draft.' },
        bible: { type: 'string', description: 'The story bible as JSON, or a path to the JSON file a previous call saved.' },
        outline: { type: 'string', description: 'The beat this chapter must cover.' },
        previous: { type: 'string', description: 'The passage before this one, or a path to it.' },
        chapterIndex: { type: 'integer', description: 'Chapter number, used for the file name and the continuity note.' },
        revise: { type: 'string', description: 'For mode `revise`: what to change.' },
        rating: { type: 'string', description: 'Content rating or house style constraint.' },
        language: { type: 'string', enum: ['ja', 'en', 'auto'], description: 'Language to write in.' },
        title: { type: 'string', description: 'Story title, used for file names.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          path: { type: 'string' },
          characters: { type: 'integer' },
          biblePath: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.mode === 'outline') {
          return [
            {
              type: 'text',
              text: `物語の設計図を作りました (登場人物 ${value.characters} 人, ビート ${value.beats} 件): ${value.path ?? ''}\n\n${value.summary}`,
            },
          ];
        }
        const head = [
          `小説を書きました (${value.mode}, ${value.characters} 文字, 読了 約 ${value.readingMinutes} 分)`,
          value.path === undefined ? '' : `保存先: ${value.path}`,
          value.biblePath === undefined ? '' : `設定資料: ${value.biblePath}`,
        ].filter((line) => line !== '');
        return [{ type: 'text', text: `${head.join('\n')}\n\n${value.text}` }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: 'novel' } : { path: value.path };
      },
    },
    timeoutMs: writing.timeoutMs + 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mode = NOVEL_MODES.includes(args?.mode) ? args.mode : 'draft';
      const language = resolveLanguage(args?.language === 'auto' || args?.language === undefined ? detectLanguage(args?.brief) : args?.language);
      const route = await resolveWritingRoute(ctx, { writing });
      const bibleText = await readIfPath(ctx, exec, helpers, args?.bible);
      const previous = await readIfPath(ctx, exec, helpers, args?.previous);
      const prompt = buildNovelPrompt({ ...args, mode, language, bible: bibleText, previous });
      const { text } = await generateText(ctx, route, {
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: Math.max(writing.maxTokens, mode === 'outline' ? 12000 : 8000),
        temperature: writing.temperature,
        timeoutMs: writing.timeoutMs,
        signal: exec?.signal,
        sessionId: sessionIdOf(ctx, exec),
      });
      const slug = fileStem(args?.title ?? args?.brief, `novel-${stamp()}`);
      if (mode === 'outline') {
        const bible = extractJson(text);
        if (bible === undefined) throw new Error('設計図の JSON を取り出せませんでした。outline をもう一度実行してください。The outline reply was not valid JSON.');
        const biblePath = await outputPath(ctx, exec, helpers, writing.outputDir, `${slug}.bible.json`);
        await writeFile(biblePath.path, `${JSON.stringify(bible, null, 2)}\n`, 'utf8');
        const beats = Array.isArray(bible.beats) ? bible.beats.length : 0;
        const characters = Array.isArray(bible.characters) ? bible.characters.length : 0;
        return {
          mode,
          summary: `logline: ${bible.logline ?? ''}\n登場人物 ${characters} 人 / ビート ${beats} 件`,
          bible,
          beats,
          characters,
          path: displayPath(biblePath.cwd, biblePath.path),
          biblePath: displayPath(biblePath.cwd, biblePath.path),
        };
      }
      const repaired = language === 'ja' ? repairJapaneseScript(text) : { text, repairs: [] };
      const prose = language === 'ja' ? normalizeJapaneseTypography(repaired.text) : text.trim();
      const chapter = Number.isFinite(Number(args?.chapterIndex)) ? Math.max(1, Math.trunc(Number(args.chapterIndex))) : 1;
      const suffix = mode === 'continue' ? 'continue' : mode === 'revise' ? 'revised' : `ch${String(chapter).padStart(2, '0')}`;
      const name = `${slug}.${suffix}.md`;
      const target = await outputPath(ctx, exec, helpers, writing.outputDir, name);
      const body = [`# ${args?.title ?? args?.brief ?? 'Novel'} — ${suffix}`, '', prose, ''].join('\n');
      await writeFile(target.path, body, 'utf8');
      const characters = prose.replace(/\s/gu, '').length;
      return {
        mode,
        text: prose,
        characters,
        readingMinutes: readingTime(prose, language),
        language,
        chapterIndex: chapter,
        path: displayPath(target.cwd, target.path),
        ...optional('biblePath', typeof args?.bible === 'string' && args.bible.trim() !== '' ? args.bible : undefined),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// write_article
// ---------------------------------------------------------------------------

/** `write_article`: brief, outline, draft, rewrite or SEO metadata. */
function articleTool(ctx, options, writing, helpers) {
  return {
    name: 'write_article',
    description: [
      'Write or shape an article: brief, outline, draft, rewrite, or SEO metadata.',
      `Formats: ${Object.keys(ARTICLE_FORMATS).join(', ')} — each follows that format's real convention rather than a generic template.`,
      'The editor never invents statistics: claims that need a source you did not supply are marked [要出典].',
      '`seo` returns strict JSON with title candidates and character counts, a meta description, a slug, headings, an FAQ and keywords.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'topic'],
      properties: {
        mode: { type: 'string', enum: ARTICLE_MODES, description: 'What to produce.' },
        topic: { type: 'string', description: 'The subject, and the claim the article makes about it.' },
        format: { type: 'string', enum: Object.keys(ARTICLE_FORMATS), description: 'Editorial format.' },
        audience: { type: 'string', description: 'Who this is for, and what they already know.' },
        tone: { type: 'string', description: 'Register, for example "plain and unsentimental".' },
        language: { type: 'string', enum: ['ja', 'en', 'auto'], description: 'Language to write in.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Search terms the piece should earn.' },
        targetLength: { type: 'integer', description: 'Approximate characters for the body.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Facts, quotes and figures the writer may use. Numbers outside this list must not appear.' },
        brand: { type: 'string', description: 'The publisher voice, if the piece speaks for a brand.' },
        cta: { type: 'string', description: 'The single action the reader should take.' },
        outline: { type: 'string', description: 'A heading plan to follow.' },
        previous: { type: 'string', description: 'A draft to rewrite, or a path to it.' },
        title: { type: 'string', description: 'File name stem.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          path: { type: 'string' },
          characters: { type: 'integer' },
          seo: { type: 'object' },
        },
      },
      render(_args, value) {
        if (value.mode === 'seo') {
          const titles = (value.seo?.titles ?? []).map((title) => `- ${title.text} (${title.characters})`).join('\n');
          const faq = (value.seo?.faq ?? []).map((item) => `Q. ${item.question}\nA. ${item.answer}`).join('\n\n');
          return [
            {
              type: 'text',
              text: [
                'SEO 情報を作りました。',
                '',
                '## タイトル案',
                titles,
                '',
                `## メタディスクリプション (${(value.seo?.metaDescription ?? '').length} 字)`,
                value.seo?.metaDescription ?? '',
                '',
                '## スラッグ',
                value.seo?.slug ?? '',
                '',
                '## 見出し',
                (value.seo?.headings ?? []).map((heading) => `- ${heading}`).join('\n'),
                '',
                '## FAQ',
                faq,
                value.path === undefined ? '' : `\n保存先: ${value.path}`,
              ].join('\n'),
            },
          ];
        }
        const head = [
          `記事を書きました (${value.mode}, ${value.format}, ${value.characters} 文字, 読了 約 ${value.readingMinutes} 分)`,
          value.path === undefined ? '' : `保存先: ${value.path}`,
          value.citations > 0 ? `要出典の箇所: ${value.citations}` : '',
        ].filter((line) => line !== '');
        return [{ type: 'text', text: `${head.join('\n')}\n\n${value.text}` }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: 'article' } : { path: value.path };
      },
    },
    timeoutMs: writing.timeoutMs + 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mode = ARTICLE_MODES.includes(args?.mode) ? args.mode : 'draft';
      const language = resolveLanguage(args?.language === 'auto' || args?.language === undefined ? detectLanguage(args?.topic) : args?.language);
      const route = await resolveWritingRoute(ctx, { writing });
      const previous = await readIfPath(ctx, exec, helpers, args?.previous);
      const prompt = buildArticlePrompt({ ...args, mode, language, previous });
      const { text } = await generateText(ctx, route, {
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: Math.max(writing.maxTokens, 6000),
        temperature: writing.temperature,
        timeoutMs: writing.timeoutMs,
        signal: exec?.signal,
        sessionId: sessionIdOf(ctx, exec),
      });
      const slug = fileStem(args?.title ?? args?.topic, `article-${stamp()}`);
      if (mode === 'seo') {
        const seo = extractJson(text);
        if (seo === undefined) throw new Error('SEO の JSON を取り出せませんでした。seo をもう一度実行してください。The SEO reply was not valid JSON.');
        const target = await outputPath(ctx, exec, helpers, writing.outputDir, `${slug}.seo.json`);
        await writeFile(target.path, `${JSON.stringify(seo, null, 2)}\n`, 'utf8');
        return { mode, seo, path: displayPath(target.cwd, target.path), language, format: args?.format ?? 'column' };
      }
      const body = language === 'ja' ? normalizeMarkdown(text) : text.trim();
      const target = await outputPath(ctx, exec, helpers, writing.outputDir, `${slug}.md`);
      await writeFile(target.path, `${body}\n`, 'utf8');
      const citations = (body.match(/\[要出典\]/gu) ?? []).length;
      return {
        mode,
        text: body,
        format: args?.format ?? 'column',
        language,
        characters: body.replace(/\s/gu, '').length,
        readingMinutes: readingTime(body, language),
        citations,
        path: displayPath(target.cwd, target.path),
      };
    },
  };
}

/** Typeset Japanese prose while leaving Markdown structure intact. */
function normalizeMarkdown(text) {
  const lines = String(text).split(/\r?\n/u);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/u.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || /^[#>*|\-+]/u.test(line) || /^\d+\./u.test(line) || line.trim() === '') {
      out.push(line);
      continue;
    }
    out.push(normalizeJapaneseTypography(line).trimStart());
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n');
}
