/**
 * Text projects: a production written as text, run top to bottom (v3.1).
 *
 * The composer panel is going away, so the whole studio has to be reachable
 * from text. `render_project` reads a project file — YAML, JSON, or a fenced
 * block inside Markdown — and runs its steps in order, handing each tool the
 * result of the steps before it. That is the text form of the panel: a
 * readable recipe instead of a GUI.
 *
 * There is no YAML dependency. `parseYamlSubset` implements the small subset
 * the SPEC allows and refuses everything else with a line number, because a
 * recipe that is silently misread is worse than one that is rejected.
 *
 * The module never imports `index.js` (no cycles): tools are looked up through
 * `ctx.get('tools')`, and the small utilities come in through `helpers`.
 */

import { stat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import { isStudioTool } from './tools-list.js';

/** Tool timeout: a project may render several minutes of video. */
const DEFAULT_TIMEOUT_MS = 1800000;

/** Guard against a runaway project file. */
const DEFAULT_MAX_STEPS = 64;

/** How many argument problems are reported in one error message. */
const MAX_REPORTED_PROBLEMS = 6;

/** Keys a project may have at the top level. */
const PROJECT_KEYS = ['version', 'title', 'outputDir', 'steps'];

/** Keys one step may have. */
const STEP_KEYS = ['id', 'tool', 'args'];

/** A whole string that is a reference: `$cover` or `$cover.path`. */
const REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/u;

/** A reference embedded in a longer string: `{{cover.path}}`. */
const EMBEDDED_REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/gu;

/** Extensions the fence reader understands. */
const FENCE_LANGUAGES = ['yaml', 'yml', 'json'];

/** Media type guesses for artifacts a tool does not describe. */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.mid': 'audio/midi',
};

/**
 * A problem in the project text itself.
 *
 * `line` is the 1-based line of the project file (Markdown fences offset it),
 * `sourceLine` the offending text, so the message can point at it.
 */
export class ProjectError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = options.code ?? 'PROJECT';
    if (Number.isFinite(options.line) && options.line > 0) this.line = options.line;
    if (typeof options.source === 'string' && options.source !== '') this.sourceLine = options.source;
  }
}

/** Throw one `ProjectError`. */
function fail(message, options = {}) {
  throw new ProjectError(message, options);
}

/** A short reason from any thrown value. */
function reasonOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// YAML subset
// ---------------------------------------------------------------------------

/**
 * Parse the YAML subset a project file needs.
 *
 * Supported: comments, `key: value`, indentation nesting, `- item`,
 * `- key: value`, quoted strings, numbers / booleans / null, one-or-more level
 * flow `[...]` and `{...}`, and the block scalars `|` and `>` (with the `-`
 * and `+` chomping indicators). Everything else is an error with a line
 * number: anchors, aliases, tags, complex keys, documents markers after the
 * first, multi-line quoted strings, multi-line plain values, and tabs used as
 * indentation.
 *
 * @param {string} text - the YAML text.
 * @param {{ lineOffset?: number }} [options] - added to reported line numbers.
 * @returns {unknown} the parsed value.
 */
export function parseYamlSubset(text, options = {}) {
  const offset = Number.isFinite(options.lineOffset) ? options.lineOffset : 0;
  const raw = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
  const entries = [];
  let sawStartMarker = false;
  for (let index = 0; index < raw.length; index++) {
    const line = raw[index];
    if (line.trim() === '') continue;
    const lineNumber = index + 1;
    const leading = /^[ \t]*/u.exec(line)[0];
    if (leading.includes('\t')) {
      fail(`${lineNumber + offset} 行目: タブはインデントに使えません。半角スペースに置き換えてください。`, {
        line: lineNumber + offset,
        code: 'PROJECT_YAML',
        source: line,
      });
    }
    const body = line.slice(leading.length).replace(/\s+$/u, '');
    if (body === '' || body.startsWith('#')) continue;
    if (leading.length === 0 && body === '---') {
      if (sawStartMarker || entries.length > 0) {
        fail(`${lineNumber + offset} 行目: 対応外の構文です。文書区切り「---」は先頭に 1 回だけ書けます。`, {
          line: lineNumber + offset,
          code: 'PROJECT_YAML',
          source: line,
        });
      }
      sawStartMarker = true;
      continue;
    }
    if (leading.length === 0 && body === '...') {
      fail(`${lineNumber + offset} 行目: 対応外の構文です。文書終端「...」は使えません。`, {
        line: lineNumber + offset,
        code: 'PROJECT_YAML',
        source: line,
      });
    }
    entries.push({ indent: leading.length, text: body, line: lineNumber + offset, rawIndex: index });
  }
  if (entries.length === 0) {
    fail('プロジェクトが空です。`version: 1` と `steps:` から書いてください。', { code: 'PROJECT_YAML' });
  }
  const parser = new YamlParser(raw, entries, offset);
  return parser.parseDocument();
}

/** True when the line starts a sequence item. */
function isSequenceStart(text) {
  return /^-(?:[ \t]|$)/u.test(text);
}

/** True when the value is a block scalar header (`|`, `>-`, `|2`, ...). */
function isBlockScalarHeader(text) {
  return /^[|>][+-]?[1-9]?[+-]?$/u.test(text);
}

/** True when every `[` / `{` of a flow value has been closed. */
function flowBalanced(text) {
  let depth = 0;
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== '') {
      if (quote === '"' && char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index++;
          continue;
        }
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    else if (char === '#' && (index === 0 || text[index - 1] === ' ')) break;
  }
  return depth <= 0 && quote === '';
}

/**
 * Index of the `key:` colon, or -1.
 *
 * A mapping colon is followed by a space or the end of the line, and sits
 * outside quotes and outside `[...]` / `{...}`.
 */
function findKeyColon(text) {
  let depth = 0;
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== '') {
      if (quote === '"' && char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index++;
          continue;
        }
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') {
      depth++;
      continue;
    }
    if (char === ']' || char === '}') {
      depth--;
      continue;
    }
    if (char === ':' && depth === 0) {
      const next = text[index + 1];
      if (next === undefined || next === ' ' || next === '\t') return index;
    }
  }
  return -1;
}

/** Drop a trailing `# comment` that is not inside quotes. */
function stripInlineComment(text) {
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== '') {
      if (quote === '"' && char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index++;
          continue;
        }
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) {
      return text.slice(0, index);
    }
  }
  return text;
}

