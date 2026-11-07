/**
 * Standard MIDI File (SMF) の読み書き。純 JS。外部ライブラリなし。
 *
 * この module は「バイト列 ⇄ イベント列」だけを担当する。DAW 的な編曲
 * (トラック・パン・音量・リバーブ) や他形式への書き出しは `daw.js` が持つ。
 * 分けている理由は 2 つ:
 *
 * 1. `export_daw_project` と `import_midi` が同じ定義を共有するため。
 * 2. `node --test` が、書き出したものを読み戻して一致を証明できるようにするため。
 *
 * 対応しているもの:
 *   - SMF type 0 / type 1
 *   - tick division (PPQN)。SMPTE division は対象外で、読むとエラーになる
 *   - variable-length quantity (delta time と meta の長さ)
 *   - running status (書き出しでも圧縮し、読み込みでも受ける)
 *   - meta: tempo (0x51)、time signature (0x58)、track name (0x03)、
 *     MIDI channel prefix (0x20)、end of track (0x2F)
 *   - program change、note on/off (velocity 0 の note on も off として扱う)、
 *     コントローラチェンジ (CC7 / CC10 を含む全 CC)
 *
 * 拡張子やファイル入出力は知らない。呼び出し側が Buffer を渡す。
 */

/** 既定の分解能 (tick / 4 分音符)。 */
export const MIDI_TICKS_PER_QUARTER = 480;

/** SMF の division は tick モードでは 15 bit。 */
export const MIDI_MAX_DIVISION = 0x7fff;

/** General MIDI の打楽器チャンネル (0 始まり)。1 始まりでは 10。 */
export const GM_DRUM_CHANNEL = 0x09;

/** velocity を指定されなかったときの値。 */
export const MIDI_DEFAULT_VELOCITY = 96;

/** velocity と CC の上限。 */
const MAX_DATA = 0x7f;

/** 書き出すときのイベント種別。 */
const EVENT_META = 0;
const EVENT_CONTROL = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_NOTE_ON = 3;

const META_TEXT = 0x03;
const META_CHANNEL_PREFIX = 0x20;
const META_END_OF_TRACK = 0x2f;
const META_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;

const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CONTROL_CHANGE = 0xb0;
const STATUS_PROGRAM_CHANGE = 0xc0;
const STATUS_CHANNEL_PRESSURE = 0xd0;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

// #region Bytes

/** 文字列を UTF-8 のバイト配列にする。 */
export function encodeText(text) {
  return Array.from(utf8Encoder.encode(String(text ?? '')));
}

/** UTF-8 のバイト配列を文字列にする。壊れた並びは replacement char になる。 */
export function decodeText(bytes) {
  return utf8Decoder.decode(Uint8Array.from(bytes ?? []));
}

/** 0 以上の整数を variable-length quantity にする。 */
export function encodeVlq(value) {
  const clamped = Math.max(0, Math.trunc(Number(value) || 0));
  const bytes = [clamped & 0x7f];
  let rest = clamped >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/**
 * VLQ を読む。
 *
 * @param {Uint8Array|number[]} bytes - 対象のバイト列。
 * @param {number} offset - 読み始める位置。
 * @returns {{ value: number, offset: number }} 値と、読み終わった次の位置。
 */
export function decodeVlq(bytes, offset = 0) {
  let value = 0;
  let cursor = Math.max(0, Math.trunc(offset) || 0);
  for (let count = 0; count < 5; count += 1) {
    if (cursor >= bytes.length) throw new Error('VLQ が途中で終わっています。');
    const byte = bytes[cursor];
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset: cursor };
  }
  throw new Error('VLQ が 5 バイトを超えました。');
}

/** 任意のバイト表現を Uint8Array にそろえる。 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError('SMF のバイト列を解釈できません。');
}

/** 4 文字の ASCII をバイト配列にする。 */
function asciiBytes(text) {
  return [0, 1, 2, 3].map((index) => text.codePointAt(index) & 0xff);
}

