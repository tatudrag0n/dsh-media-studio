/**
 * Media Studio — natural-language prompts into music plans.
 *
 * A prompt such as "dark ambient piano in D minor, slow, 8 bars" is turned
 * into a *plan*: the concrete musical decisions the composer needs (style,
 * key, scale, tempo, length, texture, register, energy, instruments, drums).
 * The plan is explicit and inspectable, so the caller can show what was
 * understood before rendering anything.
 *
 * The vocabulary is bilingual: Japanese words are folded into English cues
 * first, then one English lexicon does the matching. Nothing here touches the
 * network, the filesystem or Cordis, so `node --test` can plan a piece on its
 * own.
 */

import { KEY_NAMES, MAX_BARS, SCALES, STYLES } from './music.js';

/** Plans start from these values when the prompt says nothing about them. */
export const PROMPT_DEFAULTS = {
  style: 'pop',
  key: 'C',
  scale: 'major',
  tempo: 100,
  bars: 8,
  energy: 0.6,
  texture: 'legato',
  register: 0,
  drums: false,
};

/** Sample prompts the panel offers as a starting point. */
export const PROMPT_EXAMPLES = [
  'dark ambient piano in D minor, slow, 8 bars',
  'epic cinematic strings with drums, 90 bpm',
  'funky bass groove with guitar and drums',
  '静かな朝の lo-fi ピアノ, 30 秒',
  'happy upbeat synth pop, 124 bpm',
];

/**
 * Japanese words folded into English before matching. Ordered so that longer
 * phrases are replaced before the fragments they contain.
 */