/** A plain scalar as the value YAML would give it. */
function convertPlainScalar(text) {
  const value = text.trim();
  if (value === '') return null;
  if (/^(?:~|null|Null|NULL)$/u.test(value)) return null;
  if (/^(?:true|True|TRUE)$/u.test(value)) return true;
  if (/^(?:false|False|FALSE)$/u.test(value)) return false;
  if (/^[-+]?\d+$/u.test(value)) return Number(value);
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(value)) return Number(value);
  if (/^[-+]?\d+[eE][-+]?\d+$/u.test(value)) return Number(value);
  return value;
}

/** Fold the lines of a `>` block scalar. */
function foldBlockLines(lines) {
  let text = '';
  let pendingBlanks = 0;
  let previousIndented = false;
  for (const line of lines) {
    if (line === '') {
      pendingBlanks++;
      continue;
    }
    const indented = /^[ \t]/u.test(line);
    if (text === '') {
      text = `${'\n'.repeat(pendingBlanks)}${line}`;
    } else if (pendingBlanks > 0) {
      text += `${'\n'.repeat(pendingBlanks)}${line}`;
    } else if (indented || previousIndented) {
      text += `\n${line}`;
    } else {
      text += ` ${line}`;
    }
    pendingBlanks = 0;
    previousIndented = indented;
  }
  return text;
}

/** The recursive-descent reader behind `parseYamlSubset`. */
class YamlParser {
  constructor(raw, entries, offset) {
    this.raw = raw;
    this.entries = entries;
    this.pos = 0;
    this.offset = offset;
  }

  /** The next logical line, or undefined. */
  peek() {
    return this.entries[this.pos];
  }

  /** Fail with a line number and the offending line. */
  fail(message, entry) {
    const line = entry?.line;
    fail(line === undefined ? `対応外の構文です: ${message}` : `${line} 行目: ${message}`, {
      line,
      code: 'PROJECT_YAML',
      source: entry?.text,
    });
  }

  /** Parse the whole document. */
  parseDocument() {
    const first = this.peek();
    if (first.indent !== 0) {
      this.fail('先頭の行がインデントされています。プロジェクトは最上位のキーから書いてください。', first);
    }
    const value = this.parseBlock(0);
    const extra = this.peek();
    if (extra !== undefined) this.fail('この行のインデントが合いません。上の行とそろえてください。', extra);
    return value;
  }

