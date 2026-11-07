import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_BARS, composeMusic, midiToName } from '../music.js';
import { describePlan, normalizePrompt, parseMusicPrompt } from '../prompt.js';

test('normalizePrompt folds Japanese words into English cues', () => {
  const text = normalizePrompt('  静かな ピアノ, 30 秒  ');
  assert.equal(text, 'calm piano , 30 秒');
  assert.ok(text.includes('calm'));
});

test('parseMusicPrompt reads genre, key, scale, tempo and length', () => {
  const plan = parseMusicPrompt('dark ambient piano in D minor, slow, 8 bars');
  assert.equal(plan.style, 'ambient');
  assert.equal(plan.key, 'D');
  assert.equal(plan.scale, 'minor');
  assert.equal(plan.tempo, 68);
  assert.equal(plan.bars, 8);
  assert.equal(plan.instruments.melody, 'gm:0');
  assert.ok(plan.cues.includes('style:ambient'));
});

test('parseMusicPrompt lets an explicit BPM win over a tempo word', () => {
  const plan = parseMusicPrompt('epic cinematic strings with drums, 90 bpm');
  assert.equal(plan.style, 'cinematic');
  assert.equal(plan.mood, 'epic');
  assert.equal(plan.tempo, 90);
  assert.equal(plan.drums, true);
  assert.equal(plan.instruments.melody, 'gm:48');
  assert.equal(plan.instruments.harmony, 'gm:48');
});

test('parseMusicPrompt understands a Japanese prompt', () => {
  const plan = parseMusicPrompt('静かな朝の lo-fi ピアノ, 30 秒');
  assert.equal(plan.style, 'lofi');
  assert.equal(plan.mood, 'calm');
  assert.equal(plan.instruments.melody, 'gm:0');
  // 30 seconds at the calm tempo (100 * 0.8 = 80 BPM) is ten 4/4 bars.
  assert.equal(plan.tempo, 80);
  assert.equal(plan.bars, 10);
});

test('parseMusicPrompt reads instruments, drums and textures', () => {
  const plan = parseMusicPrompt('funky bass groove with guitar and drums, arpeggio');
  assert.equal(plan.style, 'funk');
  assert.equal(plan.instruments.bass, 'gm:33');
  assert.equal(plan.instruments.melody, 'gm:24');
  assert.equal(plan.drums, true);
  assert.equal(plan.texture, 'arp');
});

test('parseMusicPrompt keeps a flat key readable as a sharp key', () => {
  const plan = parseMusicPrompt('Bb minor ballad');
  assert.equal(plan.key, 'A#');
  assert.equal(plan.scale, 'minor');
  assert.equal(plan.style, 'ballad');
});

test('parseMusicPrompt falls back to the defaults for an empty prompt', () => {
  const plan = parseMusicPrompt('', { defaultTempo: 120, defaultBars: 4 });
  assert.equal(plan.style, 'pop');
  assert.equal(plan.tempo, 120);
  assert.equal(plan.bars, 4);
  assert.equal(plan.mood, 'neutral');
  assert.deepEqual(plan.cues, []);
});

test('parseMusicPrompt honours the caller defaults', () => {
  const plan = parseMusicPrompt('a calm piece', { defaultStyle: 'jazz', defaultKey: 'F#', defaultScale: 'dorian' });
  assert.equal(plan.style, 'jazz');
  assert.equal(plan.key, 'F#');
  assert.equal(plan.scale, 'dorian');
});

test('describePlan summarises the reading of a prompt', () => {
  const plan = parseMusicPrompt('dark ambient piano in D minor, slow, 8 bars');
  const summary = describePlan(plan);
  assert.ok(summary.includes('ambient'));
  assert.ok(summary.includes('D minor'));
  assert.ok(summary.includes('68 BPM'));
  assert.ok(summary.includes('8 bars'));
});

test('composeMusic keeps its classic output when no new option is given', () => {
  const plain = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 5 });
  assert.deepEqual(plain.tracks.map((track) => track.name), ['melody', 'harmony', 'bass']);
  assert.ok(plain.tracks.every((track) => track.notes === undefined));
});

