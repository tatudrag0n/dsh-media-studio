/**
 * DTM — マルチトラック編曲・ミックス・DAW 形式の入出力。
 *
 * v3 で足した 3 つの制作領域のうちの音の担当。`music.js` は
 * 「ノート列 → SoundFont で WAV」までを持っているので、ここはその先だけを扱う:
 *
 * - `daw_arrange`        トラックごとの音量・パン・ミュート・ソロ・リバーブ・ディレイを
 *                        適用してステレオ WAV を書き出す（mp3 / ogg も ffmpeg があれば）
 * - `export_daw_project` 同じ編曲を SMF (.mid) / MusicXML / LMMS (.mmp) /
 *                        Hydrogen (.h2song) に書き出す
 * - `import_midi`        SMF を読み、`daw_arrange` / `compose_music` に渡せる形へ分解する
 *
 * 設計の約束:
 *
 * - **合成器は二重実装しない。** 音は `soundfont.js` の `renderSoundFontTracks` だけが作る。
 *   この module はトラックごとに 1 回ずつ合成し、そのモノラル波形に
 *   エフェクト → パン → ミックスを掛ける。SoundFont が無いときは
 *   音源トラックがあれば明示的なエラーにし、音声トラックだけならミックスできる。
 * - **SMF は `midi.js`。** バイト列の知識はそちらに閉じる。
 * - **外部プロセスは `execute()` の中だけ。** ffmpeg の起動はタイムアウトと kill を持つ。
 * - `index.js` は import しない（循環参照を作らない）。必要な小道具は `helpers` で受け取る。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { GM_DRUM_CHANNEL, readSmf, toBytes, writeSmf } from './midi.js';
import { MAX_BARS, SAMPLE_RATE, midiToName, pitchToMidi } from './music.js';
import { formatScoreText, isPitchName, parseScoreText, roundBeats, splitPitches } from './score.js';
import {
  formatGmInstrument,
  parseGmInstrument,
  renderSoundFontTracks,
  soundFontAvailable,
} from './soundfont.js';

/** `daw_arrange` が書き出せる音声形式。 */
export const DAW_AUDIO_FORMATS = ['wav', 'mp3', 'ogg'];

/** `export_daw_project` が書き出せるプロジェクト形式。 */
export const DAW_PROJECT_FORMATS = ['mid', 'musicxml', 'mmp', 'h2song'];

/** 出力のサンプリング周波数。既存の SoundFont 合成と揃える。 */
export const DAW_SAMPLE_RATE = SAMPLE_RATE;

/** 既定の拍子。 */
export const DAW_DEFAULT_TIME_SIGNATURE = [4, 4];

/** 既定のテンポ。 */
export const DAW_DEFAULT_TEMPO = 120;

/** 既定のベロシティ。 */
export const DAW_DEFAULT_VELOCITY = 96;

/** 既定の出力先ディレクトリ。 */
const DAW_DEFAULT_OUTPUT_DIR = 'media-studio';

/** LMMS の内部解像度 (tick / 4 分音符)。 */
const LMMS_TICKS_PER_QUARTER = 192;

/** Hydrogen の内部解像度 (tick / 4 分音符)。 */
const HYDROGEN_TICKS_PER_QUARTER = 48;

/** 書き出す SMF の分解能。 */
const SMF_TICKS_PER_QUARTER = 480;

/** メロディ用に使える MIDI チャンネル。9 は打楽器のため飛ばす。 */
const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

/** General MIDI のプログラム名 (0..127)。MusicXML と LMMS の表示に使う。 */
export const GM_PROGRAM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/** 楽器名として通す短い別名。GM の正式名は `GM_PROGRAM_NAMES` から引く。 */
const GM_ALIASES = new Map(Object.entries({
  piano: 0, grand: 0, acoustic: 0, ep: 4, epiano: 4, 'electric piano': 4,
  harpsichord: 6, clav: 7, celesta: 8, glockenspiel: 9, musicbox: 10, 'music box': 10,
  vibraphone: 11, marimba: 12, xylophone: 13, bells: 14, tubular: 14, dulcimer: 15,
  organ: 16, 'drawbar organ': 16, 'church organ': 19, accordion: 21, harmonica: 22,
  guitar: 24, 'nylon guitar': 24, 'acoustic guitar': 24, 'steel guitar': 25,
  'clean guitar': 27, 'electric guitar': 27, 'muted guitar': 28, distortion: 30,
  bass: 33, 'acoustic bass': 32, 'finger bass': 33, 'pick bass': 34, 'slap bass': 36,
  'synth bass': 38, '808': 38, sub: 38,
  violin: 40, viola: 41, cello: 42, contrabass: 43, tremolo: 44, pizzicato: 45,
  harp: 46, timpani: 47, strings: 48, 'string ensemble': 48, 'solo strings': 40, orchestra: 48,
  pad: 89, 'warm pad': 89, polysynth: 90, 'choir pad': 91, bowed: 92, halo: 94, sweep: 95,
  choir: 52, voice: 53, 'synth voice': 54, hit: 55,
  trumpet: 56, trombone: 57, tuba: 58, 'muted trumpet': 59, horn: 60, 'french horn': 60,
  brass: 61, 'synth brass': 62,
  sax: 65, 'alto sax': 65, 'tenor sax': 66, 'baritone sax': 67, 'soprano sax': 64,
  oboe: 68, 'english horn': 69, bassoon: 70, clarinet: 71,
  piccolo: 72, flute: 73, recorder: 74, panflute: 75, 'pan flute': 75, whistle: 78, ocarina: 79,
  lead: 80, square: 80, saw: 81, 'saw lead': 81, calliope: 82, charang: 84, fifths: 86,
  'new age': 88, crystal: 98, atmosphere: 99, brightness: 100, goblins: 101, echoes: 102,
  'sci-fi': 103, scifi: 103, sitar: 104, banjo: 105, shamisen: 106, koto: 107,
  kalimba: 108, bagpipe: 109, fiddle: 110, shanai: 111,
  bell: 112, agogo: 113, 'steel drum': 114, 'steel drums': 114, woodblock: 115,
  taiko: 116, tom: 117, 'synth drum': 118, cymbal: 119,
}));

/** GM の打楽器キット (32..59)。Hydrogen の楽器名に使う。 */
const DRUM_KIT = [
  { midi: 35, name: 'Acoustic Bass Drum' },
  { midi: 36, name: 'Bass Drum' },
  { midi: 37, name: 'Side Stick' },
  { midi: 38, name: 'Snare Drum' },
  { midi: 39, name: 'Hand Clap' },
  { midi: 40, name: 'Electric Snare' },
  { midi: 41, name: 'Low Floor Tom' },
  { midi: 42, name: 'Closed Hi-Hat' },
  { midi: 43, name: 'High Floor Tom' },
  { midi: 44, name: 'Pedal Hi-Hat' },
  { midi: 45, name: 'Low Tom' },
  { midi: 46, name: 'Open Hi-Hat' },
  { midi: 47, name: 'Low-Mid Tom' },
  { midi: 48, name: 'Hi-Mid Tom' },
  { midi: 49, name: 'Crash Cymbal 1' },
  { midi: 50, name: 'High Tom' },
  { midi: 51, name: 'Ride Cymbal 1' },
  { midi: 53, name: 'Ride Bell' },
  { midi: 54, name: 'Tambourine' },
  { midi: 56, name: 'Cowbell' },
  { midi: 57, name: 'Crash Cymbal 2' },
  { midi: 59, name: 'Ride Cymbal 2' },
];

/** 調号 → MusicXML の fifths。 */
const KEY_FIFTHS = new Map(Object.entries({
  cb: -7, gb: -6, db: -5, ab: -4, eb: -3, bb: -2, f: -1,
  c: 0,
  g: 1, d: 2, a: 3, e: 4, b: 5, 'f#': 6, 'c#': 7,
  abm: -7, ebm: -6, bbm: -5, fm: -4, cm: -3, gm: -2, dm: -1,
  am: 0, em: 1, bm: 2, 'f#m': 3, 'c#m': 4, 'g#m': 5, 'd#m': 6, 'a#m': 7,
}));

// #region 小さな道具

/** 数値ならその値、そうでなければ fallback。 */
function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 0..1 に丸める。 */
function clamp01(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

/** min..max に丸める。 */
function clampRange(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

/** 整数に丸めて min..max に収める。 */
function clampInt(value, min, max, fallback = min) {
  return Math.round(clampRange(value, min, max, fallback));
}

/** 正の整数、そうでなければ fallback。 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** 非空の trim 済み文字列、そうでなければ空文字。 */
function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** ファイル名に使える slug。 */
function slugify(value, fallback = 'arrangement') {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 60);
  return cleaned === '' ? fallback : cleaned;
}

/** XML のテキストをエスケープする。 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** 属性値をエスケープする (escapeXml と同じで足りる)。 */
const escapeAttr = escapeXml;

/** セッションからの相対表示パス。 */
function displayPath(cwd, absolute) {
  return absolute.startsWith(cwd + sep) ? absolute.slice(cwd.length + 1) : absolute;
}

/** 拍子記号を `[numerator, denominator]` にそろえる。 */
export function normalizeTimeSignature(value) {
  if (Array.isArray(value) && value.length >= 2) {
    return [positiveInt(value[0], 4), positiveInt(value[1], 4)];
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*[/:]\s*(\d+)$/u);
    if (match !== null) return [positiveInt(match[1], 4), positiveInt(match[2], 4)];
  }
  if (value !== null && typeof value === 'object') {
    return [positiveInt(value.beats ?? value.numerator, 4), positiveInt(value.beatType ?? value.denominator, 4)];
  }
  return [...DAW_DEFAULT_TIME_SIGNATURE];
}

/** 1 小節が何拍 (4 分音符単位) か。 */
export function beatsPerBarOf(timeSignature) {
  const [numerator, denominator] = normalizeTimeSignature(timeSignature);
  return (numerator * 4) / denominator;
}

// #endregion

// #region 楽器

/** 楽器名を GM プログラムへ寄せる。見つからなければ null。 */
export function matchGmProgram(value) {
  const text = textOrEmpty(value).toLowerCase();
  if (text === '') return null;
  if (GM_ALIASES.has(text)) return GM_ALIASES.get(text);
  const flattened = text.replace(/[^a-z0-9]+/gu, ' ').trim();
  if (GM_ALIASES.has(flattened)) return GM_ALIASES.get(flattened);
  const index = GM_PROGRAM_NAMES.findIndex((name) => name.toLowerCase() === flattened);
  if (index >= 0) return index;
  const partial = GM_PROGRAM_NAMES.findIndex((name) => name.toLowerCase().includes(flattened));
  if (partial >= 0 && flattened.length >= 3) return partial;
  const aliasKey = [...GM_ALIASES.keys()].find((key) => key.length >= 3 && flattened.startsWith(key));
  return aliasKey === undefined ? null : GM_ALIASES.get(aliasKey);
}

