/**
 * `daw.js` + `midi.js` のテスト。
 *
 * 方針:
 * - バイト列を扱う純関数は、外部バイナリ無しで必ず走らせる。
 * - 音を出すテスト (WAV 生成) は SoundFont が無ければ `t.skip()`。
 *   ただしこのマシンには `C:\root\instrument-data\GeneralUser-GS.sf2` があるので実際に走る。
 * - mp3 / ogg は ffmpeg が無ければ skip。
 * - 書き出したものは、必ず自分で読み戻して一致を確かめる
 *   (SMF は `readSmf`、MusicXML / mmp / h2song は各パーサ)。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DAW_AUDIO_FORMATS,
  DAW_PROJECT_FORMATS,
  addEcho,
  addReverb,
  arrangementFromMidi,
  arrangementNoteCount,
  arrangementSeconds,
  arrangementToScore,
  buildMidiProject,
  checkXmlBalance,
  createDawTools,
  decodeWav,
  encodeWavStereo,
  gmProgramName,
  matchGmProgram,
  normalizeArrangement,
  panGains,
  parseH2Song,
  parseMmp,
  parseMusicXml,
  renderArrangement,
  resolveTrackInstrument,
  serializeH2Song,
  serializeMmp,
  serializeMusicXml,
} from '../daw.js';
import { decodeVlq, encodeVlq, readSmf, writeSmf } from '../midi.js';

/** このマシンの SoundFont。無ければ音を出すテストは skip する。 */
const SOUNDFONT_PATH = 'C:\\root\\instrument-data\\GeneralUser-GS.sf2';
const hasSoundFont = existsSync(SOUNDFONT_PATH);

/** ffmpeg があるか (mp3 / ogg のテストだけが使う)。 */
const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/** 登録されたツールを集める最小のコンテキスト。 */
function fakeCtx() {
  const tools = [];
  const ctx = {
    effect(factory) {
      factory();
      return () => {};
    },
    get() {
      return undefined;
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, tools };
}

/** セッション作業ディレクトリを temp にする helpers。 */
function makeHelpers(directory) {
  return {
    resolveSessionCwd: async () => directory,
    formatBytes: (bytes) => `${bytes} B`,
    safeRelativeDir: (dir) => dir,
  };
}

/** 既定の解決済みオプション。 */
function makeOptions(overrides = {}) {
  return {
    outputDir: 'media-studio',
    soundfont: { path: SOUNDFONT_PATH, gain: 1, releaseSeconds: 1.2 },
    music: { maxSeconds: 600, maxNotes: 20000, defaultInstrument: 'gm:0' },
    video: { ffmpegPath: '' },
    ...overrides,
  };
}

/** テスト用の 2 小節の編曲。 */
function sampleArrangement() {
  return {
    name: 'Test Piece',
    tempo: 120,
    timeSignature: [4, 4],
    bars: 2,
    key: 'C',
    tracks: [
      {
        name: 'lead',
        instrument: 'piano',
        volume: 1,
        pan: -0.5,
        reverb: 0.25,
        notes: [
          { start: 0, duration: 1, pitches: ['C4', 'E4', 'G4'] },
          { start: 1, duration: 1, pitches: ['D4'] },
          { start: 2, duration: 2, pitches: ['E4'] },
        ],
      },
      {
        name: 'bass',
        instrument: 'bass',
        volume: 0.8,
        pan: 0.4,
        notes: [
          { start: 0, duration: 2, pitches: ['C2'] },
          { start: 2, duration: 2, pitches: ['G2'] },
        ],
      },
      {
        name: 'drums',
        drums: true,
        volume: 0.9,
        notes: [
          { start: 0, duration: 0.25, pitches: ['C2'] },
          { start: 1, duration: 0.25, pitches: ['D2'] },
          { start: 2, duration: 0.25, pitches: ['C2'] },
          { start: 3, duration: 0.25, pitches: ['D2'] },
        ],
      },
    ],
  };
}

/** 一時ディレクトリつきでツールを組み立てる。 */
async function makeTools(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'daw-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const { ctx } = fakeCtx();
  const tools = createDawTools(ctx, makeOptions(overrides), { daw: {} }, makeHelpers(directory));
  return { directory, tools, byName: new Map(tools.map((tool) => [tool.name, tool])) };
}

// #region midi.js

test('encodeVlq and decodeVlq round trip the SMF variable-length quantity', () => {
  for (const value of [0, 1, 0x7f, 0x80, 0x2000, 0x3fff, 0x4000, 0x0fffff, 0x0fffffff]) {
    const encoded = encodeVlq(value);
    assert.deepEqual(encoded.slice(0, -1).every((byte) => (byte & 0x80) !== 0), true);
    assert.equal((encoded.at(-1) & 0x80), 0);
    assert.deepEqual(decodeVlq(encoded, 0), { value, offset: encoded.length });
  }
  assert.deepEqual(encodeVlq(0), [0]);
  assert.deepEqual(encodeVlq(0x7f), [0x7f]);
  assert.deepEqual(encodeVlq(0x80), [0x81, 0x00]);
  assert.deepEqual(encodeVlq(0x4000), [0x81, 0x80, 0x00]);
});

test('readSmf accepts running status and velocity-0 note on', () => {
  // MThd + 1 トラック。note on を running status で 2 つ並べている。
  const track = [
    0x00, 0x90, 0x3c, 0x40, // note on C4
    0x60, 0x40, 0x40, // running status: note on E4 (Δ48)
    0x00, 0x3c, 0x00, // running status: note on C4 velocity 0 → note off
    0x60, 0x40, 0x00, // running status: note on E4 velocity 0 → note off
    0x00, 0xff, 0x2f, 0x00,
  ];
  const bytes = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length, ...track,
  ]);
  const smf = readSmf(bytes);
  assert.equal(smf.format, 0);
  assert.equal(smf.ticksPerQuarter, 480);
  assert.equal(smf.tracks.length, 1);
  assert.equal(smf.tracks[0].noteCount, 2);
  assert.deepEqual(smf.tracks[0].notes.map((note) => [note.midi, note.start, note.duration]), [
    [60, 0, 0.2],
    [64, 0.2, 0.2],
  ]);
  assert.deepEqual(smf.warnings, []);
});

