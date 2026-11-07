import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  formatGmInstrument,
  parseGmInstrument,
  renderSoundFontScore,
  soundFontAvailable,
  soundFontPresets,
} from '../soundfont.js';

/** The bank fetched into the workspace; SoundFont tests skip without it. */
const SOUNDFONT_PATH = 'C:\\root\\instrument-data\\GeneralUser-GS.sf2';

test('parseGmInstrument accepts gm:<program> and gm:<bank>:<program>', () => {
  assert.deepEqual(parseGmInstrument('gm:0'), { bankMSB: 0, bankLSB: 0, program: 0 });
  assert.deepEqual(parseGmInstrument('gm:11:40'), { bankMSB: 11, bankLSB: 0, program: 40 });
  assert.deepEqual(parseGmInstrument(' GM:127 '), { bankMSB: 0, bankLSB: 0, program: 127 });
  assert.equal(parseGmInstrument('piano'), null);
  assert.equal(parseGmInstrument('gm:128'), null);
  assert.equal(parseGmInstrument('gm:'), null);
  assert.equal(parseGmInstrument(undefined), null);
});

test('formatGmInstrument omits bank 0', () => {
  assert.equal(formatGmInstrument({ bankMSB: 0, program: 4 }), 'gm:4');
  assert.equal(formatGmInstrument({ bankMSB: 12, program: 4 }), 'gm:12:4');
});

test('soundFontAvailable reports a missing file', () => {
  assert.equal(soundFontAvailable('C:\\definitely\\missing.sf2'), false);
  assert.equal(soundFontAvailable(''), false);
  assert.equal(soundFontAvailable(undefined), false);
});

test('the SoundFont renders an audible note', async (t) => {
  if (!existsSync(SOUNDFONT_PATH)) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  const presets = await soundFontPresets(SOUNDFONT_PATH);
  assert.ok(presets.length > 200, 'expected a GM-sized preset list');
  assert.ok(presets.some((preset) => preset.name === 'Grand Piano'));

  const samples = await renderSoundFontScore(SOUNDFONT_PATH, {
    notes: [{ pitch: 'C4', beats: 1 }, { pitch: 'E4,G4', beats: 1 }],
    tempo: 120,
    program: 0,
    bankMSB: 0,
    volume: 0.7,
  });
  assert.ok(samples instanceof Float32Array);
  // 2 beats at 120 BPM is 1s, plus the release tail.
  assert.ok(samples.length > 44100, 'expected at least one second of audio');
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak > 0.01, `expected audible output, peak was ${peak}`);
});