/**
 * トラックの `instrument` / `program` / `drums` から、合成と書き出しに使う値を作る。
 *
 * @param {object} source - トラック定義。
 * @param {string} fallbackInstrument - 何も指定されなかったときの `gm:N`。
 * @returns {{ instrument: string, program: number, bankMSB: number, bankLSB: number, drum: boolean }}
 */
export function resolveTrackInstrument(source, fallbackInstrument = 'gm:0') {
  const drum = source?.drums === true
    || Number(source?.channel) === GM_DRUM_CHANNEL + 1
    || numberOr(source?.bankMSB, 0) === 128;
  const explicit = typeof source?.instrument === 'string' ? source.instrument.trim() : '';
  const parsed = parseGmInstrument(explicit);
  if (parsed !== null) {
    const isDrum = parsed.bankMSB === 128 || drum;
    return {
      instrument: formatGmInstrument({ bankMSB: isDrum ? 128 : parsed.bankMSB, program: parsed.program }),
      program: parsed.program,
      bankMSB: isDrum ? 128 : parsed.bankMSB,
      bankLSB: parsed.bankLSB,
      drum: isDrum,
    };
  }
  if (Number.isInteger(Number(source?.program)) && Number(source.program) >= 0 && Number(source.program) <= 127) {
    const program = Number(source.program);
    return {
      instrument: formatGmInstrument({ bankMSB: drum ? 128 : 0, program }),
      program,
      bankMSB: drum ? 128 : 0,
      bankLSB: 0,
      drum,
    };
  }
  const named = matchGmProgram(explicit);
  if (named !== null) {
    return {
      instrument: formatGmInstrument({ bankMSB: drum ? 128 : 0, program: named }),
      program: named,
      bankMSB: drum ? 128 : 0,
      bankLSB: 0,
      drum,
    };
  }
  const fallback = parseGmInstrument(fallbackInstrument) ?? { bankMSB: 0, program: 0 };
  return {
    instrument: formatGmInstrument({ bankMSB: drum ? 128 : fallback.bankMSB, program: fallback.program }),
    program: fallback.program,
    bankMSB: drum ? 128 : fallback.bankMSB,
    bankLSB: fallback.bankLSB,
    drum: drum || fallback.bankMSB === 128,
  };
}

/** GM プログラム番号の表示名。 */
export function gmProgramName(program) {
  return GM_PROGRAM_NAMES[clampInt(program, 0, 127, 0)] ?? 'Acoustic Grand Piano';
}

// #endregion

// #region 編曲の正規化

/**
 * 1 トラック分のノートを `{ start, duration, pitches, velocity }` にそろえる。
 * 拍は 4 分音符単位。音名は `score.js` と同じ表記 (`C4`, `F#3`)。
 */
function normalizeNotes(rawNotes, warnings, label) {
  const notes = [];
  for (const raw of Array.isArray(rawNotes) ? rawNotes : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const candidates = Array.isArray(raw.pitches)
      ? raw.pitches
      : splitPitches(typeof raw.pitch === 'string' ? raw.pitch : '');
    const pitches = candidates
      .map((pitch) => (typeof pitch === 'string' ? pitch.trim() : ''))
      .filter((pitch) => pitch !== '' && isPitchName(pitch));
    if (pitches.length === 0) {
      warnings.push(`${label}: 音名が不正なノートを飛ばしました。`);
      continue;
    }
    const start = Math.max(0, roundBeats(numberOr(raw.start ?? raw.beat ?? raw.position, 0)));
    const duration = roundBeats(numberOr(raw.duration ?? raw.length ?? raw.beats, 1));
    if (!(duration > 0)) {
      warnings.push(`${label}: 長さが 0 以下のノートを飛ばしました。`);
      continue;
    }
    notes.push({
      start,
      duration,
      pitches,
      velocity: clampInt(raw.velocity ?? raw.vel, 1, 127, DAW_DEFAULT_VELOCITY),
    });
  }
  notes.sort((first, second) => first.start - second.start);
  return notes;
}

/** ステップ格子 (`compose_music` の出力) をノート列にする。 */
function notesFromSteps(steps, stepBeats) {
  const beat = numberOr(stepBeats, 1) > 0 ? numberOr(stepBeats, 1) : 1;
  const notes = [];
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    const pitches = (Array.isArray(step) ? step : [step])
      .map((pitch) => (typeof pitch === 'string' ? pitch.trim() : ''))
      .filter((pitch) => pitch !== '' && isPitchName(pitch));
    if (pitches.length > 0) {
      notes.push({ start: roundBeats(index * beat), duration: roundBeats(beat), pitches, velocity: DAW_DEFAULT_VELOCITY });
    }
  });
  return notes;
}

/**
 * 入力 (編曲 JSON / MSX スコア) を、描画と書き出しが共有する形へ正規化する。
 *
 * @param {object} input - `daw_arrange` / `export_daw_project` の引数。
 * @param {object} [options] - `defaultInstrument`。
 * @returns {object} 正規化された編曲。
 */
export function normalizeArrangement(input, options = {}) {
  const warnings = [];
  const source = input?.arrangement ?? input ?? {};
  const defaultInstrument = parseGmInstrument(options.defaultInstrument) !== null
    ? options.defaultInstrument
    : 'gm:0';

  let rawTracks = Array.isArray(source.tracks) ? source.tracks : [];
  let scorePiece = null;

  // MSX スコアでも受け取れるようにする (compose_music の出力をそのまま渡せる)。
  const scoreText = textOrEmpty(input?.score ?? source.score);
  if (rawTracks.length === 0 && scoreText !== '') {
    const piece = parseScoreText(scoreText);
    scorePiece = piece;
    for (const warning of piece.warnings ?? []) warnings.push(warning);
    rawTracks = (piece.tracks ?? []).map((track) => ({
      name: track.name,
      instrument: track.instrument,
      notes: track.notes,
    }));
  }

  // 引数で明示された値が編曲の中身より優先する。
  const tempo = Math.round(clampRange(input?.tempo ?? source.tempo ?? scorePiece?.tempo, 20, 400, DAW_DEFAULT_TEMPO));
  const timeSignature = normalizeTimeSignature(input?.timeSignature ?? source.timeSignature);
  const beatsPerBar = beatsPerBarOf(timeSignature);
  const key = textOrEmpty(input?.key ?? source.key) || 'C';

  const tracks = [];
  let melodicUsed = 0;
  const usedChannels = new Set();
  for (let index = 0; index < rawTracks.length; index += 1) {
    const raw = rawTracks[index] ?? {};
    const name = textOrEmpty(raw.name) || `track ${index + 1}`;
    const audioPath = textOrEmpty(raw.audio ?? raw.audioPath ?? raw.path);
    const instrument = resolveTrackInstrument(raw, defaultInstrument);

    let notes = normalizeNotes(raw.notes, warnings, name);
    if (notes.length === 0 && Array.isArray(raw.steps)) {
      notes = normalizeNotes(notesFromSteps(raw.steps, raw.stepBeats), warnings, name);
    }

    const kind = audioPath !== '' ? 'audio' : (instrument.drum ? 'drums' : 'instrument');
    if (kind !== 'audio' && notes.length === 0) {
      if (raw.notes !== undefined || raw.steps !== undefined) warnings.push(`${name}: 有効なノートがありません。`);
      continue;
    }

    let channel;
    if (kind === 'drums') {
      channel = GM_DRUM_CHANNEL;
    } else {
      const explicit = Number.isInteger(Number(raw.channel)) ? Number(raw.channel) - 1 : NaN;
      if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 15 && explicit !== GM_DRUM_CHANNEL && !usedChannels.has(explicit)) {
        channel = explicit;
      } else {
        channel = MELODIC_CHANNELS[melodicUsed % MELODIC_CHANNELS.length];
        while (usedChannels.has(channel) && usedChannels.size < MELODIC_CHANNELS.length) {
          melodicUsed += 1;
          channel = MELODIC_CHANNELS[melodicUsed % MELODIC_CHANNELS.length];
        }
      }
      usedChannels.add(channel);
      melodicUsed += 1;
    }

    tracks.push({
      name,
      kind,
      instrument: kind === 'drums'
        ? formatGmInstrument({ bankMSB: 128, program: instrument.program })
        : instrument.instrument,
      program: instrument.program,
      bankMSB: kind === 'drums' ? 128 : instrument.bankMSB,
      bankLSB: instrument.bankLSB,
      drum: kind === 'drums',
      channel,
      volume: clampRange(raw.volume, 0, 2, 1),
      pan: clampRange(raw.pan, -1, 1, 0),
      mute: raw.mute === true,
      solo: raw.solo === true,
      reverb: clamp01(raw.reverb, 0),
      delay: clamp01(raw.delay, 0),
      offsetBeats: Math.max(0, roundBeats(numberOr(raw.offset ?? raw.offsetBeats, 0))),
      notes,
      audioPath,
    });
  }

  if (tracks.length === 0) {
    throw new Error('トラックがありません。arrangement.tracks か score を指定してください。');
  }

  const naturalEnd = tracks.reduce((longest, track) => {
    const end = track.notes.reduce((latest, note) => Math.max(latest, note.start + note.duration), 0) + track.offsetBeats;
    return Math.max(longest, end);
  }, 0);
  const requestedBars = positiveInt(input?.bars ?? source.bars, 0);
  const bars = Math.min(
    MAX_BARS,
    Math.max(1, requestedBars > 0 ? requestedBars : Math.ceil(naturalEnd / beatsPerBar)),
  );

  return {
    name: textOrEmpty(input?.name ?? source.name) || textOrEmpty(scorePiece?.title) || 'untitled',
    tempo,
    timeSignature,
    beatsPerBar,
    bars,
    key,
    tracks,
    warnings,
  };
}

/** 編曲の長さ (秒)。末尾にリリース分の余白を足す。 */
export function arrangementSeconds(arrangement, releaseSeconds = 1.2) {
  const totalBeats = Math.max(
    arrangement.bars * arrangement.beatsPerBar,
    arrangement.tracks.reduce((longest, track) => {
      const end = track.notes.reduce((latest, note) => Math.max(latest, note.start + note.duration), 0) + track.offsetBeats;
      return Math.max(longest, end);
    }, 0),
  );
  return (totalBeats * 60) / arrangement.tempo + Math.max(0, releaseSeconds);
}