  /** Parse a mapping or a sequence that starts at `indent`. */
  parseBlock(indent) {
    const entry = this.peek();
    if (entry === undefined) {
      this.fail('値がありません。', this.entries[this.entries.length - 1]);
    }
    return isSequenceStart(entry.text) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  /** Parse `key: value` pairs at `indent`. */
  parseMapping(indent) {
    const map = {};
    const seen = new Map();
    for (;;) {
      const entry = this.peek();
      if (entry === undefined || entry.indent < indent) break;
      if (entry.indent > indent) this.fail('この行のインデントが深すぎます。上の行とそろえてください。', entry);
      if (isSequenceStart(entry.text)) {
        this.fail('同じ位置に「key: 値」と「- 」が混ざっています。', entry);
      }
      const pair = this.readPair(entry);
      if (seen.has(pair.key)) {
        this.fail(`キー「${pair.key}」が ${seen.get(pair.key)} 行目と重複しています。`, entry);
      }
      seen.set(pair.key, entry.line);
      this.pos++;
      map[pair.key] = this.parseValue(pair.rest, entry, indent);
    }
    return map;
  }

  /** Parse `- item` lines at `indent`. */
  parseSequence(indent) {
    const items = [];
    for (;;) {
      const entry = this.peek();
      if (entry === undefined || entry.indent < indent) break;
      if (entry.indent > indent) this.fail('この行のインデントが深すぎます。上の行とそろえてください。', entry);
      if (!isSequenceStart(entry.text)) {
        this.fail('同じ位置に「key: 値」と「- 」が混ざっています。', entry);
      }
      const match = /^-([ \t]*)([\s\S]*)$/u.exec(entry.text);
      const gap = match[1];
      if (gap.includes('\t')) this.fail('「-」のあとにタブは使えません。', entry);
      const rest = match[2].trim();
      const restColumn = indent + 1 + gap.length;
      this.pos++;
      if (rest === '') {
        const next = this.peek();
        items.push(next !== undefined && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      if (/^-(?:[ \t]|$)/u.test(rest)) {
        this.fail('対応外の構文です。1 行に 2 つ以上の「- 」は書けません。', entry);
      }
      if (isBlockScalarHeader(rest)) {
        items.push(this.readBlockScalar(entry, indent, rest));
        continue;
      }
      if (/^[[{]/u.test(rest)) {
        items.push(this.readFlow(rest, entry, indent));
        continue;
      }
      if (findKeyColon(rest) >= 0) {
        items.push(this.readInlineMapping(rest, entry, restColumn));
        continue;
      }
      items.push(this.parsePlain(rest, entry, indent));
    }
    const next = this.peek();
    if (next !== undefined && next.indent === indent) {
      this.fail('同じ位置に「- 」と「key: 値」が混ざっています。', next);
    }
    return items;
  }

  /** One mapping item that started on the dash line: `- id: cover`. */
  readInlineMapping(rest, entry, restColumn) {
    const map = {};
    const seen = new Map();
    const synthetic = { indent: restColumn, text: rest, line: entry.line, rawIndex: entry.rawIndex };
    const first = this.readPair(synthetic);
    seen.set(first.key, entry.line);
    map[first.key] = this.parseValue(first.rest, synthetic, restColumn);
    for (;;) {
      const next = this.peek();
      if (next === undefined || next.indent < restColumn) break;
      if (next.indent > restColumn) this.fail('この行のインデントが深すぎます。上の行とそろえてください。', next);
      if (isSequenceStart(next.text)) break;
      const pair = this.readPair(next);
      if (seen.has(pair.key)) {
        this.fail(`キー「${pair.key}」が ${seen.get(pair.key)} 行目と重複しています。`, next);
      }
      seen.set(pair.key, next.line);
      this.pos++;
      map[pair.key] = this.parseValue(pair.rest, next, restColumn);
    }
    return map;
  }

  /** Split one line into its key and the rest after the colon. */
  readPair(entry) {
    if (/^\?[ \t]/u.test(entry.text)) {
      this.fail('対応外の構文です。複合キー（? で始まるキー）は使えません。', entry);
    }
    const index = findKeyColon(entry.text);
    if (index < 0) {
      this.fail('「key: 値」の形になっていません。キーのあとに「: 」（コロンと空白）を入れてください。', entry);
    }
    const rawKey = entry.text.slice(0, index).trim();
    if (rawKey === '') this.fail('キーが空です。', entry);
    return { key: this.readKey(rawKey, entry), rest: entry.text.slice(index + 1).trim() };
  }

  /** A bare or quoted key. */
  readKey(rawKey, entry) {
    if (/^["']/u.test(rawKey)) {
      const quoted = this.readQuoted(rawKey, entry);
      if (quoted.end !== rawKey.length) this.fail('キーの引用符のあとに余分な文字があります。', entry);
      return quoted.value;
    }
    if (/^[?[\]{}&*!|>@`]/u.test(rawKey)) {
      this.fail(`対応外のキーです: 「${rawKey}」。引用符で囲ってください。`, entry);
    }
    if (/:\s/u.test(rawKey)) this.fail('キーに「: 」は使えません。', entry);
    return rawKey;
  }

  /** The value after `key:` or after `- `. */
  parseValue(rest, entry, indent) {
    const value = rest.trim();
    if (value === '' || value.startsWith('#')) return this.parseNested(entry, indent);
    if (/^["']/u.test(value)) {
      const quoted = this.readQuoted(value, entry);
      const rest2 = value.slice(quoted.end).trim();
      if (rest2 !== '' && !rest2.startsWith('#')) {
        this.fail('引用符で囲った値のあとに余分な文字があります。', entry);
      }
      return quoted.value;
    }
    if (/^[[{]/u.test(value)) return this.readFlow(value, entry, indent);
    if (isBlockScalarHeader(value)) return this.readBlockScalar(entry, indent, value);
    return this.parsePlain(value, entry, indent);
  }

  /**
   * Read a flow value (`[...]`, `{...}`), on one line or wrapped over several.
   *
   * The continuation lines must be indented deeper than the parent, and the
   * brackets have to balance; a flow value that never closes is an error with
   * the line the flow started on.
   */
  readFlow(text, entry, parentIndent) {
    let body = text;
    let lastConsumed = entry.rawIndex;
    let index = entry.rawIndex + 1;
    while (!flowBalanced(body) && index < this.raw.length) {
      const line = this.raw[index];
      if (line.trim() === '') {
        lastConsumed = index;
        index++;
        continue;
      }
      const leading = /^[ \t]*/u.exec(line)[0];
      if (leading.includes('\t')) {
        this.fail('タブはインデントに使えません。', { line: index + 1 + this.offset, text: line, rawIndex: index });
      }
      if (leading.length <= parentIndent) break;
      body = `${body} ${line.trim()}`;
      lastConsumed = index;
      index++;
    }
    if (!flowBalanced(body)) this.fail('対応外のフロー形式です。] か } が足りません。', entry);
    while (this.entries[this.pos] !== undefined && this.entries[this.pos].rawIndex <= lastConsumed) this.pos++;
    return new FlowParser(body, entry, this).parseDocument();
  }

  /** A plain, unquoted scalar. */
  parsePlain(text, entry, indent) {
    const value = text.trim();
    if (/^[&*!]/u.test(value)) {
      this.fail('対応外の構文です。アンカー（&）・エイリアス（*）・タグ（!）は使えません。', entry);
    }
    if (/^[?@`]/u.test(value)) this.fail(`対応外の構文です。「${value[0]}」で始まる値は使えません。`, entry);
    if (/^-(?:[ \t]|$)/u.test(value)) {
      this.fail('対応外の構文です。値の位置に「- 」（リスト項目）は書けません。', entry);
    }
    const body = stripInlineComment(value).trim();
    if (/:\s/u.test(body)) {
      this.fail('値の中に「: 」があります。引用符（"..."）で囲ってください。', entry);
    }
    const next = this.peek();
    if (next !== undefined && next.indent > indent) {
      this.fail('対応外の構文です。値を次の行に続ける書き方はできません。1 行に収めるか、ブロックスカラー（| や >）を使ってください。', next);
    }
    return convertPlainScalar(body);
  }

  /** The nested block under an empty value, or null. */
  parseNested(entry, indent) {
    const next = this.peek();
    if (next === undefined) return null;
    if (next.indent > indent) return this.parseBlock(next.indent);
    if (next.indent === indent && isSequenceStart(next.text)) {
      this.fail('対応外の構文です。リストはキーより深くインデントしてください。', next);
    }
    return null;
  }

  /** A `'...'` or `"..."` string on one line. */
  readQuoted(text, entry) {
    const quote = text[0];
    let value = '';
    for (let index = 1; index < text.length; index++) {
      const char = text[index];
      if (quote === "'") {
        if (char === "'") {
          if (text[index + 1] === "'") {
            value += "'";
            index++;
            continue;
          }
          return { value, end: index + 1 };
        }
        value += char;
        continue;
      }
      if (char === '\\') {
        const escape = text[index + 1];
        index++;
        if (escape === undefined) this.fail('対応外の構文です。文字列が行末で終わっています。', entry);
        const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', b: '\b', f: '\f' };
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.fail(`対応外のエスケープです: 「\\u${hex}」`, entry);
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
          continue;
        }
        if (simple[escape] === undefined) this.fail(`対応外のエスケープです: 「\\${escape}」`, entry);
        value += simple[escape];
        continue;
      }
      if (char === '"') return { value, end: index + 1 };
      value += char;
    }
    this.fail('対応外の構文です。引用符が閉じられていません（複数行のクォート文字列は使えません）。', entry);
  }

  /** Read a `|` or `>` block scalar. */
  readBlockScalar(entry, parentIndent, header) {
    const match = /^([|>])([+-]?)([1-9]?)([+-]?)$/u.exec(header);
    if (!match) this.fail(`対応外のブロックスカラー指定です: 「${header}」`, entry);
    const fold = match[1] === '>';
    const indicators = `${match[2]}${match[4]}`;
    const chomp = indicators.includes('-') ? 'strip' : indicators.includes('+') ? 'keep' : 'clip';
    const minIndent = parentIndent + 1;
    const lines = [];
    let blockIndent = null;
    let lastConsumed = entry.rawIndex;
    let index = entry.rawIndex + 1;
    while (index < this.raw.length) {
      const line = this.raw[index];
      const blank = line.trim() === '';
      const leading = /^[ \t]*/u.exec(line)[0];
      if (!blank && leading.includes('\t')) {
        this.fail('タブはインデントに使えません。', { line: index + 1 + this.offset, text: line, rawIndex: index });
      }
      const width = leading.length;
      if (!blank) {
        if (width < minIndent) break;
        if (blockIndent === null) blockIndent = width;
        else if (width < blockIndent) break;
      }
      lines.push(blank ? '' : line.slice(blockIndent ?? width));
      lastConsumed = index;
      index++;
    }
    while (this.entries[this.pos] !== undefined && this.entries[this.pos].rawIndex <= lastConsumed) this.pos++;
    const joined = fold ? foldBlockLines(lines) : lines.join('\n');
    const clipped = joined.replace(/\n+$/u, '');
    if (chomp === 'strip') return clipped;
    if (chomp === 'keep') return joined === '' ? '' : `${joined}\n`;
    return clipped === '' ? '' : `${clipped}\n`;
  }
}

/** The single-line flow reader for `[a, b]` and `{k: v}`. */
class FlowParser {
  constructor(text, entry, parser) {
    this.text = text;
    this.entry = entry;
    this.parser = parser;
    this.index = 0;
  }

  /** Parse the whole flow value, then allow a trailing comment. */
  parseDocument() {
    const value = this.parseValue();
    this.skipSpaces();
    const rest = this.text.slice(this.index);
    if (rest !== '' && !rest.startsWith('#')) {
      this.parser.fail('対応外のフロー形式です。式のあとに余分な文字があります。', this.entry);
    }
    if (this.index >= this.text.length && !this.closed) {
      this.parser.fail('対応外のフロー形式です。] か } が足りません。', this.entry);
    }
    return value;
  }

  skipSpaces() {
    while (this.index < this.text.length && (this.text[this.index] === ' ' || this.text[this.index] === '\t')) {
      this.index++;
    }
  }

  parseValue() {
    this.skipSpaces();
    const char = this.text[this.index];
    if (char === undefined) this.parser.fail('対応外のフロー形式です。値が途中で終わっています。', this.entry);
    if (char === '[') return this.parseList();
    if (char === '{') return this.parseMap();
    if (char === '"' || char === "'") {
      const quoted = this.parser.readQuoted(this.text.slice(this.index), this.entry);
      this.index += quoted.end;
      return quoted.value;
    }
    return convertPlainScalar(this.readPlainToken());
  }

  parseList() {
    this.index++;
    const items = [];
    for (;;) {
      this.skipSpaces();
      if (this.text[this.index] === ']') {
        this.index++;
        this.closed = true;
        return items;
      }
      if (this.index >= this.text.length) {
        this.parser.fail('対応外のフロー形式です。] が足りません（複数行のフロー形式は使えません）。', this.entry);
      }
      items.push(this.parseValue());
      this.skipSpaces();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.text[this.index] === ']') continue;
      if (this.index >= this.text.length) {
        this.parser.fail('対応外のフロー形式です。] が足りません（複数行のフロー形式は使えません）。', this.entry);
      }
      this.parser.fail('対応外のフロー形式です。値のあとには , か ] が必要です。', this.entry);
    }
  }

  parseMap() {
    this.index++;
    const map = {};
    for (;;) {
      this.skipSpaces();
      if (this.text[this.index] === '}') {
        this.index++;
        this.closed = true;
        return map;
      }
      if (this.index >= this.text.length) {
        this.parser.fail('対応外のフロー形式です。} が足りません（複数行のフロー形式は使えません）。', this.entry);
      }
      let key;
      if (this.text[this.index] === '"' || this.text[this.index] === "'") {
        const quoted = this.parser.readQuoted(this.text.slice(this.index), this.entry);
        this.index += quoted.end;
        key = quoted.value;
      } else {
        key = this.readPlainToken(':', true);
        if (key === '') this.parser.fail('対応外のフロー形式です。キーが空です。', this.entry);
      }
      this.skipSpaces();
      if (this.text[this.index] !== ':') {
        this.parser.fail(`対応外のフロー形式です。キー「${key}」のあとに : がありません。`, this.entry);
      }
      this.index++;
      map[key] = this.parseValue();
      this.skipSpaces();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.text[this.index] === '}') continue;
      if (this.index >= this.text.length) {
        this.parser.fail('対応外のフロー形式です。} が足りません（複数行のフロー形式は使えません）。', this.entry);
      }
      this.parser.fail('対応外のフロー形式です。値のあとには , か } が必要です。', this.entry);
    }
  }

  /** A plain token up to `,`, a closing bracket, or a mapping colon. */
  readPlainToken(stopAtColon = false) {
    const start = this.index;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === ',' || char === ']' || char === '}') break;
      if (stopAtColon && char === ':') break;
      this.index++;
    }
    if (this.index === start && !stopAtColon) {
      this.parser.fail('対応外のフロー形式です。値が空です。', this.entry);
    }
    return this.text.slice(start, this.index).trim();
  }
}

// ---------------------------------------------------------------------------
// Reading a project
// ---------------------------------------------------------------------------

/** The format guessed from a file name: markdown, json, yaml or '' (unknown). */
export function projectFormat(path) {
  const text = String(path ?? '').toLowerCase();
  if (/\.(?:md|markdown)$/u.test(text)) return 'markdown';
  if (/\.json$/u.test(text)) return 'json';
  if (/\.ya?ml$/u.test(text)) return 'yaml';
  return '';
}

/** Strip the indentation the Markdown author added to the fence body. */
function dedentBlock(lines) {
  const widths = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/u.exec(line)[0].length);
  const width = widths.length === 0 ? 0 : Math.min(...widths);
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(width)));
}

