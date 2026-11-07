/**
 * 効果音の合成 (procedural sound-effect synthesis).
 *
 * Node の標準機能だけで音を作る。外部プロセスも python も ffmpeg も使わない。
 * 出力は決定的で、同じ `seed` と同じ入力からは常に同じサンプル列が出る。
 *
 * The catalogue is organised around physical events rather than "sounds": a
 * whoosh is moving air past a microphone, an impact is a mass hitting a
 * surface, rain is many small droplets over a noise bed. Each recipe composes
 * the same small DSP primitives below, which keeps the whole file testable
 * without a sound card.
 */

const TAU = Math.PI * 2;

/** Every kind this renderer knows. */
export const SFX_KINDS = [
  'whoosh',
  'swoosh',
  'impact',
  'sub-drop',
  'riser',
  'downlifter',
  'reverse-cymbal',
  'transition',
  'click',
  'pop',
  'beep',
  'notification',
  'chime',
  'bell',
  'alarm',
  'laser',
  'powerup',
  'coin',
  'magic',
  'glitch',
  'static',
  'explosion',
  'footsteps',
  'door',
  'camera-shutter',
  'typing',
  'page-turn',
  'rain',
  'wind',
  'fire',
  'water',
  'crowd',
  'horror-drone',
  'heartbeat',
  'engine',
];

/** Kinds whose natural use is a continuous bed rather than a one-shot. */
const AMBIENCE = new Set(['rain', 'wind', 'fire', 'water', 'crowd', 'horror-drone', 'engine', 'static']);

/** Default duration (seconds) and loop flag per kind. */
export const SFX_DEFAULTS = {
  whoosh: { duration: 0.55, loop: false },
  swoosh: { duration: 0.4, loop: false },
  impact: { duration: 1.1, loop: false },
  'sub-drop': { duration: 0.9, loop: false },
  riser: { duration: 2.4, loop: false },
  downlifter: { duration: 1.8, loop: false },
  'reverse-cymbal': { duration: 1.6, loop: false },
  transition: { duration: 1.2, loop: false },
  click: { duration: 0.08, loop: false },
  pop: { duration: 0.18, loop: false },
  beep: { duration: 0.22, loop: false },
  notification: { duration: 0.9, loop: false },
  chime: { duration: 1.8, loop: false },
  bell: { duration: 2.4, loop: false },
  alarm: { duration: 1.6, loop: false },
  laser: { duration: 0.35, loop: false },
  powerup: { duration: 0.9, loop: false },
  coin: { duration: 0.35, loop: false },
  magic: { duration: 1.4, loop: false },
  glitch: { duration: 0.6, loop: false },
  static: { duration: 2, loop: true },
  explosion: { duration: 2.2, loop: false },
  footsteps: { duration: 2.4, loop: false },
  door: { duration: 1.2, loop: false },
  'camera-shutter': { duration: 0.3, loop: false },
  typing: { duration: 2, loop: false },
  'page-turn': { duration: 0.5, loop: false },
  rain: { duration: 4, loop: true },
  wind: { duration: 5, loop: true },
  fire: { duration: 4, loop: true },
  water: { duration: 3, loop: true },
  crowd: { duration: 4, loop: true },
  'horror-drone': { duration: 6, loop: true },
  heartbeat: { duration: 3, loop: false },
  engine: { duration: 4, loop: true },
};

/** Sample rates this renderer accepts. */
export const SFX_SAMPLE_RATES = [44100, 48000];

/** Smallest and largest accepted duration, in seconds. */
const MIN_SECONDS = 0.05;
const MAX_SECONDS = 60;

/**
 * Deterministic 32-bit PRNG. Two runs with the same seed produce the same
 * noise, which is what makes a rendered effect reproducible.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a string into a seed so different kinds never share a noise stream. */
function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** White noise in -1..1. */
function whiteNoise(length, rand) {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) out[index] = rand() * 2 - 1;
  return out;
}

/** Pink-ish noise (1/f) from a white source through Paul Kellet's filter. */
function pinkNoise(length, rand) {
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let index = 0; index < length; index += 1) {
    const white = rand() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[index] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
  }
  return out;
}

/** Brown noise (1/f²): integrated white noise with a leaky corner. */
function brownNoise(length, rand) {
  const out = new Float32Array(length);
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = (value + (rand() * 2 - 1) * 0.06) * 0.995;
    out[index] = value;
  }
  return out;
}

/** One-pole low pass, applied in place. */
function onePoleLowpass(buffer, cutoffHz, sampleRate) {
  const alpha = 1 - Math.exp((-TAU * Math.max(cutoffHz, 1)) / sampleRate);
  let state = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    state += alpha * (buffer[index] - state);
    buffer[index] = state;
  }
  return buffer;
}

/** One-pole high pass, applied in place. */
function onePoleHighpass(buffer, cutoffHz, sampleRate) {
  const alpha = 1 - Math.exp((-TAU * Math.max(cutoffHz, 1)) / sampleRate);
  let low = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    low += alpha * (value - low);
    buffer[index] = value - low;
  }
  return buffer;
}

/** RBJ cookbook biquad coefficients. */
function biquadCoefficients(type, frequency, sampleRate, q, gainDb = 0) {
  const omega = (TAU * Math.min(frequency, sampleRate * 0.49)) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * Math.max(q, 0.05));
  const a0 = 1 + alpha;
  const norm = (value) => value / a0;
  if (type === 'highpass') {
    return {
      b0: norm((1 + cos) / 2),
      b1: norm(-(1 + cos)),
      b2: norm((1 + cos) / 2),
      a1: norm(-2 * cos),
      a2: norm(1 - alpha),
    };
  }
  if (type === 'bandpass') {
    return { b0: norm(alpha), b1: 0, b2: norm(-alpha), a1: norm(-2 * cos), a2: norm(1 - alpha) };
  }
  if (type === 'peaking') {
    const a = 10 ** (gainDb / 40);
    return {
      b0: norm(1 + alpha * a),
      b1: norm(-2 * cos),
      b2: norm(1 - alpha * a),
      a1: norm(-2 * cos),
      a2: norm(1 - alpha / a),
    };
  }
  return {
    b0: norm((1 - cos) / 2),
    b1: norm(1 - cos),
    b2: norm((1 - cos) / 2),
    a1: norm(-2 * cos),
    a2: norm(1 - alpha),
  };
}

/** Apply one biquad in place. */
function biquad(buffer, type, frequency, sampleRate, q = 0.707, gainDb = 0) {
  const coefficients = biquadCoefficients(type, frequency, sampleRate, q, gainDb);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const x0 = buffer[index];
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    buffer[index] = y0;
  }
  return buffer;
}