/** 編曲のノート総数。 */
export function arrangementNoteCount(arrangement) {
  return arrangement.tracks.reduce(
    (sum, track) => sum + track.notes.reduce((inner, note) => inner + note.pitches.length, 0),
    0,
  );
}

// #endregion

// #region WAV

/** 位置 `at` から符号なし 16 bit リトルエンディアンを読む。 */
function readU16le(bytes, at) {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/** 位置 `at` から符号なし 32 bit リトルエンディアンを読む。 */
function readU32le(bytes, at) {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

/**
 * PCM / IEEE float の WAV をデコードする。
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} input - WAV のバイト列。
 * @returns {{ sampleRate: number, channels: number, frames: number, samples: Float32Array }} インターリーブ済み。
 */
export function decodeWav(input) {
  const bytes = toBytes(input);
  if (bytes.length < 44) throw new Error('WAV としては短すぎます。');
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('RIFF/WAVE ではありません。');

  let format = 1;
  let channels = 1;
  let sampleRate = DAW_SAMPLE_RATE;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[cursor], bytes[cursor + 1], bytes[cursor + 2], bytes[cursor + 3]);
    const size = readU32le(bytes, cursor + 4);
    const body = cursor + 8;
    if (id === 'fmt ' && size >= 16) {
      format = readU16le(bytes, body);
      channels = readU16le(bytes, body + 2);
      sampleRate = readU32le(bytes, body + 4);
      bitsPerSample = readU16le(bytes, body + 14);
      // WAVE_FORMAT_EXTENSIBLE: 実体は sub-format の先頭 2 バイト。
      if (format === 0xfffe && size >= 40) format = readU16le(bytes, body + 24);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
    }
    cursor = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error('WAV に data チャンクがありません。');
  if (channels < 1 || channels > 8) throw new Error(`WAV のチャンネル数が不正です: ${channels}`);
  if (![1, 3].includes(format)) throw new Error(`未対応の WAV 形式です (format=${format})。`);

  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataOffset + (frame * channels + channel) * bytesPerSample;
      let value = 0;
      if (format === 3) {
        value = bitsPerSample === 64
          ? Number(new Float64Array(new Uint8Array(bytes.buffer, bytes.byteOffset + at, 8).slice().buffer)[0])
          : Number(new Float32Array(new Uint8Array(bytes.buffer, bytes.byteOffset + at, 4).slice().buffer)[0]);
      } else if (bitsPerSample === 8) {
        value = ((bytes[at] ?? 128) - 128) / 128;
      } else if (bitsPerSample === 16) {
        const raw = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
        value = ((raw << 16) >> 16) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
        value = ((raw << 8) >> 8) / 8388608;
      } else if (bitsPerSample === 32) {
        value = readU32le(bytes, at) / 4294967296;
      }
      samples[frame * channels + channel] = Number.isFinite(value) ? value : 0;
    }
  }

  return { sampleRate, channels, frames, samples };
}

/** ステレオ (またはモノラル) の WAV を左右チャンネルに開く。 */
function openStereo(bytes) {
  const wav = decodeWav(bytes);
  const left = new Float32Array(wav.frames);
  const right = new Float32Array(wav.frames);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    left[frame] = wav.samples[frame * wav.channels] ?? 0;
    right[frame] = wav.channels > 1
      ? (wav.samples[frame * wav.channels + 1] ?? 0)
      : left[frame];
  }
  return { sampleRate: wav.sampleRate, left, right, frames: wav.frames };
}

/**
 * ステレオの Float32 を 16 bit PCM の WAV にする。
 *
 * @param {Float32Array} left - 左チャンネル。
 * @param {Float32Array} right - 右チャンネル。
 * @param {number} sampleRate - サンプリング周波数。
 * @returns {Buffer} WAV のバイト列。
 */
export function encodeWavStereo(left, right, sampleRate = DAW_SAMPLE_RATE) {
  const frames = Math.min(left.length, right.length);
  const dataSize = frames * 4;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (at, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(at + index, text.codePointAt(index) & 0xff);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const samples of [left, right]) {
      const value = Math.max(-1, Math.min(1, samples[frame] ?? 0));
      view.setInt16(offset, Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), true);
      offset += 2;
    }
  }
  return Buffer.from(buffer);
}

/** 線形補間でサンプリング周波数を合わせる。 */
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index / ratio;
    const low = Math.floor(position);
    const high = Math.min(samples.length - 1, low + 1);
    const fraction = position - low;
    out[index] = (samples[low] ?? 0) * (1 - fraction) + (samples[high] ?? 0) * fraction;
  }
  return out;
}

// #endregion

// #region エフェクト

/** フィードバック付きのエコー。`wet` は 0..1。 */
export function addEcho(samples, sampleRate, wet, delaySeconds) {
  const amount = clamp01(wet, 0);
  if (amount <= 0 || samples.length === 0) return samples;
  const delay = Math.max(1, Math.round(delaySeconds * sampleRate));
  if (delay >= samples.length) return samples;
  const out = Float32Array.from(samples);
  const feedback = 0.42 * amount;
  for (let index = delay; index < out.length; index += 1) {
    out[index] += out[index - delay] * feedback;
  }
  return out;
}

/** コムフィルタ 4 本の簡易リバーブ。`wet` は 0..1。 */
export function addReverb(samples, sampleRate, wet) {
  const amount = clamp01(wet, 0);
  if (amount <= 0 || samples.length === 0) return samples;
  const out = Float32Array.from(samples);
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437];
  for (const seconds of combDelays) {
    const delay = Math.max(1, Math.round(seconds * sampleRate));
    if (delay >= samples.length) continue;
    const line = new Float32Array(delay);
    let cursor = 0;
    const feedback = 0.78;
    for (let index = 0; index < samples.length; index += 1) {
      const delayed = line[cursor];
      line[cursor] = samples[index] + delayed * feedback;
      cursor = (cursor + 1) % delay;
      out[index] += delayed * amount * 0.25;
    }
  }
  return out;
}

/** 等パワーパンの左右ゲイン。 */
export function panGains(pan) {
  const angle = ((clampRange(pan, -1, 1, 0) + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

// #endregion

// #region レンダリング

/**
 * 編曲をステレオへレンダリングする。
 *
 * 音源トラックは 1 本ずつ `renderSoundFontTracks` に通す (パンとエフェクトを
 * トラック独立に掛けるため)。音声トラックは WAV を読んで同じバスへ混ぜる。
 *
 * @param {object} arrangement - `normalizeArrangement` の結果。
 * @param {object} runtime - `{ soundfontPath, gain, releaseSeconds, sampleRate, maxSeconds }`。
 * @returns {Promise<{ left: Float32Array, right: Float32Array, sampleRate: number,
 *   seconds: number, frames: number, peak: number, rms: number, rendered: object[], warnings: string[] }>}
 */
export async function renderArrangement(arrangement, runtime = {}) {
  const sampleRate = positiveInt(runtime.sampleRate, DAW_SAMPLE_RATE);
  const releaseSeconds = Number.isFinite(runtime.releaseSeconds) ? Math.max(0, runtime.releaseSeconds) : 1.2;
  const gain = Number.isFinite(runtime.gain) && runtime.gain > 0 ? runtime.gain : 1;
  const soundfontPath = textOrEmpty(runtime.soundfontPath);
  const warnings = [...(arrangement.warnings ?? [])];

  const seconds = arrangementSeconds(arrangement, releaseSeconds);
  const maxSeconds = Number.isFinite(runtime.maxSeconds) && runtime.maxSeconds > 0 ? runtime.maxSeconds : 600;
  if (seconds > maxSeconds) {
    throw new Error(`演奏時間が上限 (${Math.round(maxSeconds)}s) を超えています: ${seconds.toFixed(1)}s`);
  }
  const frames = Math.max(1, Math.ceil(seconds * sampleRate));

  const soloed = arrangement.tracks.some((track) => track.solo);
  const audible = arrangement.tracks.filter((track) => {
    if (soloed) return track.solo;
    return !track.mute;
  });

  const needsSynth = audible.some((track) => track.kind !== 'audio');
  if (needsSynth && !soundFontAvailable(soundfontPath)) {
    throw new Error(
      `SoundFont が見つかりません: ${soundfontPath === '' ? '(未設定)' : soundfontPath}。`
      + ' 音源トラックを鳴らすには config の soundfont.path に .sf2 を指定してください。',
    );
  }

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rendered = [];

  for (const track of audible) {
    let mono;
    let startFrame = Math.round((track.offsetBeats * 60 * sampleRate) / arrangement.tempo);
    if (track.kind === 'audio') {
      if (track.audioPath === '') continue;
      const bytes = await readFile(resolveAudioPath(track.audioPath, runtime.baseDir));
      const opened = openStereo(bytes);
      mono = new Float32Array(opened.frames);
      for (let frame = 0; frame < opened.frames; frame += 1) mono[frame] = (opened.left[frame] + opened.right[frame]) * 0.5;
      if (opened.sampleRate !== sampleRate) mono = resampleLinear(mono, opened.sampleRate, sampleRate);
    } else {
      const pieceTrack = {
        name: track.name,
        instrument: track.instrument,
        notes: track.notes.map((note) => ({ start: note.start, duration: note.duration, pitches: note.pitches })),
      };
      mono = await renderSoundFontTracks(soundfontPath, {
        tempo: arrangement.tempo,
        tracks: [pieceTrack],
        volume: 1,
        gain,
        releaseSeconds,
      });
    }

    if (track.delay > 0) {
      const delaySeconds = (0.75 * 60) / arrangement.tempo;
      mono = addEcho(mono, sampleRate, track.delay, delaySeconds);
    }
    if (track.reverb > 0) mono = addReverb(mono, sampleRate, track.reverb);

    const gains = panGains(track.pan);
    const level = Math.max(0, track.volume);
    const limit = Math.min(frames, startFrame + mono.length);
    for (let frame = Math.max(0, startFrame); frame < limit; frame += 1) {
      const value = mono[frame - startFrame];
      left[frame] += value * level * gains.left;
      right[frame] += value * level * gains.right;
    }
    rendered.push({ name: track.name, kind: track.kind, instrument: track.instrument, frames: mono.length });
  }

  // ピークが 1 を超えたら全体を下げる (クリップさせない)。
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] *= scale;
      right[frame] *= scale;
    }
    peak = 0.98;
  }

  let sum = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    sum += left[frame] * left[frame] + right[frame] * right[frame];
  }
  const rms = frames > 0 ? Math.sqrt(sum / (frames * 2)) : 0;
  if (peak === 0) warnings.push('無音のレンダリングになりました (ミュートや音源が空でないか確認してください)。');

  return { left, right, sampleRate, seconds: frames / sampleRate, frames, peak, rms, rendered, warnings };
}