const JAPANESE_SUBSTITUTIONS = [
  // Scales
  [/マイナー/gu, ' minor '],
  [/メジャー/gu, ' major '],
  [/ペンタトニック/gu, ' pentatonic '],
  [/ドリアン/gu, ' dorian '],
  [/ミクソリディアン/gu, ' mixolydian '],
  [/リディアン/gu, ' major '],
  // Moods
  [/切ない/gu, ' sad '],
  [/悲しい/gu, ' sad '],
  [/哀しい/gu, ' sad '],
  [/悲し/gu, ' sad '],
  [/憂鬱/gu, ' sad '],
  [/暗い/gu, ' dark '],
  [/ダーク/gu, ' dark '],
  [/寂しい/gu, ' lonely '],
  [/孤独/gu, ' lonely '],
  [/明るい/gu, ' bright '],
  [/陽気/gu, ' upbeat '],
  [/楽しい/gu, ' happy '],
  [/幸せ/gu, ' happy '],
  [/穏やか/gu, ' calm '],
  [/穏やかな/gu, ' calm '],
  [/静かな/gu, ' calm '],
  [/静か/gu, ' calm '],
  [/平和/gu, ' peaceful '],
  [/勇壮/gu, ' epic '],
  [/壮大な/gu, ' epic '],
  [/英雄/gu, ' epic '],
  [/緊張/gu, ' tense '],
  [/不安/gu, ' tense '],
  [/恋愛/gu, ' romantic '],
  [/恋/gu, ' romantic '],
  [/懐かしい/gu, ' nostalgic '],
  [/懐かし/gu, ' nostalgic '],
  [/神秘/gu, ' mysterious '],
  [/夢幻/gu, ' dreamy '],
  [/夢見/gu, ' dreamy '],
  [/活気/gu, ' energetic '],
  [/活発/gu, ' energetic '],
  [/激烈/gu, ' aggressive '],
  [/攻撃的/gu, ' aggressive '],
  [/希望/gu, ' hopeful '],
  [/応援/gu, ' uplifting '],
  [/いたずら/gu, ' playful '],
  [/のんびり/gu, ' chill '],
  [/ほっと/gu, ' chill '],
  [/怖い/gu, ' scary '],
  [/ホラー/gu, ' scary '],
  [/不気味/gu, ' eerie '],
  [/ミニマル/gu, ' minimal '],
  [/疎/gu, ' sparse '],
  // Texture
  [/アルペジオ/gu, ' arpeggio '],
  [/レガート/gu, ' legato '],
  [/スタッカート/gu, ' staccato '],
  // Genres
  [/シティポップ/gu, ' city pop '],
  [/ポップ/gu, ' pop '],
  [/バラード/gu, ' ballad '],
  [/アンビエント/gu, ' ambient '],
  [/環境音/gu, ' ambient '],
  [/8ビット/gu, ' 8bit '],
  [/チップチューン/gu, ' chiptune '],
  [/ゲーム音楽/gu, ' video game '],
  [/ジャズ/gu, ' jazz '],
  [/ロック/gu, ' rock '],
  [/シネマティック/gu, ' cinematic '],
  [/映画/gu, ' cinematic '],
  [/劇伴/gu, ' soundtrack '],
  [/サントラ/gu, ' soundtrack '],
  [/クラシック/gu, ' classical '],
  [/古典/gu, ' classical '],
  [/オーケストラ/gu, ' orchestral '],
  [/ブルース/gu, ' blues '],
  [/ファンク/gu, ' funk '],
  [/ソウル/gu, ' soul '],
  [/ボスバトル/gu, ' boss battle '],
  [/ボス/gu, ' boss '],
  [/魔王/gu, ' boss '],
  [/ドローン/gu, ' drone '],
  [/瞑想/gu, ' meditation '],
  [/ヨガ/gu, ' meditation '],
  [/眠/gu, ' sleep '],
  [/ローファイ/gu, ' lofi '],
  [/レイヴ/gu, ' edm '],
  [/クラブ/gu, ' edm '],
  // Instruments
  [/ピアノ/gu, ' piano '],
  [/ギター/gu, ' guitar '],
  [/チェロ/gu, ' cello '],
  [/バイオリン/gu, ' violin '],
  [/ヴィオラ/gu, ' viola '],
  [/ストリングス/gu, ' strings '],
  [/オルガン/gu, ' organ '],
  [/シンセ/gu, ' synth '],
  [/シンセサイザー/gu, ' synth '],
  [/パッド/gu, ' pad '],
  [/フルート/gu, ' flute '],
  [/リコーダー/gu, ' recorder '],
  [/クラリネット/gu, ' clarinet '],
  [/サックス/gu, ' sax '],
  [/トランペット/gu, ' trumpet '],
  [/トロンボーン/gu, ' trombone '],
  [/ホルン/gu, ' horn '],
  [/チェレスタ/gu, ' celesta '],
  [/音楽箱/gu, ' music box '],
  [/マリンバ/gu, ' marimba '],
  [/ヴィブラフォーン/gu, ' vibraphone '],
  [/ベル/gu, ' bells '],
  [/ハープ/gu, ' harp '],
  [/ベース/gu, ' bass '],
  [/ドラム/gu, ' drums '],
  [/ティンパニ/gu, ' timpani '],
  [/グロッケンシュpiel/gu, ' glockenspiel '],
  [/カリンバ/gu, ' kalimba '],
  [/合唱/gu, ' choir '],
  [/声/gu, ' choir '],
  // Tempo
  [/ゆっくり/gu, ' slow '],
  [/遅い/gu, ' slow '],
  [/スロー/gu, ' slow '],
  [/速い/gu, ' fast '],
  [/ハイテンポ/gu, ' fast '],
];