/**
 * The first ```` ```yaml ```` or ```` ```json ```` block of a Markdown file.
 *
 * @param {string} text - the Markdown text.
 * @returns {{ format: 'yaml'|'json', body: string, startLine: number }|undefined}
 */
export function extractFence(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index++) {
    const match = /^[ \t]*```+[ \t]*([A-Za-z]+)?/u.exec(lines[index]);
    if (!match) continue;
    const language = String(match[1] ?? '').toLowerCase();
    if (!FENCE_LANGUAGES.includes(language)) continue;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (/^[ \t]*```+[ \t]*$/u.test(lines[cursor])) {
        return {
          format: language === 'json' ? 'json' : 'yaml',
          body: dedentBlock(body).join('\n'),
          startLine: index + 2,
        };
      }
      body.push(lines[cursor]);
    }
    fail('``` で始まるコードブロックが閉じられていません。', {
      line: index + 1,
      code: 'PROJECT_MARKDOWN',
      source: lines[index],
    });
  }
  return undefined;
}

/** Read one document body as JSON when possible, else as YAML. */
function readDocument(text, mode, lineOffset) {
  if (mode !== 'yaml') {
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('プロジェクトは「{ ... }」の形（オブジェクト）にしてください。', {
          line: lineOffset,
          code: 'PROJECT_PARSE',
        });
      }
      return { project: value, format: 'json' };
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if (mode === 'json') {
        fail(`JSON として読めません: ${reasonOf(error)}`, { line: lineOffset, code: 'PROJECT_PARSE' });
      }
    }
  }
  return { project: parseYamlSubset(text, { lineOffset: lineOffset - 1 }), format: 'yaml' };
}