/** 音声パスを解決する (絶対パスはそのまま、相対はセッションからの相対)。 */
function resolveAudioPath(path, baseDir) {
  return isAbsolute(path) ? path : resolve(baseDir ?? process.cwd(), path);
}

// #endregion

// #region プロジェクト書き出し

/** 編曲を SMF 用のプロジェクトへ変換する。 */
export function buildMidiProject(arrangement, options = {}) {
  const ticksPerQuarter = positiveInt(options.ticksPerQuarter, SMF_TICKS_PER_QUARTER);
  const tracks = [];
  for (const track of arrangement.tracks) {
    if (track.kind === 'audio') continue;
    const notes = [];
    for (const note of track.notes) {
      for (const pitch of note.pitches) {
        const midi = pitchToMidi(pitch);
        if (!Number.isInteger(midi) || midi < 0 || midi > 127) continue;
        notes.push({
          start: note.start + track.offsetBeats,
          duration: note.duration,
          midi,
          velocity: note.velocity,
        });
      }
    }
    if (notes.length === 0) continue;
    tracks.push({
      name: track.name,
      channel: track.channel,
      program: track.program,
      bankMSB: track.drum ? 0 : track.bankMSB,
      bankLSB: track.bankLSB,
      drum: track.drum,
      volume: clampInt(track.volume * 100, 0, 127, 100),
      pan: clampInt((track.pan + 1) * 63.5, 0, 127, 64),
      notes: notes.sort((first, second) => (first.start - second.start) || (first.midi - second.midi)),
    });
  }
  return {
    format: 1,
    ticksPerQuarter,
    tempo: arrangement.tempo,
    timeSignature: arrangement.timeSignature,
    title: arrangement.name,
    tracks,
  };
}

/** 調号の fifths。 */
function keyFifths(key) {
  const normalized = textOrEmpty(key).toLowerCase().replace(/\s+/gu, '').replace(/minor$/u, 'm').replace(/major$/u, '');
  return KEY_FIFTHS.get(normalized) ?? 0;
}

/** 拍 → MusicXML の division。 */
function musicXmlDivisions(beats) {
  return Math.max(1, Math.round(beats * SMF_TICKS_PER_QUARTER));
}

/** 1 拍子分の `<note>` を組み立てる。 */
function musicXmlNote(pitches, durationDivisions, withChord) {
  const lines = ['      <note>'];
  if (withChord) lines.push('        <chord/>');
  for (const { step, alter, octave } of pitches) {
    lines.push('        <pitch>');
    lines.push(`          <step>${step}</step>`);
    if (alter !== 0) lines.push(`          <alter>${alter}</alter>`);
    lines.push(`          <octave>${octave}</octave>`);
    lines.push('        </pitch>');
  }
  lines.push(`        <duration>${durationDivisions}</duration>`);
  lines.push('        <voice>1</voice>');
  lines.push('      </note>');
  return lines;
}

/** `C#4` → `{ step, alter, octave }`。 */
function splitPitch(pitch) {
  const match = String(pitch).trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/u);
  if (match === null) return null;
  const step = match[1].toUpperCase();
  const alter = match[2] === '#' ? 1 : (match[2] === 'b' ? -1 : 0);
  return { step, alter, octave: Number(match[3]) };
}

/**
 * MusicXML 4.0 (partwise) を組み立てる。MuseScore が開ける形を狙う。
 *
 * @param {object} arrangement - 正規化済みの編曲。
 * @returns {string} MusicXML のテキスト。
 */
export function serializeMusicXml(arrangement) {
  const parts = arrangement.tracks.filter((track) => track.kind !== 'audio');
  const beatsPerBar = arrangement.beatsPerBar;
  const [numerator, denominator] = arrangement.timeSignature;
  const fifths = keyFifths(arrangement.key);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    '  <work>',
    `    <work-title>${escapeXml(arrangement.name)}</work-title>`,
    '  </work>',
    '  <identification>',
    '    <encoding>',
    '      <software>DSH Media Studio</software>',
    '    </encoding>',
    '  </identification>',
    '  <part-list>',
  ];

  parts.forEach((track, index) => {
    const id = `P${index + 1}`;
    lines.push('    <score-part id="' + id + '">');
    lines.push(`      <part-name>${escapeXml(track.name)}</part-name>`);
    lines.push(`      <score-instrument id="${id}-I1">`);
    lines.push(`        <instrument-name>${escapeXml(
      track.drum ? 'Drum Kit' : gmProgramName(track.program),
    )}</instrument-name>`);
    lines.push('      </score-instrument>');
    lines.push(`      <midi-instrument id="${id}-I1">`);
    lines.push(`        <midi-channel>${track.channel + 1}</midi-channel>`);
    lines.push(`        <midi-program>${track.program + 1}</midi-program>`);
    lines.push(`        <volume>${Math.round(clampRange(track.volume, 0, 1.5, 1) * 100)}</volume>`);
    lines.push(`        <pan>${Math.round(clampRange(track.pan, -1, 1, 0) * 90)}</pan>`);
    lines.push('      </midi-instrument>');
    lines.push('    </score-part>');
  });
  lines.push('  </part-list>');

  const totalBeats = arrangement.bars * beatsPerBar;
  parts.forEach((track, index) => {
    const id = `P${index + 1}`;
    lines.push(`  <part id="${id}">`);
    for (let bar = 0; bar < arrangement.bars; bar += 1) {
      const barStart = bar * beatsPerBar;
      const barEnd = Math.min(totalBeats, barStart + beatsPerBar);
      lines.push(`    <measure number="${bar + 1}">`);
      if (bar === 0) {
        lines.push('      <attributes>');
        lines.push(`        <divisions>${SMF_TICKS_PER_QUARTER}</divisions>`);
        lines.push('        <key>');
        lines.push(`          <fifths>${fifths}</fifths>`);
        lines.push('        </key>');
        lines.push('        <time>');
        lines.push(`          <beats>${numerator}</beats>`);
        lines.push(`          <beat-type>${denominator}</beat-type>`);
        lines.push('        </time>');
        if (track.drum) {
          lines.push('        <clef>');
          lines.push('          <sign>percussion</sign>');
          lines.push('          <line>2</line>');
          lines.push('        </clef>');
        } else {
          lines.push('        <clef>');
          lines.push('          <sign>G</sign>');
          lines.push('          <line>2</line>');
          lines.push('        </clef>');
        }
        lines.push('      </attributes>');
        lines.push('      <direction placement="above">');
        lines.push('        <direction-type>');
        lines.push('          <metronome>');
        lines.push('            <beat-unit>quarter</beat-unit>');
        lines.push(`            <per-minute>${Math.round(arrangement.tempo)}</per-minute>`);
        lines.push('          </metronome>');
        lines.push('        </direction-type>');
        lines.push(`        <sound tempo="${Math.round(arrangement.tempo)}"/>`);
        lines.push('      </direction>');
      }

      // 小節内で開始するノートを (start, duration) でまとめる (和音は 1 グループ)。
      const groups = new Map();
      for (const note of track.notes) {
        const startBeats = note.start + track.offsetBeats;
        if (startBeats < barStart || startBeats >= barEnd) continue;
        const clippedEnd = Math.min(startBeats + note.duration, barEnd);
        const duration = Math.max(0, clippedEnd - startBeats);
        if (duration <= 0) continue;
        const key = `${roundBeats(startBeats)}:${roundBeats(duration)}`;
        if (!groups.has(key)) groups.set(key, { start: startBeats, duration, pitches: [] });
        for (const pitch of note.pitches) {
          const parsed = splitPitch(pitch);
          if (parsed !== null) groups.get(key).pitches.push(parsed);
        }
      }
      const ordered = [...groups.values()]
        .filter((group) => group.pitches.length > 0)
        .sort((first, second) => first.start - second.start);

      let cursor = barStart;
      for (const group of ordered) {
        const gap = musicXmlDivisions(group.start - cursor);
        if (group.start - cursor > 0.0001) {
          lines.push('      <note>');
          lines.push('        <rest/>');
          lines.push(`        <duration>${gap}</duration>`);
          lines.push('        <voice>1</voice>');
          lines.push('      </note>');
        }
        const duration = musicXmlDivisions(group.duration);
        group.pitches.forEach((pitch, pitchIndex) => {
          lines.push(...musicXmlNote([pitch], duration, pitchIndex > 0));
        });
        cursor = group.start + group.duration;
      }
      if (barEnd - cursor > 0.0001) {
        lines.push('      <note>');
        lines.push('        <rest/>');
        lines.push(`        <duration>${musicXmlDivisions(barEnd - cursor)}</duration>`);
        lines.push('        <voice>1</voice>');
        lines.push('      </note>');
      }
      lines.push('    </measure>');
    }
    lines.push('  </part>');
  });

  lines.push('</score-partwise>');
  return `${lines.join('\n')}\n`;
}

/**
 * LMMS プロジェクト (.mmp) を組み立てる。
 *
 * 内部解像度は 192 tick / 4 分音符。音声トラックは LMMS のサンプラー設定を
 * 持たないため書き出さず、コメントで残す。
 *
 * @param {object} arrangement - 正規化済みの編曲。
 * @returns {string} mmp のテキスト。
 */