/** Genre cues, ordered from the most specific phrase to the most general. */
const STYLE_CUES = [
  { style: 'boss', words: ['boss battle', 'boss fight', 'final boss', 'boss theme', 'boss', 'battle theme', 'combat music'] },
  { style: 'chiptune', words: ['chiptune', '8-bit', '8 bit', '8bit', 'bit chiptune', 'retro game', 'video game', 'game music', 'game soundtrack', 'pixel art'] },
  { style: 'lofi', words: ['lofi', 'lo-fi', 'lo fi', 'chillhop', 'study music', 'study beat', 'beats to study'] },
  { style: 'house', words: ['deep house', 'house music', 'house'] },
  { style: 'techno', words: ['techno', 'drum and bass', 'industrial', 'breakbeat'] },
  { style: 'trance', words: ['trance', 'euphoric trance'] },
  { style: 'jazz', words: ['jazz', 'swing', 'bebop', 'noir jazz', 'jazz piano'] },
  { style: 'rock', words: ['rock', 'metal', 'grunge', 'punk', 'indie rock'] },
  { style: 'cinematic', words: ['cinematic', 'film score', 'movie score', 'trailer', 'soundtrack', 'orchestral', 'epic score'] },
  { style: 'classical', words: ['classical', 'sonata', 'nocturne', 'baroque', 'romantic era', 'chamber music'] },
  { style: 'blues', words: ['blues', 'shuffle', '12 bar'] },
  { style: 'funk', words: ['funk', 'funky', 'groove', 'groovy', 'disco'] },
  { style: 'soul', words: ['soul', 'r&b', 'rnb', 'motown', 'neo soul'] },
  { style: 'drone', words: ['drone', 'soundscape', 'drone music'] },
  { style: 'meditation', words: ['meditation', 'meditative', 'yoga', 'zen', 'mindfulness', 'sleep music', 'sleep'] },
  { style: 'horror', words: ['horror', 'creepy', 'dread', 'sinister', 'spooky'] },
  { style: 'ballad', words: ['ballad', 'love song', 'acoustic ballad', 'slow love song'] },
  { style: 'ambient', words: ['ambient', 'atmospheric', 'background music', 'bgm'] },
  { style: 'edm', words: ['edm', 'electronic dance', 'electro', 'rave', 'club music', 'dance music'] },
  { style: 'pop', words: ['city pop', 'j-pop', 'jpop', 'k-pop', 'pop', 'idol'] },
];