/** A smooth 0→1 curve over `length` samples, shaped by `power`. */
function ramp(length, power = 1) {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = length <= 1 ? 1 : index / (length - 1);
    out[index] = power === 1 ? t : t ** power;
  }
  return out;
}

/** Exponential decay envelope with a 1 ms attack so it never clicks. */
function decayEnvelope(length, sampleRate, tauSeconds) {
  const out = new Float32Array(length);
  const attack = Math.max(1, Math.round(sampleRate * 0.001));
  const tau = Math.max(tauSeconds, 1e-4);
  for (let index = 0; index < length; index += 1) {
    const value = Math.exp(-index / (tau * sampleRate));
    out[index] = index < attack ? value * (index / attack) : value;
  }
  return out;
}

/** Attack/decay/sustain/release envelope over `length` samples. */
function adsrEnvelope(length, sampleRate, { attack = 0.005, decay = 0.08, sustain = 0.4, release = 0.2 } = {}) {
  const out = new Float32Array(length);
  const attackSamples = Math.max(1, Math.round(attack * sampleRate));
  const decaySamples = Math.max(1, Math.round(decay * sampleRate));
  const releaseSamples = Math.max(1, Math.round(release * sampleRate));
  const sustainStart = attackSamples + decaySamples;
  const releaseStart = Math.max(sustainStart, length - releaseSamples);
  for (let index = 0; index < length; index += 1) {
    if (index < attackSamples) {
      out[index] = index / attackSamples;
    } else if (index < sustainStart) {
      const t = (index - attackSamples) / decaySamples;
      out[index] = 1 - (1 - sustain) * t;
    } else if (index < releaseStart) {
      out[index] = sustain;
    } else {
      const t = (index - releaseStart) / Math.max(1, length - releaseStart);
      out[index] = sustain * (1 - t);
    }
  }
  return out;
}

/** Multiply `buffer` by `envelope` in place. */
function applyEnvelope(buffer, envelope) {
  const length = Math.min(buffer.length, envelope.length);
  for (let index = 0; index < length; index += 1) buffer[index] *= envelope[index];
  return buffer;
}

/** Sine oscillator with an exponential glide from `f0` to `f1`. */
function sineSweep(length, sampleRate, { f0, f1 = f0, glide = 0.4, phase = 0 } = {}) {
  const out = new Float32Array(length);
  let accumulator = phase;
  for (let index = 0; index < length; index += 1) {
    const t = length <= 1 ? 0 : index / (length - 1);
    const shaped = glide === 0 ? 1 : t ** (1 / Math.max(glide, 0.05));
    const frequency = f0 * (f1 / f0) ** shaped;
    accumulator += (TAU * frequency) / sampleRate;
    out[index] = Math.sin(accumulator);
  }
  return out;
}

/** Two-operator FM tone with an exponentially decaying modulation index. */
function fmTone(length, sampleRate, { carrier, ratio = 2, index = 4, decay = 0.3 } = {}) {
  const out = new Float32Array(length);
  const modulation = new Float32Array(length);
  let carrierPhase = 0;
  let modulationPhase = 0;
  const decaySamples = Math.max(1, decay * sampleRate);
  for (let i = 0; i < length; i += 1) {
    const depth = index * Math.exp(-i / decaySamples);
    modulationPhase += (TAU * carrier * ratio) / sampleRate;
    carrierPhase += (TAU * carrier) / sampleRate + depth * Math.sin(modulationPhase) * 0.001;
    modulation[i] = Math.sin(carrierPhase);
    out[i] = modulation[i];
  }
  return out;
}

/** Additive tone: partials at `ratios` with individual decay times. */
function additiveTone(length, sampleRate, { frequency, ratios, decays, gains }) {
  const out = new Float32Array(length);
  for (let partial = 0; partial < ratios.length; partial += 1) {
    const hz = frequency * ratios[partial];
    if (hz >= sampleRate * 0.49) continue;
    const decay = decays[partial] ?? 0.3;
    const gain = gains[partial] ?? 1 / (partial + 1);
    const decaySamples = Math.max(1, decay * sampleRate);
    let phase = 0;
    for (let index = 0; index < length; index += 1) {
      phase += (TAU * hz) / sampleRate;
      out[index] += Math.sin(phase) * gain * Math.exp(-index / decaySamples);
    }
  }
  return out;
}

/** Schroeder reverb: four combs then two allpasses, mixed by `mix`. */
function schroederReverb(buffer, sampleRate, { rt60 = 1.4, mix = 0.25, preDelayMs = 12 } = {}) {
  const dry = Float32Array.from(buffer);
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437];
  const allpassDelays = [0.005, 0.0017];
  const wet = new Float32Array(buffer.length);
  for (const seconds of combDelays) {
    const delay = Math.max(1, Math.round(seconds * sampleRate));
    const feedback = 10 ** ((-3 * delay) / (rt60 * sampleRate));
    const line = new Float32Array(delay);
    let position = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const delayed = line[position];
      wet[index] += delayed / combDelays.length;
      line[position] = dry[index] + delayed * feedback;
      position = (position + 1) % delay;
    }
  }
  for (const seconds of allpassDelays) {
    const delay = Math.max(1, Math.round(seconds * sampleRate));
    const line = new Float32Array(delay);
    let position = 0;
    for (let index = 0; index < wet.length; index += 1) {
      const delayed = line[position];
      const value = wet[index] + delayed * 0.5;
      line[position] = value;
      wet[index] = delayed - value * 0.5;
      position = (position + 1) % delay;
    }
  }
  const preDelay = Math.max(0, Math.round((preDelayMs / 1000) * sampleRate));
  for (let index = 0; index < buffer.length; index += 1) {
    const wetIndex = index - preDelay;
    const wetValue = wetIndex >= 0 ? wet[wetIndex] : 0;
    buffer[index] = dry[index] * (1 - mix) + wetValue * mix;
  }
  return buffer;
}

/** Remove DC offset in place. */
function dcBlock(buffer, sampleRate) {
  const alpha = 1 - 1 / (sampleRate * 0.005);
  let previousInput = 0;
  let previousOutput = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const input = buffer[index];
    const output = input - previousInput + alpha * previousOutput;
    previousInput = input;
    previousOutput = output;
    buffer[index] = output;
  }
  return buffer;
}

/** Soft saturation in place. */
function softClip(buffer, drive = 1.2) {
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = Math.tanh(buffer[index] * drive) / Math.tanh(drive);
  }
  return buffer;
}