export function serializeMmp(arrangement) {
  const [numerator, denominator] = arrangement.timeSignature;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE lmms-project>',
    '<lmms-project version="1.2" type="song" creator="LMMS" creatorversion="1.2.2">',
    '  <head>',
    `    <bpm>${Math.round(arrangement.tempo)}</bpm>`,
    `    <timesig_num>${numerator}</timesig_num>`,
    `    <timesig_denom>${denominator}</timesig_denom>`,
    '    <mastervol>100</mastervol>',
    '    <masterpitch>0</masterpitch>',
    '  </head>',
    '  <song>',
    '    <trackcontainer>',
  ];
  const totalTicks = Math.round(arrangement.bars * arrangement.beatsPerBar * LMMS_TICKS_PER_QUARTER);

  arrangement.tracks.forEach((track, index) => {
    if (track.kind === 'audio') {
      lines.push(`      <!-- audio track "${escapeXml(track.name)}": ${escapeXml(track.audioPath)} は mmp に埋め込めません -->`);
      return;
    }
    lines.push('      <track type="instrument">');
    lines.push('        <instrument name="tripleoscillator">');
    lines.push('          <el osc1_vol="100" osc1_wave="1" osc2_vol="0" osc2_wave="0" osc3_vol="0" osc3_wave="0"'
      + ' fm_mod="0" user_wave="-1" sub_div="0" sub_vol="0" fm_freq="1" fm_ratio="1" fm_mod_type="0"/>');
    lines.push('        </instrument>');
    lines.push(`        <pattern type="0" name="${escapeAttr(track.name)}" muted="0" steps="${totalTicks}" pos="0">`);
    for (const note of track.notes) {
      for (const pitch of note.pitches) {
        const midi = pitchToMidi(pitch);
        if (!Number.isInteger(midi) || midi < 0 || midi > 127) continue;
        const pos = Math.round((note.start + track.offsetBeats) * LMMS_TICKS_PER_QUARTER);
        const len = Math.max(1, Math.round(note.duration * LMMS_TICKS_PER_QUARTER));
        const volume = clampInt(note.velocity, 1, 127, DAW_DEFAULT_VELOCITY);
        const pan = clampInt(track.pan * 100, -100, 100, 0);
        lines.push(`          <note pos="${pos}" len="${len}" key="${midi}" vol="${volume}" pan="${pan}"/>`);
      }
    }
    lines.push('        </pattern>');
    lines.push(`        <!-- track ${index + 1}: ${escapeXml(gmProgramName(track.program))} -->`);
    lines.push('      </track>');
  });

  lines.push('    </trackcontainer>');
  lines.push('  </song>');
  lines.push('</lmms-project>');
  return `${lines.join('\n')}\n`;
}

/**
 * Hydrogen のドラムパターン (.h2song) を組み立てる。
 *
 * 内部解像度は 48 tick / 4 分音符 (Hydrogen の 1 小節 = 192 tick)。
 * 打楽器トラックだけを使い、1 小節につき 1 パターンを書く。
 *
 * @param {object} arrangement - 正規化済みの編曲。
 * @returns {{ text: string, patterns: number, notes: number, skipped: string[] }} h2song と件数。
 */
export function serializeH2Song(arrangement) {
  const skipped = [];
  const drumTracks = arrangement.tracks.filter((track) => track.kind === 'drums');
  for (const track of arrangement.tracks) {
    if (track.kind === 'audio') skipped.push(`${track.name} (音声トラック)`);
    else if (track.kind === 'instrument') skipped.push(`${track.name} (音色トラック)`);
  }

  // 使われている GM 打楽器キーだけを楽器として並べる。
  const used = new Map();
  for (const track of drumTracks) {
    for (const note of track.notes) {
      for (const pitch of note.pitches) {
        const midi = pitchToMidi(pitch);
        if (!Number.isInteger(midi)) continue;
        if (!used.has(midi)) used.set(midi, DRUM_KIT.find((entry) => entry.midi === midi)?.name ?? `GM Drum ${midi}`);
      }
    }
  }
  const kit = [...used.entries()].sort((first, second) => first[0] - second[0]);
  const instrumentIndex = new Map(kit.map(([midi], index) => [midi, index]));

  const ticksPerBar = Math.round(arrangement.beatsPerBar * HYDROGEN_TICKS_PER_QUARTER);
  const patterns = [];
  let noteCount = 0;
  for (let bar = 0; bar < arrangement.bars; bar += 1) {
    const barStart = bar * arrangement.beatsPerBar;
    const barEnd = barStart + arrangement.beatsPerBar;
    const notes = [];
    for (const track of drumTracks) {
      for (const note of track.notes) {
        const startBeats = note.start + track.offsetBeats;
        if (startBeats < barStart || startBeats >= barEnd) continue;
        const position = Math.round((startBeats - barStart) * HYDROGEN_TICKS_PER_QUARTER);
        for (const pitch of note.pitches) {
          const midi = pitchToMidi(pitch);
          if (!instrumentIndex.has(midi)) continue;
          notes.push({
            position,
            velocity: clamp01(note.velocity / 127, 0.8),
            instrument: instrumentIndex.get(midi),
            length: Math.max(1, Math.round(note.duration * HYDROGEN_TICKS_PER_QUARTER)),
          });
        }
      }
    }
    notes.sort((first, second) => (first.position - second.position) || (first.instrument - second.instrument));
    noteCount += notes.length;
    patterns.push(notes);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE hydrogen_song>',
    '<hydrogen_song>',
    '  <version>1.2.0</version>',
    `  <bpm>${Math.round(arrangement.tempo)}</bpm>`,
    '  <volume>1</volume>',
    '  <metronomeVolume>0.5</metronomeVolume>',
    `  <name>${escapeXml(arrangement.name)}</name>`,
    '  <author>DSH Media Studio</author>',
    '  <notes></notes>',
    '  <license>CC0</license>',
    '  <loopEnabled>true</loopEnabled>',
    '  <mode>0</mode>',
    '  <instrumentList>',
  ];
  kit.forEach(([midi, name], index) => {
    lines.push('    <instrument>');
    lines.push(`      <id>${index}</id>`);
    lines.push(`      <name>${escapeXml(name)}</name>`);
    lines.push(`      <midiNote>${midi}</midiNote>`);
    lines.push('      <volume>1</volume>');
    lines.push('      <isMuted>false</isMuted>');
    lines.push('      <pan>0</pan>');
    lines.push('    </instrument>');
  });
  lines.push('  </instrumentList>');
  lines.push('  <patternList>');
  patterns.forEach((notes, bar) => {
    lines.push('    <pattern>');
    lines.push(`      <name>Bar ${bar + 1}</name>`);
    lines.push('      <category>0</category>');
    lines.push(`      <size>${ticksPerBar}</size>`);
    lines.push('      <noteList>');
    for (const note of notes) {
      lines.push('        <note>');
      lines.push(`          <position>${note.position}</position>`);
      lines.push(`          <leadlag>0</leadlag>`);
      lines.push(`          <velocity>${note.velocity.toFixed(3)}</velocity>`);
      lines.push('          <pan>0</pan>');
      lines.push(`          <length>${note.length}</length>`);
      lines.push('          <type>0</type>');
      lines.push(`          <instrument>${note.instrument}</instrument>`);
      lines.push('        </note>');
    }
    lines.push('      </noteList>');
    lines.push('    </pattern>');
  });
  lines.push('  </patternList>');
  lines.push('</hydrogen_song>');
  return { text: `${lines.join('\n')}\n`, patterns: patterns.length, notes: noteCount, skipped };
}

// #endregion

// #region 書き出したものの読み戻し

/**
 * XML の入れ子が閉じているかを確かめる。
 *
 * 外部パーサを持たないので、タグの対応だけを見る軽い検査。
 * `export_daw_project` の自己検証とテストが使う。
 *
 * @param {string} text - XML テキスト。
 * @returns {{ ok: boolean, error: string, tags: number }} 判定結果。
 */
export function checkXmlBalance(text) {
  const source = String(text ?? '');
  const pattern = /<([!?/]?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gu;
  const stack = [];
  let tags = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const prefix = match[1];
    const name = match[2];
    const selfClosing = match[4];
    if (prefix === '!' || prefix === '?') continue;
    tags += 1;
    if (prefix === '/') {
      const top = stack.pop();
      if (top !== name) return { ok: false, error: `閉じタグ ${name} が ${top ?? '(なし)'} と一致しません。`, tags };
    } else if (selfClosing !== '/') {
      stack.push(name);
    }
  }
  if (stack.length > 0) return { ok: false, error: `閉じていないタグ: ${stack.join(', ')}`, tags };
  return { ok: true, error: '', tags };
}

/** 書き出した MusicXML を読み戻して要約する。 */
export function parseMusicXml(text) {
  const source = String(text ?? '');
  const balance = checkXmlBalance(source);
  if (!balance.ok) throw new Error(`MusicXML の XML が壊れています: ${balance.error}`);
  if (!source.includes('<score-partwise')) throw new Error('MusicXML ではありません (score-partwise がありません)。');

  const title = source.match(/<work-title>([\s\S]*?)<\/work-title>/u)?.[1] ?? '';
  const programs = new Map();
  for (const match of source.matchAll(/<score-part id="([^"]+)">([\s\S]*?)<\/score-part>/gu)) {
    const id = match[1];
    const body = match[2];
    programs.set(id, {
      name: unescapeXml(body.match(/<part-name>([\s\S]*?)<\/part-name>/u)?.[1] ?? ''),
      channel: Number(body.match(/<midi-channel>(\d+)<\/midi-channel>/u)?.[1] ?? '1'),
      program: Number(body.match(/<midi-program>(\d+)<\/midi-program>/u)?.[1] ?? '1'),
      instrumentName: unescapeXml(body.match(/<instrument-name>([\s\S]*?)<\/instrument-name>/u)?.[1] ?? ''),
    });
  }

  const parts = [];
  for (const match of source.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/gu)) {
    const id = match[1];
    const body = match[2];
    const measures = [...body.matchAll(/<measure number="(\d+)">([\s\S]*?)<\/measure>/gu)];
    let noteCount = 0;
    let chordCount = 0;
    let restCount = 0;
    let divisions = 0;
    for (const measure of measures) {
      for (const note of measure[2].matchAll(/<note>([\s\S]*?)<\/note>/gu)) {
        if (note[1].includes('<rest/>')) restCount += 1;
        else noteCount += 1;
        if (note[1].includes('<chord/>')) chordCount += 1;
      }
      if (divisions === 0) {
        divisions = Number(measure[2].match(/<divisions>(\d+)<\/divisions>/u)?.[1] ?? '0');
      }
    }
    parts.push({
      id,
      name: programs.get(id)?.name ?? '',
      channel: programs.get(id)?.channel ?? 1,
      program: programs.get(id)?.program ?? 1,
      instrumentName: programs.get(id)?.instrumentName ?? '',
      measures: measures.length,
      notes: noteCount,
      chords: chordCount,
      rests: restCount,
      divisions,
    });
  }
  const tempo = Number(source.match(/<sound tempo="([\d.]+)"\/>/u)?.[1] ?? '0');
  return { title, tempo, parts, noteCount: parts.reduce((sum, part) => sum + part.notes, 0) };
}

