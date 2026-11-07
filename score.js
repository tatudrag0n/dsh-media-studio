/**
 * Media Studio score text (MSX) — a line-oriented, multi-track score format.
 *
 * The format is deliberately small so that a language model can emit it
 * reliably and a human can read it:
 *
 *     # comment
 *     title My Song
 *     tempo 100
 *
 *     track melody
 *     instrument gm:40
 *     C4 0 1
 *     D4 1 0.5
 *
 *     track harmony instrument=piano
 *     C4,E4,G4 0 2
 *
 * Rules
 *   - Blank lines and `#` comments are ignored.
 *   - `title <text>` and `tempo <bpm>` (or `bpm <bpm>`) are global.
 *   - `track <name>` starts a track; `instrument=<value>` may follow on the
 *     same line or appear on its own line inside the track.
 *   - A note line is `<pitch>[,<pitch>...] <start> <duration>`, in beats
 *     (1 beat = a quarter note). `rest <start> <duration>` is accepted and
 *     ignored, so positions stay absolute and explicit.
 *   - Anything unparsable becomes a warning instead of an error.
 *
 * Pure module: no Cordis context and no filesystem access.
 */

/** Format version, kept in the header comment of generated text. */
export const SCORE_TEXT_VERSION = 1;

/** Default tempo when the text names none. */
export const DEFAULT_SCORE_TEMPO = 120;

/** One pitch name such as C4, F#4, Bb3. */
const PITCH_RE = /^[A-Ga-g](?:#|b)?-?\d+$/u;

/** `track <name> [instrument=<value>]` */
const TRACK_RE = /^track\s+(.+)$/iu;
/** `instrument <value>` / `instrument: <value>` / `instrument=<value>` */
const INSTRUMENT_RE = /^instrument\s*[:=]?\s*(.+)$/iu;
/** `tempo <bpm>` / `bpm: <bpm>` */
const TEMPO_RE = /^(?:tempo|bpm)\s*[:=]?\s*([0-9]*\.?[0-9]+)\s*$/iu;
/** `title <text>` */
const TITLE_RE = /^title\s*[:=]?\s*(.+)$/iu;

/** Round a beat value to three decimals, avoiding float noise. */
export function roundBeats(value) {
  return Math.round(value * 1000) / 1000;
}

/** True when a string is a single valid pitch name. */
export function isPitchName(value) {
  return typeof value === 'string' && PITCH_RE.test(value.trim());
}

/** Split a pitch field such as "C4,E4,G4" into validated pitch names. */
export function splitPitches(field) {
  if (typeof field !== 'string') return [];
  return field
    .split(/[,;]/u)
    .map((part) => part.trim())
    .filter((part) => isPitchName(part));
}

/** Parse score text into `{ tempo, title, tracks, warnings }`. */
export function parseScoreText(text) {
  const warnings = [];
  const piece = { tempo: DEFAULT_SCORE_TEMPO, title: '', tracks: [] };
  if (typeof text !== 'string') return { ...piece, warnings };

  let current = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (line === '') continue;
    const lineNumber = index + 1;

    const trackMatch = line.match(TRACK_RE);
    if (trackMatch !== null) {
      const rest = trackMatch[1].trim();
      const inline = rest.match(/^(.*?)\s+instrument\s*[:=]\s*(.+)$/iu);
      const name = (inline === null ? rest : inline[1]).trim();
      const instrument = inline === null ? '' : inline[2].trim();
      current = { name: name === '' ? `track ${piece.tracks.length + 1}` : name, instrument, notes: [] };
      piece.tracks.push(current);
      continue;
    }

    const instrumentMatch = line.match(INSTRUMENT_RE);
    if (instrumentMatch !== null) {
      if (current === null) warnings.push(`${lineNumber}: instrument が track の外にあります`);
      else current.instrument = instrumentMatch[1].trim();
      continue;
    }

    const tempoMatch = line.match(TEMPO_RE);
    if (tempoMatch !== null) {
      const tempo = Number(tempoMatch[1]);
      if (Number.isFinite(tempo) && tempo > 0) piece.tempo = tempo;
      else warnings.push(`${lineNumber}: tempo が不正です: ${tempoMatch[1]}`);
      continue;
    }

    const titleMatch = line.match(TITLE_RE);
    if (titleMatch !== null) {
      piece.title = titleMatch[1].trim();
      continue;
    }

    const fields = line.split(/\s+/u);
    if (fields.length < 3) {
      warnings.push(`${lineNumber}: 解釈できない行です: ${line}`);
      continue;
    }
    if (current === null) {
      warnings.push(`${lineNumber}: track の外に音符があります`);
      continue;
    }
    const head = fields[0].toLowerCase();
    const start = Number(fields[1]);
    const duration = Number(fields[2]);
    if (head === 'rest' || head === 'r') continue;
    const pitches = splitPitches(fields[0]);
    if (pitches.length === 0) {
      warnings.push(`${lineNumber}: 音名が不正です: ${fields[0]}`);
      continue;
    }
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) {
      warnings.push(`${lineNumber}: 開始位置か長さが不正です: ${line}`);
      continue;
    }
    current.notes.push({ pitches, start: roundBeats(start), duration: roundBeats(duration) });
  }

  for (const track of piece.tracks) {
    if (track.instrument === '') track.instrument = 'piano';
  }
  return { ...piece, warnings };
}

