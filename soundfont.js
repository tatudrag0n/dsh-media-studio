/**
 * SoundFont 2 rendering for the music tools.
 *
 * `spessasynth_core` is imported lazily and treated as optional: when the
 * package or the .sf2 file is missing, every export degrades to "unavailable"
 * and the caller falls back to the built-in oscillator synthesizer. Nothing
 * here touches Cordis, so `node --test` can render a real preset without
 * booting a profile.
 *
 * Every track gets its own MIDI channel, so one piece can mix several
 * SoundFont presets at once.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Sample rate for SoundFont rendering. */
export const SOUNDFONT_SAMPLE_RATE = 44100;

/** Render block size; also the interval between modulator/LFO updates. */
const BLOCK_SIZE = 128;

/** MIDI channels handed to tracks in order; 9 stays reserved for percussion. */
const TRACK_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

/** Parsed banks, keyed by file path. */
const BANK_CACHE = new Map();

/** `gm:<program>` or `gm:<bankMSB>:<program>`; null for any other instrument name. */
export function parseGmInstrument(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^gm:(\d{1,3})(?::(\d{1,3}))?$/iu);
  if (match === null) return null;
  const program = match[2] === undefined ? Number(match[1]) : Number(match[2]);
  const bankMSB = match[2] === undefined ? 0 : Number(match[1]);
  if (!Number.isInteger(program) || program < 0 || program > 127) return null;
  // 128 is the General MIDI percussion bank; every other bank stays melodic.
  if (!Number.isInteger(bankMSB) || bankMSB < 0 || bankMSB > 128) return null;
  return { bankMSB, bankLSB: 0, program };
}

/** Canonical instrument string for a GM selection. */
export function formatGmInstrument({ bankMSB, program }) {
  return bankMSB === 0 ? `gm:${program}` : `gm:${bankMSB}:${program}`;
}

/** True when a SoundFont file is configured and present. */
export function soundFontAvailable(path) {
  return typeof path === 'string' && path.trim() !== '' && existsSync(path);
}

/** Load and cache a SoundFont: the parsed bank plus its preset directory. */
export async function loadSoundFont(path) {
  const cached = BANK_CACHE.get(path);
  if (cached !== undefined) return cached;
  const core = await import('spessasynth_core');
  const bytes = await readFile(path);
  const bank = core.SoundBankLoader.fromArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const probe = new core.SpessaSynthProcessor(SOUNDFONT_SAMPLE_RATE, { eventsEnabled: false });
  probe.soundBankManager.addSoundBank(bank, 'main');
  await probe.processorInitialized;
  const presets = probe.soundBankManager.presetList.map((preset) => ({
    bankMSB: preset.bankMSB,
    bankLSB: preset.bankLSB,
    program: preset.program,
    name: preset.name,
    drum: preset.isDrum === true,
  }));
  const entry = { core, bank, presets };
  BANK_CACHE.set(path, entry);
  return entry;
}

/** Preset directory for a SoundFont, or [] when it cannot be read. */
export async function soundFontPresets(path) {
  if (!soundFontAvailable(path)) return [];
  try {
    const { presets } = await loadSoundFont(path);
    return presets;
  } catch {
    return [];
  }
}

/**
 * Render every `gm:` track of a piece. Each track is assigned its own MIDI
 * channel and program; notes are scheduled on a sample timeline so release
 * tails ring into the following notes. Returns a mono Float32Array.
 */
