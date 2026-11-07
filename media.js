/**
 * Media Studio — provider-independent media helpers.
 *
 * This module is pure: no Cordis context, no ambient service lookup, and no
 * filesystem writes except the temporary directory a caller explicitly passes
 * in. It owns the wire shapes (Pollinations URL, OpenAI image/speech/
 * transcription payloads), the Windows SAPI script text, and the small media
 * inspections (WAV header, image signature) the Host half needs. Keeping them
 * here lets `node --test` exercise the exact bytes the Host sends without
 * booting a Harness profile.
 */

/** Aspect names the model-facing tools and the Media panel both accept. */
export const ASPECTS = ['square', 'landscape', 'portrait'];

/** Default pixel size per aspect for providers that accept arbitrary sides. */
export const ASPECT_SIZES = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1280, height: 768 },
  portrait: { width: 768, height: 1280 },
};

/** Size value accepted by OpenAI image endpoints, per aspect. */
export const OPENAI_SIZES = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
};

/** Lowest and highest side length handed to a free-form image endpoint. */
export const MIN_IMAGE_SIDE = 256;
export const MAX_IMAGE_SIDE = 1536;

/** Pollinations model used when the row names none. */
export const DEFAULT_POLLINATIONS_MODEL = 'flux';

/** OpenAI image model used when the row names none. */
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';

/** OpenAI speech model used when the row names none. */
export const DEFAULT_OPENAI_SPEECH_MODEL = 'gpt-4o-mini-tts';

/** OpenAI transcription model used when the row names none. */
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';

/** Voices offered for an OpenAI-compatible speech endpoint. */
export const OPENAI_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

/** One SAPI rate step, clamped to the range Windows accepts. */
export function normalizeRate(rate) {
  const value = Number.isFinite(rate) ? Math.round(rate) : 0;
  return Math.min(10, Math.max(-10, value));
}

/** Clamp a requested image side; `fallback` is used for non-numeric input. */
export function clampImageSide(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_IMAGE_SIDE, Math.max(MIN_IMAGE_SIDE, Math.round(numeric)));
}

/** Resolve the effective pixel size from an aspect name and optional sides. */
export function resolveImageSize(aspect, width, height) {
  const named = ASPECT_SIZES[aspect] ?? ASPECT_SIZES.square;
  return {
    width: clampImageSide(width, named.width),
    height: clampImageSide(height, named.height),
  };
}

/** Resolve the OpenAI `size` string for a request. */
export function resolveOpenAiSize(aspect, model) {
  if (typeof model === 'string' && model.startsWith('dall-e-2')) return '1024x1024';
  return OPENAI_SIZES[aspect] ?? OPENAI_SIZES.square;
}