/** Format a piece as score text. Chords sharing a start and duration share one line. */
export function formatScoreText(piece) {
  const tracks = Array.isArray(piece?.tracks) ? piece.tracks : [];
  const tempo = Number.isFinite(piece?.tempo) && piece.tempo > 0 ? piece.tempo : DEFAULT_SCORE_TEMPO;
  const lines = [`# Media Studio score v${SCORE_TEXT_VERSION}`];
  if (typeof piece?.title === 'string' && piece.title.trim() !== '') lines.push(`title ${piece.title.trim()}`);
  lines.push(`tempo ${roundBeats(tempo)}`);
  for (const track of tracks) {
    lines.push('');
    lines.push(`track ${track.name ?? 'track'}`);
    lines.push(`instrument ${track.instrument ?? 'piano'}`);
    for (const line of groupNoteLines(track.notes)) lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

/** One text line per (start, duration) group, chords joined with commas. */
function groupNoteLines(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const groups = new Map();
  for (const note of list) {
    const key = `${roundBeats(note.start)}:${roundBeats(note.duration)}`;
    if (!groups.has(key)) groups.set(key, { start: roundBeats(note.start), duration: roundBeats(note.duration), pitches: [] });
    for (const pitch of note.pitches ?? []) groups.get(key).pitches.push(pitch);
  }
  return [...groups.values()]
    .sort((left, right) => left.start - right.start || left.duration - right.duration)
    .map((group) => `${[...new Set(group.pitches)].join(',')} ${group.start} ${group.duration}`);
}

/** Sanitize a client-supplied piece into the canonical shape. */
export function sanitizePiece(input) {
  const source = input ?? {};
  const tempo = Number.isFinite(source.tempo) && source.tempo > 0 ? roundBeats(source.tempo) : DEFAULT_SCORE_TEMPO;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const tracks = [];
  const rawTracks = Array.isArray(source.tracks) ? source.tracks : [];
  for (let index = 0; index < rawTracks.length; index += 1) {
    const raw = rawTracks[index] ?? {};
    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : `track ${index + 1}`;
    const instrument = typeof raw.instrument === 'string' && raw.instrument.trim() !== '' ? raw.instrument.trim() : 'piano';
    const notes = [];
    for (const rawNote of Array.isArray(raw.notes) ? raw.notes : []) {
      const note = normalizeNote(rawNote);
      if (note !== null) notes.push(note);
    }
    if (notes.length > 0) tracks.push({ name, instrument, notes });
  }
  return { tempo, title, tracks };
}

/** One client note into `{ pitches, start, duration }`, or null. */
function normalizeNote(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const source = Array.isArray(raw.pitches) ? raw.pitches : (typeof raw.pitch === 'string' ? splitPitches(raw.pitch) : []);
  const pitches = source.map((pitch) => String(pitch).trim()).filter((pitch) => isPitchName(pitch));
  if (pitches.length === 0) return null;
  const start = Number.isFinite(raw.start) ? raw.start : 0;
  const duration = Number.isFinite(raw.duration) ? raw.duration : (Number.isFinite(raw.beats) ? raw.beats : 1);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) return null;
  return { pitches, start: roundBeats(start), duration: roundBeats(duration) };
}

/** Convert sequential `{ pitch, beats }` tokens into absolute per-pitch notes. */
export function sequentialToNotes(tokens) {
  const notes = [];
  let cursor = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const beats = Number.isFinite(token?.beats) && token.beats > 0 ? token.beats : 1;
    for (const pitch of splitPitches(token?.pitch)) {
      notes.push({ pitches: [pitch], start: roundBeats(cursor), duration: roundBeats(beats) });
    }
    cursor += beats;
  }
  return notes;
}

/** Convert a per-track step grid into absolute notes, merging held steps. */
export function stepsToNotes(steps, stepBeats) {
  const list = Array.isArray(steps) ? steps : [];
  const open = new Map();
  const notes = [];
  list.forEach((pitches, col) => {
    const present = new Set(Array.isArray(pitches) ? pitches : []);
    for (const [pitch, index] of [...open]) {
      if (present.has(pitch)) continue;
      notes[index].duration = roundBeats(col * stepBeats - notes[index].start);
      open.delete(pitch);
    }
    for (const pitch of present) {
      if (open.has(pitch)) continue;
      notes.push({ pitches: [pitch], start: roundBeats(col * stepBeats), duration: roundBeats(stepBeats) });
      open.set(pitch, notes.length - 1);
    }
  });
  const end = list.length * stepBeats;
  for (const index of open.values()) {
    notes[index].duration = roundBeats(end - notes[index].start);
  }
  return notes.filter((note) => note.duration > 0);
}

/** Project absolute notes onto a step grid of `stepCount` columns. */
export function notesToSteps(notes, stepBeats, stepCount) {
  const steps = Array.from({ length: Math.max(0, stepCount) }, () => []);
  for (const note of Array.isArray(notes) ? notes : []) {
    const startCol = Math.max(0, Math.round(note.start / stepBeats));
    const endCol = Math.max(startCol + 1, Math.round((note.start + note.duration) / stepBeats));
    for (let col = startCol; col < endCol && col < steps.length; col += 1) {
      for (const pitch of note.pitches ?? []) {
        if (!steps[col].includes(pitch)) steps[col].push(pitch);
      }
    }
  }
  return steps;
}

/** Longest end position in beats across every track. */
export function pieceLengthBeats(piece) {
  let end = 0;
  for (const track of piece?.tracks ?? []) {
    for (const note of track.notes ?? []) end = Math.max(end, note.start + note.duration);
  }
  return roundBeats(end);
}

/** Total note count across every track. */
export function pieceNoteCount(piece) {
  let count = 0;
  for (const track of piece?.tracks ?? []) count += Array.isArray(track.notes) ? track.notes.length : 0;
  return count;
}

/** Strip a `#` comment, keeping `#` inside pitch names such as `C#4`. */
function stripComment(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '#') continue;
    if (index === 0 || /\s/u.test(line[index - 1])) return line.slice(0, index);
  }
  return line;
}