/** 位置 `at` から 4 文字の ASCII を読む。 */
function readAscii(bytes, at) {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

/** 位置 `at` から 16 bit ビッグエンディアンを読む。 */
function readU16(bytes, at) {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/** 位置 `at` から 32 bit ビッグエンディアンを読む。 */
function readU32(bytes, at) {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

/** 16 bit ビッグエンディアンを 2 バイトにする。 */
function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** 32 bit ビッグエンディアンを 4 バイトにする。 */
function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** 正の整数、そうでなければ fallback。 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** 0..127 に丸める。 */
function clampData(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_DATA, Math.round(number)));
}

// #endregion

// #region Writing

/** 拍子記号を `[numerator, denominator]` にそろえる。 */
export function normalizeTimeSignature(value) {
  if (Array.isArray(value) && value.length === 2) {
    const numerator = positiveInt(value[0], 4);
    const denominator = positiveInt(value[1], 4);
    return [numerator, denominator];
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/u);
    if (match !== null) return [positiveInt(match[1], 4), positiveInt(match[2], 4)];
  }
  if (value !== null && typeof value === 'object') {
    return [positiveInt(value.beats ?? value.numerator, 4), positiveInt(value.beatType ?? value.denominator, 4)];
  }
  return [4, 4];
}

/** 拍子記号の分母を 2 の冪指数にする (4 分の 4 なら 2)。 */
function denominatorPower(denominator) {
  let power = 0;
  let value = denominator;
  while (value > 1 && power < 7) {
    value /= 2;
    power += 1;
  }
  return power;
}

/** tempo meta の 3 バイト (マイクロ秒 / 4 分音符)。 */
function tempoMicroseconds(bpm) {
  const safe = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const us = Math.max(1, Math.min(0xffffff, Math.round(60000000 / safe)));
  return [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}

/** meta イベントの完全なバイト列を作る。 */
function metaBytes(type, data) {
  const payload = Array.from(data ?? []);
  return [0xff, type, ...encodeVlq(payload.length), ...payload];
}

/**
 * 1 トラック分のイベント列を MTrk チャンクのデータに変換する。
 *
 * 同じ tick のイベントは与えられた順に書く。呼び出し側が
 * meta → program/CC → note off → note on の順に並べておくこと。
 *
 * @param {object[]} events - `{ tick, bytes }` の配列 (tick 昇順)。
 * @returns {number[]} end of track まで含んだバイト列。
 */
function serializeEvents(events) {
  const out = [];
  let lastTick = 0;
  let running = -1;
  for (const event of events) {
    const tick = Math.max(lastTick, Math.trunc(event.tick) || 0);
    out.push(...encodeVlq(tick - lastTick));
    lastTick = tick;
    const bytes = Array.from(event.bytes ?? []);
    if (bytes.length === 0) continue;
    const status = bytes[0];
    const isChannel = status >= 0x80 && status < 0xf0;
    if (!isChannel) {
      running = -1;
      out.push(...bytes);
    } else if (running === status) {
      out.push(...bytes.slice(1));
    } else {
      running = status;
      out.push(...bytes);
    }
  }
  out.push(0x00, 0xff, META_END_OF_TRACK, 0x00);
  return out;
}

/** MTrk チャンク (ヘッダ + 長さ + データ)。 */
function trackChunk(data) {
  return [...asciiBytes('MTrk'), ...u32(data.length), ...data];
}

/** MThd チャンク。 */
function headerChunk(format, trackCount, division) {
  return [...asciiBytes('MThd'), ...u32(6), ...u16(format), ...u16(trackCount), ...u16(division)];
}

/** 1 トラックの meta (名前・チャンネル prefix) を積む。 */
function pushTrackMeta(events, track) {
  const name = typeof track.name === 'string' ? track.name.trim() : '';
  if (name !== '') {
    events.push({ tick: 0, priority: EVENT_META, bytes: metaBytes(META_TEXT, encodeText(name)) });
  }
  const channel = clampChannel(track.channel);
  events.push({ tick: 0, priority: EVENT_META, bytes: metaBytes(META_CHANNEL_PREFIX, [channel]) });
}

/** チャンネル番号を 0..15 に丸める。 */
function clampChannel(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 0;
  return Math.max(0, Math.min(15, number));
}

/** 1 トラックのチャンネルイベント (program / CC / note) を積む。 */
function pushChannelEvents(events, track, ticksPerQuarter) {
  const channel = clampChannel(track.channel);
  const drum = track.drum === true || channel === GM_DRUM_CHANNEL;
  const bankMSB = Number.isFinite(track.bankMSB) ? clampData(track.bankMSB) : 0;
  const bankLSB = Number.isFinite(track.bankLSB) ? clampData(track.bankLSB) : 0;
  const program = Number.isFinite(track.program) ? clampData(track.program) : 0;

  if (drum) {
    // 打楽器は bank select を持たない。program は kit の選択。
    events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_PROGRAM_CHANGE | channel, program] });
  } else {
    if (bankMSB > 0) events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_CONTROL_CHANGE | channel, 0, bankMSB] });
    if (bankLSB > 0) events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_CONTROL_CHANGE | channel, 32, bankLSB] });
    events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_PROGRAM_CHANGE | channel, program] });
  }

  const volume = Number.isFinite(track.volume) ? clampData(track.volume, 100) : 100;
  const pan = Number.isFinite(track.pan) ? clampData(track.pan, 64) : 64;
  events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_CONTROL_CHANGE | channel, 7, volume] });
  events.push({ tick: 0, priority: EVENT_CONTROL, bytes: [STATUS_CONTROL_CHANGE | channel, 10, pan] });

  for (const note of Array.isArray(track.notes) ? track.notes : []) {
    const midi = clampData(note?.midi, 0);
    const velocity = clampData(note?.velocity, MIDI_DEFAULT_VELOCITY);
    const startTick = Math.max(0, Math.round((Number(note?.start) || 0) * ticksPerQuarter));
    const lengthTicks = Math.max(1, Math.round((Number(note?.duration) || 0) * ticksPerQuarter));
    events.push({ tick: startTick, priority: EVENT_NOTE_ON, bytes: [STATUS_NOTE_ON | channel, midi, Math.max(1, velocity)] });
    events.push({ tick: startTick + lengthTicks, priority: EVENT_NOTE_OFF, bytes: [STATUS_NOTE_OFF | channel, midi, 0] });
  }
}

