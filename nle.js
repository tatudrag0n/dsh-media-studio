/**
 * NLE (non-linear editing) for the Media Studio plugin.
 *
 * This module is the editing desk of the studio. The user lays out a
 * timeline — video tracks, audio tracks, subtitles — and one ffmpeg run cuts
 * it into a finished file. The same timeline can also be written out for a
 * real editing application (Kdenlive / Shotcut / Resolve / Final Cut).
 *
 *   1. `normalizeTimeline` reads a request into one normalized timeline.
 *   2. `applyProbeDurations` fills in the lengths ffprobe measured.
 *   3. `buildFilterComplex` turns the timeline into one `filter_complex`
 *      graph; `buildFfmpegArgs` wraps it in a single command line.
 *   4. `toMlt` / `toOtio` / `toFcpxml` / `toEdl` write the same timeline in
 *      the formats editing applications open.
 *
 * Everything that decides *what* the edit looks like is a pure function, so
 * it can be tested without ffmpeg on the machine. Only `execute()` spawns
 * processes, always with a timeout and `windowsHide`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

// #region Constants

/** How one clip hands over to the next. */
export const NLE_TRANSITIONS = ['cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'circleopen'];

/** Containers `edit_video` can write. */
export const NLE_FORMATS = ['mp4', 'webm', 'gif'];

/** Editing applications `export_timeline` can write for. */
export const TIMELINE_FORMATS = ['mlt', 'otio', 'fcpxml', 'edl'];

/** Subtitle formats `make_subtitles` can write. */
export const SUBTITLE_FORMATS = ['srt', 'vtt'];

/** Where a burned-in telop can sit on the canvas. */
export const TEXT_POSITIONS = ['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right'];

/** Where a picture-in-picture clip can sit on the canvas. */
export const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

/** Default canvas of a timeline. */
export const DEFAULT_NLE_WIDTH = 1280;

/** Default canvas height. */
export const DEFAULT_NLE_HEIGHT = 720;

/** Default frame rate. */
export const DEFAULT_NLE_FPS = 30;

/** Default length of a cross dissolve, in seconds. */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** Most clips one timeline can hold. */
export const MAX_NLE_CLIPS = 60;

/** Longest timeline, in seconds. */
export const MAX_NLE_SECONDS = 600;

/** Longest one subtitle cue list can be. */
export const MAX_NLE_CUES = 400;

/** Most subtitle cues burned into one render. */
export const MAX_BURNED_CUES = 300;

/** Default fraction of the canvas a picture-in-picture clip covers. */
export const DEFAULT_OVERLAY_SCALE = 0.3;

/** Default length of a still picture on the timeline, in seconds. */
export const DEFAULT_IMAGE_SECONDS = 3;

/** Sample rate every audio chain is normalized to. */
export const NLE_SAMPLE_RATE = 48000;

/** Extension per container. */
const FORMAT_EXTENSIONS = { mp4: 'mp4', webm: 'webm', gif: 'gif' };

/** Media type per container. */
const FORMAT_MEDIA_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};

/** Media type per timeline document format. */
const TIMELINE_MEDIA_TYPES = {
  mlt: 'application/xml',
  otio: 'application/json',
  fcpxml: 'application/xml',
  edl: 'text/plain',
};

/** Extension per timeline document format. */
const TIMELINE_EXTENSIONS = { mlt: 'mlt', otio: 'otio', fcpxml: 'fcpxml', edl: 'edl' };

/** Media type per subtitle format. */
const SUBTITLE_MEDIA_TYPES = { srt: 'application/x-subrip', vtt: 'text/vtt' };

/** Extensions ffmpeg reads as a still picture. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

/** Fonts tried in order for burned-in text. */
export const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\meiryo.ttc',
  'C:\\Windows\\Fonts\\YuGothM.ttc',
  'C:\\Windows\\Fonts\\msgothic.ttc',
  'C:\\Windows\\Fonts\\segoeui.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

/** ffmpeg transition name per timeline transition. */
const XFADE_NAMES = {
  fade: 'fade',
  dissolve: 'dissolve',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  slideup: 'slideup',
  circleopen: 'circleopen',
};

// #endregion

// #region Small numeric and text helpers

