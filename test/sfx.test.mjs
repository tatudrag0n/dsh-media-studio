import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SFX_DEFAULTS,
  SFX_KINDS,
  encodeWav,
  measureSamples,
  mulberry32,
  renderSfx,
} from '../sfx.js';

/** Peak absolute value of one channel. */
function peakOf(channel) {
  let peak = 0;
  for (const value of channel) peak = Math.max(peak, Math.abs(value));
  return peak;
}

/** Mean absolute sample-to-sample difference, the local "steepness". */
function meanDelta(channel) {
  let total = 0;
  for (let index = 1; index < channel.length; index += 1) total += Math.abs(channel[index] - channel[index - 1]);
  return total / Math.max(1, channel.length - 1);
}

test('the PRNG is deterministic and stays inside 0..1', () => {
  const first = mulberry32(1234);
  const second = mulberry32(1234);
  const values = Array.from({ length: 64 }, () => first());
  assert.deepEqual(values, Array.from({ length: 64 }, () => second()));
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, `value ${value} left 0..1`);
  }
});

test('the catalogue is complete and self-consistent', () => {
  assert.equal(SFX_KINDS.length, 35);
  assert.equal(new Set(SFX_KINDS).size, SFX_KINDS.length);
  for (const kind of SFX_KINDS) {
    const defaults = SFX_DEFAULTS[kind];
    assert.ok(defaults !== undefined, `${kind} has no defaults`);
    assert.ok(defaults.duration >= 0.05 && defaults.duration <= 60, `${kind} duration out of range`);
    assert.equal(typeof defaults.loop, 'boolean');
  }
});

test('a WAV file has a correct header and an honest data length', () => {
  const rendered = renderSfx({ kind: 'click' });
  const wav = encodeWav(rendered.channels, rendered.sampleRate);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM format tag');
  assert.equal(wav.readUInt16LE(22), rendered.channelCount);
  assert.equal(wav.readUInt32LE(24), rendered.sampleRate);
  assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
  const declared = wav.readUInt32LE(40);
  assert.equal(declared, wav.length - 44);
  assert.equal(declared % 2, 0, 'data chunk must be even');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
});

test('a mono WAV declares one channel and half the data of stereo', () => {
  const mono = renderSfx({ kind: 'beep', channels: 1 });
  const stereo = renderSfx({ kind: 'beep', channels: 2 });
  assert.equal(mono.channelCount, 1);
  assert.equal(stereo.channelCount, 2);
  const monoWav = encodeWav(mono.channels, mono.sampleRate);
  const stereoWav = encodeWav(stereo.channels, stereo.sampleRate);
  assert.equal(monoWav.readUInt16LE(22), 1);
  assert.equal(stereoWav.readUInt16LE(22), 2);
  assert.ok(Math.abs((stereoWav.length - 44) / (monoWav.length - 44) - 2) < 1e-9);
});

test('rendered length follows duration and sample rate', () => {
  for (const sampleRate of [44100, 48000]) {
    const rendered = renderSfx({ kind: 'beep', duration: 0.5, sampleRate });
    assert.equal(rendered.sampleRate, sampleRate);
    assert.equal(rendered.channels[0].length, Math.round(0.5 * sampleRate));
    assert.ok(Math.abs(rendered.duration - 0.5) < 1e-9);
  }
});

test('the same seed reproduces the same samples, and another seed does not', () => {
  const first = renderSfx({ kind: 'whoosh', seed: 11 });
  const same = renderSfx({ kind: 'whoosh', seed: 11 });
  const other = renderSfx({ kind: 'whoosh', seed: 12 });
  assert.deepEqual(Array.from(first.channels[0]), Array.from(same.channels[0]));
  assert.notDeepEqual(Array.from(first.channels[0]), Array.from(other.channels[0]));
});

test('variation changes the take without changing what it is', () => {
  const base = renderSfx({ kind: 'footsteps', seed: 3 });
  const variant = renderSfx({ kind: 'footsteps', seed: 3, variation: 0.7 });
  assert.notDeepEqual(Array.from(base.channels[0]), Array.from(variant.channels[0]));
  assert.ok(measureSamples(variant.channels).rms > 0.0005);
});

test('every kind is audible, centred and free of clicks', () => {
  for (const kind of SFX_KINDS) {
    const rendered = renderSfx({ kind });
    const measured = measureSamples(rendered.channels);
    assert.ok(measured.rms > 0.0005, `${kind} is silent`);
    assert.ok(measured.peak <= 1, `${kind} clips`);
    assert.ok(Math.abs(measured.dc) < 0.002, `${kind} carries DC ${measured.dc}`);
    if (SFX_DEFAULTS[kind].loop) {
      for (const channel of rendered.channels) {
        const seam = Math.abs(channel[0] - channel[channel.length - 1]);
        assert.ok(seam <= meanDelta(channel) * 12 + 1e-6, `${kind} loop seam jumps by ${seam}`);
      }
    } else {
      for (const channel of rendered.channels) {
        assert.ok(Math.abs(channel[0]) < 1e-6, `${kind} starts above zero`);
        assert.ok(Math.abs(channel[channel.length - 1]) < 1e-6, `${kind} ends above zero`);
      }
    }
  }
});

test('every kind renders at its default length quickly', () => {
  const started = Date.now();
  for (const kind of SFX_KINDS) {
    const rendered = renderSfx({ kind });
    assert.ok(rendered.channels[0].length > 0);
    assert.ok(Math.abs(rendered.duration - SFX_DEFAULTS[kind].duration) < 0.02, `${kind} duration drifted`);
  }
  assert.ok(Date.now() - started < 8000, 'the whole catalogue should render in seconds');
});

test('an unknown kind fails with usable suggestions', () => {
  assert.throws(
    () => renderSfx({ kind: 'not-a-sound' }),
    (error) => {
      assert.match(error.message, /未知の効果音/);
      assert.ok(SFX_KINDS.filter((kind) => error.message.includes(kind)).length >= 3);
      return true;
    },
  );
});

test('a duration outside the supported range is refused', () => {
  assert.throws(() => renderSfx({ kind: 'click', duration: 0 }), /duration/);
  assert.throws(() => renderSfx({ kind: 'click', duration: 120 }), /duration/);
});

test('intensity and brightness move the result in the expected direction', () => {
  const quiet = renderSfx({ kind: 'impact', intensity: 0 });
  const loud = renderSfx({ kind: 'impact', intensity: 1 });
  assert.notDeepEqual(Array.from(quiet.channels[0]), Array.from(loud.channels[0]));
  const dark = renderSfx({ kind: 'rain', brightness: 0, loop: true });
  const bright = renderSfx({ kind: 'rain', brightness: 1, loop: true });
  const energy = (channels) => channels[0].reduce((total, value) => total + Math.abs(value), 0);
  assert.ok(energy(bright.channels) > 0, 'bright rain is audible');
  assert.notDeepEqual(Array.from(dark.channels[0]), Array.from(bright.channels[0]));
});

test('a loop keeps the requested length and a one-shot is shorter than 60 seconds', () => {
  const looped = renderSfx({ kind: 'rain', duration: 2, loop: true });
  assert.equal(looped.channels[0].length, Math.round(2 * looped.sampleRate));
  const oneShot = renderSfx({ kind: 'impact' });
  assert.ok(oneShot.duration < 60);
  assert.ok(peakOf(oneShot.channels[0]) > 0.5, 'one-shots land near full scale');
});