export async function renderSoundFontTracks(path, options = {}) {
  const { core, bank } = await loadSoundFont(path);
  const sampleRate = SOUNDFONT_SAMPLE_RATE;
  const tempo = positive(options.tempo, 120);
  const tracks = Array.isArray(options.tracks) ? options.tracks : [];
  const volume = clamp01(options.volume, 0.7);
  const gain = positive(options.gain, 1);
  const releaseSeconds = Number.isFinite(options.releaseSeconds) && options.releaseSeconds >= 0
    ? options.releaseSeconds
    : 1.2;

  const synth = new core.SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(bank, 'main');
  await synth.processorInitialized;
  synth.setSystemParameter('autoAllocateVoices', true);

  const secondsPerBeat = 60 / tempo;
  const events = [];
  let endBeats = 0;
  let used = 0;
  for (const track of tracks) {
    const gm = parseGmInstrument(track?.instrument);
    if (gm === null) continue;
    // Percussion lives on MIDI channel 10 (index 9), which stays reserved.
    const channel = gm.bankMSB === 128 ? 9 : TRACK_CHANNELS[used % TRACK_CHANNELS.length];
    if (gm.bankMSB !== 128) used += 1;
    synth.controllerChange(channel, 0, gm.bankMSB);
    synth.controllerChange(channel, 32, gm.bankLSB);
    synth.programChange(channel, gm.program);
    synth.controllerChange(channel, 7, 100);
    for (const note of track?.notes ?? []) {
      const start = Math.round(note.start * secondsPerBeat * sampleRate);
      const end = Math.round((note.start + note.duration) * secondsPerBeat * sampleRate);
      endBeats = Math.max(endBeats, note.start + note.duration);
      for (const pitch of note.pitches ?? []) {
        const midi = midiForName(pitch);
        if (midi === null) continue;
        events.push({ sample: start, type: 'on', channel, midi });
        events.push({ sample: end, type: 'off', channel, midi });
      }
    }
  }

  const total = Math.max(1, Math.ceil((endBeats * secondsPerBeat + releaseSeconds) * sampleRate));
  const { left, right } = renderScheduled(synth, events, total, sampleRate);
  return mixToMono(left, right, volume * gain * 0.5);
}

/**
 * Render one preset from a sequential `{ pitch, beats }` note list. Kept for
 * single-instrument callers and tests; `renderSoundFontTracks` is the
 * multi-track entry point.
 */
export async function renderSoundFontScore(path, options = {}) {
  const tempo = positive(options.tempo, 120);
  const secondsPerBeat = 60 / tempo;
  const notes = Array.isArray(options.notes) ? options.notes : [];
  let cursor = 0;
  const tracks = [{ instrument: formatGmInstrument({
    bankMSB: Number.isFinite(options.bankMSB) ? options.bankMSB : 0,
    program: Number.isFinite(options.program) ? options.program : 0,
  }), notes: [] }];
  for (const note of notes) {
    const beats = Number.isFinite(note?.beats) && note.beats > 0 ? note.beats : 1;
    for (const pitch of splitPitches(note?.pitch)) {
      tracks[0].notes.push({ pitches: [pitch], start: cursor, duration: beats });
    }
    cursor += beats;
  }
  void secondsPerBeat;
  return await renderSoundFontTracks(path, {
    tempo,
    tracks,
    volume: options.volume,
    gain: options.gain,
    releaseSeconds: options.releaseSeconds,
  });
}

/** Apply scheduled note events while rendering in blocks. */
function renderScheduled(synth, events, total, sampleRate) {
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  events.sort((first, second) => first.sample - second.sample);
  let index = 0;
  for (let offset = 0; offset < total; offset += BLOCK_SIZE) {
    const count = Math.min(BLOCK_SIZE, total - offset);
    const limit = offset + count;
    while (index < events.length && events[index].sample < limit) {
      const event = events[index];
      index += 1;
      if (event.type === 'on') synth.noteOn(event.channel, event.midi, 100);
      else synth.noteOff(event.channel, event.midi);
    }
    synth.process(left, right, offset, count);
  }
  return { left, right };
}

/**
 * Mix stereo to mono and normalise. Preset attenuation varies a lot between
 * banks, so a bounded boost keeps the result audible without amplifying a
 * near-silent render into noise.
 */
function mixToMono(left, right, scale) {
  const total = left.length;
  const mono = new Float32Array(total);
  let peak = 0;
  for (let i = 0; i < total; i += 1) {
    const value = (left[i] + right[i]) * scale;
    mono[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const boost = peak > 1e-6 ? Math.min(8, 0.9 / peak) : 1;
  for (let i = 0; i < total; i += 1) mono[i] = Math.tanh(mono[i] * boost);
  return mono;
}

/** Split a pitch field such as "C4,E4,G4" into validated names. */
function splitPitches(field) {
  if (typeof field !== 'string') return [];
  return field.split(/[,;]/u).map((part) => part.trim()).filter((part) => midiForName(part) !== null);
}

/** MIDI number for one pitch name, or null for a rest. */
function midiForName(pitch) {
  if (typeof pitch !== 'string') return null;
  const match = pitch.trim().toLowerCase().match(/^([a-g])([#b]?)(-?\d+)$/u);
  if (match === null) return null;
  const offsets = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semitone = offsets[match[1].toUpperCase()];
  if (match[2] === '#') semitone += 1;
  else if (match[2] === 'b') semitone -= 1;
  const midi = semitone + (Number(match[3]) + 1) * 12;
  return Number.isFinite(midi) ? midi : null;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