/** Build the unauthenticated Pollinations image URL for a prompt. */
export function buildPollinationsUrl({ prompt, width, height, seed, model }) {
  const params = new URLSearchParams();
  params.set('width', String(width));
  params.set('height', String(height));
  params.set('nologo', 'true');
  params.set('model', model || DEFAULT_POLLINATIONS_MODEL);
  if (Number.isFinite(seed)) params.set('seed', String(Math.trunc(seed)));
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?${params.toString()}`;
}

/** Build the OpenAI-compatible image request body. */
export function openAiImageBody({ prompt, model, size, seed }) {
  const body = { model, prompt, n: 1, size };
  if (Number.isFinite(seed)) body.seed = Math.trunc(seed);
  return body;
}

/**
 * Decode an image-generation response into bytes and a declared media type.
 * Accepts `b64_json` (gpt-image-1) and `url` (dall-e-3) response shapes.
 * @returns {{data: Uint8Array, mediaType: string}|undefined}
 */
export function decodeOpenAiImagePayload(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const first = Array.isArray(payload.data) ? payload.data[0] : undefined;
  if (first === null || typeof first !== 'object') return undefined;
  if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    const data = Buffer.from(first.b64_json, 'base64');
    return { data: new Uint8Array(data), mediaType: sniffImageMediaType(data) ?? 'image/png' };
  }
  if (typeof first.url === 'string' && first.url.length > 0) {
    return { url: first.url };
  }
  return undefined;
}

/** Identify a published image from its magic bytes. */
export function sniffImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return undefined;
}

/** Media type from a response header, falling back to the bytes. */
export function imageMediaTypeFromResponse(contentType, bytes) {
  if (typeof contentType === 'string') {
    const normalized = contentType.split(';')[0].trim().toLowerCase();
    if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp' || normalized === 'image/gif') {
      return normalized;
    }
  }
  return sniffImageMediaType(bytes) ?? 'image/png';
}

/** True when the bytes start with a RIFF/WAVE header. */
export function isRiffWave(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 44
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

/**
 * Read the format facts of a canonical PCM WAV file.
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number, seconds: number}|undefined}
 */
export function readWaveInfo(bytes) {
  if (!isRiffWave(bytes) || bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (channels < 1 || sampleRate < 1 || bitsPerSample < 1) return undefined;
  let offset = 12;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      dataBytes = Math.min(size, bytes.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const seconds = bytesPerSecond > 0 && dataBytes > 0 ? dataBytes / bytesPerSecond : 0;
  return { sampleRate, channels, bitsPerSample, seconds };
}

/** True when the text needs a CJK-capable voice (Hiragana, Katakana, Han). */
export function hasCjkText(text) {
  return typeof text === 'string' && /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u.test(text);
}

/** Pick SAPI's `SelectVoice` name: the configured one, else a language match. */
export function chooseVoice(voices, requested, text) {
  const list = Array.isArray(voices) ? voices.filter((voice) => voice !== null && typeof voice === 'object') : [];
  if (typeof requested === 'string' && requested.trim() !== '') {
    const exact = list.find((voice) => voice.name === requested.trim());
    if (exact !== undefined) return exact.name;
    const insensitive = list.find((voice) => typeof voice.name === 'string'
      && voice.name.toLowerCase() === requested.trim().toLowerCase());
    if (insensitive !== undefined) return insensitive.name;
  }
  const cjk = hasCjkText(text);
  const wanted = cjk ? 'ja' : 'en';
  const localized = list.find((voice) => typeof voice.culture === 'string'
    && voice.culture.toLowerCase().startsWith(wanted));
  if (localized !== undefined) return localized.name;
  return list[0]?.name;
}

/** Strip characters Windows file names reject, keeping prose readable. */
export function safeFileStem(text, maxLength = 48) {
  const source = typeof text === 'string' ? text : '';
  const cleaned = source
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned.length > 0 ? cleaned : 'media';
}

/**
 * Render the PowerShell that lists installed SAPI voices as compact JSON.
 * Kept as a string so the Host writes exactly what the tests assert.
 */
export function sapiVoiceListScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    '  $rows = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {',
    "    [pscustomobject]@{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender }",
    '  })',
    '  ConvertTo-Json -InputObject $rows -Compress -Depth 3',
    '} finally { $synth.Dispose() }',
  ].join('\n');
}

/**
 * Render the PowerShell that synthesizes one WAV from an options JSON file.
 * The text never touches the command line: the script reads UTF-8 JSON, so
 * quotes, newlines, and Japanese prose arrive intact.
 */
export function sapiSynthesisScript() {
  return [
    'param([Parameter(Mandatory = $true)][string]$OptionsPath)',
    "$ErrorActionPreference = 'Stop'",
    "$options = Get-Content -LiteralPath $OptionsPath -Raw -Encoding UTF8 | ConvertFrom-Json",
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    "  if ($options.voice -is [string] -and $options.voice.Trim() -ne '') {",
    '    $synth.SelectVoice($options.voice)',
    '  } else {',
    '    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {',
    "      [pscustomobject]@{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name }",
    '    })',
    "    $cjk = $options.text -match '[\\u3040-\\u30ff\\u3400-\\u9fff]'",
    "    $wanted = if ($cjk) { 'ja' } else { 'en' }",
    '    $pick = $voices | Where-Object { $_.culture -like ($wanted + "*") } | Select-Object -First 1',
    '    $pickValue = if ($null -ne $pick) { $pick.name } else { $voices[0].name }',
    '    if ($null -ne $pickValue) { $synth.SelectVoice($pickValue) }',
    '  }',
    '  $synth.Rate = [int]$options.rate',
    '  $synth.SetOutputToWaveFile($options.output)',
    '  $synth.Speak([string]$options.text)',
    '} finally { $synth.Dispose() }',
  ].join('\n');
}