/** Mood cues: how a mood bends the plan. */
const MOOD_CUES = [
  { mood: 'sad', words: ['sad', 'melancholy', 'melancholic', 'sorrow', 'sorrowful', 'heartbroken', 'grief', 'heartbreaking'], scale: 'minor', energy: 0.3, tempoFactor: 0.85, register: -1, texture: 'legato', styles: ['ballad', 'cinematic'] },
  { mood: 'lonely', words: ['lonely', 'isolated', 'empty', 'solitary'], scale: 'minor', energy: 0.25, tempoFactor: 0.8, register: -1, texture: 'legato', styles: ['ambient'] },
  { mood: 'dark', words: ['dark', 'ominous', 'brooding', 'grim', 'bleak'], scale: 'minor', energy: 0.4, tempoFactor: 0.9, register: -1, texture: 'legato', styles: ['cinematic', 'ambient'] },
  { mood: 'scary', words: ['scary', 'eerie', 'creepy', 'frightening', 'horror'], scale: 'minor', energy: 0.35, tempoFactor: 0.85, register: -1, texture: 'legato', styles: ['horror', 'ambient'] },
  { mood: 'mysterious', words: ['mysterious', 'haunting', 'strange', 'enigmatic'], scale: 'minor', energy: 0.35, tempoFactor: 0.85, register: -1, texture: 'legato', styles: ['ambient', 'cinematic'] },
  { mood: 'tense', words: ['tense', 'suspenseful', 'anxious', 'nervous', 'urgent'], scale: 'minor', energy: 0.7, tempoFactor: 1.05, texture: 'staccato', drums: true, styles: ['boss', 'edm'] },
  { mood: 'aggressive', words: ['aggressive', 'angry', 'heavy', 'brutal', 'violent', 'furious'], scale: 'minor', energy: 0.9, tempoFactor: 1.15, register: -1, texture: 'staccato', drums: true, styles: ['rock', 'boss'] },
  { mood: 'energetic', words: ['energetic', 'driving', 'powerful', 'high energy', 'high-energy', 'pumped'], energy: 0.95, tempoFactor: 1.15, texture: 'staccato', drums: true, styles: ['edm', 'rock'] },
  { mood: 'epic', words: ['epic', 'heroic', 'majestic', 'grand', 'triumphant', 'soaring'], energy: 0.8, tempoFactor: 1.0, register: -1, texture: 'legato', drums: true, styles: ['cinematic', 'boss'] },
  { mood: 'upbeat', words: ['upbeat', 'bouncy', 'lively', 'jaunty', 'perky'], scale: 'major', energy: 0.85, tempoFactor: 1.1, texture: 'staccato', drums: true, styles: ['pop'] },
  { mood: 'happy', words: ['happy', 'joyful', 'cheerful', 'glad', 'delightful'], scale: 'major', energy: 0.8, tempoFactor: 1.05, styles: ['pop'] },
  { mood: 'bright', words: ['bright', 'sunny', 'sparkling', 'radiant'], scale: 'major', energy: 0.75, tempoFactor: 1.05, register: 1, styles: ['pop'] },
  { mood: 'playful', words: ['playful', 'quirky', 'silly', 'cheeky', 'fun'], scale: 'major', energy: 0.85, tempoFactor: 1.1, texture: 'staccato', styles: ['pop', 'chiptune'] },
  { mood: 'uplifting', words: ['uplifting', 'inspiring', 'hopeful', 'optimistic', 'encouraging'], scale: 'major', energy: 0.7, tempoFactor: 1.05, styles: ['pop'] },
  { mood: 'romantic', words: ['romantic', 'tender', 'intimate', 'loving', 'yearning'], scale: 'major', energy: 0.45, tempoFactor: 0.9, texture: 'legato', styles: ['ballad'] },
  { mood: 'dreamy', words: ['dreamy', 'ethereal', 'floating', 'hazy', 'weightless'], scale: 'major', energy: 0.4, tempoFactor: 0.9, register: 1, texture: 'legato', styles: ['ambient'] },
  { mood: 'nostalgic', words: ['nostalgic', 'wistful', 'reminiscent', 'retro', 'vintage'], scale: 'major', energy: 0.4, tempoFactor: 0.9, styles: ['lofi'] },
  { mood: 'chill', words: ['chill', 'chilled', 'laid-back', 'laid back', 'mellow', 'easygoing'], energy: 0.4, tempoFactor: 0.85, texture: 'legato', styles: ['lofi'] },
  { mood: 'calm', words: ['calm', 'peaceful', 'relaxed', 'relaxing', 'gentle', 'soothing', 'tranquil', 'quiet', 'soft', 'serene'], energy: 0.3, tempoFactor: 0.8, texture: 'legato', styles: ['ambient', 'meditation'] },
];

/** Tempo cues, from the slowest to the fastest phrase. */
const TEMPO_CUES = [
  { words: ['very slow', 'extremely slow', 'glacial', 'largo'], tempo: 52 },
  { words: ['slow', 'slower', 'adagio', 'drifting'], tempo: 68 },
  { words: ['relaxed tempo', 'laid back tempo'], tempo: 80 },
  { words: ['andante', 'walking pace'], tempo: 88 },
  { words: ['moderate', 'medium tempo', 'mid tempo'], tempo: 100 },
  { words: ['allegro', 'fast', 'quick', 'rapid', 'driving beat'], tempo: 132 },
  { words: ['very fast', 'extremely fast', 'presto'], tempo: 168 },
  { words: ['prestissimo', 'breakneck'], tempo: 190 },
];

/** Texture cues: how the notes are played. */
const TEXTURE_CUES = [
  { texture: 'arp', words: ['arpeggio', 'arpeggiated', 'arpeggios', 'arp'] },
  { texture: 'staccato', words: ['staccato', 'pizzicato', 'plucked', 'stabby'] },
  { texture: 'legato', words: ['legato', 'smooth', 'flowing', 'sustained', 'sustain'] },
];

