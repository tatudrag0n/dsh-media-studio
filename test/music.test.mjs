import assert from 'node:assert/strict';
import test from 'node:test';

import { composeMusic, encodeWav, midiToName, parseScore, pitchToFrequency, resolveNotes, stepsToScore } from '../music.js';

test('pitchToFrequency computes A4 = 440', () => {
  assert.ok(Math.abs(pitchToFrequency('A4') - 440) < 0.001);
  assert.equal(pitchToFrequency('rest'), null);
  assert.equal(pitchToFrequency('r'), null);
});

test('parseScore parses pitch:beats tokens', () => {
  assert.deepEqual(parseScore('C4:1 D4:1 E4:2 rest:1'), [
    { pitch: 'C4', beats: 1 },
    { pitch: 'D4', beats: 1 },
    { pitch: 'E4', beats: 2 },
    { pitch: 'rest', beats: 1 },
  ]);
});

test('parseScore keeps comma-separated chords inside one token', () => {
  assert.deepEqual(parseScore('C4,E4,G4:2 A3:4'), [
    { pitch: 'C4,E4,G4', beats: 2 },
    { pitch: 'A3', beats: 4 },
  ]);
});

test('resolveNotes prefers the notes array over the score string', () => {
  assert.deepEqual(resolveNotes({ notes: [{ pitch: 'C4', beats: 2 }], score: 'D4:1' }), [{ pitch: 'C4', beats: 2 }]);
  assert.deepEqual(resolveNotes({ score: 'D4:1' }), [{ pitch: 'D4', beats: 1 }]);
});

test('encodeWav writes little-endian 16-bit PCM', () => {
  const samples = new Float32Array(100).fill(0);
  const bytes = encodeWav(samples, 16000);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 200);
});

test('composeMusic is deterministic per seed and stays inside the grid', () => {
  const options = { style: 'pop', key: 'C', scale: 'major', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 5 };
  const first = composeMusic(options);
  const again = composeMusic(options);
  assert.equal(first.steps.length, 16);
  assert.deepEqual(first.steps, again.steps);
  assert.notDeepEqual(composeMusic({ ...options, seed: 6 }).steps, first.steps);

  const lowMidi = (3 + 1) * 12;
  const allowed = new Set(Array.from({ length: 24 }, (_, index) => midiToName(lowMidi + index)));
  let sounding = 0;
  for (const column of first.steps) {
    if (column.length > 0) sounding += 1;
    for (const pitch of column) assert.ok(allowed.has(pitch), `${pitch} must fit the grid`);
  }
  assert.ok(sounding > 0);
});

test('composeMusic honors style, key, scale and bars', () => {
  const piece = composeMusic({ style: 'ambient', key: 'D', scale: 'minor', bars: 3, stepsPerBar: 4, rangeBase: 4, seed: 2 });
  assert.equal(piece.style, 'ambient');
  assert.equal(piece.key, 'D');
  assert.equal(piece.scale, 'minor');
  assert.equal(piece.bars, 3);
  assert.equal(piece.steps.length, 12);
});

test('stepsToScore merges held steps into one longer note', () => {
  assert.equal(stepsToScore([['C4'], ['C4'], [], []], 0.5), 'C4:1 rest:1');
  assert.equal(stepsToScore([['E4,C4'], ['C4']], 1), 'E4,C4:1 C4:1');
  assert.equal(stepsToScore([], 1), '');
});

test('composeMusic builds chords from the scale and keeps the bass low', () => {
  const piece = composeMusic({
    style: 'ballad',
    key: 'A',
    scale: 'minor',
    bars: 2,
    stepsPerBar: 8,
    rangeBase: 3,
    seed: 9,
  });
  const [, harmony, bass] = piece.tracks;

  // A minor tonic triad on beat 1: A3, C4, E4 — never the major third C#4.
  const tonic = harmony.steps[0];
  assert.ok(tonic.includes('A3'), `tonic was ${tonic.join(',')}`);
  assert.ok(tonic.includes('C4'));
  assert.ok(tonic.includes('E4'));
  assert.ok(!tonic.includes('C#4'), 'a minor key must not produce a major third');

  // The bass follows the chord root and stays in the grid's lowest octave:
  // bar 1 is A minor (A3), bar 2 is the sixth degree, F major (F3).
  assert.deepEqual(bass.steps[0], ['A3']);
  assert.deepEqual(bass.steps[8], ['F3']);
});

test('composeMusic returns one step grid per track', () => {
  const piece = composeMusic({
    style: 'pop',
    key: 'C',
    scale: 'major',
    bars: 2,
    stepsPerBar: 8,
    rangeBase: 3,
    seed: 5,
    instruments: { melody: 'gm:40', harmony: 'gm:0', bass: 'gm:33' },
  });
  assert.deepEqual(piece.tracks.map((track) => track.name), ['melody', 'harmony', 'bass']);
  assert.deepEqual(piece.tracks.map((track) => track.instrument), ['gm:40', 'gm:0', 'gm:33']);
  for (const track of piece.tracks) assert.equal(track.steps.length, 16);
  for (let col = 0; col < 16; col += 1) {
    const merged = new Set(piece.steps[col]);
    for (const track of piece.tracks) {
      for (const pitch of track.steps[col]) assert.ok(merged.has(pitch), `${pitch} missing from the merged view`);
    }
  }
});