/**
 * Read a project from text.
 *
 * JSON is tried first and the YAML subset is the fallback, except for `.json`
 * files (JSON only) and Markdown (the first yaml/json fence).
 *
 * @param {string} text - the project text.
 * @param {{ path?: string, format?: string }} [options] - `path` picks `.md` / `.json` / `.yaml` handling.
 * @returns {{ format: 'json'|'yaml', container: 'text'|'markdown', project: object }}
 */
export function parseProject(text, options = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '');
  if (source.trim() === '') {
    fail('プロジェクトが空です。`version: 1` と `steps:` から書いてください。', { code: 'PROJECT_PARSE' });
  }
  const format = options.format ?? projectFormat(options.path ?? '');
  if (format === 'markdown') {
    const fence = extractFence(source);
    if (fence === undefined) {
      fail('Markdown のプロジェクトには ```yaml か ```json で始まるコードブロックが必要です。', {
        line: 1,
        code: 'PROJECT_MARKDOWN',
      });
    }
    const document = readDocument(fence.body, fence.format, fence.startLine);
    return { ...document, container: 'markdown' };
  }
  if (format === 'json') {
    const document = readDocument(source, 'json', 1);
    return { ...document, container: 'text' };
  }
  if (format === 'yaml') {
    const document = readDocument(source, 'yaml', 1);
    return { ...document, container: 'text' };
  }
  const fence = /^[ \t]*```+[ \t]*(?:ya?ml|json)\b/imu.test(source) ? extractFence(source) : undefined;
  if (fence !== undefined) {
    const document = readDocument(fence.body, fence.format, fence.startLine);
    return { ...document, container: 'markdown' };
  }
  const document = readDocument(source, 'auto', 1);
  return { ...document, container: 'text' };
}

/**
 * Check and normalise a parsed project.
 *
 * Ids default to `step1`, `step2`…; `args` defaults to `{}`. Unknown keys are
 * refused so a typo cannot change the meaning of a recipe.
 *
 * @param {unknown} raw - the parsed document.
 * @param {{ source?: string, maxSteps?: number }} [options]
 * @returns {{ version: number, title: string, outputDir: string, steps: Array<{ index: number, id: string, tool: string, args: object }> }}
 */
export function normalizeProject(raw, options = {}) {
  const maxSteps = Number.isFinite(options.maxSteps) && options.maxSteps > 0 ? Math.floor(options.maxSteps) : DEFAULT_MAX_STEPS;
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('プロジェクトは「key: 値」を並べたもの（オブジェクト）である必要があります。', { code: 'PROJECT_SHAPE' });
  }
  for (const key of Object.keys(raw)) {
    if (!PROJECT_KEYS.includes(key)) {
      fail(`不明なキー「${key}」があります。使えるのは ${PROJECT_KEYS.join(' / ')} だけです。`, { code: 'PROJECT_SHAPE' });
    }
  }
  let version = 1;
  if (raw.version !== undefined && raw.version !== null) {
    if (Number(raw.version) !== 1) {
      fail(`version は 1 だけ対応しています（${JSON.stringify(raw.version)} が指定されています）。`, { code: 'PROJECT_SHAPE' });
    }
    version = 1;
  }
  let title = '';
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string' && typeof raw.title !== 'number') {
      fail('title は文字列で書いてください。', { code: 'PROJECT_SHAPE' });
    }
    title = String(raw.title).trim();
  }
  let outputDir = '';
  if (raw.outputDir !== undefined && raw.outputDir !== null) {
    if (typeof raw.outputDir !== 'string') fail('outputDir は文字列で書いてください。', { code: 'PROJECT_SHAPE' });
    const normalized = raw.outputDir.trim().replace(/[\\/]+/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..')) {
      fail(`outputDir「${raw.outputDir}」は使えません。セッションの中の相対パス（例: media-studio/pv）を書いてください。`, { code: 'PROJECT_SHAPE' });
    }
    outputDir = normalized;
  }
  if (!Array.isArray(raw.steps)) {
    fail('steps は「- tool: ...」のリストで書いてください。', { code: 'PROJECT_SHAPE' });
  }
  if (raw.steps.length === 0) {
    fail('steps が空です。1 つ以上の手順を書いてください。', { code: 'PROJECT_SHAPE' });
  }
  if (raw.steps.length > maxSteps) {
    fail(`手順が多すぎます（${raw.steps.length} 個）。1 つのプロジェクトは ${maxSteps} 手順までにしてください。`, { code: 'PROJECT_SHAPE' });
  }
  const ids = new Set();
  const steps = raw.steps.map((entry, index) => {
    const position = index + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`手順 ${position} は「- tool: ...」の形（オブジェクト）で書いてください。`, { code: 'PROJECT_SHAPE' });
    }
    for (const key of Object.keys(entry)) {
      if (!STEP_KEYS.includes(key)) {
        fail(`手順 ${position} に不明なキー「${key}」があります。使えるのは ${STEP_KEYS.join(' / ')} だけです。`, { code: 'PROJECT_SHAPE' });
      }
    }
    if (typeof entry.tool !== 'string' || entry.tool.trim() === '') {
      fail(`手順 ${position} に tool がありません。実行したいツール名を書いてください。`, { code: 'PROJECT_SHAPE' });
    }
    const tool = entry.tool.trim();
    if (!isStudioTool(tool)) {
      fail(`手順 ${position} のツール「${tool}」は使えません。tools-list.js にあるスタジオのツール名を書いてください。`, { code: 'PROJECT_SHAPE' });
    }
    const id = entry.id === undefined || entry.id === null ? `step${position}` : String(entry.id).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(id)) {
      fail(`手順 ${position} の id「${id}」は使えません。英数字と _ - で、英字か _ から始めてください（$ で参照する名前になります）。`, { code: 'PROJECT_SHAPE' });
    }
    if (ids.has(id)) {
      fail(`id「${id}」が手順 ${position} で重複しています。`, { code: 'PROJECT_SHAPE' });
    }
    ids.add(id);
    let args = entry.args;
    if (args === undefined || args === null) args = {};
    else if (typeof args !== 'object' || Array.isArray(args)) {
      fail(`手順 ${position}（${id}）の args は「key: 値」の集まりで書いてください。`, { code: 'PROJECT_SHAPE' });
    }
    return { index, id, tool, args };
  });
  return { version, title, outputDir, steps };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** A value a dry run could not resolve yet. */
function isPlaceholder(value) {
  return typeof value === 'string' && (REFERENCE.test(value) || value.includes('{{'));
}

/**
 * Every `$id` / `$id.field` / `{{id.field}}` reference inside arguments.
 *
 * @param {unknown} value - arguments to scan.
 * @param {Array<{ id: string, field?: string, raw: string, embedded: boolean }>} [found]
 * @returns {Array<{ id: string, field?: string, raw: string, embedded: boolean }>}
 */
export function collectReferences(value, found = []) {
  if (typeof value === 'string') {
    if (value.startsWith('$$')) return found;
    const direct = REFERENCE.exec(value);
    if (direct !== null) {
      found.push({ id: direct[1], field: direct[2], raw: value, embedded: false });
      return found;
    }
    for (const match of value.matchAll(EMBEDDED_REFERENCE)) {
      found.push({ id: match[1], field: match[2], raw: value, embedded: true });
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectReferences(item, found);
    return found;
  }
  return found;
}

/**
 * Replace references with the results of earlier steps.
 *
 * `$cover` becomes the earlier step's path, `$cover.bytes` one field of it, and
 * `{{cover.path}}` is embedded in a longer string. `$$` at the start of a
 * string is an escaped literal `$`. A reference to a step that has not run is
 * an error; during a dry run it is left visible instead.
 *
 * @param {unknown} value - arguments to resolve.
 * @param {Map<string, object>|object} results - results by step id.
 * @param {{ trace?: Array<object>, dryRun?: boolean }} [options]
 * @returns {unknown} the resolved copy.
 */
export function resolveReferences(value, results, options = {}) {
  const trace = options.trace;
  const dryRun = options.dryRun === true;

  function lookup(id, field, raw) {
    const record = results instanceof Map ? results.get(id) : results?.[id];
    if (record === undefined) {
      if (dryRun) return raw;
      fail(`「${raw}」が参照している手順「${id}」はまだ実行されていません（または存在しません）。参照できるのは前の手順だけです。`, {
        code: 'PROJECT_REF',
      });
    }
    if (field === undefined || field === '') {
      const path = record.path;
      if (typeof path !== 'string' || path === '') {
        fail(`「${raw}」: 手順「${id}」の結果に path がありません（ある値: ${Object.keys(record).join(', ')}）。「$${id}.<名前>」で値を指定してください。`, {
          code: 'PROJECT_REF',
        });
      }
      if (Array.isArray(trace)) trace.push({ from: raw, step: id, field: 'path', value: path });
      return path;
    }
    const field2 = record[field];
    if (field2 === undefined) {
      fail(`「${raw}」: 手順「${id}」に「${field}」がありません（ある値: ${Object.keys(record).join(', ')}）。`, { code: 'PROJECT_REF' });
    }
    if (Array.isArray(trace)) trace.push({ from: raw, step: id, field, value: field2 });
    return field2;
  }

  function resolveString(node) {
    if (node.startsWith('$$')) return node.slice(1);
    const direct = REFERENCE.exec(node);
    if (direct !== null) return lookup(direct[1], direct[2], node);
    return node.replace(EMBEDDED_REFERENCE, (whole, id, field) => {
      const resolved = lookup(id, field, whole);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }

  function walk(node) {
    if (typeof node === 'string') return resolveString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(node)) out[key] = walk(item);
      return out;
    }
    return node;
  }

  return walk(value);
}

// ---------------------------------------------------------------------------
// Argument checking
// ---------------------------------------------------------------------------

/** True when `value` fits one JSON-schema type name. */
function matchesType(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** A short description of a value, for an error message. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'リスト';
  if (typeof value === 'object') return 'オブジェクト';
  if (typeof value === 'string') return `文字列「${value.length > 30 ? `${value.slice(0, 30)}…` : value}」`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Check arguments against a tool's `parameters` JSON schema.
 *
 * Only what a project author can get wrong is checked: required keys, the JSON
 * type, `enum` membership, `minItems` / `maxItems`, and unknown keys where the
 * schema forbids them. Unsupported schema keywords are ignored rather than
 * guessed at, and unresolved `$id` placeholders are not type-checked.
 *
 * @param {object|undefined} schema - the tool's `parameters`.
 * @param {unknown} args - the resolved arguments.
 * @returns {string[]} one message per problem, `args.timeline.tracks[0]…` style.
 */
export function validateArgs(schema, args, options = {}) {
  const problems = [];
  const root = options.root ?? 'args';
  check(schema, args, root);
  return problems;

  function check(node, value, path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || value === undefined) return;
    const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
    const placeholder = isPlaceholder(value);
    if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
      if (!placeholder) {
        problems.push(`${path}: ${types.join(' か ')} が必要ですが ${describeValue(value)} が入っています。`);
        return;
      }
    }
    if (Array.isArray(node.enum) && !placeholder && !node.enum.some((item) => item === value)) {
      const choices = node.enum.slice(0, 8).map((item) => JSON.stringify(item)).join(', ');
      problems.push(`${path}: ${JSON.stringify(value)} は選べません（${choices} のどれか）。`);
    }
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (isObject && (types.length === 0 || types.includes('object'))) {
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (value[key] === undefined) problems.push(`${path}.${key}: 必須の引数がありません。`);
        }
      }
      const properties = node.properties !== null && typeof node.properties === 'object' ? node.properties : {};
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) problems.push(`${path}.${key}: このツールには無い引数です。`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (value[key] !== undefined) check(child, value[key], `${path}.${key}`);
      }
    }
    if (Array.isArray(value)) {
      if (typeof node.minItems === 'number' && value.length < node.minItems) {
        problems.push(`${path}: ${node.minItems} 個以上必要です（${value.length} 個）。`);
      }
      if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
        problems.push(`${path}: ${node.maxItems} 個までです（${value.length} 個）。`);
      }
      if (node.items !== undefined) value.forEach((item, index) => check(node.items, item, `${path}[${index}]`));
    }
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** The project options for this row. */
function resolveProjectOptions(config) {
  const source = config?.project ?? {};
  const timeout = Number(source.timeoutMs);
  const maxSteps = Number(source.maxSteps);
  return {
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : DEFAULT_MAX_STEPS,
  };
}

/** The `path` of a result, or '' when it made no single file. */
function pathOf(result) {
  if (typeof result?.path === 'string' && result.path !== '') return result.path;
  if (Array.isArray(result?.files)) {
    const first = result.files.find((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string');
    if (first !== undefined) return first.path;
  }
  return '';
}

/** The media type of an artifact, from the result or the extension. */
function mediaTypeOf(result, path) {
  if (typeof result?.mediaType === 'string' && result.mediaType !== '') return result.mediaType;
  const match = /\.[A-Za-z0-9]+$/u.exec(String(path ?? ''));
  if (match === null) return '';
  return MEDIA_TYPES[match[0].toLowerCase()] ?? '';
}

/**
 * The record a later step sees as `$id`.
 *
 * The tool's own fields are kept, plus normalised `path` / `absPath` / `name` /
 * `bytes` / `mediaType`.
 */
async function summarizeStep(step, result, cwd) {
  const value = result !== null && typeof result === 'object' ? result : {};
  const record = { ...value };
  const path = pathOf(value);
  record.id = step.id;
  record.tool = step.tool;
  if (path !== '') {
    record.path = path;
    record.absPath = isAbsolute(path) ? path : resolve(cwd, path);
    if (typeof record.name !== 'string' || record.name === '') record.name = basename(path);
    if (typeof record.bytes !== 'number') {
      try {
        const info = await stat(record.absPath);
        record.bytes = info.size;
      } catch {
        // The tool may report a path it did not write (a read-only step).
      }
    }
  }
  if (typeof record.mediaType !== 'string' || record.mediaType === '') {
    const mediaType = mediaTypeOf(value, path);
    if (mediaType !== '') record.mediaType = mediaType;
  }
  return record;
}

/**
 * Every file a step produced, as artifacts.
 *
 * A tool may report one `path` or a `files` list (`cad_drawing` draws a front,
 * a top and an isometric view; `produce_video` may hand back one clip). The
 * `path` comes first and the `files` follow without repeating it, so a report
 * never lists the same file twice and never loses the 2nd…nth file.
 */
async function collectArtifacts(step, record, cwd) {
  const found = [];
  const seen = new Set();
  const keyOf = (path) => String(path).replace(/\\/gu, '/');
  const fileMeta = new Map();
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (file === null || typeof file !== 'object') continue;
      if (typeof file.path !== 'string' || file.path === '') continue;
      fileMeta.set(keyOf(file.path), file);
    }
  }
  const add = async (path, bytes, mediaType, view) => {
    if (typeof path !== 'string' || path === '') return;
    const key = keyOf(path);
    if (seen.has(key)) return;
    seen.add(key);
    const meta = fileMeta.get(key) ?? {};
    const statedBytes = typeof bytes === 'number' ? bytes : meta.bytes;
    const statedType = typeof mediaType === 'string' && mediaType !== '' ? mediaType : meta.mediaType;
    const statedView = typeof view === 'string' && view !== '' ? view : meta.view;
    let size;
    if (typeof statedBytes === 'number' && Number.isFinite(statedBytes)) {
      size = statedBytes;
    } else {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path);
      try {
        size = (await stat(absolute)).size;
      } catch {
        size = 0;
      }
    }
    const artifact = {
      id: step.id,
      tool: step.tool,
      path,
      bytes: size,
      mediaType: typeof statedType === 'string' && statedType !== '' ? statedType : mediaTypeOf({}, path),
    };
    if (typeof statedView === 'string' && statedView !== '') artifact.view = statedView;
    found.push(artifact);
  };
  if (typeof record.path === 'string' && record.path !== '') {
    await add(record.path, record.bytes, record.mediaType, record.view);
  }
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (file === null || typeof file !== 'object') continue;
      await add(file.path, file.bytes, file.mediaType, file.view);
    }
  }
  return found;
}

/** `formatBytes` with a local fallback for a bare context. */
function bytesFormatter(helpers) {
  if (typeof helpers?.formatBytes === 'function') return (bytes) => helpers.formatBytes(bytes);
  return (bytes) => {
    const size = Number.isFinite(bytes) ? bytes : 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };
}

/** Arguments shortened for a one-line report. */
function compactArgs(args) {
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    text = '';
  }
  if (text === undefined || text === '') return '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** The tool definition. */
function renderProjectTool(ctx, options, settings, helpers) {
  const formatBytes = bytesFormatter(helpers);

  /** The session directory, resolved the way every studio tool resolves it. */
  async function sessionCwd(exec) {
    if (typeof helpers?.resolveSessionCwd === 'function') return helpers.resolveSessionCwd(ctx, exec);
    return process.cwd();
  }

  /** Look up a registered tool by name. */
  function toolLookup() {
    const candidates = [];
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
    if (viaGet !== undefined && viaGet !== null) candidates.push(viaGet);
    if (ctx?.tools !== undefined && ctx.tools !== null) candidates.push(ctx.tools);
    return (name) => {
      for (const registry of candidates) {
        if (typeof registry?.get === 'function') {
          const found = registry.get(name);
          if (found !== undefined && found !== null) return found;
        }
      }
      return null;
    };
  }

  /** The project text and the path it came from. */
  async function loadProject(args, cwd) {
    const source = typeof args.source === 'string' ? args.source : '';
    if (source.trim() !== '') return { text: source, path: '' };
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    if (path === '') {
      fail('path か source のどちらかが必要です。プロジェクトファイルのパスを渡すか、プロジェクトの中身を source に直接書いてください。', {
        code: 'PROJECT_INPUT',
      });
    }
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      return { text: await readFile(absolute, 'utf8'), path };
    } catch (error) {
      fail(`プロジェクトファイルを読めません: ${path}（${error?.code ?? reasonOf(error)}）`, { code: 'PROJECT_INPUT' });
    }
    return { text: '', path };
  }

  /** Every reference must point at an earlier step of this project. */
  function checkReferenceOrder(project) {
    const positions = new Map(project.steps.map((step, index) => [step.id, index]));
    project.steps.forEach((step, index) => {
      for (const reference of collectReferences(step.args)) {
        const position = positions.get(reference.id);
        if (position === undefined) {
          fail(`手順 ${index + 1}（${step.id}）の「${reference.raw}」が指す id「${reference.id}」はこのプロジェクトにありません。`, {
            code: 'PROJECT_REF',
          });
        }
        if (position >= index) {
          fail(`手順 ${index + 1}（${step.id}）の「${reference.raw}」は手順 ${position + 1}（${reference.id}）を参照していますが、参照できるのは前の手順だけです。`, {
            code: 'PROJECT_REF',
          });
        }
      }
    });
  }

  return {
    name: 'render_project',
    description: [
      'Run a production written as text: a project file (YAML, JSON, or a ```yaml / ```json block in Markdown) whose steps name studio tools and their arguments, executed top to bottom.',
      'Each step may use the result of an earlier step: "$cover" is that step\'s file path, "$cover.bytes" / "$cover.name" / "$cover.attachmentId" one field of it, and "{{cover.path}}" embeds it inside a longer string.',
      'Steps are: "- id: cover" (optional, defaults to step1), "tool: generate_image", and "args:" with the tool arguments. Only the studio\'s own tool names are allowed.',
      'Use dryRun to check the plan and the resolved arguments without creating anything, and stopOnError: false to keep going after a failing step.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Project file path, session-relative or absolute. The extension picks the reader: .yaml / .yml, .json, or .md (the first yaml/json fence).',
        },
        source: {
          type: 'string',
          description: 'The project itself as text. Takes precedence over path; .md / .json / .yaml handling is inferred, otherwise JSON is tried first and YAML second.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Resolve the steps and their arguments but run nothing and create no files. Defaults to false.',
        },
        stopOnError: {
          type: 'boolean',
          description: 'Stop at the first failing step. Defaults to true; false keeps going and collects the failures.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dryRun: { type: 'boolean' },
          steps: { type: 'array', items: { type: 'object' } },
          artifacts: { type: 'array', items: { type: 'object' } },
          failures: { type: 'array', items: { type: 'object' } },
          seconds: { type: 'number' },
        },
      },
      render(_args, value) {
        const lines = [];
        const artifactLine = (artifact) => {
          const size = typeof artifact.bytes === 'number' && artifact.bytes > 0 ? ` (${formatBytes(artifact.bytes)})` : '';
          const view = typeof artifact.view === 'string' && artifact.view !== '' ? ` [${artifact.view}]` : '';
          return `- ${artifact.id}: ${artifact.path}${size}${view}`;
        };
        if (value.dryRun) {
          lines.push(`ドライラン: ${value.title === '' ? '無題のプロジェクト' : value.title}（${value.steps.length} ステップ、何も作成していません）`);
          lines.push('手順と解決後の引数:');
          for (const step of value.steps) {
            lines.push(step.ok ? `- ${step.id}: ${step.tool} ${compactArgs(step.args)}` : `- ${step.id}: ${step.tool} — ✗ ${step.error}`);
          }
          if (value.artifacts.length > 0) {
            lines.push('成果物:');
            for (const artifact of value.artifacts) lines.push(artifactLine(artifact));
          }
        } else {
          const done = value.steps.filter((step) => step.ok).length;
          lines.push(`${value.steps.length} ステップ中 ${done} 成功。${Number(value.seconds).toFixed(1)} 秒。`);
          if (value.artifacts.length === 0) {
            lines.push('成果物: なし');
          } else {
            lines.push('成果物:');
            for (const artifact of value.artifacts) lines.push(artifactLine(artifact));
          }
          if (value.failures.length > 0) {
            lines.push('失敗:');
            for (const failure of value.failures) lines.push(`- ${failure.id}（${failure.tool}）: ${failure.error}`);
          }
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {};
      const started = Date.now();
      const cwd = await sessionCwd(exec);
      const loaded = await loadProject(args, cwd);
      const parsed = parseProject(loaded.text, { path: loaded.path });
      const project = normalizeProject(parsed.project, { maxSteps: settings.maxSteps });
      checkReferenceOrder(project);
      const dryRun = args.dryRun === true;
      const stopOnError = args.stopOnError !== false;
      const lookup = toolLookup();
      const results = new Map();
      const steps = [];
      const artifacts = [];
      const failures = [];

      const recordFailure = (step, error) => {
        const entry = { id: step.id, tool: step.tool, ok: false, error: reasonOf(error) };
        steps.push(entry);
        failures.push({ id: step.id, tool: step.tool, error: entry.error });
      };

      for (const step of project.steps) {
        const definition = lookup(step.tool);
        let resolved;
        try {
          resolved = resolveReferences(step.args, results, { dryRun });
        } catch (error) {
          recordFailure(step, error);
          if (stopOnError) break;
          continue;
        }
        if (project.outputDir !== '' && definition !== null) {
          const properties = definition.parameters?.properties ?? {};
          if (properties.outputDir !== undefined && resolved.outputDir === undefined) {
            resolved = { ...resolved, outputDir: project.outputDir };
          }
        }
        if (definition === null) {
          recordFailure(step, new ProjectError(`ツール「${step.tool}」はこの環境では登録されていません。`, { code: 'PROJECT_TOOL' }));
          if (stopOnError) break;
          continue;
        }
        const problems = validateArgs(definition.parameters, resolved);
        if (problems.length > 0) {
          const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).map((problem) => `  - ${problem}`).join('\n');
          const more = problems.length > MAX_REPORTED_PROBLEMS ? `\n  （ほか ${problems.length - MAX_REPORTED_PROBLEMS} 件）` : '';
          recordFailure(step, new ProjectError(`引数がツールのスキーマに合いません。\n${shown}${more}`, { code: 'PROJECT_ARGS' }));
          if (stopOnError) break;
          continue;
        }
        if (dryRun) {
          steps.push({ id: step.id, tool: step.tool, ok: true, args: resolved });
          continue;
        }
        let value;
        try {
          value = await definition.execute(resolved, exec);
        } catch (error) {
          recordFailure(step, error);
          if (stopOnError) break;
          continue;
        }
        const record = await summarizeStep(step, value, cwd);
        results.set(step.id, record);
        const entry = { id: step.id, tool: step.tool, ok: true };
        if (typeof record.path === 'string' && record.path !== '') entry.path = record.path;
        if (typeof record.bytes === 'number') entry.bytes = record.bytes;
        steps.push(entry);
        for (const artifact of await collectArtifacts(step, record, cwd)) artifacts.push(artifact);
      }

      return {
        title: project.title,
        dryRun,
        steps,
        artifacts,
        failures,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      };
    },
  };
}

/**
 * Register the v3.1 text tools (`render_project`).
 *
 * Registration is synchronous; the work happens in `execute`.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {object} config - the raw row config (`project.timeoutMs`, `project.maxSteps`).
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers
 * @returns {void}
 */
export function registerProjectTools(ctx, options, config, helpers) {
  const settings = resolveProjectOptions(config);
  const tool = renderProjectTool(ctx, options, settings, helpers ?? {});
  ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
}