/** Instrument cues, ordered so the specific phrase wins over the general one. */
const INSTRUMENT_CUES = [
  { words: ['grand piano', 'acoustic piano'], slot: 'lead', gm: 'gm:0' },
  { words: ['electric piano', 'rhodes', 'e-piano', 'wurlitzer'], slot: 'lead', gm: 'gm:4' },
  { words: ['piano'], slot: 'lead', gm: 'gm:0' },
  { words: ['music box', 'musical box'], slot: 'lead', gm: 'gm:10' },
  { words: ['vibraphone', 'vibes'], slot: 'lead', gm: 'gm:11' },
  { words: ['marimba'], slot: 'lead', gm: 'gm:12' },
  { words: ['celesta', 'celeste'], slot: 'lead', gm: 'gm:8' },
  { words: ['glockenspiel'], slot: 'lead', gm: 'gm:9' },
  { words: ['tubular bells', 'bells', 'chimes'], slot: 'lead', gm: 'gm:14' },
  { words: ['pipe organ', 'church organ', 'organ'], slot: 'lead', gm: 'gm:16' },
  { words: ['accordion'], slot: 'lead', gm: 'gm:21' },
  { words: ['harp'], slot: 'lead', gm: 'gm:46' },
  { words: ['timpani'], slot: 'lead', gm: 'gm:47' },
  { words: ['kalimba'], slot: 'lead', gm: 'gm:108' },
  { words: ['sitar'], slot: 'lead', gm: 'gm:104' },
  { words: ['banjo'], slot: 'lead', gm: 'gm:105' },
  { words: ['steel drum', 'steelpan'], slot: 'lead', gm: 'gm:115' },
  { words: ['flute'], slot: 'lead', gm: 'gm:73' },
  { words: ['recorder'], slot: 'lead', gm: 'gm:74' },
  { words: ['clarinet'], slot: 'lead', gm: 'gm:71' },
  { words: ['oboe'], slot: 'lead', gm: 'gm:68' },
  { words: ['sax', 'saxophone'], slot: 'lead', gm: 'gm:65' },
  { words: ['trumpet'], slot: 'lead', gm: 'gm:56' },
  { words: ['trombone'], slot: 'lead', gm: 'gm:57' },
  { words: ['french horn', 'horn'], slot: 'lead', gm: 'gm:60' },
  { words: ['violin'], slot: 'lead', gm: 'gm:40' },
  { words: ['viola'], slot: 'lead', gm: 'gm:41' },
  { words: ['cello'], slot: 'lead', gm: 'gm:42' },
  { words: ['distorted guitar', 'overdriven guitar', 'heavy guitar'], slot: 'lead', gm: 'gm:30' },
  { words: ['electric guitar', 'clean guitar'], slot: 'lead', gm: 'gm:27' },
  { words: ['guitar'], slot: 'lead', gm: 'gm:24' },
  { words: ['synth lead', 'lead synth', 'saw lead'], slot: 'lead', gm: 'gm:80' },
  { words: ['synth', 'synthesizer', 'synthesiser', 'electronic'], slot: 'lead', gm: 'gm:80' },
  { words: ['strings', 'string ensemble', 'orchestra', 'orchestral', 'violins'], slot: 'harmony', gm: 'gm:48' },
  { words: ['synth pad', 'pad', 'ambient pad'], slot: 'harmony', gm: 'gm:89' },
  { words: ['choir', 'voices', 'vocal pad', 'humming', 'chant'], slot: 'harmony', gm: 'gm:52' },
  { words: ['brass', 'brass section'], slot: 'harmony', gm: 'gm:61' },
  { words: ['synth bass', 'sub bass', '808', 'subbass'], slot: 'bass', gm: 'gm:38' },
  { words: ['upright bass', 'double bass', 'acoustic bass'], slot: 'bass', gm: 'gm:32' },
  { words: ['bass', 'bass guitar'], slot: 'bass', gm: 'gm:33' },
  { words: ['drum kit', 'drumkit', 'drum set', 'drums', 'drum', 'percussion', 'beat'], slot: 'drums', gm: 'gm:128:0' },
];