/** Fade the first and last `ms` milliseconds so edges never click. */
function fadeEdges(buffer, sampleRate, ms = 3) {
  const samples = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const limit = Math.min(samples, Math.floor(buffer.length / 2));
  for (let index = 0; index < limit; index += 1) {
    const gain = index / limit;
    buffer[index] *= gain;
    buffer[buffer.length - 1 - index] *= gain;
  }
  return buffer;
}

/** Scale a buffer to `target` peak. */
function normalizePeak(buffer, target) {
  let peak = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = Math.abs(buffer[index]);
    if (value > peak) peak = value;
  }
  if (peak < 1e-9) return buffer;
  const gain = target / peak;
  for (let index = 0; index < buffer.length; index += 1) buffer[index] *= gain;
  return buffer;
}

/** Scale a buffer to `target` RMS. */
function normalizeRms(buffer, target) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
  const rms = Math.sqrt(sum / Math.max(1, buffer.length));
  if (rms < 1e-9) return buffer;
  const gain = target / rms;
  for (let index = 0; index < buffer.length; index += 1) buffer[index] *= gain;
  return buffer;
}

/** Add `source` into `target` at a sample offset. */
function mixInto(target, source, gain = 1, offset = 0) {
  const start = Math.max(0, Math.round(offset));
  const length = Math.min(source.length, target.length - start);
  for (let index = 0; index < length; index += 1) target[start + index] += source[index] * gain;
  return target;
}

/** Turn a mono signal into a decorrelated stereo pair. */
function stereoize(mono, sampleRate, { width = 0.6, haasMs = 0, rand = Math.random } = {}) {
  const left = Float32Array.from(mono);
  const right = Float32Array.from(mono);
  if (haasMs > 0) {
    const delay = Math.max(1, Math.round((haasMs / 1000) * sampleRate));
    for (let index = mono.length - 1; index >= delay; index -= 1) right[index] = mono[index - delay];
    for (let index = 0; index < delay; index += 1) right[index] = 0;
  }
  if (width > 0) {
    const noise = whiteNoise(mono.length, rand);
    onePoleLowpass(noise, 4000, sampleRate);
    for (let index = 0; index < mono.length; index += 1) {
      left[index] *= 1 - width * 0.5;
      right[index] *= 1 - width * 0.5;
      left[index] += noise[index] * width * 0.12;
      right[index] -= noise[index] * width * 0.12;
    }
  }
  return { left, right };
}

/** Place `source` on both channels with a stereo offset. */
function placeStereo(target, source, gain, offset, width, sampleRate, rand) {
  const { left, right } = stereoize(source, sampleRate, { width, rand });
  mixInto(target.left, left, gain, offset);
  mixInto(target.right, right, gain, offset);
  return target;
}