test('writeSmf and readSmf round trip a type 1 project with tempo, programs and CC', () => {
  const project = {
    format: 1,
    ticksPerQuarter: 480,
    tempo: 90,
    timeSignature: [3, 4],
    title: 'Round Trip',
    tracks: [
      {
        name: 'keys',
        channel: 0,
        program: 4,
        volume: 88,
        pan: 40,
        notes: [{ start: 0, duration: 1, midi: 60, velocity: 100 }, { start: 1, duration: 0.5, midi: 64, velocity: 70 }],
      },
      { name: 'drums', channel: 9, drum: true, program: 0, notes: [{ start: 0.5, duration: 0.25, midi: 38, velocity: 120 }] },
    ],
  };
  const bytes = writeSmf(project);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'MThd');
  const smf = readSmf(bytes);

  assert.equal(smf.format, 1);
  assert.equal(smf.trackCount, 3); // conductor + 2
  assert.equal(Math.round(smf.tempos[0].bpm), 90);
  assert.deepEqual(smf.timeSignature, [3, 4]);
  assert.equal(smf.title, 'Round Trip');

  const [conductor, keys, drums] = smf.tracks;
  assert.equal(conductor.noteCount, 0);
  assert.equal(keys.name, 'keys');
  assert.equal(keys.program, 4);
  assert.equal(keys.volume, 88);
  assert.equal(keys.pan, 40);
  assert.deepEqual(keys.notes.map((note) => note.midi), [60, 64]);
  assert.equal(drums.drum, true);
  assert.equal(drums.channel, 9);
  assert.equal(drums.noteCount, 1);
  assert.equal(drums.notes[0].start, 0.5);
});

test('readSmf rejects a file that is not SMF and SMPTE division', () => {
  assert.throws(() => readSmf(Buffer.from('not a midi file at all')), /SMF/u);
  const smpte = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x02, 0xe7, 0x28,
  ]);
  assert.throws(() => readSmf(smpte), /SMPTE/u);
});

// #endregion

// #region 正規化と楽器

