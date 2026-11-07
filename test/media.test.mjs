import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASPECTS,
  OPENAI_SIZES,
  buildPollinationsUrl,
  chooseVoice,
  clampImageSide,
  decodeOpenAiImagePayload,
  hasCjkText,
  imageMediaTypeFromResponse,
  isRiffWave,
  normalizeRate,
  openAiImageBody,
  readWaveInfo,
  resolveImageSize,
  resolveOpenAiSize,
  safeFileStem,
  sapiSynthesisScript,
  sapiVoiceListScript,
  sniffImageMediaType,
} from '../media.js';

/** Build a canonical mono PCM16 WAV with a silent payload. */
function waveBytes({ sampleRate = 16000, channels = 1, seconds = 0.5 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

test('aspect sizes stay inside the provider bounds', () => {
  assert.deepEqual(ASPECTS, ['square', 'landscape', 'portrait']);
  assert.deepEqual(resolveImageSize('landscape'), { width: 1280, height: 768 });
  assert.deepEqual(resolveImageSize('unknown'), { width: 1024, height: 1024 });
  assert.deepEqual(resolveImageSize('square', 999999, 1), { width: 1536, height: 256 });
  assert.equal(clampImageSide('not a number', 768), 768);
  assert.equal(resolveOpenAiSize('portrait'), OPENAI_SIZES.portrait);
  assert.equal(resolveOpenAiSize('landscape', 'dall-e-2'), '1024x1024');
});

test('pollinations URL carries the prompt and the render parameters', () => {
  const url = new URL(buildPollinationsUrl({ prompt: 'a red apple,水彩', width: 512, height: 768, seed: 7, model: 'flux' }));
  assert.equal(url.origin, 'https://image.pollinations.ai');
  assert.equal(url.pathname, '/prompt/a%20red%20apple%2C%E6%B0%B4%E5%BD%A9');
  assert.equal(url.searchParams.get('width'), '512');
  assert.equal(url.searchParams.get('height'), '768');
  assert.equal(url.searchParams.get('seed'), '7');
  assert.equal(url.searchParams.get('nologo'), 'true');
  assert.equal(url.searchParams.get('model'), 'flux');
  assert.equal(new URL(buildPollinationsUrl({ prompt: 'x', width: 8, height: 8 })).searchParams.get('seed'), null);
});

test('OpenAI image requests only carry supported fields', () => {
  assert.deepEqual(openAiImageBody({ prompt: 'p', model: 'gpt-image-1', size: '1024x1024' }), {
    model: 'gpt-image-1',
    prompt: 'p',
    n: 1,
    size: '1024x1024',
  });
  assert.equal(openAiImageBody({ prompt: 'p', model: 'm', size: 's', seed: 3 }).seed, 3);
});

test('image responses decode from base64 and keep the real media type', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const payload = { data: [{ b64_json: Buffer.from(png).toString('base64') }] };
  const decoded = decodeOpenAiImagePayload(payload);
  assert.equal(decoded.mediaType, 'image/png');
  assert.deepEqual([...decoded.data], [...png]);
  assert.equal(decodeOpenAiImagePayload({ data: [{ url: 'https://example.test/a.jpg' }] }).url, 'https://example.test/a.jpg');
  assert.equal(decodeOpenAiImagePayload({ data: [] }), undefined);
  assert.equal(decodeOpenAiImagePayload(null), undefined);
});

test('image signatures and response headers agree', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), undefined);
  assert.equal(imageMediaTypeFromResponse('image/jpeg; charset=binary', new Uint8Array()), 'image/jpeg');
  assert.equal(imageMediaTypeFromResponse('application/octet-stream', waveBytes()), 'image/png');
});

test('WAV headers are read without decoding the payload', () => {
  const bytes = waveBytes({ seconds: 0.5 });
  assert.equal(isRiffWave(bytes), true);
  const info = readWaveInfo(bytes);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.seconds, 0.5);
  assert.equal(readWaveInfo(new Uint8Array(64)), undefined);
  assert.equal(isRiffWave(new Uint8Array(10)), false);
});

test('voice choice prefers the configured voice, then the text language', () => {
  const voices = [
    { name: 'Microsoft Zira Desktop', culture: 'en-US', gender: 'Female' },
    { name: 'Microsoft Haruka Desktop', culture: 'ja-JP', gender: 'Female' },
  ];
  assert.equal(chooseVoice(voices, 'Microsoft Zira Desktop', 'こんにちは'), 'Microsoft Zira Desktop');
  assert.equal(chooseVoice(voices, 'microsoft haruka desktop', 'hello'), 'Microsoft Haruka Desktop');
  assert.equal(chooseVoice(voices, '', 'こんにちは'), 'Microsoft Haruka Desktop');
  assert.equal(chooseVoice(voices, '', 'hello'), 'Microsoft Zira Desktop');
  assert.equal(chooseVoice([], '', 'hello'), undefined);
  assert.equal(hasCjkText('こんにちは'), true);
  assert.equal(hasCjkText('hello'), false);
});

test('rate and file stems are bounded', () => {
  assert.equal(normalizeRate(99), 10);
  assert.equal(normalizeRate(-99), -10);
  assert.equal(normalizeRate(Number.NaN), 0);
  assert.equal(normalizeRate(2.6), 3);
  assert.equal(safeFileStem('a/b:c*?"<>|'), 'a b c');
  assert.equal(safeFileStem(''), 'media');
  assert.equal(safeFileStem('あ'.repeat(60)).length, 48);
});

test('PowerShell helpers read text from JSON instead of the command line', () => {
  const synthesis = sapiSynthesisScript();
  assert.match(synthesis, /System\.Speech/);
  assert.match(synthesis, /SelectVoice/);
  assert.match(synthesis, /SetOutputToWaveFile/);
  assert.match(synthesis, /ConvertFrom-Json/);
  assert.match(synthesis, /\$synth\.Speak/);
  assert.equal(synthesis.includes('{{text}}'), false);

  const listing = sapiVoiceListScript();
  assert.match(listing, /GetInstalledVoices/);
  assert.match(listing, /ConvertTo-Json/);
  assert.match(listing, /VoiceInfo\.Name/);
});