/** Empty stereo accumulator. */
function stereoBuffer(length) {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

/** Time offset in samples. */
function at(seconds, sampleRate) {
  return Math.round(seconds * sampleRate);
}

/** A short filtered noise burst, the raw material of most foley. */
function noiseBurst(length, sampleRate, rand, { color = 'white', band = [400, 3000], q = 0.9 } = {}) {
  const source = color === 'pink' ? pinkNoise(length, rand) : color === 'brown' ? brownNoise(length, rand) : whiteNoise(length, rand);
  biquad(source, 'bandpass', Math.sqrt(band[0] * band[1]), sampleRate, q);
  return source;
}

/** Bell-like voice: inharmonic partials, the sound of struck metal. */
function bellVoice(length, sampleRate, frequency, { decay = 0.9, brightness = 0.5 } = {}) {
  return additiveTone(length, sampleRate, {
    frequency,
    ratios: [1, 2.01, 2.99, 4.16, 5.43, 6.79, 8.21],
    decays: [decay, decay * 0.7, decay * 0.55, decay * 0.4, decay * 0.3, decay * 0.22, decay * 0.16],
    gains: [1, 0.55, 0.36, 0.24 * brightness, 0.18 * brightness, 0.12 * brightness, 0.08 * brightness],
  });
}

/**
 * Recipes. Each returns a stereo pair already shaped in time and level; the
 * shared finish pass then removes DC, soft clips, fades and normalises.
 */
const RECIPES = {
  whoosh(n, sr, p) {
    const source = noiseBurst(n, sr, p.rand, { band: [300, 2400], q: 0.7 });
    const centre = 380 + p.brightness * 2600;
    biquad(source, 'bandpass', centre, sr, 1.1);
    const envelope = new Float32Array(n);
    for (let index = 0; index < n; index += 1) {
      const t = index / n;
      envelope[index] = Math.sin(Math.PI * t ** 0.65) ** 1.4;
    }
    applyEnvelope(source, envelope);
    const doppler = sineSweep(n, sr, { f0: centre * 0.6, f1: centre * 1.5, glide: 0.6 });
    for (let index = 0; index < n; index += 1) source[index] += doppler[index] * 0.05 * p.intensity;
    return stereoize(source, sr, { width: 0.8, haasMs: 4, rand: p.rand });
  },

  swoosh(n, sr, p) {
    const source = noiseBurst(n, sr, p.rand, { band: [600, 5000], q: 0.6 });
    const envelope = ramp(n, 2.2);
    for (let index = 0; index < n; index += 1) envelope[index] = Math.sin(Math.PI * (index / n)) ** 2;
    applyEnvelope(source, envelope);
    biquad(source, 'highpass', 500, sr, 0.7);
    return stereoize(source, sr, { width: 0.9, haasMs: 2, rand: p.rand });
  },

  impact(n, sr, p) {
    const out = stereoBuffer(n);
    const body = sineSweep(n, sr, { f0: 120 * (1 + p.variation * 0.2), f1: 38, glide: 0.35 });
    applyEnvelope(body, decayEnvelope(n, sr, 0.28 + p.intensity * 0.2));
    mixInto(out.left, body, 0.95, 0);
    mixInto(out.right, body, 0.95, 0);
    const transient = noiseBurst(at(0.12, sr), sr, p.rand, { band: [900, 7000], q: 0.5 });
    applyEnvelope(transient, decayEnvelope(transient.length, sr, 0.05));
    placeStereo(out, transient, 0.7 * p.intensity, 0, 0.5, sr, p.rand);
    const tail = noiseBurst(at(0.5, sr), sr, p.rand, { band: [200, 2200], q: 0.4 });
    applyEnvelope(tail, decayEnvelope(tail.length, sr, 0.18));
    placeStereo(out, tail, 0.28, at(0.01, sr), 0.7, sr, p.rand);
    schroederReverb(out.left, sr, { rt60: 1.1, mix: 0.18 });
    schroederReverb(out.right, sr, { rt60: 1.1, mix: 0.18 });
    return out;
  },

  'sub-drop'(n, sr, p) {
    const body = sineSweep(n, sr, { f0: 90, f1: 24, glide: 0.5 });
    applyEnvelope(body, decayEnvelope(n, sr, 0.45 + p.intensity * 0.25));
    const click = noiseBurst(at(0.02, sr), sr, p.rand, { band: [1200, 6000], q: 0.6 });
    applyEnvelope(click, decayEnvelope(click.length, sr, 0.012));
    const out = stereoBuffer(n);
    mixInto(out.left, body, 1, 0);
    mixInto(out.right, body, 1, 0);
    mixInto(out.left, click, 0.18 * p.intensity, 0);
    mixInto(out.right, click, 0.18 * p.intensity, 0);
    return out;
  },

  riser(n, sr, p) {
    const out = stereoBuffer(n);
    const air = noiseBurst(n, sr, p.rand, { band: [400, 9000], q: 0.5 });
    const envelope = ramp(n, 2.6);
    applyEnvelope(air, envelope);
    placeStereo(out, air, 0.7, 0, 0.9, sr, p.rand);
    const tone = sineSweep(n, sr, { f0: 220, f1: 1400 + p.brightness * 900, glide: 0.85 });
    const tremolo = new Float32Array(n);
    for (let index = 0; index < n; index += 1) {
      const t = index / n;
      const rate = 4 + t * 26;
      tremolo[index] = 0.55 + 0.45 * Math.sin(TAU * rate * (index / sr));
    }
    applyEnvelope(tone, tremolo);
    placeStereo(out, tone, 0.32 * p.intensity, 0, 0.4, sr, p.rand);
    return out;
  },

  downlifter(n, sr, p) {
    const out = stereoBuffer(n);
    const air = noiseBurst(n, sr, p.rand, { band: [300, 8000], q: 0.5 });
    const envelope = new Float32Array(n);
    for (let index = 0; index < n; index += 1) envelope[index] = (1 - index / n) ** 2;
    applyEnvelope(air, envelope);
    placeStereo(out, air, 0.7, 0, 0.9, sr, p.rand);
    const tone = sineSweep(n, sr, { f0: 1200, f1: 160, glide: 0.9 });
    applyEnvelope(tone, envelope);
    placeStereo(out, tone, 0.3 * p.intensity, 0, 0.4, sr, p.rand);
    return out;
  },

  'reverse-cymbal'(n, sr, p) {
    const out = stereoBuffer(n);
    const crashLength = at(1.4, sr);
    const crash = noiseBurst(crashLength, sr, p.rand, { band: [2500, 12000], q: 0.4 });
    biquad(crash, 'highpass', 2000, sr, 0.7);
    applyEnvelope(crash, decayEnvelope(crashLength, sr, 0.5));
    // Reverse it: the swell arrives at the downbeat.
    const reversed = new Float32Array(n);
    const offset = Math.max(0, n - crashLength);
    for (let index = 0; index < crashLength && offset + index < n; index += 1) {
      reversed[offset + index] = crash[crashLength - 1 - index];
    }
    const swell = ramp(n, 3);
    applyEnvelope(reversed, swell);
    placeStereo(out, reversed, 0.9, 0, 0.9, sr, p.rand);
    return out;
  },

  transition(n, sr, p) {
    const out = stereoBuffer(n);
    const half = Math.floor(n * 0.55);
    const swoosh = noiseBurst(half, sr, p.rand, { band: [500, 6000], q: 0.6 });
    const swell = ramp(half, 2.4);
    applyEnvelope(swoosh, swell);
    placeStereo(out, swoosh, 0.65, 0, 0.9, sr, p.rand);
    const hit = sineSweep(n - half, sr, { f0: 110, f1: 40, glide: 0.4 });
    applyEnvelope(hit, decayEnvelope(hit.length, sr, 0.3));
    mixInto(out.left, hit, 0.8, half);
    mixInto(out.right, hit, 0.8, half);
    schroederReverb(out.left, sr, { rt60: 1.2, mix: 0.2 });
    schroederReverb(out.right, sr, { rt60: 1.2, mix: 0.2 });
    return out;
  },

  click(n, sr, p) {
    const source = noiseBurst(n, sr, p.rand, { band: [1800, 9000], q: 0.8 });
    applyEnvelope(source, decayEnvelope(n, sr, 0.004 + p.variation * 0.004));
    const thump = sineSweep(n, sr, { f0: 900, f1: 320, glide: 0.3 });
    applyEnvelope(thump, decayEnvelope(n, sr, 0.008));
    for (let index = 0; index < n; index += 1) source[index] = source[index] * 0.8 + thump[index] * 0.5;
    return stereoize(source, sr, { width: 0.15, rand: p.rand });
  },

  pop(n, sr, p) {
    const body = sineSweep(n, sr, { f0: 720 + p.variation * 260, f1: 160, glide: 0.25 });
    applyEnvelope(body, decayEnvelope(n, sr, 0.035));
    return stereoize(body, sr, { width: 0.25, rand: p.rand });
  },

  beep(n, sr, p) {
    const frequency = 720 + p.brightness * 1400;
    const body = sineSweep(n, sr, { f0: frequency, f1: frequency, glide: 0 });
    const envelope = adsrEnvelope(n, sr, { attack: 0.004, decay: 0.02, sustain: 0.85, release: 0.03 });
    applyEnvelope(body, envelope);
    biquad(body, 'lowpass', 6000, sr, 0.7);
    return stereoize(body, sr, { width: 0.1, rand: p.rand });
  },

  notification(n, sr, p) {
    const out = stereoBuffer(n);
    const first = additiveTone(at(0.35, sr), sr, {
      frequency: 880,
      ratios: [1, 2.01, 3.02, 4.4],
      decays: [0.18, 0.12, 0.08, 0.05],
      gains: [1, 0.4, 0.2, 0.1],
    });
    const second = additiveTone(at(0.5, sr), sr, {
      frequency: 1320,
      ratios: [1, 2.01, 3.02, 4.4],
      decays: [0.22, 0.15, 0.09, 0.06],
      gains: [1, 0.4, 0.2, 0.1],
    });
    placeStereo(out, first, 0.8, 0, 0.35, sr, p.rand);
    placeStereo(out, second, 0.8, at(0.12, sr), 0.35, sr, p.rand);
    schroederReverb(out.left, sr, { rt60: 0.9, mix: 0.16 });
    schroederReverb(out.right, sr, { rt60: 0.9, mix: 0.16 });
    return out;
  },

  chime(n, sr, p) {
    const out = stereoBuffer(n);
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const step = n / (notes.length + 1.4);
    notes.forEach((frequency, index) => {
      const voice = bellVoice(at(1.3, sr), sr, frequency, { decay: 0.55, brightness: p.brightness });
      placeStereo(out, voice, 0.55, step * index, 0.5, sr, p.rand);
    });
    schroederReverb(out.left, sr, { rt60: 1.3, mix: 0.22 });
    schroederReverb(out.right, sr, { rt60: 1.3, mix: 0.22 });
    return out;
  },

  bell(n, sr, p) {
    const frequency = 392 * (1 + p.variation * 0.12);
    const voice = bellVoice(n, sr, frequency, { decay: 1.1 + p.intensity * 0.4, brightness: p.brightness });
    const out = stereoBuffer(n);
    placeStereo(out, voice, 0.9, 0, 0.4, sr, p.rand);
    schroederReverb(out.left, sr, { rt60: 1.8, mix: 0.24 });
    schroederReverb(out.right, sr, { rt60: 1.8, mix: 0.24 });
    return out;
  },

  alarm(n, sr, p) {
    const out = stereoBuffer(n);
    const period = at(0.22, sr);
    const toneLength = at(0.16, sr);
    for (let start = 0; start + toneLength < n; start += period) {
      const frequency = start % (period * 2) === 0 ? 880 : 660;
      const tone = sineSweep(toneLength, sr, { f0: frequency, f1: frequency, glide: 0 });
      applyEnvelope(tone, adsrEnvelope(toneLength, sr, { attack: 0.004, decay: 0.02, sustain: 0.9, release: 0.02 }));
      biquad(tone, 'lowpass', 4000, sr, 0.8);
      placeStereo(out, tone, 0.75, start, 0.3, sr, p.rand);
    }
    return out;
  },

  laser(n, sr, p) {
    const body = sineSweep(n, sr, { f0: 2600 + p.variation * 800, f1: 260, glide: 0.3 });
    applyEnvelope(body, decayEnvelope(n, sr, 0.09));
    const fm = fmTone(n, sr, { carrier: 1800, ratio: 3.5, index: 6 * p.intensity, decay: 0.08 });
    applyEnvelope(fm, decayEnvelope(n, sr, 0.06));
    for (let index = 0; index < n; index += 1) body[index] = body[index] * 0.85 + fm[index] * 0.25;
    return stereoize(body, sr, { width: 0.35, rand: p.rand });
  },

  powerup(n, sr, p) {
    const out = stereoBuffer(n);
    const notes = [392, 523.25, 659.25, 783.99, 1046.5];
    const step = n / (notes.length + 0.8);
    notes.forEach((frequency, index) => {
      const length = at(0.28, sr);
      const voice = new Float32Array(length);
      for (let sample = 0; sample < length; sample += 1) {
        const phase = (TAU * frequency * sample) / sr;
        voice[sample] = Math.sign(Math.sin(phase)) * 0.6 + Math.sin(phase) * 0.4;
      }
      applyEnvelope(voice, adsrEnvelope(length, sr, { attack: 0.003, decay: 0.05, sustain: 0.6, release: 0.08 }));
      biquad(voice, 'lowpass', 5200, sr, 0.7);
      placeStereo(out, voice, 0.5, step * index, 0.4, sr, p.rand);
    });
    return out;
  },

  coin(n, sr, p) {
    const out = stereoBuffer(n);
    const first = additiveTone(at(0.14, sr), sr, { frequency: 987.77, ratios: [1, 2.01, 3.02], decays: [0.09, 0.06, 0.04], gains: [1, 0.4, 0.18] });
    const second = additiveTone(at(0.24, sr), sr, { frequency: 1318.5, ratios: [1, 2.01, 3.02], decays: [0.14, 0.09, 0.05], gains: [1, 0.4, 0.18] });
    placeStereo(out, first, 0.8, 0, 0.25, sr, p.rand);
    placeStereo(out, second, 0.8, at(0.07, sr), 0.25, sr, p.rand);
    return out;
  },

  magic(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const sparkleCount = 16 + Math.round(p.intensity * 12);
    for (let index = 0; index < sparkleCount; index += 1) {
      const start = Math.floor(rand() * n * 0.8);
      const length = at(0.12 + rand() * 0.2, sr);
      const frequency = 1200 + rand() * 3800;
      const voice = additiveTone(length, sr, { frequency, ratios: [1, 2.01, 3.99], decays: [0.12, 0.07, 0.04], gains: [1, 0.3, 0.14] });
      placeStereo(out, voice, 0.22, start, 0.7, sr, rand);
    }
    const shimmer = noiseBurst(n, sr, rand, { band: [3000, 11000], q: 0.5 });
    const swell = new Float32Array(n);
    for (let index = 0; index < n; index += 1) swell[index] = Math.sin(Math.PI * (index / n)) ** 2;
    applyEnvelope(shimmer, swell);
    placeStereo(out, shimmer, 0.18 * p.brightness, 0, 0.8, sr, rand);
    schroederReverb(out.left, sr, { rt60: 1.6, mix: 0.28 });
    schroederReverb(out.right, sr, { rt60: 1.6, mix: 0.28 });
    return out;
  },

  glitch(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    let cursor = 0;
    while (cursor < n) {
      const blockLength = Math.min(n - cursor, at(0.01 + rand() * 0.06, sr));
      if (rand() < 0.25) {
        cursor += blockLength;
        continue;
      }
      const block = new Float32Array(blockLength);
      const mode = rand();
      for (let index = 0; index < blockLength; index += 1) {
        if (mode < 0.4) {
          block[index] = Math.sign(Math.sin((TAU * (200 + rand() * 40) * index) / sr));
        } else if (mode < 0.7) {
          block[index] = rand() * 2 - 1;
        } else {
          const bitDepth = 4 + Math.round(rand() * 8);
          const steps = 2 ** bitDepth;
          block[index] = Math.round(Math.sin((TAU * 440 * index) / sr) * steps) / steps;
        }
      }
      placeStereo(out, block, 0.4 + rand() * 0.3, cursor, 0.6, sr, rand);
      cursor += blockLength;
    }
    return out;
  },

  static(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const bed = noiseBurst(n, sr, rand, { band: [1200, 9000], q: 0.35 });
    biquad(bed, 'highpass', 900, sr, 0.7);
    const dropouts = new Float32Array(n);
    for (let index = 0; index < n; index += 1) dropouts[index] = rand() < 0.002 ? 0.1 : 1;
    for (let index = 0; index < n; index += 1) bed[index] *= dropouts[index];
    placeStereo(out, bed, 0.55, 0, 1, sr, rand);
    return out;
  },

  explosion(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const blast = noiseBurst(at(0.6, sr), sr, rand, { band: [60, 900], q: 0.35 });
    applyEnvelope(blast, decayEnvelope(blast.length, sr, 0.22));
    placeStereo(out, blast, 1, 0, 0.6, sr, rand);
    const rumble = brownNoise(n, rand);
    onePoleLowpass(rumble, 180, sr);
    applyEnvelope(rumble, decayEnvelope(n, sr, 0.7 + p.intensity * 0.5));
    mixInto(out.left, rumble, 0.7, 0);
    mixInto(out.right, rumble, 0.7, 0);
    const crack = noiseBurst(at(0.12, sr), sr, rand, { band: [2000, 12000], q: 0.4 });
    applyEnvelope(crack, decayEnvelope(crack.length, sr, 0.03));
    placeStereo(out, crack, 0.5 * p.intensity, 0, 0.8, sr, rand);
    schroederReverb(out.left, sr, { rt60: 1.9, mix: 0.24 });
    schroederReverb(out.right, sr, { rt60: 1.9, mix: 0.24 });
    return out;
  },

  footsteps(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const stepCount = Math.max(3, Math.floor(n / at(0.5, sr)));
    for (let step = 0; step < stepCount; step += 1) {
      const start = at(step * 0.5 + rand() * 0.04, sr);
      const heel = sineSweep(at(0.09, sr), sr, { f0: 160 + rand() * 60, f1: 60, glide: 0.4 });
      applyEnvelope(heel, decayEnvelope(heel.length, sr, 0.035));
      const scuff = noiseBurst(at(0.11, sr), sr, rand, { band: [700, 3800], q: 0.7 });
      applyEnvelope(scuff, decayEnvelope(scuff.length, sr, 0.03));
      const pan = 0.5 + (rand() - 0.5) * 0.4;
      const leftGain = 0.45 + (1 - pan) * 0.4;
      const rightGain = 0.45 + pan * 0.4;
      mixInto(out.left, heel, leftGain, start);
      mixInto(out.right, heel, rightGain, start);
      mixInto(out.left, scuff, leftGain * 0.5, start);
      mixInto(out.right, scuff, rightGain * 0.5, start);
    }
    return out;
  },

  door(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const creakLength = at(0.75, sr);
    const creak = new Float32Array(creakLength);
    let phase = 0;
    for (let index = 0; index < creakLength; index += 1) {
      const t = index / creakLength;
      const frequency = 180 + Math.sin(t * 26) * 60 + t * 120;
      phase += (TAU * frequency) / sr;
      const saw = ((phase / TAU) % 1) * 2 - 1;
      creak[index] = saw * (0.4 + 0.6 * Math.abs(Math.sin(t * 40)));
    }
    biquad(creak, 'bandpass', 900, sr, 2.2);
    applyEnvelope(creak, adsrEnvelope(creakLength, sr, { attack: 0.08, decay: 0.2, sustain: 0.5, release: 0.3 }));
    placeStereo(out, creak, 0.5 * p.intensity, 0, 0.5, sr, rand);
    const thudLength = at(0.3, sr);
    const thud = sineSweep(thudLength, sr, { f0: 120, f1: 45, glide: 0.4 });
    applyEnvelope(thud, decayEnvelope(thudLength, sr, 0.08));
    mixInto(out.left, thud, 0.8, at(0.8, sr));
    mixInto(out.right, thud, 0.8, at(0.8, sr));
    return out;
  },

  'camera-shutter'(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const first = noiseBurst(at(0.04, sr), sr, rand, { band: [1800, 9000], q: 0.9 });
    applyEnvelope(first, decayEnvelope(first.length, sr, 0.006));
    placeStereo(out, first, 0.9, 0, 0.3, sr, rand);
    const second = noiseBurst(at(0.05, sr), sr, rand, { band: [1400, 7000], q: 0.9 });
    applyEnvelope(second, decayEnvelope(second.length, sr, 0.008));
    placeStereo(out, second, 0.75, at(0.075, sr), 0.3, sr, rand);
    const mech = sineSweep(at(0.06, sr), sr, { f0: 420, f1: 220, glide: 0.4 });
    applyEnvelope(mech, decayEnvelope(mech.length, sr, 0.02));
    mixInto(out.left, mech, 0.3, at(0.07, sr));
    mixInto(out.right, mech, 0.3, at(0.07, sr));
    return out;
  },

  typing(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    let cursor = 0;
    while (cursor < n - at(0.05, sr)) {
      const length = at(0.025, sr);
      const key = noiseBurst(length, sr, rand, { band: [1200 + rand() * 1500, 6000], q: 1.1 });
      applyEnvelope(key, decayEnvelope(length, sr, 0.004 + rand() * 0.004));
      const pan = 0.5 + (rand() - 0.5) * 0.5;
      mixInto(out.left, key, (1 - pan) * 0.9, cursor);
      mixInto(out.right, key, pan * 0.9, cursor);
      cursor += at(0.055 + rand() * 0.11, sr);
    }
    return out;
  },

  'page-turn'(n, sr, p) {
    const source = noiseBurst(n, sr, p.rand, { band: [900, 7000], q: 0.5 });
    const envelope = new Float32Array(n);
    for (let index = 0; index < n; index += 1) {
      const t = index / n;
      envelope[index] = Math.sin(Math.PI * t ** 0.7) ** 1.6;
    }
    applyEnvelope(source, envelope);
    const flutter = new Float32Array(n);
    for (let index = 0; index < n; index += 1) flutter[index] = 1 + 0.3 * Math.sin((TAU * 22 * index) / sr);
    for (let index = 0; index < n; index += 1) source[index] *= flutter[index];
    return stereoize(source, sr, { width: 0.6, haasMs: 3, rand: p.rand });
  },

  rain(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const bed = pinkNoise(n, rand);
    biquad(bed, 'highpass', 400, sr, 0.7);
    biquad(bed, 'lowpass', 7000 + p.brightness * 3000, sr, 0.7);
    placeStereo(out, bed, 0.45, 0, 1, sr, rand);
    const droplets = Math.floor((n / sr) * 90);
    for (let index = 0; index < droplets; index += 1) {
      const start = Math.floor(rand() * n);
      const length = at(0.02 + rand() * 0.03, sr);
      if (start + length >= n) continue;
      const drop = sineSweep(length, sr, { f0: 2200 + rand() * 3000, f1: 900 + rand() * 600, glide: 0.3 });
      applyEnvelope(drop, decayEnvelope(length, sr, 0.006));
      const pan = rand();
      mixInto(out.left, drop, (1 - pan) * 0.18, start);
      mixInto(out.right, drop, pan * 0.18, start);
    }
    return out;
  },

  wind(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const gust = brownNoise(n, rand);
    onePoleLowpass(gust, 300 + p.brightness * 500, sr);
    for (let index = 0; index < n; index += 1) {
      const t = index / sr;
      const swell = 0.55 + 0.45 * Math.sin((TAU * 0.19 * t) + Math.sin(TAU * 0.07 * t) * 2);
      gust[index] *= swell;
    }
    placeStereo(out, gust, 1.1, 0, 0.9, sr, rand);
    const hiss = noiseBurst(n, sr, rand, { band: [900, 5200], q: 0.4 });
    for (let index = 0; index < n; index += 1) {
      const t = index / sr;
      hiss[index] *= 0.5 + 0.5 * Math.sin((TAU * 0.11 * t) + 1.3);
    }
    placeStereo(out, hiss, 0.28 * p.intensity, 0, 1, sr, rand);
    return out;
  },

  fire(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const bed = brownNoise(n, rand);
    onePoleLowpass(bed, 500, sr);
    placeStereo(out, bed, 0.5, 0, 0.7, sr, rand);
    const crackles = Math.floor((n / sr) * 26);
    for (let index = 0; index < crackles; index += 1) {
      const start = Math.floor(rand() * (n - at(0.05, sr)));
      const length = at(0.01 + rand() * 0.04, sr);
      const crackle = noiseBurst(length, sr, rand, { band: [1500 + rand() * 3000, 9000], q: 0.9 });
      applyEnvelope(crackle, decayEnvelope(length, sr, 0.004 + rand() * 0.01));
      const pan = rand();
      mixInto(out.left, crackle, (1 - pan) * 0.5, start);
      mixInto(out.right, crackle, pan * 0.5, start);
    }
    return out;
  },

  water(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const bed = noiseBurst(n, sr, rand, { band: [300, 2600], q: 0.5 });
    placeStereo(out, bed, 0.22, 0, 0.8, sr, rand);
    const bubbles = Math.floor((n / sr) * 34);
    for (let index = 0; index < bubbles; index += 1) {
      const start = Math.floor(rand() * (n - at(0.12, sr)));
      const length = at(0.03 + rand() * 0.07, sr);
      const bubble = sineSweep(length, sr, { f0: 320 + rand() * 300, f1: 700 + rand() * 900, glide: 0.6 });
      applyEnvelope(bubble, decayEnvelope(length, sr, 0.02));
      const pan = rand();
      mixInto(out.left, bubble, (1 - pan) * 0.22, start);
      mixInto(out.right, bubble, pan * 0.22, start);
    }
    return out;
  },

  crowd(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const voices = 26;
    for (let index = 0; index < voices; index += 1) {
      const length = at(0.35 + rand() * 0.9, sr);
      const start = Math.floor(rand() * Math.max(1, n - length));
      const voice = noiseBurst(length, sr, rand, { band: [300 + rand() * 500, 1400 + rand() * 1400], q: 2.4 });
      applyEnvelope(voice, adsrEnvelope(length, sr, { attack: 0.08, decay: 0.15, sustain: 0.5, release: 0.25 }));
      const pan = rand();
      mixInto(out.left, voice, (1 - pan) * 0.35, start);
      mixInto(out.right, voice, pan * 0.35, start);
    }
    const murmur = pinkNoise(n, rand);
    biquad(murmur, 'bandpass', 700, sr, 0.8);
    placeStereo(out, murmur, 0.3, 0, 1, sr, rand);
    return out;
  },

  'horror-drone'(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const base = 42 + p.variation * 12;
    for (const [detune, gain] of [
      [1, 0.5],
      [1.006, 0.4],
      [1.5, 0.18],
    ]) {
      const tone = sineSweep(n, sr, { f0: base * detune, f1: base * detune * 1.01, glide: 0.9 });
      for (let index = 0; index < n; index += 1) {
        const t = index / sr;
        tone[index] *= 0.6 + 0.4 * Math.sin(TAU * 0.06 * t);
      }
      mixInto(out.left, tone, gain * (1 - (detune - 1) * 6), 0);
      mixInto(out.right, tone, gain * (1 + (detune - 1) * 6), 0);
    }
    const air = noiseBurst(n, sr, rand, { band: [200, 1800], q: 0.4 });
    const swell = ramp(n, 2.2);
    applyEnvelope(air, swell);
    placeStereo(out, air, 0.16, 0, 0.9, sr, rand);
    return out;
  },

  heartbeat(n, sr, p) {
    const out = stereoBuffer(n);
    const period = at(60 / 72, sr);
    for (let start = 0; start < n; start += period) {
      const lubLength = at(0.16, sr);
      const lub = sineSweep(lubLength, sr, { f0: 70, f1: 42, glide: 0.5 });
      applyEnvelope(lub, decayEnvelope(lubLength, sr, 0.05));
      mixInto(out.left, lub, 0.9, start);
      mixInto(out.right, lub, 0.9, start);
      const dubLength = at(0.12, sr);
      const dub = sineSweep(dubLength, sr, { f0: 60, f1: 36, glide: 0.5 });
      applyEnvelope(dub, decayEnvelope(dubLength, sr, 0.04));
      mixInto(out.left, dub, 0.65, start + at(0.28, sr));
      mixInto(out.right, dub, 0.65, start + at(0.28, sr));
    }
    return out;
  },

  engine(n, sr, p) {
    const out = stereoBuffer(n);
    const rand = p.rand;
    const fundamental = 48 + p.variation * 22;
    const voice = new Float32Array(n);
    for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
      const frequency = fundamental * harmonic;
      let phase = 0;
      const gain = 1 / (harmonic ** 1.3);
      for (let index = 0; index < n; index += 1) {
        const t = index / sr;
        const wobble = 1 + 0.004 * Math.sin(TAU * (5 + harmonic) * t);
        phase += (TAU * frequency * wobble) / sr;
        voice[index] += Math.sin(phase) * gain;
      }
    }
    for (let index = 0; index < n; index += 1) {
      const t = index / sr;
      voice[index] *= 0.7 + 0.3 * Math.sin(TAU * 3.2 * t);
    }
    biquad(voice, 'lowpass', 900 + p.brightness * 1600, sr, 0.8);
    placeStereo(out, voice, 0.7, 0, 0.4, sr, rand);
    const hiss = noiseBurst(n, sr, rand, { band: [1200, 6000], q: 0.5 });
    placeStereo(out, hiss, 0.1 * p.intensity, 0, 0.7, sr, rand);
    return out;
  },
};