test('normalizeArrangement resolves GM names, programs, drums and channels', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });

  assert.equal(arrangement.tempo, 120);
  assert.equal(arrangement.bars, 2);
  assert.deepEqual(arrangement.timeSignature, [4, 4]);
  assert.equal(arrangement.tracks.length, 3);
  assert.equal(arrangementNoteCount(arrangement), 3 + 1 + 1 + 2 + 4);

  const [lead, bass, drums] = arrangement.tracks;
  assert.equal(lead.instrument, 'gm:0');
  assert.equal(lead.kind, 'instrument');
  assert.equal(lead.channel, 0);
  assert.equal(bass.instrument, 'gm:33');
  assert.equal(bass.channel, 1);
  assert.equal(drums.kind, 'drums');
  assert.equal(drums.instrument, 'gm:128:0');
  assert.equal(drums.channel, 9);
  assert.equal(lead.reverb, 0.25);
  assert.equal(bass.pan, 0.4);
  assert.deepEqual(drums.notes[0].pitches, ['C2']);
  assert.deepEqual(arrangement.warnings, []);
});

test('matchGmProgram and resolveTrackInstrument understand names and gm: selectors', () => {
  assert.equal(matchGmProgram('strings'), 48);
  assert.equal(matchGmProgram('Strings'), 48);
  assert.equal(matchGmProgram('electric bass'), 33);
  assert.equal(matchGmProgram('String Ensemble 1'), 48);
  assert.equal(matchGmProgram('nonsense-voice'), null);
  assert.equal(gmProgramName(33), 'Electric Bass (finger)');

  assert.deepEqual(resolveTrackInstrument({ instrument: 'gm:40' }), {
    instrument: 'gm:40', program: 40, bankMSB: 0, bankLSB: 0, drum: false,
  });
  assert.deepEqual(resolveTrackInstrument({ instrument: 'gm:128:5' }), {
    instrument: 'gm:128:5', program: 5, bankMSB: 128, bankLSB: 0, drum: true,
  });
  assert.deepEqual(resolveTrackInstrument({ drums: true, program: 0 }), {
    instrument: 'gm:128:0', program: 0, bankMSB: 128, bankLSB: 0, drum: true,
  });
  assert.equal(resolveTrackInstrument({ instrument: 'flute' }).program, 73);
  // 未知の名前は既定へ落ちる。
  assert.equal(resolveTrackInstrument({ instrument: 'unknown' }, 'gm:0').instrument, 'gm:0');
});

test('normalizeArrangement accepts an MSX score and derives the bar count', () => {
  const score = ['tempo 100', 'track melody', 'instrument gm:0', 'C4 0 1', 'E4 1 1', 'track bass', 'instrument bass', 'C2 0 4'].join('\n');
  const arrangement = normalizeArrangement({ score });
  assert.equal(arrangement.tempo, 100);
  assert.equal(arrangement.tracks.length, 2);
  assert.equal(arrangementNoteCount(arrangement), 3);
  assert.equal(arrangement.bars, 1);
});

test('arrangementSeconds follows bars and tempo and adds the release tail', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  // 2 小節 × 4 拍 = 8 拍、120 BPM → 4 秒 + リリース 1.2 秒
  assert.equal(arrangementSeconds(arrangement, 1.2), 5.2);
  assert.equal(arrangementSeconds(arrangement, 0), 4);
});

// #endregion

// #region WAV とエフェクト

test('encodeWavStereo and decodeWav round trip stereo samples', () => {
  const left = Float32Array.from([0, 0.5, -0.5, 0.999, -0.999]);
  const right = Float32Array.from([0, -0.25, 0.25, 0.5, -0.5]);
  const bytes = encodeWavStereo(left, right, 44100);

  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.readUInt16LE(22), 2);
  assert.equal(bytes.readUInt32LE(24), 44100);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  assert.equal(bytes.length, 44 + left.length * 4);

  const wav = decodeWav(bytes);
  assert.equal(wav.channels, 2);
  assert.equal(wav.frames, 5);
  assert.equal(wav.sampleRate, 44100);
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs(wav.samples[index * 2] - left[index]) < 0.001);
    assert.ok(Math.abs(wav.samples[index * 2 + 1] - right[index]) < 0.001);
  }
});