/**
 * 編曲のトラック定義から SMF を組み立てる。
 *
 * @param {object} project - `{ format, ticksPerQuarter, tempo, timeSignature, title, tracks }`。
 * @param {object[]} project.tracks - `{ name, channel, program, bankMSB, bankLSB, drum, volume, pan, notes }`。
 *   ノートは `{ start, duration, midi, velocity }`、start/duration は 4 分音符単位。
 * @returns {Buffer} `.mid` のバイト列。
 */
export function writeSmf(project = {}) {
  const ticksPerQuarter = Math.max(1, Math.min(MIDI_MAX_DIVISION, positiveInt(project.ticksPerQuarter, MIDI_TICKS_PER_QUARTER)));
  const format = Number(project.format) === 0 ? 0 : 1;
  const tempo = Number.isFinite(project.tempo) && project.tempo > 0 ? project.tempo : 120;
  const [numerator, denominator] = normalizeTimeSignature(project.timeSignature);
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const title = typeof project.title === 'string' ? project.title.trim() : '';

  const conductorMeta = [
    ...(title === '' ? [] : [{ tick: 0, priority: EVENT_META, bytes: metaBytes(META_TEXT, encodeText(title)) }]),
    { tick: 0, priority: EVENT_META, bytes: metaBytes(META_TEMPO, tempoMicroseconds(tempo)) },
    {
      tick: 0,
      priority: EVENT_META,
      bytes: metaBytes(META_TIME_SIGNATURE, [numerator & 0xff, denominatorPower(denominator), 24, 8]),
    },
  ];

  if (format === 0) {
    const events = [...conductorMeta];
    for (const track of tracks) pushChannelEvents(events, track, ticksPerQuarter);
    events.sort((first, second) => (first.tick - second.tick) || (first.priority - second.priority));
    const bytes = [...headerChunk(0, 1, ticksPerQuarter), ...trackChunk(serializeEvents(events))];
    return Buffer.from(bytes);
  }

  const chunks = [trackChunk(serializeEvents(conductorMeta))];
  for (const track of tracks) {
    const events = [];
    pushTrackMeta(events, track);
    pushChannelEvents(events, track, ticksPerQuarter);
    events.sort((first, second) => (first.tick - second.tick) || (first.priority - second.priority));
    chunks.push(trackChunk(serializeEvents(events)));
  }
  const bytes = [...headerChunk(1, chunks.length, ticksPerQuarter), ...chunks.flat()];
  return Buffer.from(bytes);
}

// #endregion

// #region Reading

