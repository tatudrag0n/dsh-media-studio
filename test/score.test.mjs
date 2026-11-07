import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatScoreText,
  notesToSteps,
  parseScoreText,
  pieceLengthBeats,
  pieceNoteCount,
  sanitizePiece,
  sequentialToNotes,
  stepsToNotes,
} from '../score.js';

const SAMPLE = [
  '# Media Studio score v1',
  'title Demo',
  'tempo 96',
  '',
  'track melody',
  'instrument gm:40',
  'C4 0 1',
  'D#4 1 0.5',
  'E4 1.5 0.5   # comment after a note',
  '',
  'track harmony instrument=piano',
  'C4,E4,G4 0 2',
  'rest 2 2',
].join('\n');

test('parseScoreText reads directives, tracks and notes', () => {
  const piece = parseScoreText(SAMPLE);
  assert.equal(piece.tempo, 96);
  assert.equal(piece.title, 'Demo');
  assert.deepEqual(piece.warnings, []);
  assert.equal(piece.tracks.length, 2);

  const [melody, harmony] = piece.tracks;
  assert.equal(melody.name, 'melody');
  assert.equal(melody.instrument, 'gm:40');
  assert.deepEqual(melody.notes, [
    { pitches: ['C4'], start: 0, duration: 1 },
    { pitches: ['D#4'], start: 1, duration: 0.5 },
    { pitches: ['E4'], start: 1.5, duration: 0.5 },
  ]);
  assert.equal(harmony.name, 'harmony');
  assert.equal(harmony.instrument, 'piano');
  assert.deepEqual(harmony.notes, [{ pitches: ['C4', 'E4', 'G4'], start: 0, duration: 2 }]);
  assert.equal(pieceLengthBeats(piece), 2);
  assert.equal(pieceNoteCount(piece), 4);
});

test('a # inside a pitch name is not a comment', () => {
  const piece = parseScoreText('track lead\nC#4 0 1\nF#3 1 1\n');
  assert.equal(piece.warnings.length, 0);
  assert.deepEqual(piece.tracks[0].notes.map((note) => note.pitches[0]), ['C#4', 'F#3']);
});

test('unparsable lines become warnings instead of errors', () => {
  const piece = parseScoreText('tempo nope\nC4 0 1\nnonsense line\ninstrument\n');
  assert.equal(piece.tracks.length, 0);
  assert.ok(piece.warnings.length >= 2);
  assert.match(piece.warnings.join('\n'), /track の外/);
});

test('formatScoreText round-trips through parseScoreText', () => {
  const piece = {
    tempo: 90,
    title: 'Round Trip',
    tracks: [
      { name: 'melody', instrument: 'gm:40', notes: [
        { pitches: ['C4'], start: 0, duration: 1 },
        { pitches: ['E4'], start: 1, duration: 2 },
      ] },
      { name: 'bass', instrument: 'bass', notes: [{ pitches: ['C2'], start: 0, duration: 3 }] },
    ],
  };
  const text = formatScoreText(piece);
  assert.match(text, /tempo 90/);
  const back = parseScoreText(text);
  assert.equal(back.tempo, 90);
  assert.equal(back.title, 'Round Trip');
  assert.equal(back.tracks.length, 2);
  assert.deepEqual(back.tracks[0].notes, piece.tracks[0].notes);
  assert.deepEqual(back.tracks[1].notes, piece.tracks[1].notes);
});

test('chords sharing a start and duration share one text line', () => {
  const text = formatScoreText({
    tempo: 120,
    tracks: [{ name: 'harmony', instrument: 'pad', notes: [
      { pitches: ['E4'], start: 0, duration: 2 },
      { pitches: ['C4'], start: 0, duration: 2 },
      { pitches: ['G4'], start: 0, duration: 2 },
    ] }],
  });
  assert.match(text, /E4,C4,G4 0 2/);
});

test('stepsToNotes merges held steps and notesToSteps projects them back', () => {
  const steps = [['C4'], ['C4'], [], ['E4']];
  const notes = stepsToNotes(steps, 1);
  assert.deepEqual(notes, [
    { pitches: ['C4'], start: 0, duration: 2 },
    { pitches: ['E4'], start: 3, duration: 1 },
  ]);
  assert.deepEqual(notesToSteps(notes, 1, 4), [['C4'], ['C4'], [], ['E4']]);
});

test('sanitizePiece normalizes client-supplied tracks', () => {
  const piece = sanitizePiece({
    tempo: 90,
    tracks: [
      { name: 'm', instrument: 'gm:40', notes: [{ pitch: 'C4', start: 0, beats: 2 }] },
      { instrument: '', notes: [{ pitches: ['C2'], start: 0, duration: 1 }] },
      { name: 'empty', instrument: 'piano', notes: [] },
      { name: 'bad', instrument: 'piano', notes: [{ pitch: 'zzz', start: 0, duration: 1 }] },
    ],
  });
  assert.equal(piece.tempo, 90);
  assert.equal(piece.tracks.length, 2);
  assert.equal(piece.tracks[0].instrument, 'gm:40');
  assert.deepEqual(piece.tracks[0].notes, [{ pitches: ['C4'], start: 0, duration: 2 }]);
  assert.equal(piece.tracks[1].name, 'track 2');
  assert.equal(piece.tracks[1].instrument, 'piano');
});

test('sequentialToNotes converts legacy pitch:beats tokens', () => {
  const notes = sequentialToNotes([
    { pitch: 'C4,E4', beats: 1 },
    { pitch: 'rest', beats: 1 },
    { pitch: 'G4', beats: 2 },
  ]);
  assert.deepEqual(notes, [
    { pitches: ['C4'], start: 0, duration: 1 },
    { pitches: ['E4'], start: 0, duration: 1 },
    { pitches: ['G4'], start: 2, duration: 2 },
  ]);
});