test('panGains keeps the power constant and addEcho/addReverb add a tail', () => {
  const centre = panGains(0);
  const left = panGains(-1);
  const right = panGains(1);
  for (const gains of [centre, left, right]) {
    assert.ok(Math.abs(gains.left ** 2 + gains.right ** 2 - 1) < 1e-9);
  }
  assert.ok(centre.left > 0.7 && Math.abs(centre.left - centre.right) < 1e-9);
  assert.ok(left.left > 0.99 && left.right < 1e-9);
  assert.ok(right.right > 0.99 && right.left < 1e-9);

  const impulse = new Float32Array(2000);
  impulse[0] = 1;
  const echoed = addEcho(impulse, 8000, 0.8, 0.01); // 80 サンプル後
  assert.equal(echoed.length, impulse.length);
  assert.ok(Math.abs(echoed[0] - 1) < 1e-6);
  assert.ok(echoed[80] > 0.1, 'エコーが 80 サンプル後に出ている');

  const reverbed = addReverb(impulse, 8000, 0.9);
  const tail = reverbed.subarray(100).reduce((sum, value) => sum + Math.abs(value), 0);
  assert.ok(tail > 0, 'リバーブの残響が乗っている');
});

// #endregion

// #region プロジェクト書き出し (純関数)

test('buildMidiProject maps the arrangement onto channels, programs and CC values', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const project = buildMidiProject(arrangement);

  assert.equal(project.format, 1);
  assert.equal(project.tempo, 120);
  assert.deepEqual(project.timeSignature, [4, 4]);
  assert.equal(project.tracks.length, 3);

  const [lead, bass, drums] = project.tracks;
  assert.equal(lead.channel, 0);
  assert.equal(lead.program, 0);
  assert.equal(lead.notes.length, 5); // C4 E4 G4 + D4 + E4
  assert.deepEqual(lead.notes.map((note) => note.midi), [60, 64, 67, 62, 64]);
  assert.equal(lead.volume, 100);
  assert.equal(lead.pan, 32); // pan -0.5 → 32
  assert.equal(bass.program, 33);
  assert.equal(drums.drum, true);
  assert.equal(drums.channel, 9);
});

test('the arrangement survives export → import → export byte for byte', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const first = writeSmf(buildMidiProject(arrangement));

  const smf = readSmf(first);
  const imported = arrangementFromMidi(smf);
  const second = writeSmf(buildMidiProject(normalizeArrangement({ arrangement: imported })));

  assert.equal(second.length, first.length);
  assert.equal(second.equals(first), true);

  // 中身も数え直す
  assert.equal(imported.tracks.length, 3);
  assert.equal(arrangementNoteCount(imported), arrangementNoteCount(arrangement));
  assert.equal(imported.tempo, 120);
  assert.deepEqual(imported.tracks.map((track) => track.instrument), ['gm:0', 'gm:33', 'gm:128:0']);
  assert.deepEqual(imported.tracks.map((track) => track.drum), [false, false, true]);
});

test('serializeMusicXml writes well-formed MusicXML that parses back', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const text = serializeMusicXml(arrangement);

  assert.deepEqual(checkXmlBalance(text), { ok: true, error: '', tags: checkXmlBalance(text).tags });
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));

  const parsed = parseMusicXml(text);
  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.noteCount, arrangementNoteCount(arrangement));
  assert.equal(parsed.parts[0].measures, 2);
  assert.equal(parsed.parts[0].divisions, 480);
  assert.equal(parsed.tempo, 120);
  assert.deepEqual(parsed.parts.map((part) => part.name), ['lead', 'bass', 'drums']);
  assert.equal(parsed.parts[0].program, 1); // MusicXML は 1 始まり
  assert.equal(parsed.parts[2].channel, 10); // 打楽器
});

test('serializeMmp writes an LMMS project that parses back', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const text = serializeMmp(arrangement);

  assert.ok(text.includes('<lmms-project'));
  assert.equal(checkXmlBalance(text).ok, true);

  const parsed = parseMmp(text);
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.timeSignature, [4, 4]);
  assert.equal(parsed.trackCount, 3);
  assert.equal(parsed.noteCount, arrangementNoteCount(arrangement));
  assert.equal(parsed.tracks[0].instrument, 'tripleoscillator');
  // 192 tick / 4 分音符で、C4 は 60
  assert.equal(parsed.tracks[0].minKey, 60);
});