/** 1 トラックチャンクを解析して、生イベントとノートを取り出す。 */
function parseTrackChunk(bytes, start, length, ticksPerQuarter) {
  const end = Math.min(bytes.length, start + length);
  let cursor = start;
  let tick = 0;
  let running = -1;
  let name = '';
  let channelPrefix = null;
  let program = null;
  let ended = false;
  const controllers = new Map();
  const openNotes = new Map();
  const notes = [];
  const tempos = [];
  const timeSignatures = [];
  const warnings = [];

  const closeNote = (channel, midi, endTick, velocity) => {
    const key = `${channel}:${midi}`;
    const queue = openNotes.get(key);
    if (queue === undefined || queue.length === 0) {
      warnings.push(`${endTick} tick: 対応する note on がない note off (note ${midi})`);
      return;
    }
    const opened = queue.shift();
    notes.push({
      start: opened.tick / ticksPerQuarter,
      duration: Math.max(0, (endTick - opened.tick) / ticksPerQuarter),
      midi,
      velocity: opened.velocity,
      channel,
      endVelocity: velocity,
    });
  };

  while (cursor < end && !ended) {
    const delta = decodeVlq(bytes, cursor);
    cursor = delta.offset;
    tick += delta.value;
    if (cursor >= end) break;
    const first = bytes[cursor];

    if (first === 0xff) {
      cursor += 1;
      const type = bytes[cursor] ?? 0;
      cursor += 1;
      const length = decodeVlq(bytes, cursor);
      cursor = length.offset;
      const data = bytes.subarray(cursor, cursor + length.value);
      cursor += length.value;
      running = -1;
      if (type === META_END_OF_TRACK) {
        ended = true;
        break;
      }
      if (type === META_TEXT) name = decodeText(data);
      else if (type === META_CHANNEL_PREFIX && data.length >= 1) channelPrefix = data[0] & 0x0f;
      else if (type === META_TEMPO && data.length >= 3) {
        const us = (data[0] << 16) | (data[1] << 8) | data[2];
        if (us > 0) tempos.push({ bpm: 60000000 / us, tick });
      } else if (type === META_TIME_SIGNATURE && data.length >= 2) {
        timeSignatures.push({ tick, signature: [data[0], 2 ** data[1]] });
      }
      continue;
    }

    if (first === 0xf0 || first === 0xf7) {
      cursor += 1;
      const length = decodeVlq(bytes, cursor);
      cursor = length.offset + length.value;
      running = -1;
      continue;
    }

    let status;
    if (first < 0x80) {
      if (running < 0) throw new Error('running status の対象になるイベントがありません。');
      status = running;
    } else {
      status = first;
      running = status;
      cursor += 1;
    }

    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (channelPrefix === null) channelPrefix = channel;

    if (kind === STATUS_PROGRAM_CHANGE || kind === STATUS_CHANNEL_PRESSURE) {
      const data1 = bytes[cursor] ?? 0;
      cursor += 1;
      if (kind === STATUS_PROGRAM_CHANGE) program = data1 & 0x7f;
      continue;
    }

    const data1 = (bytes[cursor] ?? 0) & 0x7f;
    const data2 = (bytes[cursor + 1] ?? 0) & 0x7f;
    cursor += 2;

    if (kind === STATUS_NOTE_ON) {
      if (data2 === 0) {
        closeNote(channel, data1, tick, 0);
      } else {
        const key = `${channel}:${data1}`;
        if (!openNotes.has(key)) openNotes.set(key, []);
        openNotes.get(key).push({ tick, velocity: data2 });
      }
    } else if (kind === STATUS_NOTE_OFF) {
      closeNote(channel, data1, tick, data2);
    } else if (kind === STATUS_CONTROL_CHANGE) {
      const perChannel = controllers.get(channel) ?? new Map();
      perChannel.set(data1, data2);
      controllers.set(channel, perChannel);
    }
  }

  for (const [key, queue] of openNotes) {
    const [channelText, midiText] = key.split(':');
    for (const opened of queue) {
      warnings.push(`${opened.tick} tick の note on (note ${midiText}) が閉じていません`);
      notes.push({
        start: opened.tick / ticksPerQuarter,
        duration: 0,
        midi: Number(midiText),
        velocity: opened.velocity,
        channel: Number(channelText),
        endVelocity: 0,
      });
    }
  }

  return {
    name,
    channel: channelPrefix ?? 0,
    program: program ?? 0,
    controllers,
    tempos,
    timeSignatures,
    notes: notes.sort((first, second) => (first.start - second.start) || (first.midi - second.midi)),
    warnings,
  };
}