test('composeMusic adds a percussion track when drums are asked for', () => {
  const piece = composeMusic({ style: 'rock', key: 'E', scale: 'minor', bars: 1, stepsPerBar: 8, rangeBase: 3, seed: 3, drums: true });
  const drums = piece.tracks.find((track) => track.name === 'drums');
  assert.ok(drums !== undefined);
  assert.equal(drums.instrument, 'gm:128:0');
  assert.equal(drums.notes.length, drums.steps.filter((column) => column.length > 0).length);
  // The kick sits on the first beat of the bar.
  assert.ok(drums.steps[0].includes('C2'));
  assert.ok(drums.notes[0].start === 0);
});

test('composeMusic shortens the melody for a staccato texture', () => {
  const legato = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 4 });
  const staccato = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 4, texture: 'staccato' });
  const legatoNotes = legato.tracks[0].steps.flat().length;
  const staccatoNotes = staccato.tracks[0].steps.flat().length;
  assert.ok(staccatoNotes < legatoNotes, `${staccatoNotes} should be fewer than ${legatoNotes}`);
});

test('composeMusic arpeggiates the chord for an arp texture', () => {
  const piece = composeMusic({ style: 'ambient', key: 'C', scale: 'major', bars: 1, stepsPerBar: 8, rangeBase: 3, seed: 2, texture: 'arp' });
  const harmony = piece.tracks[1].steps;
  assert.ok(harmony.every((column) => column.length <= 1), 'an arpeggio plays one note at a time');
  assert.ok(new Set(harmony.map((column) => column.join(','))).size > 1, 'the arpeggio moves');
});

test('composeMusic keeps the melody inside the grid for every register', () => {
  for (const register of [-1, 0, 1]) {
    const piece = composeMusic({ style: 'cinematic', key: 'D', scale: 'minor', bars: 2, stepsPerBar: 8, rangeBase: 3, seed: 6, register });
    const lowMidi = (3 + 1) * 12;
    const allowed = new Set(Array.from({ length: 24 }, (_, index) => midiToName(lowMidi + index)));
    for (const track of piece.tracks) {
      if (track.name === 'drums') continue;
      for (const column of track.steps) {
        for (const pitch of column) assert.ok(allowed.has(pitch), `${pitch} must fit the grid`);
      }
    }
  }
});

test('composeMusic thins the melody out with a low energy', () => {
  const busy = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 4, stepsPerBar: 8, rangeBase: 3, seed: 8, energy: 1 });
  const sparse = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 4, stepsPerBar: 8, rangeBase: 3, seed: 8, energy: 0.1 });
  const count = (piece) => piece.tracks[0].steps.flat().length;
  assert.ok(count(sparse) < count(busy));
});

test('parseMusicPrompt turns a duration in minutes into a bar count', () => {
  const plan = parseMusicPrompt('a piano piece, 3 minutes', { defaultTempo: 100 });
  // Three minutes at 100 BPM is 75 four-four bars.
  assert.equal(plan.tempo, 100);
  assert.equal(plan.bars, 75);
  assert.ok(plan.cues.includes('length:180s'));
});

test('parseMusicPrompt reads a Japanese duration', () => {
  const plan = parseMusicPrompt('ピアノの曲, 3分', { defaultTempo: 100 });
  assert.equal(plan.bars, 75);
});

test('a mood that slows the piece down shortens it with it', () => {
  const plan = parseMusicPrompt('a calm piano piece, 3 minutes', { defaultTempo: 100 });
  // "Calm" halves the tempo to 80 BPM, so three minutes hold fewer bars.
  assert.equal(plan.tempo, 80);
  assert.equal(plan.bars, 60);
});

test('parseMusicPrompt uses the tempo the prompt names for the length', () => {
  const plan = parseMusicPrompt('epic strings, 3 minutes, 120 bpm');
  assert.equal(plan.tempo, 120);
  assert.equal(plan.bars, 90);
});

test('a three-minute prompt is not cut down to a short piece', () => {
  const plan = parseMusicPrompt('epic cinematic strings, 3 minutes, 100 bpm');
  const piece = composeMusic({
    style: plan.style,
    key: plan.key,
    scale: plan.scale,
    bars: plan.bars,
    stepsPerBar: 8,
    rangeBase: 3,
    seed: 4,
  });
  assert.equal(piece.bars, 75);
  assert.equal(piece.tracks[0].steps.length, 75 * 8);
});

test('composeMusic still refuses a piece longer than the limit', () => {
  const piece = composeMusic({ style: 'pop', key: 'C', scale: 'major', bars: 100000, stepsPerBar: 8, rangeBase: 3, seed: 1 });
  assert.equal(piece.bars, MAX_BARS);
});