test('serializeH2Song writes a Hydrogen pattern with every drum note inside its bar', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const result = serializeH2Song(arrangement);

  assert.ok(result.text.includes('<hydrogen_song'));
  assert.equal(checkXmlBalance(result.text).ok, true);
  assert.equal(result.patterns, 2); // 2 小節 → 2 パターン
  assert.equal(result.notes, 4); // 打楽器だけ
  assert.deepEqual(result.skipped, ['lead (音色トラック)', 'bass (音色トラック)']);

  const parsed = parseH2Song(result.text);
  assert.equal(parsed.bpm, 120);
  assert.equal(parsed.patternCount, 2);
  assert.equal(parsed.noteCount, 4);
  assert.equal(parsed.instruments.length, 2); // C2 (36) と D2 (38)
  assert.deepEqual(parsed.instruments.map((instrument) => instrument.midiNote), [36, 38]);
  for (const pattern of parsed.patterns) {
    assert.equal(pattern.size, 192); // 4 拍 × 48 tick
    for (const position of pattern.positions) assert.ok(position >= 0 && position < 192);
  }
});

test('arrangementToScore emits MSX text that parses back into the same notes', () => {
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  const score = arrangementToScore(arrangement);
  const again = normalizeArrangement({ score });
  assert.equal(arrangementNoteCount(again), arrangementNoteCount(arrangement));
  // 打楽器は gm:128:<program> として往復する。
  assert.equal(again.tracks[2].drum, true);
});

// #endregion

// #region ツール登録

test('registerDawTools registers daw_arrange, export_daw_project and import_midi', async () => {
  const { ctx, tools } = fakeCtx();
  const { registerDawTools } = await import('../daw.js');
  registerDawTools(ctx, makeOptions(), { daw: {} }, makeHelpers(tmpdir()));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['daw_arrange', 'export_daw_project', 'import_midi']);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.isConcurrencySafe(), true);
    assert.ok(tool.timeoutMs >= 60000);
  }
  assert.deepEqual(DAW_AUDIO_FORMATS, ['wav', 'mp3', 'ogg']);
  assert.deepEqual(DAW_PROJECT_FORMATS, ['mid', 'musicxml', 'mmp', 'h2song']);
});

// #endregion

// #region 実際のレンダリング

test('daw_arrange renders a stereo 44.1 kHz WAV with real audio in it', async (t) => {
  if (!hasSoundFont) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  const { directory, byName } = await makeTools(t);
  const result = await byName.get('daw_arrange').execute(
    { arrangement: sampleArrangement(), format: 'wav' },
    { signal: undefined },
  );

  assert.equal(result.format, 'wav');
  assert.equal(result.mediaType, 'audio/wav');
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.channels, 2);
  assert.equal(result.tracks, 3);
  assert.equal(result.notes, 11);
  assert.equal(result.bars, 2);
  assert.equal(result.tempo, 120);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.path, join('media-studio', 'test-piece.wav'));

  const bytes = await readFile(join(directory, result.path));
  assert.equal(bytes.length, result.bytes);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(bytes.readUInt16LE(20), 1); // PCM
  assert.equal(bytes.readUInt16LE(22), 2); // stereo
  assert.equal(bytes.readUInt32LE(24), 44100);
  assert.equal(bytes.readUInt32LE(28), 44100 * 4); // byte rate
  assert.equal(bytes.readUInt16LE(32), 4); // block align
  assert.equal(bytes.readUInt16LE(34), 16); // bits
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);

  // 長さ: 2 小節 = 8 拍 @120 = 4 秒 + リリース 1.2 秒
  const seconds = (bytes.length - 44) / 4 / 44100;
  assert.ok(Math.abs(seconds - 5.2) < 0.02, `WAV の長さが想定と違う: ${seconds}`);
  assert.ok(Math.abs(result.seconds - 5.2) < 0.02);

  // 無音でないこと。左右が同じでないこと (パンが効いていること)。
  const wav = decodeWav(bytes);
  let peak = 0;
  let difference = 0;
  for (let frame = 0; frame < wav.frames; frame += 1) {
    const left = wav.samples[frame * 2];
    const right = wav.samples[frame * 2 + 1];
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    difference += Math.abs(left - right);
  }
  assert.ok(peak > 0.2, `ピークが小さすぎる: ${peak}`);
  assert.ok(result.peak > 0.2);
  assert.ok(result.rms > 0.001, `RMS が小さすぎる: ${result.rms}`);
  assert.ok(difference > 1, 'パンが左右に差を作っていない');
});