/** XML のエスケープを戻す。 */
function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/** 書き出した LMMS プロジェクトを読み戻して要約する。 */
export function parseMmp(text) {
  const source = String(text ?? '');
  const balance = checkXmlBalance(source);
  if (!balance.ok) throw new Error(`mmp の XML が壊れています: ${balance.error}`);
  if (!source.includes('<lmms-project')) throw new Error('mmp ではありません (lmms-project がありません)。');
  const tracks = [];
  for (const match of source.matchAll(/<track type="([^"]+)">([\s\S]*?)<\/track>/gu)) {
    const body = match[2];
    const patterns = [...body.matchAll(/<pattern[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/pattern>/gu)];
    let notes = 0;
    let maxKey = 0;
    let minKey = 127;
    for (const pattern of patterns) {
      for (const note of pattern[2].matchAll(/<note pos="(\d+)" len="(\d+)" key="(\d+)"/gu)) {
        notes += 1;
        const key = Number(note[3]);
        maxKey = Math.max(maxKey, key);
        minKey = Math.min(minKey, key);
      }
    }
    tracks.push({
      type: match[1],
      name: patterns[0]?.[1] ?? '',
      patterns: patterns.length,
      notes,
      minKey: notes === 0 ? 0 : minKey,
      maxKey: notes === 0 ? 0 : maxKey,
      instrument: body.match(/<instrument name="([^"]+)"/u)?.[1] ?? '',
    });
  }
  return {
    bpm: Number(source.match(/<bpm>([\d.]+)<\/bpm>/u)?.[1] ?? '0'),
    timeSignature: [
      Number(source.match(/<timesig_num>(\d+)<\/timesig_num>/u)?.[1] ?? '4'),
      Number(source.match(/<timesig_denom>(\d+)<\/timesig_denom>/u)?.[1] ?? '4'),
    ],
    tracks,
    trackCount: tracks.length,
    noteCount: tracks.reduce((sum, track) => sum + track.notes, 0),
  };
}

/** 書き出した Hydrogen パターンを読み戻して要約する。 */
export function parseH2Song(text) {
  const source = String(text ?? '');
  const balance = checkXmlBalance(source);
  if (!balance.ok) throw new Error(`h2song の XML が壊れています: ${balance.error}`);
  if (!source.includes('<hydrogen_song')) throw new Error('h2song ではありません (hydrogen_song がありません)。');
  const instruments = [...(source.match(/<instrumentList>([\s\S]*?)<\/instrumentList>/u)?.[1] ?? '')
    .matchAll(/<instrument>([\s\S]*?)<\/instrument>/gu)].map((match) => ({
    id: Number(match[1].match(/<id>(\d+)<\/id>/u)?.[1] ?? '0'),
    name: unescapeXml(match[1].match(/<name>([\s\S]*?)<\/name>/u)?.[1] ?? ''),
    midiNote: Number(match[1].match(/<midiNote>(\d+)<\/midiNote>/u)?.[1] ?? '36'),
  }));
  const patterns = [];
  for (const match of source.matchAll(/<pattern>([\s\S]*?)<\/pattern>/gu)) {
    const size = Number(match[1].match(/<size>(\d+)<\/size>/u)?.[1] ?? '0');
    const notes = [...match[1].matchAll(/<note>([\s\S]*?)<\/note>/gu)].map((note) => ({
      position: Number(note[1].match(/<position>(\d+)<\/position>/u)?.[1] ?? '0'),
      instrument: Number(note[1].match(/<instrument>(\d+)<\/instrument>/u)?.[1] ?? '0'),
      velocity: Number(note[1].match(/<velocity>([\d.]+)<\/velocity>/u)?.[1] ?? '1'),
    }));
    patterns.push({ size, notes: notes.length, positions: notes.map((note) => note.position) });
  }
  return {
    bpm: Number(source.match(/<bpm>([\d.]+)<\/bpm>/u)?.[1] ?? '0'),
    name: unescapeXml(source.match(/<name>([\s\S]*?)<\/name>/u)?.[1] ?? ''),
    instruments,
    patterns,
    patternCount: patterns.length,
    noteCount: patterns.reduce((sum, pattern) => sum + pattern.notes, 0),
  };
}

// #endregion

// #region MIDI から編曲へ

/**
 * `readSmf` の結果を `daw_arrange` / `export_daw_project` へ渡せる編曲にする。
 *
 * @param {object} smf - `midi.js` の `readSmf` の戻り値。
 * @param {object} [options] - `name`, `tempo`。
 * @returns {object} `{ name, tempo, timeSignature, bars, key, tracks }`。
 */
export function arrangementFromMidi(smf, options = {}) {
  const tempo = Number.isFinite(options.tempo) && options.tempo > 0
    ? options.tempo
    : (smf.tempos?.[0]?.bpm ?? DAW_DEFAULT_TEMPO);
  const timeSignature = Array.isArray(smf.timeSignature) && smf.timeSignature.length === 2
    ? smf.timeSignature
    : [...DAW_DEFAULT_TIME_SIGNATURE];
  const beatsPerBar = beatsPerBarOf(timeSignature);

  const tracks = [];
  let naturalEnd = 0;
  for (const track of smf.tracks ?? []) {
    if (track.noteCount === 0) continue;
    const notes = track.notes.map((note) => ({
      start: roundBeats(note.start),
      duration: roundBeats(Math.max(0.001, note.duration)),
      pitches: [midiToName(note.midi)],
      velocity: clampInt(note.velocity, 1, 127, DAW_DEFAULT_VELOCITY),
    }));
    for (const note of notes) naturalEnd = Math.max(naturalEnd, note.start + note.duration);
    const drum = track.drum === true;
    tracks.push({
      name: track.name,
      instrument: drum
        ? formatGmInstrument({ bankMSB: 128, program: track.program })
        : formatGmInstrument({ bankMSB: 0, program: track.program }),
      program: track.program,
      bankMSB: drum ? 128 : 0,
      bankLSB: 0,
      drum,
      channel: track.channel,
      volume: clampRange((track.volume ?? 100) / 100, 0, 2, 1),
      pan: clampRange(((track.pan ?? 64) - 64) / 63.5, -1, 1, 0),
      mute: false,
      solo: false,
      reverb: 0,
      delay: 0,
      offsetBeats: 0,
      notes,
    });
  }

  return {
    name: textOrEmpty(options.name) || textOrEmpty(smf.title) || 'imported',
    tempo: Math.round(clampRange(tempo, 20, 400, DAW_DEFAULT_TEMPO)),
    timeSignature,
    beatsPerBar,
    bars: Math.min(MAX_BARS, Math.max(1, Math.ceil(naturalEnd / beatsPerBar))),
    key: 'C',
    tracks,
    warnings: smf.warnings ?? [],
  };
}

/** 編曲を MSX スコア (compose_music が読める形) にする。 */
export function arrangementToScore(arrangement) {
  return formatScoreText({
    tempo: arrangement.tempo,
    title: arrangement.name,
    tracks: arrangement.tracks
      .filter((track) => track.kind !== 'audio')
      .map((track) => ({
        name: track.name,
        instrument: track.instrument,
        notes: track.notes.map((note) => ({ start: note.start, duration: note.duration, pitches: note.pitches })),
      })),
  });
}

// #endregion

// #region 外部プロセス