/** Scale names the composer understands, with the nearest fallback. */
const SCALE_ALIASES = {
  major: 'major',
  minor: 'minor',
  pentatonic: 'pentatonic',
  dorian: 'dorian',
  mixolydian: 'mixolydian',
  lydian: 'major',
  phrygian: 'minor',
  'harmonic minor': 'minor',
  'melodic minor': 'minor',
  'major pentatonic': 'pentatonic',
  'minor pentatonic': 'pentatonic',
};

/** Cached word-boundary patterns, one per cue word. */
const PATTERN_CACHE = new Map();

/** A pattern that matches `word` as a whole word inside ASCII text. */
function wordPattern(word) {
  const cached = PATTERN_CACHE.get(word);
  if (cached !== undefined) return cached;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'iu');
  PATTERN_CACHE.set(word, pattern);
  return pattern;
}

/** True when `word` appears in `text` as a whole word. */
function hasWord(text, word) {
  return wordPattern(word).test(text);
}

/** Fold Japanese words into English cues and normalise the rest. */
export function normalizePrompt(value) {
  let text = typeof value === 'string' ? value : '';
  text = text.normalize('NFKC');
  text = text.replace(/♯/gu, '#').replace(/♭/gu, 'b');
  text = text.toLowerCase();
  for (const [pattern, replacement] of JAPANESE_SUBSTITUTIONS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/gu, ' ').trim();
}

/** The first cue in `cues` whose word appears in `text`. */
function firstCue(text, cues) {
  for (const cue of cues) {
    for (const word of cue.words) {
      if (hasWord(text, word)) return { cue, word };
    }
  }
  return undefined;
}