test('mute and solo change the mix', async (t) => {
  if (!hasSoundFont) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'daw-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = {
    soundfontPath: SOUNDFONT_PATH,
    gain: 1,
    releaseSeconds: 0.6,
    sampleRate: 44100,
    maxSeconds: 600,
    baseDir: directory,
  };
  const full = normalizeArrangement({ arrangement: sampleArrangement() });
  const muted = normalizeArrangement({ arrangement: sampleArrangement() });
  muted.tracks[0].mute = true;
  const soloed = normalizeArrangement({ arrangement: sampleArrangement() });
  soloed.tracks[2].solo = true;

  const fullMix = await renderArrangement(full, runtime);
  const mutedMix = await renderArrangement(muted, runtime);
  const soloMix = await renderArrangement(soloed, runtime);

  assert.equal(fullMix.frames, mutedMix.frames);
  assert.ok(mutedMix.rms < fullMix.rms, 'ミュートしたトラックの分だけ静かになる');
  assert.ok(soloMix.rms < fullMix.rms, 'ソロで他のトラックが落ちる');
  assert.ok(soloMix.rms > 0, 'ソロのトラックは鳴っている');
  assert.deepEqual(soloMix.rendered.map((entry) => entry.name), ['drums']);
});

test('an instrument track without a SoundFont fails with an actionable message', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'daw-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const arrangement = normalizeArrangement({ arrangement: sampleArrangement() });
  await assert.rejects(
    renderArrangement(arrangement, {
      soundfontPath: 'C:\\definitely\\missing.sf2',
      sampleRate: 44100,
      releaseSeconds: 1.2,
      maxSeconds: 600,
      baseDir: directory,
    }),
    /SoundFont が見つかりません.*soundfont\.path/u,
  );
});

test('an audio-only arrangement mixes WAV files without a SoundFont', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'daw-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  // 400 Hz のモノラル WAV を 1 秒ぶん作る。
  const frames = 44100;
  const tone = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) tone[index] = Math.sin((2 * Math.PI * 400 * index) / 44100) * 0.5;
  const wavPath = join(directory, 'tone.wav');
  await writeFile(wavPath, encodeWavStereo(tone, tone, 44100));

  const arrangement = normalizeArrangement({
    arrangement: {
      name: 'Audio Only',
      tempo: 120,
      bars: 1,
      tracks: [{ name: 'tone', audio: 'tone.wav', volume: 1, pan: -1 }],
    },
  });
  assert.equal(arrangement.tracks[0].kind, 'audio');

  const rendered = await renderArrangement(arrangement, {
    soundfontPath: '',
    sampleRate: 44100,
    releaseSeconds: 0,
    maxSeconds: 60,
    baseDir: directory,
  });
  assert.ok(rendered.peak > 0.3, `音声トラックが鳴っていない: ${rendered.peak}`);
  // pan -1 なので左だけ。
  let rightEnergy = 0;
  for (let frame = 0; frame < rendered.frames; frame += 1) rightEnergy += Math.abs(rendered.right[frame]);
  assert.ok(rightEnergy < 0.01, `右チャンネルに漏れている: ${rightEnergy}`);
});

test('export_daw_project writes and verifies every project format', async (t) => {
  const { directory, byName } = await makeTools(t);
  const expected = { mid: 'audio/midi', musicxml: 'application/vnd.recordare.musicxml+xml', mmp: 'application/xml', h2song: 'application/xml' };

  for (const format of DAW_PROJECT_FORMATS) {
    const result = await byName.get('export_daw_project').execute(
      { arrangement: sampleArrangement(), format },
      { signal: undefined },
    );
    assert.equal(result.format, format);
    assert.equal(result.mediaType, expected[format]);
    assert.equal(result.tracks, 3);
    assert.equal(result.notes, 11);
    assert.ok(result.bytes > 100, `${format} の出力が小さすぎる`);
    assert.ok(result.name.endsWith(`.${format}`));
    assert.equal(result.verified.xml === undefined ? true : result.verified.xml.ok, true);

    const bytes = await readFile(join(directory, result.path));
    assert.equal(bytes.length, result.bytes);

    if (format === 'mid') {
      const smf = readSmf(bytes);
      assert.equal(smf.format, 1);
      assert.equal(smf.totalNotes, 11);
      assert.deepEqual(smf.timeSignature, [4, 4]);
      assert.equal(Math.round(smf.tempos[0].bpm), 120);
      assert.deepEqual(result.verified.programs.map((entry) => entry.channel), [1, 2, 10]);
      assert.equal(result.ticksPerQuarter, 480);
    } else if (format === 'musicxml') {
      const parsed = parseMusicXml(bytes.toString('utf8'));
      assert.equal(parsed.noteCount, 11);
      assert.equal(parsed.parts.length, 3);
      assert.ok(result.verified.xml.tags > 100);
    } else if (format === 'mmp') {
      const parsed = parseMmp(bytes.toString('utf8'));
      assert.equal(parsed.noteCount, 11);
      assert.equal(parsed.bpm, 120);
    } else {
      const parsed = parseH2Song(bytes.toString('utf8'));
      assert.equal(parsed.noteCount, 4);
      assert.equal(parsed.patternCount, 2);
    }
  }
});