/** Round to three decimals, for filter arguments. */
function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/** Keep a number inside a range. */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A trimmed non-empty string, or undefined. */
function textOrUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Drop keys whose value is undefined, so the tool result stays lossless JSON. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Escape a string for XML text or attribute content. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * Escape a path for use as an ffmpeg filter option value.
 *
 * ffmpeg treats `\` as an escape character and `:` as the option separator,
 * so a Windows path has to become `C\:/dir/file`. The result is still wrapped
 * in single quotes by the caller.
 */
export function escapeFilterPath(value) {
  return String(value ?? '')
    .replace(/\\/gu, '/')
    .replace(/:/gu, '\\:')
    .replace(/'/gu, "\\'");
}

/** Convert an absolute path to a `file:///C:/...` URL. */
export function toFileUrl(value) {
  const forward = String(value ?? '').replace(/\\/gu, '/');
  if (/^[A-Za-z]:\//u.test(forward)) return `file:///${forward}`;
  if (forward.startsWith('/')) return `file://${forward}`;
  return `file:///${forward}`;
}

/** Format seconds as `HH:MM:SS,mmm`, the SRT way. */
export function formatSrtTime(seconds) {
  return formatClock(seconds, ',', 3);
}

/** Format seconds as `HH:MM:SS.mmm`, the WebVTT way. */
export function formatVttTime(seconds) {
  return formatClock(seconds, '.', 3);
}

/** Format seconds as `HH:MM:SS,mmm` or `HH:MM:SS.mmm`. */
function formatClock(seconds, separator, digits) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMs = Math.round(safe * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const fraction = digits === 3 ? String(millis).padStart(3, '0') : String(Math.floor(millis / 10)).padStart(2, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}${separator}${fraction}`;
}

/** Format seconds as a CMX3600 timecode `HH:MM:SS:FF`. */
export function formatEdlTimecode(seconds, fps) {
  const rate = Math.max(1, Math.round(numberOr(fps, DEFAULT_NLE_FPS)));
  const safe = Math.max(0, Number(seconds) || 0);
  const totalFrames = Math.round(safe * rate);
  const frames = totalFrames % rate;
  const totalSeconds = Math.floor(totalFrames / rate);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}:${pad2(frames)}`;
}

/** Format seconds as an FCPXML rational time such as `105/30s`. */
export function formatFcpxmlTime(seconds, fps) {
  const rate = Math.max(1, Math.round(numberOr(fps, DEFAULT_NLE_FPS)));
  const frames = Math.max(0, Math.round((Number(seconds) || 0) * rate));
  if (frames === 0) return '0s';
  return `${frames}/${rate}s`;
}

/** Two-digit zero padding. */
function pad2(value) {
  return String(Math.max(0, Math.trunc(value))).padStart(2, '0');
}

// #endregion

// #region Subtitles

/**
 * Read SRT or WebVTT text into cue objects.
 *
 * Accepts a byte-order mark, CRLF line endings and multi-line cue text.
 */
export function parseSubtitles(source) {
  const text = String(source ?? '').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const isVtt = /^WEBVTT/u.test(text.trimStart());
  const cues = [];
  const blocks = text.split(/\n{2,}/u);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) continue;
    const match = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/u.exec(lines[timeIndex].trim());
    if (match === null) continue;
    const start = clockToSeconds(match[1], match[2], match[3], match[4]);
    const end = clockToSeconds(match[5], match[6], match[7], match[8]);
    const body = lines.slice(timeIndex + 1).join('\n').trim();
    if (body === '') continue;
    cues.push({ start, end: end > start ? end : start + 1, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, format: isVtt ? 'vtt' : 'srt' };
}

/** Hours, minutes, seconds and a fraction as seconds. */
function clockToSeconds(hours, minutes, seconds, fraction) {
  const millis = Number(`0.${String(fraction).padEnd(3, '0').slice(0, 3)}`);
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + millis;
}

/** Write cues as SRT text. */
export function toSrt(cues) {
  const list = normalizeCues(cues);
  const blocks = list.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`);
  return `${blocks.join('\n\n')}${blocks.length === 0 ? '' : '\n'}`;
}

/** Write cues as WebVTT text. */
export function toVtt(cues) {
  const list = normalizeCues(cues);
  const blocks = list.map((cue) => `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length === 0 ? '' : '\n'}`;
}

/** Sort, clamp and de-duplicate cues. */
export function normalizeCues(cues) {
  const list = Array.isArray(cues) ? cues : [];
  const out = [];
  for (const cue of list) {
    if (cue === null || typeof cue !== 'object') continue;
    const text = textOrUndefined(cue.text);
    if (text === undefined) continue;
    const start = Math.max(0, numberOr(cue.start, 0));
    const rawEnd = numberOr(cue.end, start + 1);
    out.push({ start, end: rawEnd > start ? rawEnd : start + 0.5, text });
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_NLE_CUES);
}

/**
 * Split a block of text into cues spread over a duration.
 *
 * Sentences are the unit: a line break or a full stop ends one cue. When the
 * text has no sentence marks the words are spread evenly instead, so the
 * result always covers the whole span.
 */
export function cuesFromText(text, options = {}) {
  const body = String(text ?? '').trim();
  if (body === '') return [];
  const start = Math.max(0, numberOr(options.start, 0));
  const duration = Math.max(0.5, numberOr(options.duration, 5));
  const gap = Math.max(0, numberOr(options.gap, 0));
  const maxCues = Math.max(1, Math.trunc(numberOr(options.maxCues, MAX_NLE_CUES)));

  let pieces = body
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s*/u))
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');

  if (pieces.length <= 1) {
    const words = body.split(/\s+/u).filter((word) => word !== '');
    pieces = words.length > 1 ? words : [body];
  }
  if (pieces.length > maxCues) {
    // Fold the tail into the last cue rather than dropping text.
    const head = pieces.slice(0, maxCues - 1);
    pieces = [...head, pieces.slice(maxCues - 1).join(' ')];
  }

  const usable = Math.max(0.5, duration - gap * (pieces.length - 1));
  const slot = usable / pieces.length;
  const cues = pieces.map((piece, index) => {
    const cueStart = start + index * (slot + gap);
    return {
      start: round3(cueStart),
      end: round3(cueStart + slot),
      text: piece,
    };
  });
  return cues;
}

// #endregion

// #region Timeline normalization

/** True when a path names a still picture. */
export function isImagePath(value) {
  return IMAGE_EXTENSIONS.has(extname(String(value ?? '')).toLowerCase());
}

/** Read a `materials` argument into a plain id → path map. */
export function materialMap(materials) {
  const map = new Map();
  if (materials === null || materials === undefined) return map;
  if (Array.isArray(materials)) {
    for (const entry of materials) {
      if (entry === null || typeof entry !== 'object') continue;
      const id = textOrUndefined(entry.id ?? entry.name);
      const path = textOrUndefined(entry.path);
      if (id !== undefined && path !== undefined) map.set(id, path);
    }
    return map;
  }
  if (typeof materials === 'object') {
    for (const [id, value] of Object.entries(materials)) {
      if (typeof value === 'string' && value !== '') map.set(id, value);
    }
  }
  return map;
}

/** Resolve the path of one clip through `path` or `materialId`. */
function clipPath(raw, materials) {
  const direct = textOrUndefined(raw?.path) ?? textOrUndefined(raw?.source) ?? textOrUndefined(raw?.file);
  if (direct !== undefined) return direct;
  const id = textOrUndefined(raw?.materialId) ?? textOrUndefined(raw?.id);
  if (id !== undefined && materials.has(id)) return materials.get(id);
  return undefined;
}

/**
 * Read a request into one normalized timeline.
 *
 * `defaults` carries the tool arguments that sit beside the timeline
 * (`width`, `height`, `fps`, `format`) plus the `materials` id → path map.
 */
export function normalizeTimeline(input, defaults = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const width = Math.trunc(clamp(numberOr(source.width ?? defaults.width, DEFAULT_NLE_WIDTH), 16, 7680));
  const height = Math.trunc(clamp(numberOr(source.height ?? defaults.height, DEFAULT_NLE_HEIGHT), 16, 4320));
  const fps = Math.trunc(clamp(numberOr(source.fps ?? defaults.fps, DEFAULT_NLE_FPS), 1, 120));
  const format = NLE_FORMATS.includes(source.format) ? source.format : (NLE_FORMATS.includes(defaults.format) ? defaults.format : 'mp4');
  const materials = defaults.materials instanceof Map ? defaults.materials : materialMap(defaults.materials);

  const rawTracks = Array.isArray(source.tracks) ? source.tracks : undefined;
  const looseClips = Array.isArray(source.clips) ? source.clips : (Array.isArray(source.paths) ? source.paths : undefined);

  let tracks;
  if (rawTracks !== undefined && rawTracks.length > 0) {
    tracks = rawTracks
      .filter((track) => track !== null && typeof track === 'object')
      .map((track) => {
        const type = track.type === 'audio' ? 'audio' : 'video';
        const rawClips = Array.isArray(track.clips) ? track.clips : [];
        return { type, clips: rawClips.map((clip) => normalizeClip(clip, type, materials)) };
      })
      .filter((track) => track.clips.length > 0);
  } else if (looseClips !== undefined && looseClips.length > 0) {
    tracks = [{ type: 'video', clips: looseClips.map((clip) => normalizeClip(clip, 'video', materials)) }];
  } else {
    tracks = [];
  }

  if (tracks.length === 0) {
    throw new Error('タイムラインが空です。Add at least one clip or track. Timeline is empty.');
  }

  const videoTracks = tracks.filter((track) => track.type === 'video');
  if (videoTracks.length === 0) {
    throw new Error('映像トラックがありません。A timeline needs at least one video track.');
  }

  const totalClips = tracks.reduce((sum, track) => sum + track.clips.length, 0);
  if (totalClips > MAX_NLE_CLIPS) {
    throw new Error(`クリップは最大 ${MAX_NLE_CLIPS} 個までです。Too many clips (${totalClips}).`);
  }

  const subtitles = Array.isArray(source.subtitles) ? normalizeCues(source.subtitles) : [];

  return {
    width,
    height,
    fps,
    format,
    tracks,
    subtitles,
    baseTrack: tracks.indexOf(videoTracks[0]),
  };
}

/** Read one clip of a timeline. */
function normalizeClip(raw, trackType, materials) {
  const value = raw !== null && typeof raw === 'object' ? raw : { path: raw };
  const path = clipPath(value, materials);
  if (path === undefined) {
    throw new Error('クリップに path がありません。Every clip needs a path (or a materialId that resolves through materials).');
  }

  const start = Math.max(0, numberOr(value.in ?? value.start, 0));
  const out = value.out === undefined || value.out === null ? undefined : Math.max(0, numberOr(value.out, start));
  const speed = clamp(numberOr(value.speed, 1), 0.25, 4);
  const sourceDuration = out === undefined ? undefined : Math.max(0, out - start);
  const duration = sourceDuration === undefined ? undefined : round3(sourceDuration / speed);

  const clip = {
    path,
    in: round3(start),
    out: out === undefined ? undefined : round3(out),
    speed: round3(speed),
    duration,
    sourceDuration: sourceDuration === undefined ? undefined : round3(sourceDuration),
    volume: round3(clamp(numberOr(value.volume, 1), 0, 4)),
    fadeIn: round3(clamp(numberOr(value.fadeIn, 0), 0, 60)),
    fadeOut: round3(clamp(numberOr(value.fadeOut, 0), 0, 60)),
    duck: value.duck === true,
    isImage: isImagePath(path),
  };

  if (trackType === 'video') {
    clip.transition = NLE_TRANSITIONS.includes(value.transition) ? value.transition : 'cut';
    clip.transitionDuration = round3(clamp(numberOr(value.transitionDuration, DEFAULT_TRANSITION_SECONDS), 0.05, 5));
    clip.crop = readCrop(value.crop);
    clip.rotate = readRotation(value.rotate ?? value.rotation);
    clip.color = readColor(value.color);
    clip.text = readText(value.text, value.telop);
    clip.overlay = readOverlay(value);
  } else {
    clip.transition = 'cut';
    clip.transitionDuration = 0;
    clip.overlay = undefined;
  }

  return clip;
}

/** Read a crop box. */
function readCrop(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const w = Math.trunc(numberOr(value.w ?? value.width, 0));
  const h = Math.trunc(numberOr(value.h ?? value.height, 0));
  if (w <= 0 || h <= 0) return undefined;
  return {
    w,
    h,
    x: Math.trunc(Math.max(0, numberOr(value.x, 0))),
    y: Math.trunc(Math.max(0, numberOr(value.y, 0))),
  };
}

/** Read a rotation in degrees, normalized to 0 / 90 / 180 / 270. */
function readRotation(value) {
  const degrees = numberOr(value, 0);
  if (!Number.isFinite(degrees) || degrees === 0) return 0;
  const normalized = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

/** Read a colour adjustment block. */
function readColor(value) {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const color = {};
  const brightness = numberOr(value.brightness, 0);
  const contrast = numberOr(value.contrast, 1);
  const saturation = numberOr(value.saturation, 1);
  const gamma = numberOr(value.gamma, 1);
  if (brightness !== 0) color.brightness = round3(clamp(brightness, -1, 1));
  if (contrast !== 1) color.contrast = round3(clamp(contrast, 0, 4));
  if (saturation !== 1) color.saturation = round3(clamp(saturation, 0, 4));
  if (gamma !== 1) color.gamma = round3(clamp(gamma, 0.1, 10));
  return Object.keys(color).length === 0 ? undefined : color;
}

/** Read a telop (text overlay). */
function readText(text, telop) {
  const value = text ?? telop;
  if (value === null || value === undefined) return undefined;
  const plain = typeof value === 'string' ? value : textOrUndefined(value.value ?? value.text);
  if (plain === undefined) return undefined;
  const options = typeof value === 'string' ? {} : value;
  return {
    value: plain,
    position: TEXT_POSITIONS.includes(options.position) ? options.position : 'bottom',
    color: textOrUndefined(options.color) ?? 'white',
    boxColor: textOrUndefined(options.boxColor) ?? 'black@0.5',
    fontSize: Math.trunc(clamp(numberOr(options.fontSize ?? options.size, 0), 0, 400)),
  };
}

/** Read the picture-in-picture placement of an overlay clip. */
function readOverlay(value) {
  const hasOverlay = value.position !== undefined || value.scale !== undefined || value.pip === true || value.at !== undefined;
  if (!hasOverlay) return undefined;
  return {
    at: round3(Math.max(0, numberOr(value.at, 0))),
    scale: round3(clamp(numberOr(value.scale, DEFAULT_OVERLAY_SCALE), 0.05, 1)),
    position: OVERLAY_POSITIONS.includes(value.position) ? value.position : 'top-right',
  };
}

/** Flatten a timeline into one entry per clip, in input order. */
export function flattenTimeline(timeline) {
  const out = [];
  timeline.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      out.push({ trackIndex, clipIndex, trackType: track.type, clip, index: out.length });
    });
  });
  return out;
}

/** Index of the first video track. */
export function baseVideoTrackIndex(timeline) {
  return timeline.tracks.findIndex((track) => track.type === 'video');
}

/**
 * Group the clips of the base video track.
 *
 * A `cut` keeps the next clip in the same group (they are concatenated); any
 * other transition opens a new group, and the groups are joined with `xfade`.
 */
export function planVideoGroups(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const groups = [];
  let current = { transition: 'cut', transitionDuration: 0, items: [clips[0]] };
  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1];
    const transition = NLE_TRANSITIONS.includes(previous.transition) ? previous.transition : 'cut';
    if (transition === 'cut') {
      current.items.push(clips[index]);
      continue;
    }
    groups.push(current);
    current = {
      transition,
      transitionDuration: numberOr(previous.transitionDuration, DEFAULT_TRANSITION_SECONDS),
      items: [clips[index]],
    };
  }
  groups.push(current);
  for (const group of groups) {
    group.duration = group.items.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);
  }
  return groups;
}

/** The transition length actually usable between two groups. */
export function effectiveTransition(seconds, before, after) {
  const limit = Math.min(Number(before) || 0, Number(after) || 0) / 2;
  const wanted = numberOr(seconds, DEFAULT_TRANSITION_SECONDS);
  return round3(clamp(wanted, 0.05, Math.max(0.05, limit)));
}

/** Total length of the base video track, in seconds. */
export function timelineSeconds(timeline) {
  const base = timeline.tracks[baseVideoTrackIndex(timeline)];
  if (base === undefined) return 0;
  const groups = planVideoGroups(base.clips);
  if (groups.length === 0) return 0;
  let total = groups[0].duration;
  for (let index = 1; index < groups.length; index += 1) {
    const overlap = effectiveTransition(groups[index].transitionDuration, total, groups[index].duration);
    total += groups[index].duration - overlap;
  }
  return round3(total);
}

/**
 * Fill the lengths ffprobe measured into the clips that did not state them.
 *
 * `probes` is aligned with `flattenTimeline(timeline)`.
 */
export function applyProbeDurations(timeline, probes) {
  const flat = flattenTimeline(timeline);
  flat.forEach((entry, index) => {
    const probe = probes[index];
    if (probe === undefined || probe === null) return;
    const clip = entry.clip;
    const sourceLength = Number(probe.duration);
    if (!Number.isFinite(sourceLength) || sourceLength <= 0) {
      if (clip.isImage && clip.out === undefined) {
        clip.out = round3(clip.in + DEFAULT_IMAGE_SECONDS);
        clip.sourceDuration = DEFAULT_IMAGE_SECONDS;
        clip.duration = round3(DEFAULT_IMAGE_SECONDS / clip.speed);
      }
      return;
    }
    if (clip.out === undefined || clip.out <= clip.in) {
      clip.out = round3(sourceLength);
      clip.sourceDuration = round3(Math.max(0, sourceLength - clip.in));
      clip.duration = round3(clip.sourceDuration / clip.speed);
    }
    clip.probed = {
      duration: round3(sourceLength),
      hasVideo: probe.hasVideo === true,
      hasAudio: probe.hasAudio === true,
      width: Number.isFinite(Number(probe.width)) ? Math.trunc(Number(probe.width)) : undefined,
      height: Number.isFinite(Number(probe.height)) ? Math.trunc(Number(probe.height)) : undefined,
    };
  });
  return timeline;
}

// #endregion

// #region ffmpeg filter graph

/** Number of atempo stages needed for a speed change. */
export function atempoChain(speed) {
  const target = numberOr(speed, 1);
  if (Math.abs(target - 1) < 0.001) return '';
  const stages = [];
  let remaining = target;
  let guard = 0;
  while (remaining > 2 && guard < 8) {
    stages.push('atempo=2');
    remaining /= 2;
    guard += 1;
  }
  while (remaining < 0.5 && guard < 8) {
    stages.push('atempo=0.5');
    remaining /= 0.5;
    guard += 1;
  }
  stages.push(`atempo=${round3(remaining)}`);
  return stages.join(',');
}

/** The `scale` + `pad` pair that fits a frame onto the canvas. */
export function fitToCanvas(width, height) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** The `x`/`y` expressions for a telop position. */
export function textPosition(position, width, height) {
  switch (position) {
    case 'top':
      return { x: '(w-text_w)/2', y: String(Math.round(height * 0.06)) };
    case 'center':
      return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
    case 'top-left':
      return { x: '48', y: '48' };
    case 'top-right':
      return { x: 'w-text_w-48', y: '48' };
    case 'bottom-left':
      return { x: '48', y: 'h-text_h-48' };
    case 'bottom-right':
      return { x: 'w-text_w-48', y: 'h-text_h-48' };
    case 'bottom':
    default:
      return { x: '(w-text_w)/2', y: 'h-text_h-' + String(Math.round(height * 0.08)) };
  }
}

/** The `x`/`y` expressions for a picture-in-picture corner. */
export function overlayPosition(position, margin) {
  switch (position) {
    case 'top-left':
      return { x: String(margin), y: String(margin) };
    case 'bottom-left':
      return { x: String(margin), y: `H-h-${margin}` };
    case 'bottom-right':
      return { x: `W-w-${margin}`, y: `H-h-${margin}` };
    case 'center':
      return { x: '(W-w)/2', y: '(H-h)/2' };
    case 'top-right':
    default:
      return { x: `W-w-${margin}`, y: String(margin) };
  }
}

/** One `drawtext` filter, reading its text from a file. */
export function drawTextFilter(spec) {
  const parts = [
    `textfile='${escapeFilterPath(spec.file)}'`,
    `fontfile='${escapeFilterPath(spec.fontFile)}'`,
    `fontsize=${Math.round(spec.fontSize)}`,
    `fontcolor=${spec.color}`,
    'box=1',
    `boxcolor=${spec.boxColor}`,
    `boxborderw=${Math.round(Math.max(4, spec.fontSize * 0.35))}`,
    `x=${spec.x}`,
    `y=${spec.y}`,
  ];
  if (Array.isArray(spec.enable)) {
    parts.push(`enable='between(t,${round3(spec.enable[0])},${round3(spec.enable[1])})'`);
  }
  return `drawtext=${parts.join(':')}`;
}

/** The chain that turns one input into a canvas-sized video segment. */
function videoSegmentChain(entry, timeline) {
  const clip = entry.clip;
  const parts = [];
  const start = clip.in;
  const end = clip.out === undefined ? undefined : clip.out;
  parts.push(end === undefined ? `trim=start=${round3(start)}` : `trim=start=${round3(start)}:end=${round3(end)}`);
  parts.push(clip.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${round3(clip.speed)}`);
  if (clip.crop !== undefined) parts.push(`crop=${clip.crop.w}:${clip.crop.h}:${clip.crop.x}:${clip.crop.y}`);
  if (clip.rotate === 90) parts.push('transpose=1');
  else if (clip.rotate === 180) parts.push('transpose=1,transpose=1');
  else if (clip.rotate === 270) parts.push('transpose=2');
  if (clip.color !== undefined) {
    const color = clip.color;
    const args = [];
    if (color.brightness !== undefined) args.push(`brightness=${color.brightness}`);
    if (color.contrast !== undefined) args.push(`contrast=${color.contrast}`);
    if (color.saturation !== undefined) args.push(`saturation=${color.saturation}`);
    if (color.gamma !== undefined) args.push(`gamma=${color.gamma}`);
    if (args.length > 0) parts.push(`eq=${args.join(':')}`);
  }
  parts.push(`fps=${timeline.fps}`);
  parts.push(fitToCanvas(timeline.width, timeline.height));
  parts.push('setsar=1');
  parts.push('format=yuv420p');
  parts.push('settb=AVTB');
  return `[${entry.index}:v]${parts.join(',')}`;
}