/** The key named in the text, with its scale, or undefined. */
function findKey(text) {
  const scalePhrase = text.match(/(^|[^a-z0-9])([a-g])(#|b)?\s*(major|minor|maj|min|dorian|mixolydian|pentatonic|lydian|phrygian)(?![a-z])/u);
  if (scalePhrase !== null) {
    return { key: rootName(scalePhrase[2], scalePhrase[3]), scale: scalePhrase[4] };
  }
  const keyPhrase = text.match(/(?:key|キー|调|調)\s*(?:of|is|を)?\s*([a-g])(#|b)?(?![a-z])/u);
  if (keyPhrase === null) return undefined;
  return { key: rootName(keyPhrase[1], keyPhrase[2]), scale: undefined };
}

/** A key root name such as "C", "F#' or "Bb". Flats are folded to sharps. */
function rootName(letter, accidental) {
  const base = letter.toUpperCase();
  if (accidental === 'b') {
    const flat = { C: 'B', D: 'C#', E: 'D#', G: 'F#', A: 'G#', B: 'A#' }[base];
    return flat ?? base;
  }
  const root = accidental === '#' ? `${base}#` : base;
  return KEY_NAMES.includes(root) ? root : base;
}

/** The scale named in the text, or undefined. */
function findScale(text) {
  const match = text.match(/(^|[^a-z0-9])(major|minor|pentatonic|dorian|mixolydian|lydian|phrygian)(?![a-z])/u);
  if (match === null) return undefined;
  const scale = SCALE_ALIASES[match[2]];
  return scale === undefined ? undefined : scale;
}

/** The tempo in BPM named in the text, or undefined. */
function findTempo(text) {
  const bpm = text.match(/(^|[^0-9])(\d{2,3})\s*(bpm|beats per minute|拍)/u);
  if (bpm !== null) {
    const value = Number(bpm[2]);
    if (Number.isFinite(value) && value > 0) return Math.min(300, Math.round(value));
  }
  return undefined;
}

/** The length in bars named in the text, or undefined. */
function findBars(text) {
  const bars = text.match(/(\d{1,3})\s*(bars?|小節)/u);
  if (bars !== null) {
    const value = Number(bars[1]);
    if (Number.isFinite(value) && value > 0) return Math.min(MAX_BARS, Math.round(value));
  }
  const seconds = text.match(/(\d{1,3})\s*(seconds?|secs?|秒)/u);
  const minutes = text.match(/(\d{1,2})\s*(minutes?|mins?|分)/u);
  let total = undefined;
  if (minutes !== null) total = Number(minutes[1]) * 60;
  else if (seconds !== null) total = Number(seconds[1]);
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  return { seconds: total };
}

/**
 * Turn a free-form prompt into a music plan.
 *
 * `options` supplies the fallbacks: `defaultTempo`, `defaultBars`,
 * `defaultKey`, `defaultScale`, `defaultStyle`, `defaultInstruments`.
 */
export function parseMusicPrompt(prompt, options = {}) {
  const source = typeof prompt === 'string' ? prompt.trim() : '';
  const text = normalizePrompt(source);
  const cues = [];
  const defaults = PROMPT_DEFAULTS;
  const plan = {
    prompt: source,
    style: typeof options.defaultStyle === 'string' && Object.prototype.hasOwnProperty.call(STYLES, options.defaultStyle)
      ? options.defaultStyle
      : defaults.style,
    key: KEY_NAMES.includes(options.defaultKey) ? options.defaultKey : defaults.key,
    scale: Object.prototype.hasOwnProperty.call(SCALES, options.defaultScale) ? options.defaultScale : defaults.scale,
    tempo: Number.isFinite(options.defaultTempo) && options.defaultTempo > 0 ? Math.round(options.defaultTempo) : defaults.tempo,
    bars: Number.isFinite(options.defaultBars) && options.defaultBars > 0 ? Math.min(MAX_BARS, Math.round(options.defaultBars)) : defaults.bars,
    energy: defaults.energy,
    texture: defaults.texture,
    register: defaults.register,
    drums: defaults.drums,
    mood: 'neutral',
    // Left empty when the prompt names no voice, so the style's own
    // instruments (or the caller's defaults) stay in charge.
    instruments: { melody: undefined, harmony: undefined, bass: undefined, ...(options.defaultInstruments ?? {}) },
    cues,
  };

  if (text === '') return plan;

  // A caller-supplied style is a choice, not a default to overwrite.
  const styleFromCaller = typeof options.defaultStyle === 'string'
    && Object.prototype.hasOwnProperty.call(STYLES, options.defaultStyle);

  // Genre: the prompt's own words win over a mood's suggestion.
  const style = firstCue(text, STYLE_CUES);
  if (style !== undefined) {
    plan.style = style.cue.style;
    cues.push(`style:${style.cue.style}`);
  }

  // Mood: the first matching mood bends scale, tempo, energy and texture.
  const mood = firstCue(text, MOOD_CUES);
  if (mood !== undefined) {
    plan.mood = mood.cue.mood;
    cues.push(`mood:${mood.cue.mood}`);
    if (mood.cue.scale !== undefined) plan.scale = mood.cue.scale;
    if (mood.cue.energy !== undefined) plan.energy = mood.cue.energy;
    if (mood.cue.texture !== undefined) plan.texture = mood.cue.texture;
    if (mood.cue.register !== undefined) plan.register = mood.cue.register;
    if (mood.cue.drums === true) plan.drums = true;
    if (mood.cue.tempoFactor !== undefined) plan.tempo = Math.round(plan.tempo * mood.cue.tempoFactor);
    if (style === undefined && !styleFromCaller && Array.isArray(mood.cue.styles) && mood.cue.styles.length > 0) {
      plan.style = mood.cue.styles[0];
      cues.push(`style:${plan.style}`);
    }
  }

  // Tempo: an explicit BPM beats a tempo word, which beats the mood factor.
  const tempoWord = firstCue(text, TEMPO_CUES);
  if (tempoWord !== undefined) {
    plan.tempo = tempoWord.cue.tempo;
    cues.push(`tempo:${plan.tempo}`);
  }
  const explicitTempo = findTempo(text);
  if (explicitTempo !== undefined) {
    plan.tempo = explicitTempo;
    cues.push(`tempo:${explicitTempo}`);
  }

  // Key and scale.
  const key = findKey(text);
  if (key !== undefined) {
    plan.key = key.key;
    cues.push(`key:${key.key}`);
  }
  const scale = findScale(text);
  if (scale !== undefined) {
    plan.scale = scale;
    cues.push(`scale:${scale}`);
  }

  // Length.
  const bars = findBars(text);
  if (bars !== undefined) {
    if (bars.seconds === undefined) {
      plan.bars = bars;
      cues.push(`bars:${plan.bars}`);
    } else {
      const computed = Math.round((bars.seconds * plan.tempo) / 240);
      plan.bars = Math.min(MAX_BARS, Math.max(1, computed));
      cues.push(`length:${bars.seconds}s`);
    }
  }

  // Texture.
  const texture = firstCue(text, TEXTURE_CUES);
  if (texture !== undefined) {
    plan.texture = texture.cue.texture;
    cues.push(`texture:${plan.texture}`);
  }

  // Instruments: the first lead voice takes the melody, the next the harmony.
  const found = [];
  for (const cue of INSTRUMENT_CUES) {
    for (const word of cue.words) {
      if (hasWord(text, word)) {
        found.push({ ...cue, word });
        break;
      }
    }
  }
  const lead = found.find((entry) => entry.slot === 'lead');
  const harmony = found.find((entry) => entry.slot === 'harmony');
  const bass = found.find((entry) => entry.slot === 'bass');
  const drums = found.find((entry) => entry.slot === 'drums');
  if (lead !== undefined) {
    plan.instruments.melody = lead.gm;
    cues.push(`melody:${lead.gm}`);
  }
  if (harmony !== undefined) {
    plan.instruments.harmony = harmony.gm;
    cues.push(`harmony:${harmony.gm}`);
    // "cinematic strings" names one voice: it plays the melody as well.
    if (lead === undefined) {
      plan.instruments.melody = harmony.gm;
      cues.push(`melody:${harmony.gm}`);
    }
  } else if (lead !== undefined) {
    // A second lead voice becomes the accompaniment instead of being dropped.
    const second = found.filter((entry) => entry.slot === 'lead')[1];
    if (second !== undefined) {
      plan.instruments.harmony = second.gm;
      cues.push(`harmony:${second.gm}`);
    }
  }
  if (bass !== undefined) {
    plan.instruments.bass = bass.gm;
    cues.push(`bass:${bass.gm}`);
  }
  if (drums !== undefined) {
    plan.drums = true;
    cues.push('drums:on');
  }

  // Sparse and minimal prompts thin the melody out.
  if (hasWord(text, 'sparse') || hasWord(text, 'minimal')) {
    plan.energy = Math.min(plan.energy, 0.3);
    cues.push('energy:sparse');
  }

  plan.tempo = Math.min(300, Math.max(30, Math.round(plan.tempo)));
  plan.bars = Math.min(MAX_BARS, Math.max(1, Math.round(plan.bars)));
  plan.energy = Math.min(1, Math.max(0, plan.energy));
  plan.register = Math.min(2, Math.max(-2, Math.round(plan.register)));
  return plan;
}

/** One-line summary of a plan, for the panel and the tool output. */
export function describePlan(plan) {
  if (plan === null || typeof plan !== 'object') return '';
  const parts = [
    plan.style,
    `${plan.key} ${plan.scale}`,
    `${plan.tempo} BPM`,
    `${plan.bars} bars`,
  ];
  if (plan.mood !== undefined && plan.mood !== 'neutral') parts.push(plan.mood);
  if (plan.texture !== undefined && plan.texture !== 'legato') parts.push(plan.texture);
  if (plan.drums === true) parts.push('drums');
  return parts.filter((part) => part !== undefined && part !== '').join(' / ');
}