/**
 * SMF を読む。
 *
 * @param {Uint8Array|Buffer|ArrayBuffer|number[]} input - `.mid` のバイト列。
 * @returns {{
 *   format: number, ticksPerQuarter: number, trackCount: number,
 *   tempos: { bpm: number, tick: number }[], timeSignature: number[], title: string,
 *   tracks: { name: string, channel: number, program: number, drum: boolean,
 *     volume: number, pan: number, notes: object[], warnings: string[] }[],
 *   warnings: string[]
 * }} 読み取った内容。
 */
export function readSmf(input) {
  const bytes = toBytes(input);
  if (bytes.length < 14) throw new Error('SMF としては短すぎます。');
  if (readAscii(bytes, 0) !== 'MThd') throw new Error('SMF ではありません (MThd が見つかりません)。');
  const headerLength = readU32(bytes, 4);
  const format = readU16(bytes, 8);
  const trackCount = readU16(bytes, 10);
  const division = readU16(bytes, 12);
  if ((division & 0x8000) !== 0) throw new Error('SMPTE division の SMF には対応していません。');
  const ticksPerQuarter = division & MIDI_MAX_DIVISION;
  if (ticksPerQuarter === 0) throw new Error('SMF の分解能 (division) が 0 です。');

  const warnings = [];
  const tempos = [];
  let foundSignature = null;
  const rawTracks = [];

  let cursor = 8 + headerLength;
  while (cursor + 8 <= bytes.length && rawTracks.length < trackCount) {
    const id = readAscii(bytes, cursor);
    const length = readU32(bytes, cursor + 4);
    const body = cursor + 8;
    if (id !== 'MTrk') {
      warnings.push(`未知のチャンク ${JSON.stringify(id)} を飛ばしました。`);
      cursor = body + length;
      continue;
    }
    const parsed = parseTrackChunk(bytes, body, length, ticksPerQuarter);
    rawTracks.push(parsed);
    for (const warning of parsed.warnings) warnings.push(warning);
    cursor = body + length;
  }
  if (rawTracks.length < trackCount) {
    warnings.push(`ヘッダは ${trackCount} トラックですが、${rawTracks.length} トラックしかありません。`);
  }

  // tempo と拍子はトラックをまたいで先頭の値を採る。
  for (const track of rawTracks) {
    for (const entry of track.tempos) tempos.push(entry);
    if (foundSignature === null && track.timeSignatures.length > 0) foundSignature = track.timeSignatures[0].signature;
  }

  const tracks = rawTracks.map((track, index) => {
    const channels = new Set(track.notes.map((note) => note.channel));
    const channel = track.channel ?? (channels.size > 0 ? [...channels][0] : 0);
    const perChannel = track.controllers.get(track.channel) ?? track.controllers.get(channel) ?? new Map();
    const volume = perChannel.get(7) ?? 100;
    const pan = perChannel.get(10) ?? 64;
    return {
      index,
      name: track.name === '' ? `track ${index + 1}` : track.name,
      channel,
      program: typeof track.program === 'number' ? track.program : 0,
      drum: channel === GM_DRUM_CHANNEL,
      volume,
      pan,
      noteCount: track.notes.length,
      notes: track.notes,
      warnings: track.warnings,
    };
  });

  // type 1 の先頭トラックは conductor (名前だけあって音符が無い) なので、それを曲名にする。
  const conductor = tracks.find((track) => track.noteCount === 0 && track.name !== '');
  const title = conductor === undefined ? '' : conductor.name;

  return {
    format,
    ticksPerQuarter,
    trackCount: rawTracks.length,
    tempos: tempos.sort((first, second) => first.tick - second.tick),
    timeSignature: foundSignature ?? [4, 4],
    title,
    tracks,
    totalNotes: tracks.reduce((sum, track) => sum + track.noteCount, 0),
    warnings,
  };
}

/**
 * `readSmf` の結果から、最初の tempo と拍子を取り出す。
 * tempo が無ければ 120 BPM、拍子が無ければ 4/4。
 */
export function tempoMapOf(smf) {
  const tempos = Array.isArray(smf?.tempos) && smf.tempos.length > 0 ? smf.tempos : [{ bpm: 120, tick: 0 }];
  return {
    initialBpm: tempos[0].bpm,
    changes: tempos,
  };
}

// #endregion