test('import_midi reads back a file written by export_daw_project', async (t) => {
  const { directory, byName } = await makeTools(t);
  const exported = await byName.get('export_daw_project').execute(
    { arrangement: sampleArrangement(), format: 'mid' },
    { signal: undefined },
  );
  const imported = await byName.get('import_midi').execute(
    { path: exported.path },
    { signal: undefined },
  );

  assert.equal(imported.tracks, 3);
  assert.equal(imported.notes, 11);
  assert.equal(imported.tempo, 120);
  assert.deepEqual(imported.timeSignature, [4, 4]);
  assert.equal(imported.format, 1);
  assert.equal(imported.ticksPerQuarter, 480);
  assert.deepEqual(imported.warnings, []);
  assert.ok(imported.score.includes('track lead'));
  assert.ok(imported.score.includes('instrument gm:0'));

  assert.equal(imported.arrangement.tracks.length, 3);
  assert.deepEqual(imported.arrangement.tracks.map((track) => track.instrument), ['gm:0', 'gm:33', 'gm:128:0']);
  assert.deepEqual(imported.arrangement.tracks[0].notes[0], {
    start: 0,
    duration: 1,
    pitches: ['C4'],
    velocity: 96,
  });
  assert.ok(Math.abs(imported.arrangement.tracks[0].pan + 0.5039) < 0.01);

  // 読み戻した編曲をもう一度書き出すと、同じバイト列になる。
  const again = await byName.get('export_daw_project').execute(
    { arrangement: imported.arrangement, format: 'mid' },
    { signal: undefined },
  );
  const first = await readFile(join(directory, exported.path));
  const second = await readFile(join(directory, again.path));
  assert.equal(second.equals(first), true);
});

test('import_midi reports a missing file instead of throwing a raw ENOENT', async (t) => {
  const { byName } = await makeTools(t);
  await assert.rejects(
    byName.get('import_midi').execute({ path: 'nope.mid' }, { signal: undefined }),
    /MIDI ファイルを読めません/u,
  );
});

test('daw_arrange converts to mp3 with ffmpeg when it is installed', async (t) => {
  if (!hasSoundFont) {
    t.skip(`no SoundFont at ${SOUNDFONT_PATH}`);
    return;
  }
  if (!hasFfmpeg) {
    t.skip('no ffmpeg on PATH');
    return;
  }
  const { directory, byName } = await makeTools(t);
  const result = await byName.get('daw_arrange').execute(
    { arrangement: sampleArrangement(), format: 'mp3' },
    { signal: undefined },
  );

  assert.equal(result.format, 'mp3');
  assert.equal(result.mediaType, 'audio/mpeg');
  assert.ok(result.name.endsWith('.mp3'));
  assert.equal(typeof result.wavPath, 'string');
  assert.deepEqual(result.warnings, []);

  const bytes = await readFile(join(directory, result.path));
  assert.ok(bytes.length > 1000);
  // MP3 のフレーム同期 (0xFF Ex/Fx) か ID3 タグで始まる。
  const looksLikeMp3 = bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  assert.equal(looksLikeMp3, true, 'MP3 のヘッダが見つからない');
  assert.ok(existsSync(join(directory, result.wavPath)), 'WAV も残っている');
});

// #endregion