/** The chain that turns one input into a normalized, trimmed audio segment. */
function audioSegmentChain(entry, clip) {
  const filters = [];
  filters.push(clip.out === undefined ? `atrim=start=${round3(clip.in)}` : `atrim=start=${round3(clip.in)}:end=${round3(clip.out)}`);
  filters.push('asetpts=PTS-STARTPTS');
  const extra = audioClipFilters(clip);
  if (extra !== '') filters.push(extra);
  return audioNormalizeChain(`[${entry.index}:a]${filters.join(',')}`);
}

/** The chain that normalizes one input's audio to the mixing format. */
function audioNormalizeChain(label) {
  return `${label},aresample=${NLE_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

/** Build the filter that applies a clip's volume, fades and speed. */
function audioClipFilters(clip) {
  const parts = [];
  const tempo = atempoChain(clip.speed);
  if (tempo !== '') parts.push(tempo);
  if (Math.abs(clip.volume - 1) > 0.001) parts.push(`volume=${round3(clip.volume)}`);
  if (clip.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${round3(clip.fadeIn)}`);
  if (clip.fadeOut > 0) {
    const length = Number(clip.duration) || 0;
    if (length > 0) parts.push(`afade=t=out:st=${round3(Math.max(0, length - clip.fadeOut))}:d=${round3(clip.fadeOut)}`);
  }
  return parts.join(',');
}

/**
 * Turn a timeline into one `filter_complex` graph.
 *
 * `sources` is aligned with `flattenTimeline(timeline)` and says what each
 * input actually contains (`hasVideo`, `hasAudio`, `isImage`).
 */
