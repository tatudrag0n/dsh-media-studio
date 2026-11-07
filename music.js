/**
 * Music Studio — provider-independent score helpers.
 *
 * Pure module: no Cordis context, no filesystem writes. Owns pitch parsing,
 * score parsing, automatic composition and WAV encoding. SoundFont synthesis
 * itself lives in `soundfont.js`; this module no longer contains an
 * oscillator engine.
 */

/** Sample rate for generated WAV files. */
export const SAMPLE_RATE = 44100;

/** Default tempo in beats per minute. */
export const DEFAULT_TEMPO = 120;

/** Default instrument: a SoundFont (General MIDI) preset. */
export const DEFAULT_INSTRUMENT = 'gm:0';

/**
 * Longest piece the composer builds, in 4/4 bars.
 *
 * 256 bars is about 8.5 minutes at 120 BPM, so a three-minute piece (75 bars
 * at 100 BPM) fits comfortably.
 */
export const MAX_BARS = 256;

/** Note names to semitone offsets within an octave (C = 0). */
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Convert a pitch string such as "C#4" or "Db3" to a MIDI note number, or null. */
export function pitchToMidi(pitch) {
  if (typeof pitch !== 'string') return null;
  const text = pitch.trim().toLowerCase();
  if (text === '' || text === 'rest' || text === 'r' || text === '-') return null;
  const match = text.match(/^([a-g])([#b]?)(-?\d+)$/);
  if (match === null) return null;
  const letter = match[1].toUpperCase();
  const accidental = match[2];
  const octave = Number(match[3]);
  if (!Number.isFinite(octave)) return null;
  let semitone = SEMITONES[letter];
  if (accidental === '#') semitone += 1;
  else if (accidental === 'b') semitone -= 1;
  return semitone + (octave + 1) * 12;
}

/** Convert a pitch string such as "C#4", "Db3", or "rest" to a frequency in Hz. */
export function pitchToFrequency(pitch) {
  const midi = pitchToMidi(pitch);
  return midi === null ? null : 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI notes for a token that may hold a comma-separated chord. */
export function pitchesToMidi(pitch) {
  if (typeof pitch !== 'string') return [];
  const out = [];
  for (const part of pitch.split(/[,;]/u)) {
    const midi = pitchToMidi(part);
    if (midi !== null) out.push(midi);
  }
  return out;
}

/** Parse a score string into an array of { pitch, beats }. Tokens are separated by whitespace; each token is "pitch:beats" (beats defaults to 1). A token may name a chord with commas, e.g. "C4,E4,G4:2". */
export function parseScore(score) {
  if (typeof score !== 'string') return [];
  const tokens = score.trim().split(/\s+/u).filter((token) => token !== '');
  const out = [];
  for (const token of tokens) {
    const index = token.lastIndexOf(':');
    let pitch = token;
    let beats = 1;
    if (index > 0) {
      const parsed = Number(token.slice(index + 1));
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      beats = parsed;
      pitch = token.slice(0, index);
    }
    if (pitch === '') continue;
    out.push({ pitch, beats });
  }
  return out;
}

/** Normalize a notes array into { pitch, beats } entries. */
export function normalizeNotes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') continue;
    const pitch = typeof entry.pitch === 'string' ? entry.pitch : (typeof entry.note === 'string' ? entry.note : '');
    const beats = Number.isFinite(entry.beats) ? entry.beats : (Number.isFinite(entry.duration) ? entry.duration : 1);
    if (beats <= 0) continue;
    out.push({ pitch, beats });
  }
  return out;
}

/** Resolve effective note list from tool args. */
export function resolveNotes(args) {
  if (Array.isArray(args?.notes) && args.notes.length > 0) return normalizeNotes(args.notes);
  if (typeof args?.score === 'string' && args.score.trim() !== '') return parseScore(args.score);
  return [];
}

/** Total beats in a note list. */
export function totalBeats(notes) {
  return notes.reduce((sum, note) => sum + (Number.isFinite(note.beats) ? note.beats : 0), 0);
}

/** Encode a Float32 buffer as a 16-bit PCM WAV. */
export function encodeWav(samples, sampleRate) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Read WAV info. */
export function readWaveInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const channels = view.getUint16(22, true);
  if (sampleRate < 1 || bitsPerSample !== 16 || channels !== 1) return undefined;
  let offset = 12;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') { dataBytes = Math.min(size, bytes.length - offset - 8); break; }
    offset += 8 + size + (size % 2);
  }
  const bytesPerSecond = sampleRate * (bitsPerSample / 8);
  const seconds = bytesPerSecond > 0 && dataBytes > 0 ? dataBytes / bytesPerSecond : 0;
  return { sampleRate, channels, bitsPerSample, seconds };
}