/**
 * Crossfade the tail into the head and drop the tail, so playback from the
 * last sample back to the first continues the same waveform. The caller
 * renders `fadeSamples` extra frames, which keeps the final length exact.
 */
function makeLoopable(channels, fadeSamples) {
  if (fadeSamples < 8) return channels;
  return channels.map((channel) => {
    const out = new Float32Array(channel.length - fadeSamples);
    for (let index = 0; index < fadeSamples; index += 1) {
      const weight = index / fadeSamples;
      out[index] = channel[index] * weight + channel[channel.length - fadeSamples + index] * (1 - weight);
    }
    out.set(channel.subarray(fadeSamples, channel.length - fadeSamples), fadeSamples);
    return out;
  });
}

/** Peak, RMS, DC offset and an approximate loudness reading for one render. */
export function measureSamples(channels) {
  let peak = 0;
  let sum = 0;
  let dc = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const value = channel[index];
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sum += value * value;
      dc += value;
      count += 1;
    }
  }
  const rms = count === 0 ? 0 : Math.sqrt(sum / count);
  // Loudness is 10·log₁₀(mean square), and the mean square is RMS², so this
  // is 20·log₁₀(RMS); using 10·log₁₀(RMS) would read 6 dB too quiet.
  const lufs = rms < 1e-9 ? -Infinity : -0.691 + 20 * Math.log10(rms);
  return { peak, rms, lufs, dc: count === 0 ? 0 : dc / count };
}