/** ffmpeg を 1 回だけ起動し、終了コードを見る。タイムアウトで kill する。 */
function runFfmpeg(executable, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error(`ffmpeg が ${Math.round(timeoutMs / 1000)} 秒でタイムアウトしました。`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.stdout?.resume();
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`ffmpeg を起動できません: ${String(cause?.message ?? cause)}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(Buffer.concat(stderr).toString('utf8'));
        return;
      }
      const tail = Buffer.concat(stderr).toString('utf8').trim().slice(-1200);
      rejectPromise(new Error(`ffmpeg が終了コード ${code} で失敗しました。${tail === '' ? '' : ` ${tail}`}`));
    });
  });
}

/** ffmpeg の場所。空文字なら PATH の `ffmpeg`。 */
function resolveFfmpeg(daw) {
  return daw.ffmpegPath === '' ? 'ffmpeg' : daw.ffmpegPath;
}

// #endregion

// #region オプション

/** `config.daw` と解決済みオプションから、この module の設定を作る。 */
export function resolveDawOptions(config, options, helpers) {
  const source = config?.daw ?? {};
  const fallbackDir = options?.outputDir ?? DAW_DEFAULT_OUTPUT_DIR;
  const safeDir = typeof helpers?.safeRelativeDir === 'function'
    ? helpers.safeRelativeDir(source.outputDir ?? fallbackDir)
    : (source.outputDir ?? fallbackDir);
  return {
    outputDir: safeDir,
    sampleRate: DAW_SAMPLE_RATE,
    defaultInstrument: typeof source.defaultInstrument === 'string' && parseGmInstrument(source.defaultInstrument) !== null
      ? source.defaultInstrument
      : (options?.music?.defaultInstrument ?? 'gm:0'),
    maxSeconds: Number.isFinite(Number(source.maxSeconds))
      ? Math.max(1, Number(source.maxSeconds))
      : (options?.music?.maxSeconds ?? 600),
    maxNotes: Number.isFinite(Number(source.maxNotes))
      ? Math.max(1, Number(source.maxNotes))
      : 20000,
    maxTracks: Number.isFinite(Number(source.maxTracks)) ? Math.max(1, Number(source.maxTracks)) : 32,
    ffmpegPath: textOrEmpty(source.ffmpegPath) || textOrEmpty(options?.video?.ffmpegPath),
    ffmpegTimeoutMs: Number.isFinite(Number(source.ffmpegTimeoutMs)) ? Math.max(5000, Number(source.ffmpegTimeoutMs)) : 180000,
    mp3Quality: Number.isFinite(Number(source.mp3Quality))
      ? clampInt(source.mp3Quality, 0, 9, 2)
      : 2,
    oggQuality: Number.isFinite(Number(source.oggQuality))
      ? clampInt(source.oggQuality, 0, 10, 6)
      : 6,
    ticksPerQuarter: positiveInt(source.ticksPerQuarter, SMF_TICKS_PER_QUARTER),
    soundfontPath: textOrEmpty(options?.soundfont?.path),
    soundfontGain: Number.isFinite(Number(options?.soundfont?.gain)) ? Number(options.soundfont.gain) : 1,
    releaseSeconds: Number.isFinite(Number(options?.soundfont?.releaseSeconds))
      ? Math.max(0, Number(options.soundfont.releaseSeconds))
      : 1.2,
  };
}

// #endregion

// #region ツール

/** 出力先の絶対パスを作る。 */
async function outputTarget(ctx, exec, helpers, daw, name) {
  const cwd = await helpers.resolveSessionCwd(ctx, exec);
  const directory = join(cwd, daw.outputDir);
  await mkdir(directory, { recursive: true });
  return { cwd, path: join(directory, name), directory };
}

/**
 * `daw_arrange` — マルチトラック編曲を 1 曲にレンダリングする。
 */
function dawArrangeTool(ctx, options, daw, helpers) {
  return {
    name: 'daw_arrange',
    description: [
      'Arrange and mix a multi-track piece and render it to audio.',
      'Give an `arrangement`: tracks with notes in beats, each with an instrument',
      '(a GM program number, a GM name such as "piano" or "strings", or `drums: true`',
      'for the GM percussion channel), plus `volume`, `pan`, `mute`, `solo`, `reverb`',
      'and `delay`; audio tracks name a WAV with `audio`.',
      'Tracks are synthesised through the configured SoundFont, each one separately,',
      'so pan and effects apply per track, then mixed to a stereo 44.1 kHz WAV.',
      'Use it for a finished multi-instrument demo, a backing track, or a mixdown of',
      'tracks you wrote earlier. Use compose_music instead for automatic composition',
      'from a prompt, and export_daw_project to hand the same arrangement to a DAW.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        arrangement: {
          type: 'object',
          description: 'The arrangement: `{ tempo, timeSignature, bars, key, tracks: [...] }`.',
          additionalProperties: true,
          properties: {
            name: { type: 'string', description: 'Title, used in the file name.' },
            tempo: { type: 'number', description: 'Tempo in BPM. Defaults to 120.' },
            timeSignature: {
              description: 'Time signature as [beats, beatType] or "4/4". Defaults to 4/4.',
            },
            bars: { type: 'integer', description: 'Length in bars. Derived from the notes when omitted.' },
            key: { type: 'string', description: 'Key, e.g. "C" or "Am".' },
            tracks: {
              type: 'array',
              description: 'The tracks, mixed in order.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  name: { type: 'string', description: 'Track name.' },
                  instrument: {
                    type: 'string',
                    description: 'SoundFont preset as "gm:<program>" / "gm:<bank>:<program>", or a GM name such as "piano", "strings", "bass", "pad".',
                  },
                  program: { type: 'integer', description: 'GM program number 0-127. Ignored when `instrument` names one.' },
                  drums: { type: 'boolean', description: 'Send this track to the GM percussion channel.' },
                  notes: {
                    type: 'array',
                    description: 'Notes in beats: `{ start, duration, pitches: ["C4"], velocity }`.',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        start: { type: 'number', description: 'Onset in quarter notes from the start.' },
                        duration: { type: 'number', description: 'Length in quarter notes.' },
                        pitches: { type: 'array', items: { type: 'string' }, description: 'Pitch names, e.g. ["C4","E4","G4"].' },
                        pitch: { type: 'string', description: 'One pitch name; a shortcut for `pitches`.' },
                        velocity: { type: 'integer', description: '1-127. Defaults to 96.' },
                      },
                    },
                  },
                  steps: {
                    type: 'array',
                    description: 'A step grid as returned by compose_music, instead of `notes`.',
                    items: { type: 'array', items: { type: 'string' } },
                  },
                  stepBeats: { type: 'number', description: 'Length of one step in quarter notes, for `steps`.' },
                  audio: { type: 'string', description: 'A WAV file to mix in as an audio track, instead of notes.' },
                  offset: { type: 'number', description: 'Offset of the whole track in quarter notes. Defaults to 0.' },
                  volume: { type: 'number', description: '0-2. Defaults to 1.' },
                  pan: { type: 'number', description: '-1 (left) to 1 (right). Defaults to 0.' },
                  mute: { type: 'boolean', description: 'Drop this track from the mix.' },
                  solo: { type: 'boolean', description: 'Mute every track that is not soloed.' },
                  reverb: { type: 'number', description: '0-1 reverb send. Defaults to 0.' },
                  delay: { type: 'number', description: '0-1 echo send (dotted eighth). Defaults to 0.' },
                },
              },
            },
          },
        },
        score: { type: 'string', description: 'An MSX multi-track score text, as an alternative to `arrangement`.' },
        tempo: { type: 'number', description: 'Tempo in BPM, overriding the arrangement.' },
        bars: { type: 'integer', description: 'Length in bars, overriding the arrangement.' },
        timeSignature: { type: 'string', description: 'Time signature such as "4/4", overriding the arrangement.' },
        name: { type: 'string', description: 'Title, overriding the arrangement.' },
        format: { type: 'string', enum: DAW_AUDIO_FORMATS, description: 'Output format. Defaults to wav.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'bytes', 'mediaType', 'seconds', 'sampleRate', 'channels', 'tracks', 'notes', 'bars', 'tempo', 'format'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          format: { type: 'string' },
          seconds: { type: 'number' },
          sampleRate: { type: 'integer' },
          channels: { type: 'integer' },
          tracks: { type: 'integer' },
          notes: { type: 'integer' },
          bars: { type: 'integer' },
          tempo: { type: 'number' },
          peak: { type: 'number' },
          rms: { type: 'number' },
          muted: { type: 'integer' },
          soloed: { type: 'integer' },
          wavPath: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const blocks = [{
          type: 'text',
          text: `編曲を書き出しました (${value.tracks} トラック, ${value.notes} ノート, `
            + `${value.bars} 小節, ${Math.round(value.tempo)} BPM, ${value.seconds.toFixed(2)}s, `
            + `ピーク ${value.peak.toFixed(3)}): ${value.path ?? value.name}`,
        }];
        if (Array.isArray(value.warnings) && value.warnings.length > 0) {
          blocks.push({ type: 'text', text: `注意: ${value.warnings.join(' / ')}` });
        }
        return blocks;
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 1800000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const arrangement = normalizeArrangement({
        arrangement: args?.arrangement,
        score: args?.score,
        tempo: args?.tempo,
        bars: args?.bars,
        timeSignature: args?.timeSignature,
        name: args?.name,
      }, { defaultInstrument: daw.defaultInstrument });
      if (arrangement.tracks.length > daw.maxTracks) {
        throw new Error(`トラック数が上限 (${daw.maxTracks}) を超えています。`);
      }
      if (arrangementNoteCount(arrangement) > daw.maxNotes) {
        throw new Error(`ノート数が上限 (${daw.maxNotes}) を超えています。`);
      }

      const format = DAW_AUDIO_FORMATS.includes(textOrEmpty(args?.format)) ? textOrEmpty(args.format) : 'wav';
      const cwd = await helpers.resolveSessionCwd(ctx, exec);
      const runtime = {
        soundfontPath: daw.soundfontPath,
        gain: daw.soundfontGain,
        releaseSeconds: daw.releaseSeconds,
        sampleRate: daw.sampleRate,
        maxSeconds: daw.maxSeconds,
        baseDir: cwd,
      };
      const rendered = await renderArrangement(arrangement, runtime);
      const slug = slugify(arrangement.name, 'arrangement');
      const target = await outputTarget(ctx, exec, helpers, daw, `${slug}.wav`);
      await writeFile(target.path, encodeWavStereo(rendered.left, rendered.right, rendered.sampleRate));

      let finalPath = target.path;
      let finalName = `${slug}.wav`;
      let mediaType = 'audio/wav';
      let wavPath;
      if (format !== 'wav') {
        const converted = join(target.directory, `${slug}.${format}`);
        const argsList = [
          '-y', '-nostdin', '-loglevel', 'error',
          '-i', target.path,
          ...(format === 'mp3'
            ? ['-codec:a', 'libmp3lame', '-q:a', String(daw.mp3Quality)]
            : ['-codec:a', 'libvorbis', '-q:a', String(daw.oggQuality)]),
          converted,
        ];
        try {
          await runFfmpeg(resolveFfmpeg(daw), argsList, daw.ffmpegTimeoutMs);
          wavPath = displayPath(cwd, target.path);
          finalPath = converted;
          finalName = `${slug}.${format}`;
          mediaType = format === 'mp3' ? 'audio/mpeg' : 'audio/ogg';
        } catch (cause) {
          rendered.warnings.push(`${format} への変換に失敗したので WAV を返します: ${String(cause?.message ?? cause)}`);
        }
      }

      const bytes = (await readFile(finalPath)).length;
      const soloed = arrangement.tracks.filter((track) => track.solo).length;
      const muted = arrangement.tracks.filter((track) => track.mute && !track.solo).length;
      return {
        name: finalName,
        path: displayPath(cwd, finalPath),
        bytes,
        mediaType,
        format,
        seconds: rendered.seconds,
        sampleRate: rendered.sampleRate,
        channels: 2,
        tracks: arrangement.tracks.length,
        notes: arrangementNoteCount(arrangement),
        bars: arrangement.bars,
        tempo: arrangement.tempo,
        peak: Number(rendered.peak.toFixed(6)),
        rms: Number(rendered.rms.toFixed(6)),
        ...(muted > 0 ? { muted } : {}),
        ...(soloed > 0 ? { soloed } : {}),
        ...(wavPath === undefined ? {} : { wavPath }),
        warnings: rendered.warnings.slice(0, 12),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `DAW arrange: ${args?.name ?? args?.arrangement?.name ?? 'arrangement'}`, kind: 'other' };
    },
  };
}

/**
 * `export_daw_project` — 編曲を外部の DAW / 記譜ソフト向けに書き出す。
 */
function exportDawProjectTool(ctx, options, daw, helpers) {
  return {
    name: 'export_daw_project',
    description: [
      'Write the same arrangement out as a project file another program can open:',
      '`mid` (a standard MIDI file, type 1, with a tempo map, program changes and',
      'CC7/CC10 per track), `musicxml` (MusicXML 4.0 partwise, for MuseScore),',
      '`mmp` (an LMMS project) or `h2song` (a Hydrogen drum pattern).',
      'Nothing needs to be installed: this only writes files, and every writer is',
      'read back by its own parser before the file is reported as written.',
      'Use it to continue an arrangement in a real DAW, or to hand a score to a',
      'notation program. Use import_midi for the opposite direction.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['format'],
      properties: {
        format: { type: 'string', enum: DAW_PROJECT_FORMATS, description: 'Which project format to write.' },
        arrangement: {
          type: 'object',
          description: 'The arrangement, in the same shape daw_arrange takes.',
          additionalProperties: true,
        },
        score: { type: 'string', description: 'An MSX multi-track score text, as an alternative to `arrangement`.' },
        name: { type: 'string', description: 'Title, used in the file name and the file header.' },
        tempo: { type: 'number', description: 'Tempo in BPM, overriding the arrangement.' },
        bars: { type: 'integer', description: 'Length in bars, overriding the arrangement.' },
        timeSignature: { type: 'string', description: 'Time signature such as "4/4", overriding the arrangement.' },
        ticksPerQuarter: { type: 'integer', description: 'MIDI resolution for the .mid file. Defaults to 480.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'bytes', 'mediaType', 'format', 'tracks', 'notes', 'tempo', 'bars', 'verified'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          format: { type: 'string' },
          tracks: { type: 'integer' },
          notes: { type: 'integer' },
          tempo: { type: 'number' },
          bars: { type: 'integer' },
          timeSignature: { type: 'array', items: { type: 'number' } },
          ticksPerQuarter: { type: 'integer' },
          verified: {
            type: 'object',
            additionalProperties: true,
            description: 'What reading the written file back reported.',
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const verified = value.verified ?? {};
        const detail = value.format === 'mid'
          ? `SMF を読み戻して ${verified.trackCount ?? 0} トラック / ${verified.noteCount ?? 0} ノートを確認`
          : `${value.format} を解析して ${verified.noteCount ?? 0} ノートを確認`;
        const blocks = [{
          type: 'text',
          text: `DAW プロジェクトを書き出しました (${value.format}, ${value.tracks} トラック, `
            + `${value.notes} ノート, ${value.bytes} バイト): ${value.path ?? value.name}。${detail}。`,
        }];
        if (Array.isArray(value.warnings) && value.warnings.length > 0) {
          blocks.push({ type: 'text', text: `注意: ${value.warnings.join(' / ')}` });
        }
        return blocks;
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const format = textOrEmpty(args?.format);
      if (!DAW_PROJECT_FORMATS.includes(format)) {
        throw new Error(`format には ${DAW_PROJECT_FORMATS.join(' / ')} のいずれかを指定してください。`);
      }
      const arrangement = normalizeArrangement({
        arrangement: args?.arrangement,
        score: args?.score,
        tempo: args?.tempo,
        bars: args?.bars,
        timeSignature: args?.timeSignature,
        name: args?.name,
      }, { defaultInstrument: daw.defaultInstrument });

      const warnings = [...arrangement.warnings];
      const slug = slugify(arrangement.name, 'arrangement');
      const totalNotes = arrangementNoteCount(arrangement);
      let body;
      let extension;
      let mediaType;
      let verified;
      let extra = {};

      if (format === 'mid') {
        const project = buildMidiProject(arrangement, { ticksPerQuarter: positiveInt(args?.ticksPerQuarter, daw.ticksPerQuarter) });
        body = writeSmf(project);
        extension = 'mid';
        mediaType = 'audio/midi';
        const smf = readSmf(body);
        verified = {
          format: smf.format,
          trackCount: smf.trackCount,
          noteCount: smf.totalNotes,
          tempo: Math.round(smf.tempos[0]?.bpm ?? 0),
          timeSignature: smf.timeSignature,
          programs: smf.tracks.filter((track) => track.noteCount > 0).map((track) => ({
            name: track.name,
            channel: track.channel + 1,
            program: track.program,
            drum: track.drum,
            notes: track.noteCount,
          })),
        };
        extra = { ticksPerQuarter: project.ticksPerQuarter };
      } else if (format === 'musicxml') {
        const text = serializeMusicXml(arrangement);
        const parsed = parseMusicXml(text);
        body = Buffer.from(text, 'utf8');
        extension = 'musicxml';
        mediaType = 'application/vnd.recordare.musicxml+xml';
        verified = {
          parts: parsed.parts.length,
          noteCount: parsed.noteCount,
          measures: parsed.parts[0]?.measures ?? 0,
          tempo: Math.round(parsed.tempo),
          divisions: parsed.parts[0]?.divisions ?? 0,
          xml: checkXmlBalance(text),
        };
        if (parsed.noteCount < totalNotes) warnings.push(`MusicXML には ${parsed.noteCount} 音しか入りませんでした (編曲は ${totalNotes} 音)。`);
      } else if (format === 'mmp') {
        const text = serializeMmp(arrangement);
        const parsed = parseMmp(text);
        body = Buffer.from(text, 'utf8');
        extension = 'mmp';
        mediaType = 'application/xml';
        verified = {
          trackCount: parsed.trackCount,
          noteCount: parsed.noteCount,
          bpm: Math.round(parsed.bpm),
          timeSignature: parsed.timeSignature,
          xml: checkXmlBalance(text),
        };
        const audioTracks = arrangement.tracks.filter((track) => track.kind === 'audio');
        if (audioTracks.length > 0) warnings.push('音声トラックは mmp に埋め込めないため、コメントとして残しました。');
      } else {
        const result = serializeH2Song(arrangement);
        const parsed = parseH2Song(result.text);
        body = Buffer.from(result.text, 'utf8');
        extension = 'h2song';
        mediaType = 'application/xml';
        verified = {
          patternCount: parsed.patternCount,
          noteCount: parsed.noteCount,
          instruments: parsed.instruments.length,
          bpm: Math.round(parsed.bpm),
          xml: checkXmlBalance(result.text),
        };
        if (parsed.instruments.length === 0) warnings.push('打楽器トラックが無いため、空のパターンを書き出しました。');
        for (const skipped of result.skipped) warnings.push(`${skipped} は Hydrogen には入りません。`);
      }

      const name = `${slug}.${extension}`;
      const target = await outputTarget(ctx, exec, helpers, daw, name);
      await writeFile(target.path, body);
      const cwd = await helpers.resolveSessionCwd(ctx, exec);

      return {
        name,
        path: displayPath(cwd, target.path),
        bytes: body.length,
        mediaType,
        format,
        tracks: arrangement.tracks.length,
        notes: totalNotes,
        tempo: arrangement.tempo,
        bars: arrangement.bars,
        timeSignature: arrangement.timeSignature,
        verified,
        ...extra,
        warnings: warnings.slice(0, 12),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `Export DAW project: ${args?.format ?? 'mid'}`, kind: 'other' };
    },
  };
}

/**
 * `import_midi` — SMF を読み、編曲として渡せる形に分解する。
 */
function importMidiTool(ctx, options, daw, helpers) {
  return {
    name: 'import_midi',
    description: [
      'Read a standard MIDI file and break it into tracks, notes, tempo and programs',
      'so the arrangement can be rendered or edited here.',
      'It returns an `arrangement` object that daw_arrange and export_daw_project',
      'accept directly, plus `score` (MSX score text) for compose_music and',
      'generate_music. Running status, tempo maps, program changes and CC7/CC10 are',
      'read from type 0 and type 1 files. Use it to bring a MIDI file a user has,',
      'or a file written by export_daw_project, back into the studio.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'The .mid file, relative to the session directory or absolute.' },
        name: { type: 'string', description: 'Title for the imported arrangement. Defaults to the MIDI track name.' },
        tempo: { type: 'number', description: 'Tempo in BPM, overriding the tempo map in the file.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'tracks', 'notes', 'tempo', 'bars', 'arrangement', 'score'],
        properties: {
          name: { type: 'string' },
          sourcePath: { type: 'string' },
          tracks: { type: 'integer' },
          notes: { type: 'integer' },
          tempo: { type: 'number' },
          bars: { type: 'integer' },
          timeSignature: { type: 'array', items: { type: 'number' } },
          format: { type: 'integer' },
          ticksPerQuarter: { type: 'integer' },
          arrangement: { type: 'object', additionalProperties: true },
          score: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const blocks = [{
          type: 'text',
          text: `MIDI を読み込みました (${value.tracks} トラック, ${value.notes} ノート, `
            + `${value.bars} 小節, ${Math.round(value.tempo)} BPM): ${value.sourcePath ?? value.name}`,
        }];
        if (Array.isArray(value.warnings) && value.warnings.length > 0) {
          blocks.push({ type: 'text', text: `注意: ${value.warnings.join(' / ')}` });
        }
        return blocks;
      },
      presentationMeta(_args, value) {
        return value.sourcePath === undefined ? { name: value.name } : { path: value.sourcePath };
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = textOrEmpty(args?.path);
      if (requested === '') throw new Error('path に .mid ファイルを指定してください。');
      const cwd = await helpers.resolveSessionCwd(ctx, exec);
      const candidates = isAbsolute(requested)
        ? [requested]
        : [join(cwd, requested), join(cwd, daw.outputDir, requested)];
      let bytes;
      let used;
      let lastError;
      for (const candidate of candidates) {
        try {
          bytes = await readFile(candidate);
          used = candidate;
          break;
        } catch (cause) {
          lastError = cause;
        }
      }
      if (bytes === undefined) {
        throw new Error(`MIDI ファイルを読めません: ${requested}。${String(lastError?.message ?? '')}`);
      }

      const smf = readSmf(bytes);
      const arrangement = arrangementFromMidi(smf, { name: args?.name, tempo: args?.tempo });
      if (arrangement.tracks.length === 0) throw new Error('MIDI にノートがありませんでした。');
      const score = arrangementToScore(arrangement);

      return {
        name: arrangement.name,
        sourcePath: displayPath(cwd, used),
        tracks: arrangement.tracks.length,
        notes: arrangementNoteCount(arrangement),
        tempo: arrangement.tempo,
        bars: arrangement.bars,
        timeSignature: arrangement.timeSignature,
        format: smf.format,
        ticksPerQuarter: smf.ticksPerQuarter,
        arrangement: {
          name: arrangement.name,
          tempo: arrangement.tempo,
          timeSignature: arrangement.timeSignature,
          bars: arrangement.bars,
          key: arrangement.key,
          tracks: arrangement.tracks.map((track) => ({
            name: track.name,
            instrument: track.instrument,
            drums: track.drum,
            volume: track.volume,
            pan: Math.round(track.pan * 1000) / 1000,
            notes: track.notes.map((note) => ({
              start: note.start,
              duration: note.duration,
              pitches: note.pitches,
              velocity: note.velocity,
            })),
          })),
        },
        score,
        warnings: (arrangement.warnings ?? []).slice(0, 12),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `Import MIDI: ${args?.path ?? ''}`, kind: 'other' };
    },
  };
}

/** この module が登録するツール一式 (テストと登録が共有する)。 */
export function createDawTools(ctx, options, config, helpers) {
  const daw = resolveDawOptions(config, options, helpers);
  return [
    dawArrangeTool(ctx, options, daw, helpers),
    exportDawProjectTool(ctx, options, daw, helpers),
    importMidiTool(ctx, options, daw, helpers),
  ];
}

/**
 * DTM のツールをプラグインコンテキストへ登録する。
 *
 * @param {object} ctx - プラグインコンテキスト (`ctx.effect`, `ctx.tools.register`)。
 * @param {object} options - 解決済みオプション (`outputDir`, `soundfont`, `music`, `video`)。
 * @param {object} config - 行設定の生オブジェクト (`config.daw`)。
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers - `index.js` 所有の小道具。
 * @returns {void}
 */
export function registerDawTools(ctx, options, config, helpers) {
  for (const tool of createDawTools(ctx, options, config, helpers)) {
    ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
  }
}

// #endregion