// #region Automatic composition

/** Chromatic pitch classes, indexed by semitone offset from C. */
export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Scale shapes, as semitone offsets from the key root. */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/**
 * Styles: a chord progression as scale degrees, a melody rhythm in beats, and
 * a feel. `instruments` are the default voices of the style; `drums` names a
 * drum pattern; `register` shifts the melody inside the grid.
 */
export const STYLES = {
  pop: { progression: [0, 4, 5, 3], rhythm: [0, 1, 2, 3], chordSustain: true, instruments: { melody: 'gm:0', harmony: 'gm:48', bass: 'gm:33' } },
  ballad: { progression: [0, 5, 3, 4], rhythm: [0, 2], sustained: true, instruments: { melody: 'gm:0', harmony: 'gm:48', bass: 'gm:33' } },
  chiptune: { progression: [0, 3, 4, 0], rhythm: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], instruments: { melody: 'gm:0', harmony: 'gm:48', bass: 'gm:33' } },
  ambient: { progression: [0, 1, 3, 4], rhythm: [0, 2], sustained: true, chordBars: 2, instruments: { melody: 'gm:0', harmony: 'gm:48', bass: 'gm:33' } },
  edm: { progression: [5, 3, 0, 4], rhythm: [0, 1, 1.5, 2, 3, 3.5], instruments: { melody: 'gm:0', harmony: 'gm:48', bass: 'gm:33' } },
  jazz: { progression: [1, 4, 0, 0], rhythm: [0, 1, 2, 2.5, 3], swing: true, instruments: { melody: 'gm:56', harmony: 'gm:0', bass: 'gm:32' } },
  rock: { progression: [0, 5, 3, 4], rhythm: [0, 1, 2, 3], drums: 'rock', instruments: { melody: 'gm:30', harmony: 'gm:27', bass: 'gm:33' } },
  cinematic: { progression: [0, 5, 3, 4], rhythm: [0, 2], sustained: true, chordBars: 2, register: -1, instruments: { melody: 'gm:48', harmony: 'gm:89', bass: 'gm:33' } },
  lofi: { progression: [0, 3, 4, 0], rhythm: [0, 1.5, 2.5, 3], sustained: true, instruments: { melody: 'gm:4', harmony: 'gm:48', bass: 'gm:32' } },
  house: { progression: [0, 4, 5, 3], rhythm: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], drums: 'four', instruments: { melody: 'gm:80', harmony: 'gm:88', bass: 'gm:38' } },
  techno: { progression: [0, 0, 3, 4], rhythm: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], drums: 'four', instruments: { melody: 'gm:81', harmony: 'gm:89', bass: 'gm:38' } },
  trance: { progression: [0, 4, 5, 3], rhythm: [0, 1, 1.5, 2, 3, 3.5], drums: 'four', instruments: { melody: 'gm:81', harmony: 'gm:89', bass: 'gm:38' } },
  classical: { progression: [0, 4, 5, 3], rhythm: [0, 2], sustained: true, instruments: { melody: 'gm:40', harmony: 'gm:48', bass: 'gm:33' } },
  blues: { progression: [0, 0, 3, 4], rhythm: [0, 1, 2, 3], swing: true, instruments: { melody: 'gm:27', harmony: 'gm:48', bass: 'gm:32' } },
  funk: { progression: [0, 0, 3, 4], rhythm: [0, 0.5, 1, 2, 2.5, 3], drums: 'funk', instruments: { melody: 'gm:26', harmony: 'gm:48', bass: 'gm:35' } },
  soul: { progression: [0, 4, 5, 3], rhythm: [0, 1, 1.5, 2, 3], sustained: true, instruments: { melody: 'gm:4', harmony: 'gm:48', bass: 'gm:33' } },
  boss: { progression: [0, 3, 4, 0], rhythm: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], drums: 'rock', sustained: true, instruments: { melody: 'gm:56', harmony: 'gm:48', bass: 'gm:33' } },
  drone: { progression: [0, 0, 0, 0], rhythm: [0, 4], sustained: true, chordBars: 4, instruments: { melody: 'gm:48', harmony: 'gm:89', bass: 'gm:33' } },
  meditation: { progression: [0, 3, 4, 0], rhythm: [0, 2], sustained: true, chordBars: 2, instruments: { melody: 'gm:73', harmony: 'gm:48', bass: 'gm:33' } },
  horror: { progression: [0, 1, 0, 3], rhythm: [0, 2], sustained: true, chordBars: 2, register: -1, instruments: { melody: 'gm:48', harmony: 'gm:89', bass: 'gm:33' } },
};