/** Subtract the mean so a rendered effect sits exactly on zero. */
function removeDc(buffer) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) sum += buffer[index];
  const mean = sum / Math.max(1, buffer.length);
  for (let index = 0; index < buffer.length; index += 1) buffer[index] -= mean;
  return buffer;
}

/** Finish one channel set: DC, soft clip, fades, loudness, peak ceiling. */
function finish(channels, sampleRate, { loop, ambience }) {
  for (const channel of channels) {
    dcBlock(channel, sampleRate);
    softClip(channel, 1.15);
  }
  const target = ambience ? 0.05 : 0.126;
  for (const channel of channels) removeDc(normalizeRms(channel, target));
  for (const channel of channels) normalizePeak(removeDc(channel), 0.891);
  // Fade last, so the edge samples are exactly zero whatever the gain pass did.
  if (!loop) for (const channel of channels) fadeEdges(channel, sampleRate, 4);
  return channels;
}

/**
 * Render one sound effect into memory.
 *
 * @param {object} input - `kind`, `duration`, `intensity`, `brightness`, `seed`,
 *   `sampleRate`, `channels`, `loop`, `variation`.
 * @returns {{ channels: Float32Array[], sampleRate: number, channelCount: number, duration: number, peak: number, rms: number, lufs: number }}
 */