export function buildFilterComplex(timeline, sources, options = {}) {
  const fontFile = options.fontFile ?? FONT_CANDIDATES[0];
  const chains = [];
  const flat = flattenTimeline(timeline);
  const baseTrack = baseVideoTrackIndex(timeline);
  if (baseTrack === -1) throw new Error('映像トラックがありません。A timeline needs at least one video track.');

  const baseEntries = flat.filter((entry) => entry.trackIndex === baseTrack);
  if (baseEntries.length === 0) throw new Error('映像トラックが空です。The video track has no clips.');

  const inputs = flat.map((entry) => {
    const probe = sources[entry.index] ?? {};
    return compact({
      index: entry.index,
      path: entry.clip.path,
      kind: entry.clip.isImage ? 'image' : (entry.trackType === 'audio' ? 'audio' : 'video'),
      loop: entry.clip.isImage ? true : undefined,
      duration: entry.clip.duration,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    });
  });

  // --- base video track -------------------------------------------------
  const segmentLabels = [];
  for (const entry of baseEntries) {
    const label = `bv${entry.index}`;
    chains.push(`${videoSegmentChain(entry, timeline)}[${label}]`);
    segmentLabels.push({ label, clip: entry.clip });
  }

  const groups = planVideoGroups(baseEntries.map((entry) => entry.clip));
  let cursor = 0;
  const groupLabels = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const labels = segmentLabels.slice(cursor, cursor + group.items.length).map((item) => item.label);
    cursor += group.items.length;
    if (labels.length === 1) {
      groupLabels.push({ label: labels[0], duration: group.duration, transition: group.transition, transitionDuration: group.transitionDuration });
      continue;
    }
    const out = `gv${index}`;
    chains.push(`${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=1:a=0[${out}]`);
    groupLabels.push({ label: out, duration: group.duration, transition: group.transition, transitionDuration: group.transitionDuration });
  }

  let videoLabel = groupLabels[0].label;
  let videoSeconds = groupLabels[0].duration;
  const usedTransitions = [];
  for (let index = 1; index < groupLabels.length; index += 1) {
    const group = groupLabels[index];
    const overlap = effectiveTransition(group.transitionDuration, videoSeconds, group.duration);
    const offset = round3(Math.max(0, videoSeconds - overlap));
    const out = `xv${index}`;
    const name = XFADE_NAMES[group.transition] ?? 'fade';
    chains.push(`[${videoLabel}][${group.label}]xfade=transition=${name}:duration=${round3(overlap)}:offset=${offset}[${out}]`);
    usedTransitions.push({ name, seconds: round3(overlap) });
    videoLabel = out;
    videoSeconds = round3(videoSeconds + group.duration - overlap);
  }

  // --- telops (per-clip text) -------------------------------------------
  for (const entry of baseEntries) {
    const clip = entry.clip;
    if (clip.text === undefined || clip.text.file === undefined) continue;
    const fontSize = clip.text.fontSize > 0 ? clip.text.fontSize : Math.round(timeline.height * 0.055);
    const position = textPosition(clip.text.position, timeline.width, timeline.height);
    const out = `tv${entry.index}`;
    chains.push(`[${videoLabel}]${drawTextFilter({
      file: clip.text.file,
      fontFile,
      fontSize,
      color: clip.text.color,
      boxColor: clip.text.boxColor,
      x: position.x,
      y: position.y,
    })}[${out}]`);
    videoLabel = out;
  }

  // --- overlay (picture-in-picture) tracks -------------------------------
  const overlayEntries = flat.filter((entry) => entry.trackIndex !== baseTrack && entry.trackType === 'video');
  overlayEntries.forEach((entry, order) => {
    const clip = entry.clip;
    const placement = clip.overlay ?? { at: 0, scale: DEFAULT_OVERLAY_SCALE, position: 'top-right' };
    const overlayWidth = Math.max(16, Math.round(timeline.width * placement.scale));
    const position = overlayPosition(placement.position, Math.round(timeline.width * 0.03) + 12);
    const scaled = `ov${entry.index}`;
    const overlayFilters = [
      clip.out === undefined ? `trim=start=${round3(clip.in)}` : `trim=start=${round3(clip.in)}:end=${round3(clip.out)}`,
      clip.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${round3(clip.speed)}`,
      `fps=${timeline.fps}`,
      `scale=${overlayWidth}:-2`,
      'setsar=1',
      'format=yuv420p',
    ];
    chains.push(`[${entry.index}:v]${overlayFilters.join(',')}[${scaled}]`);
    const at = round3(placement.at);
    const length = Number(clip.duration) || 0;
    const out = `pi${order}`;
    chains.push(`[${videoLabel}][${scaled}]overlay=x=${position.x}:y=${position.y}:enable='between(t,${at},${round3(at + length)})'[${out}]`);
    videoLabel = out;
  });

  // --- subtitles burned in ----------------------------------------------
  const cues = Array.isArray(timeline.subtitles) ? timeline.subtitles.slice(0, MAX_BURNED_CUES) : [];
  cues.forEach((cue, index) => {
    if (cue.file === undefined) return;
    const fontSize = Math.round(timeline.height * 0.05);
    const out = `sv${index}`;
    chains.push(`[${videoLabel}]${drawTextFilter({
      file: cue.file,
      fontFile,
      fontSize,
      color: 'white',
      boxColor: 'black@0.55',
      x: '(w-text_w)/2',
      y: 'h-text_h-' + String(Math.round(timeline.height * 0.08)),
      enable: [cue.start, cue.end],
    })}[${out}]`);
    videoLabel = out;
  });

  // --- audio -------------------------------------------------------------
  const audioTracks = timeline.tracks.filter((track) => track.type === 'audio');
  const audioEntries = flat.filter((entry) => entry.trackType === 'audio');
  const baseAudioEntries = baseEntries.filter((entry) => (sources[entry.index] ?? {}).hasAudio === true);

  // A GIF carries no audio stream, so the whole audio half is skipped.
  const hasAnyAudio = timeline.format !== 'gif' && (baseAudioEntries.length > 0 || audioEntries.length > 0);
  let audioLabel;
  const duckedLabels = [];
  const primaryLabels = [];

  if (hasAnyAudio) {
    // Base track audio: cut inside a group, crossfade between groups.
    const baseAudioLabels = [];
    // Every base clip contributes one audio label, silent or not, so the
    // audio groups stay aligned with the video groups.
    if (baseAudioEntries.length > 0) {
      for (const entry of baseEntries) {
        const clip = entry.clip;
        const label = `ba${entry.index}`;
        if ((sources[entry.index] ?? {}).hasAudio === true) {
          chains.push(`${audioSegmentChain(entry, clip)}[${label}]`);
        } else {
          const length = Number(clip.duration) || 0;
          chains.push(`anullsrc=r=${NLE_SAMPLE_RATE}:cl=stereo,atrim=duration=${round3(Math.max(0.05, length))},asetpts=PTS-STARTPTS[${label}]`);
        }
        baseAudioLabels.push({ label, clip });
      }
    }

    // Group the base audio the same way the base video is grouped.
    const audioGroups = [];
    let cursorAudio = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const count = groups[index].items.length;
      const labels = baseAudioLabels.slice(cursorAudio, cursorAudio + count).map((item) => item.label);
      cursorAudio += count;
      audioGroups.push({ labels, duration: groups[index].duration, transition: groups[index].transition, transitionDuration: groups[index].transitionDuration });
    }

    let baseLabel;
    let baseSeconds = 0;
    const audioGroupLabels = [];
    for (let index = 0; index < audioGroups.length; index += 1) {
      const group = audioGroups[index];
      if (group.labels.length === 0) {
        // A silent group still needs a stream so the mix stays in sync.
        const silent = `sg${index}`;
        chains.push(`anullsrc=r=${NLE_SAMPLE_RATE}:cl=stereo,atrim=duration=${round3(Math.max(0.05, group.duration))},asetpts=PTS-STARTPTS[${silent}]`);
        audioGroupLabels.push({ label: silent, duration: group.duration, transition: group.transition, transitionDuration: group.transitionDuration });
        continue;
      }
      if (group.labels.length === 1) {
        audioGroupLabels.push({ label: group.labels[0], duration: group.duration, transition: group.transition, transitionDuration: group.transitionDuration });
        continue;
      }
      const out = `ag${index}`;
      chains.push(`${group.labels.map((label) => `[${label}]`).join('')}concat=n=${group.labels.length}:v=0:a=1[${out}]`);
      audioGroupLabels.push({ label: out, duration: group.duration, transition: group.transition, transitionDuration: group.transitionDuration });
    }

    baseLabel = audioGroupLabels[0].label;
    baseSeconds = audioGroupLabels[0].duration;
    for (let index = 1; index < audioGroupLabels.length; index += 1) {
      const group = audioGroupLabels[index];
      const overlap = effectiveTransition(group.transitionDuration, baseSeconds, group.duration);
      const out = `ax${index}`;
      chains.push(`[${baseLabel}][${group.label}]acrossfade=d=${round3(overlap)}:c1=tri:c2=tri[${out}]`);
      baseLabel = out;
      baseSeconds = round3(baseSeconds + group.duration - overlap);
    }
    primaryLabels.push(baseLabel);

    // Audio tracks: clips play one after another.
    audioTracks.forEach((track, trackOrder) => {
      const entries = flat.filter((entry) => entry.trackType === 'audio' && timeline.tracks[entry.trackIndex] === track);
      const labels = [];
      const ducked = [];
      for (const entry of entries) {
        const clip = entry.clip;
        const label = `at${trackOrder}_${entry.clipIndex}`;
        const hasAudio = (sources[entry.index] ?? {}).hasAudio === true;
        if (hasAudio) {
          chains.push(`${audioSegmentChain(entry, clip)}[${label}]`);
        } else {
          const length = Number(clip.duration) || 0;
          chains.push(`anullsrc=r=${NLE_SAMPLE_RATE}:cl=stereo,atrim=duration=${round3(Math.max(0.05, length))},asetpts=PTS-STARTPTS[${label}]`);
        }
        if (clip.duck) ducked.push(label);
        else labels.push(label);
      }
      if (labels.length === 1) {
        primaryLabels.push(labels[0]);
      } else if (labels.length > 1) {
        const out = `am${trackOrder}`;
        chains.push(`${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=0:a=1[${out}]`);
        primaryLabels.push(out);
      }
      duckedLabels.push(...ducked);
    });

    // Duck the music bed under the primary mix with a sidechain compressor.
    let primaryLabel;
    if (primaryLabels.length === 1) {
      primaryLabel = primaryLabels[0];
    } else {
      const out = 'aprimary';
      chains.push(`${primaryLabels.map((label) => `[${label}]`).join('')}amix=inputs=${primaryLabels.length}:duration=longest:dropout_transition=0:normalize=0[${out}]`);
      primaryLabel = out;
    }

    const mixLabels = [];
    if (duckedLabels.length > 0) {
      const splits = duckedLabels.length + 1;
      const splitOuts = [];
      for (let index = 0; index < splits; index += 1) splitOuts.push(`sp${index}`);
      chains.push(`[${primaryLabel}]asplit=${splits}${splitOuts.map((label) => `[${label}]`).join('')}`);
      mixLabels.push(splitOuts[0]);
      duckedLabels.forEach((label, index) => {
        const out = `dk${index}`;
        chains.push(`[${label}][${splitOuts[index + 1]}]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[${out}]`);
        mixLabels.push(out);
      });
    } else {
      mixLabels.push(primaryLabel);
    }

    if (mixLabels.length === 1) {
      const out = 'aout';
      chains.push(`[${mixLabels[0]}]apad[${out}]`);
      audioLabel = out;
    } else {
      const out = 'aout';
      chains.push(`${mixLabels.map((label) => `[${label}]`).join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad[${out}]`);
      audioLabel = out;
    }
  }

  // --- palette for GIF ---------------------------------------------------
  let finalVideo = videoLabel;
  if (timeline.format === 'gif') {
    chains.push(`[${videoLabel}]split[gp0][gp1]`);
    chains.push('[gp0]palettegen=stats_mode=diff[gpal]');
    chains.push('[gp1][gpal]paletteuse=dither=bayer:bayer_scale=5[gifout]');
    finalVideo = 'gifout';
  }

  return {
    filter: chains.join(';'),
    video: finalVideo,
    audio: audioLabel,
    seconds: round3(videoSeconds),
    inputs,
    transitions: usedTransitions,
  };
}

/**
 * Build the whole ffmpeg command line for a rendered timeline.
 *
 * Pure: it only assembles arguments, so the shape can be asserted in tests.
 */
export function buildFfmpegArgs(timeline, graph, target) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error'];
  for (const input of graph.inputs) {
    if (input.loop === true) {
      args.push('-loop', '1', '-t', String(round3(Math.max(0.1, Number(input.duration) || DEFAULT_IMAGE_SECONDS))));
    }
    args.push('-i', input.path);
  }
  args.push('-filter_complex', graph.filter);
  args.push('-map', `[${graph.video}]`);
  if (graph.audio !== undefined) args.push('-map', `[${graph.audio}]`);

  const format = timeline.format;
  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '2M', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p');
    if (graph.audio !== undefined) args.push('-c:a', 'libopus', '-b:a', '128k');
  } else if (format === 'gif') {
    args.push('-loop', '0');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (graph.audio !== undefined) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', String(NLE_SAMPLE_RATE));
  }
  args.push('-t', String(round3(Math.max(0.1, graph.seconds))));
  args.push(target);
  return args;
}

// #endregion

// #region ffprobe summary

/** Read an ffprobe rate such as `30000/1001` as a number. */
export function parseRate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? round3(value) : undefined;
  if (typeof value !== 'string' || value === '') return undefined;
  const [numerator, denominator] = value.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return undefined;
  const rate = top / bottom;
  return Number.isFinite(rate) && rate > 0 ? round3(rate) : undefined;
}

/** Summarize an `ffprobe -print_format json` document. */
export function summarizeProbe(document) {
  const streams = Array.isArray(document?.streams) ? document.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const format = document?.format ?? {};
  const duration = numberOr(format.duration ?? video?.duration ?? audio?.duration, 0);

  return compact({
    duration: round3(duration),
    size: Number.isFinite(Number(format.size)) ? Math.trunc(Number(format.size)) : undefined,
    bitrate: Number.isFinite(Number(format.bit_rate)) ? Math.trunc(Number(format.bit_rate)) : undefined,
    formatName: textOrUndefined(format.format_name),
    videoCodec: textOrUndefined(video?.codec_name),
    width: Number.isFinite(Number(video?.width)) ? Math.trunc(Number(video.width)) : undefined,
    height: Number.isFinite(Number(video?.height)) ? Math.trunc(Number(video.height)) : undefined,
    fps: parseRate(video?.avg_frame_rate ?? video?.r_frame_rate),
    pixelFormat: textOrUndefined(video?.pix_fmt),
    audioCodec: textOrUndefined(audio?.codec_name),
    channels: Number.isFinite(Number(audio?.channels)) ? Math.trunc(Number(audio.channels)) : undefined,
    sampleRate: Number.isFinite(Number(audio?.sample_rate)) ? Math.trunc(Number(audio.sample_rate)) : undefined,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    streams: streams.map((stream, index) => compact({
      index: Number.isFinite(Number(stream.index)) ? Math.trunc(Number(stream.index)) : index,
      type: textOrUndefined(stream.codec_type),
      codec: textOrUndefined(stream.codec_name),
      width: Number.isFinite(Number(stream.width)) ? Math.trunc(Number(stream.width)) : undefined,
      height: Number.isFinite(Number(stream.height)) ? Math.trunc(Number(stream.height)) : undefined,
      fps: stream.codec_type === 'video' ? parseRate(stream.avg_frame_rate ?? stream.r_frame_rate) : undefined,
      channels: Number.isFinite(Number(stream.channels)) ? Math.trunc(Number(stream.channels)) : undefined,
      sampleRate: Number.isFinite(Number(stream.sample_rate)) ? Math.trunc(Number(stream.sample_rate)) : undefined,
    })),
  });
}

// #endregion

// #region Editing-application documents

/** The source length of one clip, in seconds. */
function clipSourceLength(clip) {
  const out = clip.out === undefined ? undefined : Number(clip.out);
  if (out !== undefined && Number.isFinite(out)) return round3(Math.max(0, out - clip.in));
  return round3(Number(clip.duration) || 0);
}

/** The timeline length of one clip, in seconds. */
function clipTimelineLength(clip) {
  return round3((Number(clip.duration) || 0));
}

/** One line per track, describing what the document writers need. */
export function timelinePlan(timeline) {
  const base = baseVideoTrackIndex(timeline);
  const plan = [];
  timeline.tracks.forEach((track, trackIndex) => {
    const clips = track.clips.map((clip) => ({
      clip,
      sourceIn: round3(clip.in),
      sourceLength: clipSourceLength(clip),
      timelineLength: clipTimelineLength(clip),
    }));
    plan.push({ trackIndex, type: track.type, isBase: trackIndex === base, clips });
  });
  return plan;
}

/**
 * Write the timeline as MLT XML, which Kdenlive and Shotcut open.
 */
export function toMlt(timeline, options = {}) {
  const title = options.title ?? 'Media Studio Timeline';
  const fps = timeline.fps;
  const width = timeline.width;
  const height = timeline.height;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<mlt LC_NUMERIC="C" version="7.0.0" title="${escapeXml(title)}" producer="main_bin">`);
  lines.push(`  <profile description="${escapeXml(`${width}x${height} ${fps} fps`)}" width="${width}" height="${height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width}" display_aspect_den="${height}" frame_rate_num="${fps}" frame_rate_den="1" colorspace="709"/>`);
  lines.push(`  <playlist id="main_bin">`);

  const plan = timelinePlan(timeline);
  let producerIndex = 0;
  const producers = [];
  plan.forEach((track) => {
    track.clips.forEach((entry) => {
      const id = `producer${producerIndex}`;
      producerIndex += 1;
      producers.push({ id, entry });
      lines.push(`    <entry producer="${id}"/>`);
    });
  });
  lines.push('  </playlist>');

  for (const producer of producers) {
    const clip = producer.entry.clip;
    lines.push(`  <producer id="${producer.id}" in="00:00:00.000" out="${formatMltTime(producer.entry.sourceLength)}">`);
    lines.push(`    <property name="resource">${escapeXml(String(clip.path).replace(/\\/gu, '/'))}</property>`);
    lines.push(`    <property name="mlt_service">avformat-novalidate</property>`);
    if (clip.isImage) lines.push('    <property name="ttl">1</property>');
    if (clip.speed !== 1) lines.push(`    <property name="warp_speed">${clip.speed}</property>`);
    if (clip.volume !== 1) lines.push(`    <property name="volume">${clip.volume}</property>`);
    lines.push('  </producer>');
  }

  const tractorTracks = [];
  plan.forEach((track, order) => {
    const playlistId = `playlist${order}`;
    lines.push(`  <playlist id="${playlistId}">`);
    let clock = 0;
    let producerCursor = plan.slice(0, order).reduce((sum, previous) => sum + previous.clips.length, 0);
    track.clips.forEach((entry) => {
      const producer = producers[producerCursor];
      producerCursor += 1;
      if (track.isBase) {
        lines.push(`    <entry producer="${producer.id}" in="${formatMltTime(entry.sourceIn)}" out="${formatMltTime(entry.sourceIn + Math.max(0.001, entry.sourceLength - 0.001))}"/>`);
        clock += entry.timelineLength;
        return;
      }
      const at = Number(entry.clip.overlay?.at) || 0;
      if (at > clock) {
        lines.push(`    <blank length="${formatMltTime(at - clock)}"/>`);
        clock = at;
      }
      lines.push(`    <entry producer="${producer.id}" in="${formatMltTime(entry.sourceIn)}" out="${formatMltTime(entry.sourceIn + Math.max(0.001, entry.sourceLength - 0.001))}"/>`);
      clock += entry.timelineLength;
    });
    lines.push('  </playlist>');
    tractorTracks.push(playlistId);
  });

  const total = timelineSeconds(timeline);
  lines.push(`  <tractor id="tractor0" title="${escapeXml(title)}" in="00:00:00.000" out="${formatMltTime(total)}">`);
  for (const playlistId of tractorTracks) {
    lines.push(`    <track producer="${playlistId}"/>`);
  }
  lines.push('  </tractor>');
  lines.push('</mlt>');
  return `${lines.join('\n')}\n`;
}

/** Format seconds as `HH:MM:SS.mmm`, the MLT way. */
export function formatMltTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMs = Math.round(safe * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}.${String(millis).padStart(3, '0')}`;
}

/** One OpenTimelineIO rational time. */
export function otioRationalTime(seconds, fps) {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    rate: fps,
    value: round3((Number(seconds) || 0) * fps),
  };
}

/** One OpenTimelineIO time range. */
export function otioTimeRange(startSeconds, durationSeconds, fps) {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    duration: otioRationalTime(durationSeconds, fps),
    start_time: otioRationalTime(startSeconds, fps),
  };
}

/** Write the timeline as an OpenTimelineIO document (JSON text). */
export function toOtio(timeline, options = {}) {
  const fps = timeline.fps;
  const plan = timelinePlan(timeline);
  const tracks = plan.map((track) => {
    const children = [];
    let clock = 0;
    for (const entry of track.clips) {
      if (!track.isBase) {
        const at = Number(entry.clip.overlay?.at) || 0;
        if (at > clock) {
          children.push({ OTIO_SCHEMA: 'Gap.1', name: 'gap', metadata: {}, source_range: otioTimeRange(0, at - clock, fps) });
          clock = at;
        }
      }
      children.push({
        OTIO_SCHEMA: 'Clip.1',
        name: basename(String(entry.clip.path)),
        metadata: compact({ 'media-studio': compact({ speed: entry.clip.speed === 1 ? undefined : entry.clip.speed, volume: entry.clip.volume === 1 ? undefined : entry.clip.volume }) }),
        source_range: otioTimeRange(entry.sourceIn, Math.max(0, entry.sourceLength), fps),
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: basename(String(entry.clip.path)),
          metadata: {},
          target_url: toFileUrl(entry.clip.path),
          available_range: otioTimeRange(0, Math.max(0, entry.sourceLength), fps),
        },
      });
      clock += entry.timelineLength;
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      name: `${track.type === 'audio' ? 'A' : 'V'}${track.trackIndex + 1}`,
      kind: track.type === 'audio' ? 'Audio' : 'Video',
      metadata: {},
      source_range: null,
      children,
    };
  });

  const document = {
    OTIO_SCHEMA: 'Timeline.1',
    name: options.title ?? 'Media Studio Timeline',
    metadata: compact({ 'media-studio': compact({ width: timeline.width, height: timeline.height, fps: timeline.fps }) }),
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      metadata: {},
      source_range: null,
      children: tracks,
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Write the timeline as FCPXML 1.9, which Final Cut Pro and Resolve open. */
export function toFcpxml(timeline, options = {}) {
  const fps = timeline.fps;
  const plan = timelinePlan(timeline);
  const total = timelineSeconds(timeline);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push('<fcpxml version="1.9">');
  lines.push('  <resources>');
  lines.push(`    <format id="r1" name="FFVideoFormat${timeline.width}x${timeline.height}p${fps}" frameDuration="1/${fps}s" width="${timeline.width}" height="${timeline.height}"/>`);

  let assetIndex = 2;
  const assetIds = new Map();
  for (const track of plan) {
    for (const entry of track.clips) {
      if (assetIds.has(entry.clip.path)) continue;
      const id = `r${assetIndex}`;
      assetIndex += 1;
      assetIds.set(entry.clip.path, id);
      const duration = Math.max(entry.sourceLength, entry.timelineLength, 0.001);
      lines.push(`    <asset id="${id}" name="${escapeXml(basename(String(entry.clip.path)))}" start="0s" duration="${formatFcpxmlTime(duration, fps)}" hasVideo="${track.type === 'video' ? 1 : 0}" hasAudio="${entry.clip.isImage ? 0 : 1}" format="r1">`);
      lines.push(`      <media-rep kind="original-media" src="${escapeXml(toFileUrl(entry.clip.path))}"/>`);
      lines.push('    </asset>');
    }
  }
  lines.push('  </resources>');
  lines.push('  <library>');
  lines.push(`    <event name="${escapeXml(options.event ?? 'Media Studio')}">`);
  lines.push(`      <project name="${escapeXml(options.title ?? 'Timeline')}">`);
  lines.push(`        <sequence format="r1" duration="${formatFcpxmlTime(total, fps)}" tcStart="0s" tcFormat="NDF">`);
  lines.push('          <spine>');

  const spineTrack = plan.find((track) => track.isBase) ?? plan[0];
  let clock = 0;
  for (const entry of spineTrack.clips) {
    lines.push(`            <asset-clip ref="${assetIds.get(entry.clip.path)}" offset="${formatFcpxmlTime(clock, fps)}" name="${escapeXml(basename(String(entry.clip.path)))}" start="${formatFcpxmlTime(entry.sourceIn, fps)}" duration="${formatFcpxmlTime(Math.max(0.001, entry.timelineLength), fps)}"/>`);
    clock += entry.timelineLength;
  }

  const connected = plan.filter((track) => !track.isBase);
  for (const track of connected) {
    for (const entry of track.clips) {
      const at = Number(entry.clip.overlay?.at) || 0;
      lines.push(`            <asset-clip ref="${assetIds.get(entry.clip.path)}" lane="${track.type === 'audio' ? -1 : 1}" offset="${formatFcpxmlTime(at, fps)}" name="${escapeXml(basename(String(entry.clip.path)))}" start="${formatFcpxmlTime(entry.sourceIn, fps)}" duration="${formatFcpxmlTime(Math.max(0.001, entry.timelineLength), fps)}"/>`);
    }
  }

  lines.push('          </spine>');
  lines.push('        </sequence>');
  lines.push('      </project>');
  lines.push('    </event>');
  lines.push('  </library>');
  lines.push('</fcpxml>');
  return `${lines.join('\n')}\n`;
}

/** Write the timeline as a CMX3600 EDL. */
export function toEdl(timeline, options = {}) {
  const fps = timeline.fps;
  const plan = timelinePlan(timeline);
  const lines = [];
  lines.push(`TITLE: ${String(options.title ?? 'Media Studio Timeline').toUpperCase().slice(0, 70)}`);
  lines.push('FCM: NON-DROP FRAME');
  lines.push('');

  let event = 0;
  plan.forEach((track) => {
    let clock = 0;
    for (const entry of track.clips) {
      const at = track.isBase ? clock : (Number(entry.clip.overlay?.at) || 0);
      event += 1;
      const number = String(event).padStart(3, '0');
      const channel = track.type === 'audio' ? 'A' : 'V';
      const reel = reelName(entry.clip.path);
      const from = formatEdlTimecode(entry.sourceIn, fps);
      const to = formatEdlTimecode(entry.sourceIn + entry.timelineLength, fps);
      const recordIn = formatEdlTimecode(at, fps);
      const recordOut = formatEdlTimecode(at + entry.timelineLength, fps);
      lines.push(`${number}  ${reel.padEnd(8, ' ')} ${channel}     C        ${from} ${to} ${recordIn} ${recordOut}`);
      lines.push(`* FROM CLIP NAME: ${basename(String(entry.clip.path))}`);
      if (!track.isBase) lines.push(`* MEDIA STUDIO LAYER: ${track.type}`);
      lines.push('');
      clock = at + entry.timelineLength;
    }
  });
  return `${lines.join('\n')}\n`;
}

/** A short reel name for an EDL event. */
function reelName(path) {
  const stem = basename(String(path ?? 'AX')).replace(/\.[^.]+$/u, '').toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  return stem === '' ? 'AX' : stem.slice(0, 8);
}

/** Write a timeline document in the requested format. */
export function renderTimelineDocument(timeline, format, options = {}) {
  switch (format) {
    case 'mlt':
      return toMlt(timeline, options);
    case 'otio':
      return toOtio(timeline, options);
    case 'fcpxml':
      return toFcpxml(timeline, options);
    case 'edl':
      return toEdl(timeline, options);
    default:
      throw new Error(`未対応の形式です: ${format}。Unsupported timeline format.`);
  }
}

// #endregion

// #region Process helpers

/** Spawn one process with a timeout, an optional abort signal and no window. */
function runProcess(executable, args, { timeoutMs = 1800000, signal, cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      rejectPromise(cause);
      return;
    }
    const stdout = [];
    const stderr = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already be gone.
      }
      finish(rejectPromise, new Error(`${basename(executable)} が ${Math.round(timeoutMs / 1000)} 秒でタイムアウトしました。Timed out.`));
    }, timeoutMs);
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already be gone.
      }
      finish(rejectPromise, new Error('キャンセルされました。Cancelled.'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (cause) => finish(rejectPromise, cause));
    child.on('close', (code) => finish(resolvePromise, {
      code: code ?? 0,
      stdout: Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))).toString('utf8'),
      stderr: Buffer.concat(stderr.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    }));
  });
}

/** The first stderr line that carries a real message. */
function firstMeaningfulLine(text) {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  return lines.find((line) => !line.startsWith('[') && !/^WARNING/u.test(line)) ?? lines[0];
}

/** Candidate ffprobe path that sits beside a known ffmpeg. */
function siblingProbe(ffmpegPath) {
  if (typeof ffmpegPath !== 'string' || ffmpegPath === '' || ffmpegPath === 'ffmpeg') return undefined;
  const candidate = join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return existsSync(candidate) ? candidate : undefined;
}

/** Find ffmpeg and ffprobe, or say what to install. */
export async function resolveBinaries(options, config) {
  const section = config ?? {};
  const configured = textOrUndefined(section.ffmpegPath)
    ?? textOrUndefined(options?.video?.ffmpegPath)
    ?? textOrUndefined(options?.nle?.ffmpegPath);

  let ffmpeg;
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`ffmpeg が見つかりません: ${configured}`);
    ffmpeg = configured;
  } else {
    try {
      await runProcess('ffmpeg', ['-version'], { timeoutMs: 15000 });
      ffmpeg = 'ffmpeg';
    } catch {
      throw new Error('ffmpeg が見つかりません。PATH に追加するか、cordis.patch.yml の video.ffmpegPath / nle.ffmpegPath にフルパスを指定してください。ffmpeg is required to edit video.');
    }
  }

  const configuredProbe = textOrUndefined(section.ffprobePath) ?? textOrUndefined(options?.video?.ffprobePath);
  let ffprobe;
  if (configuredProbe !== undefined) {
    if (!existsSync(configuredProbe)) throw new Error(`ffprobe が見つかりません: ${configuredProbe}`);
    ffprobe = configuredProbe;
  } else {
    const sibling = siblingProbe(ffmpeg);
    if (sibling !== undefined) {
      ffprobe = sibling;
    } else {
      try {
        await runProcess('ffprobe', ['-version'], { timeoutMs: 15000 });
        ffprobe = 'ffprobe';
      } catch {
        throw new Error('ffprobe が見つかりません。PATH に追加するか、cordis.patch.yml の nle.ffprobePath にフルパスを指定してください。ffprobe is required to probe media.');
      }
    }
  }
  return { ffmpeg, ffprobe };
}

/** Ask ffprobe about one file. */
async function probeFile(ffprobe, path, timeoutMs) {
  const run = await runProcess(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs });
  if (run.code !== 0) {
    throw new Error(`メディアを読み取れません (exit ${run.code}): ${path} — ${firstMeaningfulLine(run.stderr) ?? ''}`.trim());
  }
  let document;
  try {
    document = JSON.parse(run.stdout);
  } catch {
    throw new Error(`ffprobe の出力を解析できません: ${path}`);
  }
  return summarizeProbe(document);
}

/** Pick a font file for burned-in text. */
export function resolveFont(options, config) {
  const configured = textOrUndefined(config?.fontPath) ?? textOrUndefined(options?.nle?.fontPath);
  if (configured !== undefined && existsSync(configured)) return configured;
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return FONT_CANDIDATES[0];
}

// #endregion

// #region Paths and output

/** The session working directory, falling back to the process directory. */
async function sessionCwd(ctx, exec, helpers) {
  if (typeof helpers?.resolveSessionCwd === 'function') {
    const value = await helpers.resolveSessionCwd(ctx, exec);
    if (typeof value === 'string' && value !== '') return value;
  }
  return process.cwd();
}

/** A directory inside the session, safe against `..` escapes. */
function outputDirectory(options, config, helpers, requested) {
  const base = requested ?? options?.outputDir ?? 'media-studio';
  const safe = typeof helpers?.safeRelativeDir === 'function' ? helpers.safeRelativeDir(base) : base;
  return typeof safe === 'string' && safe !== '' ? safe : 'media-studio';
}

/** A display path relative to the session directory. */
function displayPath(cwd, absolute) {
  return absolute.startsWith(cwd + sep) ? absolute.slice(cwd.length + 1) : absolute;
}

/** Resolve a caller-supplied media path against the session. */
function resolveMediaPath(cwd, value) {
  const text = String(value ?? '');
  if (text === '') throw new Error('空のパスです。Empty path.');
  const absolute = isAbsolute(text) ? text : resolve(cwd, text);
  if (!existsSync(absolute)) throw new Error(`ファイルが見つかりません: ${text}`);
  return absolute;
}

/** A file stem safe to use on disk. */
function safeStem(value, fallback) {
  const text = textOrUndefined(value);
  if (text === undefined) return fallback;
  const cleaned = text.replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned === '' ? fallback : cleaned.slice(0, 60);
}

/** A short timestamp for generated names. */
function stamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    '-',
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds()),
  ].join('');
}

/** Size of a file in bytes. */
async function fileSize(path) {
  const info = await stat(path);
  return info.size;
}

// #endregion

// #region Tool: edit_video

/** `edit_video`: cut a timeline into one finished file. */
function editVideoTool(ctx, options, config, helpers) {
  const timeoutMs = numberOr(config?.timeoutMs, 1800000);
  return {
    name: 'edit_video',
    description: [
      'Edit a video timeline into one finished file: trim clips, join them with',
      'transitions, change speed, crop, scale, rotate, overlay a picture-in-picture,',
      'burn in telops and subtitles, mix a music bed with fades and ducking, and',
      'adjust colour. Use it when the user asks to cut, trim, join, subtitle or',
      're-edit existing footage; for a generated clip use generate_video, and for a',
      'slide-style sequence of drawn scenes use produce_video.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeline: {
          type: 'object',
          additionalProperties: true,
          description: 'The timeline: { width, height, fps, tracks: [{ type: "video"|"audio", clips: [...] }], subtitles: [...] }.',
          properties: {
            width: { type: 'integer', description: 'Canvas width in pixels.' },
            height: { type: 'integer', description: 'Canvas height in pixels.' },
            fps: { type: 'integer', description: 'Frames per second.' },
            tracks: {
              type: 'array',
              description: 'The tracks, bottom first.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  type: { type: 'string', enum: ['video', 'audio'], description: 'video or audio.' },
                  clips: {
                    type: 'array',
                    description: 'The clips of this track, in order.',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        path: { type: 'string', description: 'File path of the clip, relative to the session or absolute.' },
                        materialId: { type: 'string', description: 'A material id, resolved through materials.' },
                        in: { type: 'number', description: 'Source in point in seconds. Defaults to 0.' },
                        out: { type: 'number', description: 'Source out point in seconds. Defaults to the end of the file.' },
                        speed: { type: 'number', description: 'Playback speed, 0.25 to 4. Defaults to 1.' },
                        volume: { type: 'number', description: 'Audio gain, 0 to 4. Defaults to 1.' },
                        fadeIn: { type: 'number', description: 'Audio fade in, in seconds.' },
                        fadeOut: { type: 'number', description: 'Audio fade out, in seconds.' },
                        duck: { type: 'boolean', description: 'Lower this clip under the main audio (music ducking).' },
                        transition: { type: 'string', enum: NLE_TRANSITIONS, description: 'How this clip hands over to the next.' },
                        transitionDuration: { type: 'number', description: 'Length of that transition, in seconds. Defaults to 0.5.' },
                        crop: {
                          type: 'object',
                          additionalProperties: false,
                          description: 'Cut a rectangle out of the frame before fitting it to the canvas.',
                          properties: {
                            w: { type: 'integer' },
                            h: { type: 'integer' },
                            x: { type: 'integer' },
                            y: { type: 'integer' },
                          },
                        },
                        rotate: { type: 'number', description: 'Rotation in degrees: 0, 90, 180 or 270.' },
                        color: {
                          type: 'object',
                          additionalProperties: false,
                          description: 'Colour adjustment.',
                          properties: {
                            brightness: { type: 'number', description: '-1 to 1. Defaults to 0.' },
                            contrast: { type: 'number', description: '0 to 4. Defaults to 1.' },
                            saturation: { type: 'number', description: '0 to 4. Defaults to 1.' },
                            gamma: { type: 'number', description: '0.1 to 10. Defaults to 1.' },
                          },
                        },
                        text: {
                          type: 'object',
                          additionalProperties: false,
                          description: 'A telop burned over this clip.',
                          properties: {
                            value: { type: 'string', description: 'The words.' },
                            position: { type: 'string', enum: TEXT_POSITIONS, description: 'Where it sits. Defaults to bottom.' },
                            color: { type: 'string', description: 'Text colour, a name or #rrggbb. Defaults to white.' },
                            boxColor: { type: 'string', description: 'Backing box colour. Defaults to black@0.5.' },
                            fontSize: { type: 'integer', description: 'Font size in pixels. Defaults to 5.5% of the canvas height.' },
                          },
                        },
                        position: { type: 'string', enum: OVERLAY_POSITIONS, description: 'Corner for a picture-in-picture clip.' },
                        scale: { type: 'number', description: 'Picture-in-picture size as a fraction of the canvas width. Defaults to 0.3.' },
                        at: { type: 'number', description: 'When a picture-in-picture clip appears, in seconds.' },
                      },
                    },
                  },
                },
              },
            },
            subtitles: {
              type: 'array',
              description: 'Subtitle cues burned into the picture.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  start: { type: 'number', description: 'Start time in seconds.' },
                  end: { type: 'number', description: 'End time in seconds.' },
                  text: { type: 'string', description: 'The line.' },
                },
              },
            },
          },
        },
        clips: {
          type: 'array',
          description: 'A shortcut for a single video track: file paths (or clip objects) joined in order.',
          items: { type: ['string', 'object'] },
        },
        paths: {
          type: 'array',
          description: 'Alias of clips: file paths joined in order.',
          items: { type: 'string' },
        },
        materials: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Material id to file path, so clips can name a materialId instead of a path.',
        },
        subtitles: {
          type: 'array',
          description: 'Subtitle cues burned into the picture, as an alternative to timeline.subtitles.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
              text: { type: 'string' },
            },
          },
        },
        width: { type: 'integer', description: 'Canvas width in pixels. Defaults to 1280.' },
        height: { type: 'integer', description: 'Canvas height in pixels. Defaults to 720.' },
        fps: { type: 'integer', description: 'Frames per second. Defaults to 30.' },
        format: { type: 'string', enum: NLE_FORMATS, description: 'Output container. Defaults to mp4.' },
        name: { type: 'string', description: 'File name stem for the result.' },
        outputDir: { type: 'string', description: 'Directory inside the session. Defaults to media-studio.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['width', 'height', 'fps', 'seconds', 'clips', 'tracks', 'bytes', 'mediaType', 'name'],
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          fps: { type: 'integer' },
          seconds: { type: 'number' },
          clips: { type: 'integer' },
          tracks: { type: 'integer' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          name: { type: 'string' },
          hasAudio: { type: 'boolean' },
          subtitles: { type: 'integer' },
          transitions: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        const blocks = [{
          type: 'text',
          text: `動画を編集しました (${value.tracks} トラック / ${value.clips} クリップ, ${value.width}×${value.height}, ${value.fps}fps, ${value.seconds.toFixed(1)}s, ${value.format}): ${value.path ?? value.name}`,
        }];
        const notes = [];
        if (value.transitions > 0) notes.push(`トランジション ${value.transitions} か所`);
        if (value.subtitles > 0) notes.push(`字幕 ${value.subtitles} 行を焼き込み`);
        if (value.hasAudio === false) notes.push('音声なし');
        if (notes.length > 0) blocks.push({ type: 'text', text: notes.join(' / ') });
        return blocks;
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: timeoutMs + 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec, helpers);
      const materials = materialMap(args.materials);
      const input = args.timeline ?? (args.clips !== undefined ? { clips: args.clips } : (args.paths !== undefined ? { paths: args.paths } : undefined));
      if (input === undefined) {
        throw new Error('timeline か clips を指定してください。Provide a timeline or a list of clips.');
      }

      const timeline = normalizeTimeline(input, {
        width: args.width,
        height: args.height,
        fps: args.fps,
        format: args.format,
        materials,
      });

      const requestedSubtitles = args.subtitles;
      if (Array.isArray(requestedSubtitles) && requestedSubtitles.length > 0) {
        timeline.subtitles = normalizeCues(requestedSubtitles);
      }
      timeline.subtitles = normalizeCues(timeline.subtitles);

      const flat = flattenTimeline(timeline);
      const absolutePaths = flat.map((entry) => resolveMediaPath(cwd, entry.clip.path));
      flat.forEach((entry, index) => {
        entry.clip.path = absolutePaths[index];
      });

      const binaries = await resolveBinaries(options, config);
      const probes = [];
      for (const path of absolutePaths) {
        probes.push(await probeFile(binaries.ffprobe, path, Math.min(timeoutMs, 120000)));
      }

      for (const entry of flat) {
        const probe = probes[entry.index];
        if (entry.trackType === 'video' && probe.hasVideo !== true) {
          throw new Error(`映像ストリームがありません: ${basename(entry.clip.path)}。No video stream in this clip.`);
        }
      }

      applyProbeDurations(timeline, probes);
      const seconds = timelineSeconds(timeline);
      if (seconds > MAX_NLE_SECONDS) {
        throw new Error(`タイムラインが長すぎます (${Math.round(seconds)} 秒)。上限は ${MAX_NLE_SECONDS} 秒です。`);
      }

      const work = await mkdtemp(join(tmpdir(), 'dsh-nle-'));
      try {
        const fontFile = resolveFont(options, config);

        // Write every text block to a file so no quoting can break the filter.
        let textIndex = 0;
        const writeText = async (value) => {
          const path = join(work, `text-${textIndex}.txt`);
          textIndex += 1;
          await writeFile(path, String(value), 'utf8');
          return path;
        };
        for (const entry of flat) {
          if (entry.clip.text !== undefined) entry.clip.text.file = await writeText(entry.clip.text.value);
        }
        for (const cue of timeline.subtitles) {
          cue.file = await writeText(cue.text);
        }

        const graph = buildFilterComplex(timeline, probes.map((probe) => ({
          hasVideo: probe.hasVideo === true,
          hasAudio: probe.hasAudio === true,
        })), { fontFile });

        const directory = join(cwd, outputDirectory(options, config, helpers, args.outputDir));
        await mkdir(directory, { recursive: true });
        const extension = FORMAT_EXTENSIONS[timeline.format];
        const stem = safeStem(args.name, `edit-${stamp()}`);
        const target = join(directory, `${stem}.${extension}`);

        const run = await runProcess(binaries.ffmpeg, buildFfmpegArgs(timeline, graph, target), {
          timeoutMs,
          signal: exec?.signal,
        });
        if (run.code !== 0) {
          throw new Error(`動画の書き出しに失敗しました (exit ${run.code}): ${firstMeaningfulLine(run.stderr) ?? run.stderr.trim()}`);
        }

        const bytes = await fileSize(target);
        if (bytes === 0) throw new Error('ffmpeg が空のファイルを書き出しました。');

        return compact({
          width: timeline.width,
          height: timeline.height,
          fps: timeline.fps,
          seconds: graph.seconds,
          clips: flat.length,
          tracks: timeline.tracks.length,
          format: timeline.format,
          bytes,
          mediaType: FORMAT_MEDIA_TYPES[timeline.format],
          name: basename(target),
          hasAudio: graph.audio !== undefined,
          subtitles: timeline.subtitles.length,
          transitions: graph.transitions.length,
          path: displayPath(cwd, target),
        });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// #endregion

// #region Tool: probe_video

/** `probe_video`: what is inside a media file. */
function probeVideoTool(ctx, options, config, helpers) {
  const timeoutMs = numberOr(config?.probeTimeoutMs, 120000);
  return {
    name: 'probe_video',
    description: [
      'Read what a media file actually contains: duration, size, bitrate, codecs,',
      'resolution, frame rate, channels and sample rate. Use it before editing a',
      'recording, when the user asks how long a file is, or to confirm what',
      'edit_video just wrote.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File to inspect, relative to the session or absolute.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'bytes', 'mediaType', 'duration', 'hasVideo', 'hasAudio'],
        properties: {
          name: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          duration: { type: 'number' },
          hasVideo: { type: 'boolean' },
          hasAudio: { type: 'boolean' },
          formatName: { type: 'string' },
          videoCodec: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          fps: { type: 'number' },
          pixelFormat: { type: 'string' },
          audioCodec: { type: 'string' },
          channels: { type: 'integer' },
          sampleRate: { type: 'integer' },
          bitrate: { type: 'integer' },
          streams: { type: 'array', items: { type: 'object', additionalProperties: true } },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        const blocks = [{
          type: 'text',
          text: `${value.name}: ${value.duration.toFixed(2)}s${value.width === undefined ? '' : `, ${value.width}×${value.height}`}${value.fps === undefined ? '' : `, ${value.fps}fps`}${value.videoCodec === undefined ? '' : `, ${value.videoCodec}`}${value.audioCodec === undefined ? '' : `, ${value.audioCodec}`}`,
        }];
        const extra = [];
        if (value.hasAudio) {
          extra.push(value.channels === undefined ? '音声あり' : `音声 ${value.channels}ch`);
        } else {
          extra.push('音声なし');
        }
        extra.push(`${value.bytes} バイト`);
        blocks.push({ type: 'text', text: extra.join(' / ') });
        return blocks;
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: timeoutMs + 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec, helpers);
      const absolute = resolveMediaPath(cwd, args.path);
      const binaries = await resolveBinaries(options, config);
      const summary = await probeFile(binaries.ffprobe, absolute, timeoutMs);
      const bytes = await fileSize(absolute);
      const extension = extname(absolute).toLowerCase();

      return compact({
        name: basename(absolute),
        bytes,
        mediaType: mediaTypeForExtension(extension),
        duration: summary.duration,
        hasVideo: summary.hasVideo,
        hasAudio: summary.hasAudio,
        formatName: summary.formatName,
        videoCodec: summary.videoCodec,
        width: summary.width,
        height: summary.height,
        fps: summary.fps,
        pixelFormat: summary.pixelFormat,
        audioCodec: summary.audioCodec,
        channels: summary.channels,
        sampleRate: summary.sampleRate,
        bitrate: summary.bitrate,
        streams: summary.streams,
        path: displayPath(cwd, absolute),
      });
    },
  };
}

/** Media type guessed from a file extension. */
function mediaTypeForExtension(extension) {
  switch (extension) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.gif':
      return 'image/gif';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    case '.flac':
      return 'audio/flac';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

// #endregion

// #region Tool: export_timeline

/** `export_timeline`: write the timeline for an editing application. */
function exportTimelineTool(ctx, options, config, helpers) {
  return {
    name: 'export_timeline',
    description: [
      'Write the same timeline as a project file an editing application opens:',
      'mlt (Kdenlive, Shotcut), otio (OpenTimelineIO, Resolve, RV), fcpxml 1.9',
      '(Final Cut Pro, DaVinci Resolve) or edl (CMX3600). Use it when the user',
      'wants to keep editing elsewhere, or asks for an EDL or a project file.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['format'],
      properties: {
        format: { type: 'string', enum: TIMELINE_FORMATS, description: 'mlt, otio, fcpxml or edl.' },
        timeline: {
          type: 'object',
          additionalProperties: true,
          description: 'The timeline, in the same shape edit_video takes.',
        },
        clips: {
          type: 'array',
          description: 'A shortcut for a single video track: file paths joined in order.',
          items: { type: ['string', 'object'] },
        },
        paths: {
          type: 'array',
          description: 'Alias of clips.',
          items: { type: 'string' },
        },
        materials: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Material id to file path.',
        },
        title: { type: 'string', description: 'Name of the project inside the document.' },
        width: { type: 'integer', description: 'Canvas width in pixels. Defaults to 1280.' },
        height: { type: 'integer', description: 'Canvas height in pixels. Defaults to 720.' },
        fps: { type: 'integer', description: 'Frames per second. Defaults to 30.' },
        name: { type: 'string', description: 'File name stem for the result.' },
        outputDir: { type: 'string', description: 'Directory inside the session. Defaults to media-studio.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['format', 'name', 'bytes', 'mediaType', 'clips', 'tracks', 'seconds'],
        properties: {
          format: { type: 'string' },
          name: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          clips: { type: 'integer' },
          tracks: { type: 'integer' },
          seconds: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          fps: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `タイムラインを ${value.format.toUpperCase()} で書き出しました (${value.tracks} トラック / ${value.clips} クリップ, ${value.seconds.toFixed(1)}s): ${value.path ?? value.name}`,
        }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec, helpers);
      const materials = materialMap(args.materials);
      const input = args.timeline ?? (args.clips !== undefined ? { clips: args.clips } : (args.paths !== undefined ? { paths: args.paths } : undefined));
      if (input === undefined) {
        throw new Error('timeline か clips を指定してください。Provide a timeline or a list of clips.');
      }
      if (!TIMELINE_FORMATS.includes(args.format)) {
        throw new Error(`未対応の形式です: ${args.format}。Unsupported timeline format.`);
      }

      const timeline = normalizeTimeline(input, {
        width: args.width,
        height: args.height,
        fps: args.fps,
        materials,
      });

      const flat = flattenTimeline(timeline);
      const absolutePaths = flat.map((entry) => resolveMediaPath(cwd, entry.clip.path));
      flat.forEach((entry, index) => {
        entry.clip.path = absolutePaths[index];
      });

      // Lengths come from the files when the timeline does not state them.
      const needsProbe = flat.some((entry) => entry.clip.duration === undefined || entry.clip.duration <= 0);
      if (needsProbe) {
        const binaries = await resolveBinaries(options, config);
        const probes = [];
        for (const path of absolutePaths) {
          probes.push(await probeFile(binaries.ffprobe, path, 120000));
        }
        applyProbeDurations(timeline, probes);
      }

      const text = renderTimelineDocument(timeline, args.format, { title: args.title });
      const directory = join(cwd, outputDirectory(options, config, helpers, args.outputDir));
      await mkdir(directory, { recursive: true });
      const stem = safeStem(args.name, `timeline-${stamp()}`);
      const target = join(directory, `${stem}.${TIMELINE_EXTENSIONS[args.format]}`);
      await writeFile(target, text, 'utf8');
      const bytes = await fileSize(target);

      return compact({
        format: args.format,
        name: basename(target),
        bytes,
        mediaType: TIMELINE_MEDIA_TYPES[args.format],
        clips: flat.length,
        tracks: timeline.tracks.length,
        seconds: timelineSeconds(timeline),
        width: timeline.width,
        height: timeline.height,
        fps: timeline.fps,
        path: displayPath(cwd, target),
      });
    },
  };
}

// #endregion

// #region Tool: make_subtitles

/** `make_subtitles`: build an SRT or WebVTT file. */
function makeSubtitlesTool(ctx, options, config, helpers) {
  return {
    name: 'make_subtitles',
    description: [
      'Build a subtitle file (SRT or WebVTT) from timed cues, from a block of text',
      'spread over a duration, from the result of transcribe_audio, or from an',
      'existing subtitle file that needs converting. Burn the result into the',
      'picture with edit_video subtitles.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cues: {
          type: 'array',
          description: 'Timed cues: [{ start, end, text }] in seconds.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'number', description: 'Start time in seconds.' },
              end: { type: 'number', description: 'End time in seconds.' },
              text: { type: 'string', description: 'The line.' },
            },
          },
        },
        text: { type: 'string', description: 'Plain text to split into cues and spread over duration.' },
        duration: { type: 'number', description: 'How long the text should run, in seconds. Defaults to 5.' },
        transcript: {
          type: 'object',
          additionalProperties: true,
          description: 'A transcribe_audio result: either { segments: [{ start, end, text }] } or { text, duration }.',
        },
        input: { type: 'string', description: 'An existing .srt or .vtt file to read or convert.' },
        format: { type: 'string', enum: SUBTITLE_FORMATS, description: 'srt or vtt. Defaults to srt.' },
        name: { type: 'string', description: 'File name stem for the result.' },
        outputDir: { type: 'string', description: 'Directory inside the session. Defaults to media-studio.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['format', 'name', 'bytes', 'mediaType', 'cues', 'seconds'],
        properties: {
          format: { type: 'string' },
          name: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          cues: { type: 'integer' },
          seconds: { type: 'number' },
          firstCue: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `字幕を ${value.format.toUpperCase()} で作りました (${value.cues} 行, ${value.seconds.toFixed(1)}s): ${value.path ?? value.name}`,
        }];
      },
      presentationMeta(_args, value) {
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec, helpers);
      const format = SUBTITLE_FORMATS.includes(args.format) ? args.format : 'srt';

      let cues = [];
      if (Array.isArray(args.cues) && args.cues.length > 0) {
        cues = normalizeCues(args.cues);
      } else if (args.input !== undefined) {
        const absolute = resolveMediaPath(cwd, args.input);
        const parsed = parseSubtitles(await readFile(absolute, 'utf8'));
        cues = parsed.cues;
      } else if (args.transcript !== null && typeof args.transcript === 'object') {
        const transcript = args.transcript;
        if (Array.isArray(transcript.segments) && transcript.segments.length > 0) {
          cues = normalizeCues(transcript.segments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text,
          })));
        } else if (typeof transcript.text === 'string') {
          cues = normalizeCues(cuesFromText(transcript.text, {
            duration: numberOr(transcript.duration, numberOr(args.duration, 5)),
          }));
        }
      } else if (typeof args.text === 'string' && args.text.trim() !== '') {
        cues = normalizeCues(cuesFromText(args.text, { duration: numberOr(args.duration, 5) }));
      }

      if (cues.length === 0) {
        throw new Error('字幕の元になるテキストがありません。Provide cues, text, transcript or input.');
      }

      const text = format === 'vtt' ? toVtt(cues) : toSrt(cues);
      const directory = join(cwd, outputDirectory(options, config, helpers, args.outputDir));
      await mkdir(directory, { recursive: true });
      const stem = safeStem(args.name, `subtitles-${stamp()}`);
      const target = join(directory, `${stem}.${format}`);
      await writeFile(target, text, 'utf8');
      const bytes = await fileSize(target);
      const last = cues[cues.length - 1];

      return compact({
        format,
        name: basename(target),
        bytes,
        mediaType: SUBTITLE_MEDIA_TYPES[format],
        cues: cues.length,
        seconds: round3(last.end),
        firstCue: cues[0].text.slice(0, 80),
        path: displayPath(cwd, target),
      });
    },
  };
}

// #endregion

// #region Registration

/**
 * Register the four NLE tools on the plugin context.
 *
 * Registration is synchronous: nothing here touches the disk or spawns a
 * process. The work happens in `execute()`.
 */
export function registerNleTools(ctx, options, config, helpers) {
  const section = config?.nle ?? {};
  const tools = [
    editVideoTool(ctx, options, section, helpers),
    probeVideoTool(ctx, options, section, helpers),
    exportTimelineTool(ctx, options, section, helpers),
    makeSubtitlesTool(ctx, options, section, helpers),
  ];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
  }
}

// #endregion