/** Drum patterns: kick, snare and closed-hat positions inside one 4/4 bar. */
const DRUM_PATTERNS = {
  four: { kick: [0, 1, 2, 3], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  rock: { kick: [0, 2, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  funk: { kick: [0, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  basic: { kick: [0, 2], snare: [1, 3], hat: [0, 1, 2, 3] },
};

/** GM percussion pitches: kick, snare and closed hi-hat. */
const DRUM_PITCHES = { kick: 'C2', snare: 'D2', hat: 'F#2' };

/**
 * Triad on a scale degree, as semitone offsets from the key root. Stacking
 * scale degrees (instead of fixed intervals) keeps the chord quality correct
 * in every scale, so a minor key really gets minor triads.
 */
function triadFor(scaleSteps, degree) {
  const span = scaleSteps.length;
  const offsets = [];
  for (const step of [degree, degree + 2, degree + 4]) {
    const wrapped = ((step % span) + span) % span;
    offsets.push(scaleSteps[wrapped] + Math.floor(step / span) * 12);
  }
  return offsets;
}

/** Deterministic PRNG (mulberry32): one seed always yields one piece. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable positive integer for any seed value. */
function seedToInt(seed) {
  if (Number.isFinite(seed)) return Math.abs(Math.trunc(seed)) || 1;
  const text = typeof seed === 'string' ? seed : String(seed ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/** MIDI number to a pitch name such as "C4". */
export function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return `${KEY_NAMES[pc]}${Math.floor(midi / 12) - 1}`;
}

/** Fold a MIDI note into [low, high] by octaves, or null when it cannot fit. */
function foldMidi(midi, low, high) {
  let value = midi;
  while (value > high) value -= 12;
  while (value < low) value += 12;
  return value >= low && value <= high ? value : null;
}

/** Clamp a numeric option into [min, max], falling back when it is not a number. */
function clampRange(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** True when `beat` matches one of the style's onset beats. */
function isOnset(rhythm, beat) {
  return rhythm.some((onset) => Math.abs(onset - beat) < 1e-6);
}

/** The scale degree closest to `degree` whose pitch class belongs to the chord. */
function nearestChordDegree(scaleSteps, rootPc, chordPitchClasses, degree) {
  const span = scaleSteps.length;
  let best = degree;
  let bestDistance = Infinity;
  for (let index = 0; index < span; index += 1) {
    const pc = ((rootPc + scaleSteps[index]) % 12 + 12) % 12;
    if (!chordPitchClasses.has(pc)) continue;
    const distance = Math.abs(index - (((degree % span) + span) % span));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * Compose a piece as a step grid: one entry per step, each an array of the
 * pitch names sounding together. The lowest octave of `rangeBase` holds the
 * bass and chords; the octave above holds the melody, so the result always
 * fits the panel's two-octave grid.
 *
 * Beyond the classic style/key/scale/bars options the composer understands
 * four expressive knobs, all optional:
 *
 *   - `energy`   0–1, how many onsets become notes (default: every onset);
 *   - `texture`  'legato' (held), 'staccato' (short notes) or 'arp' (the
 *                harmony track arpeggiates the chord instead of holding it);
 *   - `register` -1/0/+1, the octave the melody sits in;
 *   - `drums`    add a GM percussion track.
 */
export function composeMusic(options = {}) {
  const styleName = Object.prototype.hasOwnProperty.call(STYLES, options.style) ? options.style : 'pop';
  const style = STYLES[styleName];
  const scaleName = Object.prototype.hasOwnProperty.call(SCALES, options.scale) ? options.scale : 'major';
  const scaleSteps = SCALES[scaleName];
  const keyName = KEY_NAMES.includes(options.key) ? options.key : 'C';
  const rootPc = KEY_NAMES.indexOf(keyName);
  const bars = clampRange(options.bars, 1, MAX_BARS, 4);
  const stepsPerBar = clampRange(options.stepsPerBar, 4, 16, 8);
  const rangeBase = clampRange(options.rangeBase, 1, 6, 3);
  const seed = seedToInt(options.seed ?? 1);
  const random = mulberry32(seed);

  const energy = Number.isFinite(options.energy) ? Math.min(1, Math.max(0, options.energy)) : undefined;
  const texture = typeof options.texture === 'string' ? options.texture : undefined;
  const register = Number.isFinite(options.register)
    ? Math.min(1, Math.max(-1, Math.round(options.register)))
    : (Number.isFinite(style.register) ? style.register : 0);
  const withDrums = options.drums === true || (options.drums === undefined && typeof style.drums === 'string');
  const drumPattern = DRUM_PATTERNS[style.drums] ?? DRUM_PATTERNS.basic;

  const lowMidi = (rangeBase + 1) * 12;
  const topMidi = lowMidi + 23;
  const stepsPerBeat = stepsPerBar / 4;
  const stepBeats = 4 / stepsPerBar;
  const chordBars = Number.isFinite(style.chordBars) ? style.chordBars : 1;
  const chordPitchClasses = new Set();
  const total = bars * stepsPerBar;
  const steps = [];
  const melodySteps = [];
  const harmonySteps = [];
  const bassSteps = [];
  const drumSteps = [];
  const drumNotes = [];
  let melody = null;
  let melodyUntil = Number.POSITIVE_INFINITY;
  let degree = 0;
  let arpIndex = 0;

  // The melody stays inside the grid; the register picks which octave of it.
  const melodyLow = register < 0 ? lowMidi + 12 : lowMidi + 12;
  const melodyHigh = register > 0 ? topMidi : (register < 0 ? lowMidi + 23 : topMidi);

  for (let index = 0; index < total; index += 1) {
    const bar = Math.floor(index / stepsPerBar);
    const beat = (index % stepsPerBar) / stepsPerBeat;
    const onBeat = Math.abs(beat - Math.round(beat)) < 1e-6;
    const degreeIndex = style.progression[Math.floor(bar / chordBars) % style.progression.length] ?? 0;
    const chord = triadFor(scaleSteps, degreeIndex);
    chordPitchClasses.clear();
    for (const offset of chord) chordPitchClasses.add(((rootPc + offset) % 12 + 12) % 12);

    const melodyColumn = [];
    const harmonyColumn = [];
    const bassColumn = [];

    if (isOnset(style.rhythm, beat)) {
      const accepted = energy === undefined ? true : random() <= energy;
      if (accepted) {
        degree += random() < 0.5 ? 1 : -1;
        if (onBeat && random() < 0.5) degree = nearestChordDegree(scaleSteps, rootPc, chordPitchClasses, degree);
        const span = scaleSteps.length;
        const wrapped = ((degree % span) + span) % span;
        const octaveShift = Math.floor(degree / span);
        const candidate = lowMidi + 12 + rootPc + scaleSteps[wrapped] + octaveShift * 12;
        melody = foldMidi(candidate, melodyLow, melodyHigh);
        melodyUntil = texture === 'staccato' ? index + 1 : Number.POSITIVE_INFINITY;
      }
    }
    if (melody !== null && index < melodyUntil) melodyColumn.push(melody);

    const chordPitches = [];
    for (const offset of chord) {
      const note = foldMidi(lowMidi + rootPc + offset, lowMidi, topMidi);
      if (note !== null) chordPitches.push(note);
    }
    if (texture === 'arp') {
      if (chordPitches.length > 0) {
        const ascending = [...chordPitches].sort((left, right) => left - right);
        harmonyColumn.push(ascending[arpIndex % ascending.length]);
        arpIndex += 1;
      }
    } else if (style.sustained === true || style.chordSustain === true || onBeat) {
      for (const note of chordPitches) harmonyColumn.push(note);
    }
    if (style.sustained === true || style.chordSustain === true || onBeat) {
      // Keep the bass in the lowest octave of the grid, whatever the degree.
      const bass = foldMidi(lowMidi + rootPc + chord[0], lowMidi, lowMidi + 11);
      if (bass !== null) bassColumn.push(bass);
    }

    melodySteps.push(namesFor(melodyColumn));
    harmonySteps.push(namesFor(harmonyColumn));
    bassSteps.push(namesFor(bassColumn));

    if (withDrums) {
      const drumColumn = [];
      if (drumPattern.kick.includes(beat)) drumColumn.push(DRUM_PITCHES.kick);
      if (drumPattern.snare.includes(beat)) drumColumn.push(DRUM_PITCHES.snare);
      if (drumPattern.hat.includes(beat)) drumColumn.push(DRUM_PITCHES.hat);
      drumSteps.push(drumColumn);
      // Percussion is re-triggered on every hit, so the notes stay separate
      // instead of merging into one long note the way pitched tracks do.
      if (drumColumn.length > 0) {
        drumNotes.push({ pitches: drumColumn, start: Math.round(index * stepBeats * 1000) / 1000, duration: stepBeats });
      }
    }

    steps.push(namesFor([...melodyColumn, ...harmonyColumn, ...bassColumn]));
  }

  const instruments = {
    melody: instrumentName(options.instruments?.melody, style.instruments?.melody ?? 'gm:0'),
    harmony: instrumentName(options.instruments?.harmony, style.instruments?.harmony ?? 'gm:48'),
    bass: instrumentName(options.instruments?.bass, style.instruments?.bass ?? 'gm:33'),
  };
  const tracks = [
    { name: 'melody', instrument: instruments.melody, steps: melodySteps },
    { name: 'harmony', instrument: instruments.harmony, steps: harmonySteps },
    { name: 'bass', instrument: instruments.bass, steps: bassSteps },
  ];
  if (withDrums) {
    tracks.push({ name: 'drums', instrument: 'gm:128:0', steps: drumSteps, notes: drumNotes });
  }

  return { style: styleName, key: keyName, scale: scaleName, bars, stepsPerBar, rangeBase, seed, steps, tracks };
}

/** Instrument name for a track, falling back when the caller names none. */
function instrumentName(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Sorted, de-duplicated pitch names for one column (highest first). */
function namesFor(midis) {
  return [...new Set(midis.map(midiToName))]
    .sort((left, right) => (pitchToFrequency(right) ?? 0) - (pitchToFrequency(left) ?? 0));
}

/** Compress a step grid into a "pitch,beats" score, merging held steps. */
export function stepsToScore(steps, stepBeats) {
  if (!Array.isArray(steps)) return '';
  const groups = [];
  for (const entry of steps) {
    const key = Array.isArray(entry) ? entry.join(',') : '';
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.count += 1;
    else groups.push({ key, count: 1 });
  }
  return groups
    .map((group) => `${group.key === '' ? 'rest' : group.key}:${Math.round(group.count * stepBeats * 1000) / 1000}`)
    .join(' ');
}

// #endregion