export function renderSfx(input = {}) {
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!SFX_KINDS.includes(kind)) {
    const suggestions = SFX_KINDS.slice(0, 6).join(', ');
    throw new Error(
      `未知の効果音です: "${kind}"。指定できる種類: ${suggestions} など ${SFX_KINDS.length} 種。Unknown sound effect; pass one of the documented kinds.`,
    );
  }
  const defaults = SFX_DEFAULTS[kind];
  const sampleRate = SFX_SAMPLE_RATES.includes(Number(input.sampleRate)) ? Number(input.sampleRate) : 44100;
  const requested = Number.isFinite(Number(input.duration)) ? Number(input.duration) : defaults.duration;
  if (requested < MIN_SECONDS || requested > MAX_SECONDS) {
    throw new Error(
      `duration は ${MIN_SECONDS}〜${MAX_SECONDS} 秒の範囲で指定してください (指定値: ${requested})。Duration must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds.`,
    );
  }
  const channelCount = Number(input.channels) === 1 ? 1 : 2;
  const loop = input.loop === true || (input.loop === undefined && defaults.loop);
  const intensity = clamp01(input.intensity, 0.6);
  const brightness = clamp01(input.brightness, 0.5);
  const variation = clamp01(input.variation, 0);
  const seed = Number.isFinite(Number(input.seed)) ? Math.trunc(Number(input.seed)) : 1;
  const frames = Math.round(requested * sampleRate);
  const fadeSamples = loop ? Math.min(Math.round(sampleRate * 0.25), Math.floor(frames / 4)) : 0;
  const rand = mulberry32((hashText(kind) ^ Math.imul(seed, 2654435761) ^ Math.imul(Math.round(variation * 1000), 40503)) >>> 0);
  const recipe = RECIPES[kind];
  const rendered = recipe(frames + fadeSamples, sampleRate, { intensity, brightness, variation, rand });
  let channels = [rendered.left, rendered.right];
  finish(channels, sampleRate, { loop, ambience: AMBIENCE.has(kind) });
  // Loop after the finish pass, so the seam joins material that is already
  // levelled; a stateful filter would otherwise change the head and the tail
  // by different amounts and reopen the seam.
  if (loop) {
    channels = makeLoopable(channels, fadeSamples);
    for (const channel of channels) normalizePeak(removeDc(channel), 0.891);
  }
  if (channelCount === 1) {
    const mono = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) mono[index] = (channels[0][index] + channels[1][index]) * 0.5;
    channels = [mono];
  }
  const measured = measureSamples(channels);
  return {
    channels,
    sampleRate,
    channelCount: channels.length,
    duration: frames / sampleRate,
    peak: measured.peak,
    rms: measured.rms,
    lufs: measured.lufs,
  };
}

/** Clamp one optional 0..1 control. */
function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

/**
 * Encode channel data as a RIFF/WAVE PCM 16-bit file.
 *
 * @param {Float32Array[]} channels - one array per channel, equal lengths.
 * @param {number} sampleRate - frames per second.
 * @returns {Buffer} a complete `.wav` file.
 */
export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('エンコードするチャンネルがありません。No channels to encode.');
  const channelCount = channels.length;
  const frames = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frames) throw new Error('チャンネルごとの長さが違います。Channels must have equal length.');
  }
  const bytesPerSample = 2;
  const dataBytes = frames * channelCount * bytesPerSample;
  const padding = dataBytes % 2 === 0 ? 0 : 1;
  const buffer = Buffer.alloc(44 + dataBytes + padding);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes + padding, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = channels[channel][frame];
      const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
      buffer.writeInt16LE(Math.round(clamped * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}

