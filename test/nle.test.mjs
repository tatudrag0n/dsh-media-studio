/**
 * Tests for the NLE module.
 *
 * The pure half — timeline normalization, the filter graph, the four project
 * documents and the subtitle writers — runs everywhere. The render half runs
 * against the real ffmpeg when the machine has one, and says so when it does
 * not.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as nle from '../nle.js';

const hasBinary = (name) => {
  try {
    return spawnSync(name, ['-version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
};

const hasFfmpeg = hasBinary('ffmpeg') && hasBinary('ffprobe');
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;

/** Build a tool set wired to a session directory. */
function makeTools(session, config = {}, options = {}) {
  const tools = new Map();
  const ctx = {
    effect(effect) {
      effect();
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
  };
  const helpers = {
    async resolveSessionCwd() {
      return session;
    },
    formatBytes(bytes) {
      return `${bytes} B`;
    },
    safeRelativeDir(dir) {
      return dir;
    },
  };
  nle.registerNleTools(ctx, { outputDir: 'media-studio', video: {}, ...options }, config, helpers);
  return tools;
}

/** Normalize a timeline and give every clip the length a probe would report. */
function timelineWithDurations(spec, durations, defaults = {}) {
  const timeline = nle.normalizeTimeline(spec, defaults);
  nle.applyProbeDurations(timeline, durations.map((entry) => (typeof entry === 'number'
    ? { duration: entry, hasVideo: true, hasAudio: true }
    : entry)));
  return timeline;
}

/** The filter graph for a timeline, with every input assumed to carry video and audio. */
function graphFor(timeline, overrides = []) {
  const flat = nle.flattenTimeline(timeline);
  const sources = flat.map((entry, index) => overrides[index] ?? { hasVideo: true, hasAudio: true });
  return nle.buildFilterComplex(timeline, sources, { fontFile: 'C:/Windows/Fonts/meiryo.ttc' });
}

// #region Pure: text and time formatting

describe('nle escaping helpers', () => {
  it('escapes XML text and attribute content', () => {
    assert.equal(nle.escapeXml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
    assert.equal(nle.escapeXml(undefined), '');
  });

  it('turns a Windows path into an ffmpeg filter value', () => {
    assert.equal(nle.escapeFilterPath('C:\\Temp\\a b\\x.txt'), 'C\\:/Temp/a b/x.txt');
  });

  it('turns an absolute path into a file URL', () => {
    assert.equal(nle.toFileUrl('C:\\clips\\a.mp4'), 'file:///C:/clips/a.mp4');
    assert.equal(nle.toFileUrl('/home/x/a.mp4'), 'file:///home/x/a.mp4');
  });
});

describe('nle time formatting', () => {
  it('formats SRT and WebVTT timestamps', () => {
    assert.equal(nle.formatSrtTime(0), '00:00:00,000');
    assert.equal(nle.formatSrtTime(3661.25), '01:01:01,250');
    assert.equal(nle.formatVttTime(2.5), '00:00:02.500');
  });

  it('formats a CMX3600 timecode', () => {
    assert.equal(nle.formatEdlTimecode(0, 30), '00:00:00:00');
    assert.equal(nle.formatEdlTimecode(1.5, 30), '00:00:01:15');
    assert.equal(nle.formatEdlTimecode(61, 25), '00:01:01:00');
  });

  it('formats FCPXML rational times', () => {
    assert.equal(nle.formatFcpxmlTime(0, 30), '0s');
    assert.equal(nle.formatFcpxmlTime(3.5, 30), '105/30s');
  });

  it('formats MLT clock times', () => {
    assert.equal(nle.formatMltTime(3.5), '00:00:03.500');
    assert.equal(nle.formatMltTime(0), '00:00:00.000');
  });
});

// #endregion

// #region Pure: subtitles

describe('nle subtitle text', () => {
  it('parses an SRT document', () => {
    const parsed = nle.parseSubtitles('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n');
    assert.equal(parsed.format, 'srt');
    assert.equal(parsed.cues.length, 2);
    assert.deepEqual(parsed.cues[0], { start: 1, end: 2.5, text: 'Hello' });
  });

  it('parses a WebVTT document with a byte order mark and CRLF', () => {
    const parsed = nle.parseSubtitles('\uFEFFWEBVTT\r\n\r\n00:00:00.500 --> 00:00:01.000\r\nHi\r\n');
    assert.equal(parsed.format, 'vtt');
    assert.equal(parsed.cues.length, 1);
    assert.equal(parsed.cues[0].start, 0.5);
    assert.equal(parsed.cues[0].text, 'Hi');
  });

  it('keeps multi-line cue text', () => {
    const parsed = nle.parseSubtitles('1\n00:00:00,000 --> 00:00:01,000\nline one\nline two\n');
    assert.equal(parsed.cues[0].text, 'line one\nline two');
  });

  it('writes SRT and reads it back', () => {
    const cues = [{ start: 0, end: 1.5, text: 'ひとつめ' }, { start: 2, end: 3.25, text: 'ふたつめ' }];
    const text = nle.toSrt(cues);
    assert.match(text, /^1\n00:00:00,000 --> 00:00:01,500\nひとつめ/u);
    assert.deepEqual(nle.parseSubtitles(text).cues, cues);
  });

  it('writes WebVTT with the required header', () => {
    const text = nle.toVtt([{ start: 0, end: 1, text: 'a' }]);
    assert.ok(text.startsWith('WEBVTT\n\n'));
    assert.match(text, /00:00:00\.000 --> 00:00:01\.000/u);
  });

  it('sorts and clamps cues', () => {
    const cues = nle.normalizeCues([
      { start: 5, end: 6, text: 'late' },
      { start: -3, end: -1, text: 'early' },
      { start: 1, end: 1, text: 'zero' },
      { start: 0, end: 1, text: '   ' },
    ]);
    assert.deepEqual(cues.map((cue) => cue.text), ['early', 'zero', 'late']);
    assert.equal(cues[0].start, 0);
    assert.ok(cues[1].end > cues[1].start);
  });

  it('spreads sentences over a duration', () => {
    const cues = nle.cuesFromText('One. Two. Three. Four.', { duration: 8 });
    assert.equal(cues.length, 4);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[3].end, 8);
    for (let index = 1; index < cues.length; index += 1) {
      assert.ok(cues[index].start >= cues[index - 1].end - 0.001);
    }
  });

  it('splits unpunctuated text by words', () => {
    const cues = nle.cuesFromText('alpha beta gamma', { duration: 3 });
    assert.equal(cues.length, 3);
    assert.equal(cues[1].text, 'beta');
  });

  it('returns nothing for empty text', () => {
    assert.deepEqual(nle.cuesFromText('   '), []);
  });
});

// #endregion

// #region Pure: timeline normalization

describe('nle timeline normalization', () => {
  it('applies the documented defaults', () => {
    const timeline = nle.normalizeTimeline({ clips: ['a.mp4', 'b.mp4'] });
    assert.equal(timeline.width, 1280);
    assert.equal(timeline.height, 720);
    assert.equal(timeline.fps, 30);
    assert.equal(timeline.format, 'mp4');
    assert.equal(timeline.tracks.length, 1);
    assert.equal(timeline.tracks[0].type, 'video');
    assert.equal(timeline.tracks[0].clips.length, 2);
    assert.equal(timeline.tracks[0].clips[0].in, 0);
    assert.equal(timeline.tracks[0].clips[0].speed, 1);
  });

  it('accepts the tool arguments as defaults', () => {
    const timeline = nle.normalizeTimeline({ clips: ['a.mp4'] }, { width: 640, height: 360, fps: 24, format: 'webm' });
    assert.deepEqual(
      [timeline.width, timeline.height, timeline.fps, timeline.format],
      [640, 360, 24, 'webm'],
    );
  });

  it('reads tracks and computes durations from in and out', () => {
    const timeline = nle.normalizeTimeline({
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', in: 1, out: 4 }] },
        { type: 'audio', clips: [{ path: 'b.wav', in: 0, out: 3, volume: 0.4 }] },
      ],
    });
    assert.equal(timeline.tracks.length, 2);
    assert.equal(timeline.tracks[0].clips[0].duration, 3);
    assert.equal(timeline.tracks[1].clips[0].volume, 0.4);
    assert.equal(timeline.tracks[1].clips[0].transition, 'cut');
  });

  it('divides the duration by the speed', () => {
    const timeline = nle.normalizeTimeline({ clips: [{ path: 'a.mp4', in: 0, out: 4, speed: 2 }] });
    assert.equal(timeline.tracks[0].clips[0].duration, 2);
  });

  it('resolves a materialId through the materials map', () => {
    const timeline = nle.normalizeTimeline({ clips: [{ materialId: 'clip-1', out: 2 }] }, { materials: { 'clip-1': 'C:/x/a.mp4' } });
    assert.equal(timeline.tracks[0].clips[0].path, 'C:/x/a.mp4');
  });

  it('reads a materials array', () => {
    const map = nle.materialMap([{ id: 'a', path: 'C:/a.mp4' }, { id: 'b', path: 'C:/b.mp4' }]);
    assert.equal(map.get('b'), 'C:/b.mp4');
  });

  it('marks still pictures', () => {
    const timeline = nle.normalizeTimeline({ clips: ['photo.PNG', 'clip.mp4'] });
    assert.equal(timeline.tracks[0].clips[0].isImage, true);
    assert.equal(timeline.tracks[0].clips[1].isImage, false);
  });

  it('clamps speed, volume and unknown transitions', () => {
    const timeline = nle.normalizeTimeline({ clips: [{ path: 'a.mp4', out: 2, speed: 99, volume: 9, transition: 'spin' }] });
    const clip = timeline.tracks[0].clips[0];
    assert.equal(clip.speed, 4);
    assert.equal(clip.volume, 4);
    assert.equal(clip.transition, 'cut');
  });

  it('reads crop, rotation and colour', () => {
    const timeline = nle.normalizeTimeline({
      clips: [{ path: 'a.mp4', out: 2, crop: { w: 640, h: 360, x: 10, y: 20 }, rotate: 90, color: { brightness: 0.1, saturation: 1.5 } }],
    });
    const clip = timeline.tracks[0].clips[0];
    assert.deepEqual(clip.crop, { w: 640, h: 360, x: 10, y: 20 });
    assert.equal(clip.rotate, 90);
    assert.deepEqual(clip.color, { brightness: 0.1, saturation: 1.5 });
  });

  it('normalizes an odd rotation to the nearest quarter turn', () => {
    assert.equal(nle.normalizeTimeline({ clips: [{ path: 'a.mp4', rotate: 100 }] }).tracks[0].clips[0].rotate, 90);
    assert.equal(nle.normalizeTimeline({ clips: [{ path: 'a.mp4', rotate: -90 }] }).tracks[0].clips[0].rotate, 270);
  });

  it('reads a telop', () => {
    const clip = nle.normalizeTimeline({ clips: [{ path: 'a.mp4', out: 2, text: { value: 'Hi', position: 'top', fontSize: 40 } }] }).tracks[0].clips[0];
    assert.equal(clip.text.value, 'Hi');
    assert.equal(clip.text.position, 'top');
    assert.equal(clip.text.fontSize, 40);
  });

  it('reads the picture-in-picture placement', () => {
    const clip = nle.normalizeTimeline({ clips: [{ path: 'a.mp4', out: 2, at: 1, scale: 0.4, position: 'bottom-left' }] }).tracks[0].clips[0];
    assert.deepEqual(clip.overlay, { at: 1, scale: 0.4, position: 'bottom-left' });
  });

  it('rejects an empty timeline', () => {
    assert.throws(() => nle.normalizeTimeline({}), /タイムラインが空です/u);
  });

  it('rejects a timeline without a video track', () => {
    assert.throws(() => nle.normalizeTimeline({ tracks: [{ type: 'audio', clips: [{ path: 'a.wav' }] }] }), /映像トラックがありません/u);
  });

  it('rejects a clip without a path', () => {
    assert.throws(() => nle.normalizeTimeline({ clips: [{ out: 2 }] }), /path がありません/u);
  });

  it('rejects too many clips', () => {
    const clips = Array.from({ length: nle.MAX_NLE_CLIPS + 1 }, (unused, index) => `c${index}.mp4`);
    assert.throws(() => nle.normalizeTimeline({ clips }), /最大/u);
  });

  it('fills a still picture with a default length', () => {
    const timeline = nle.normalizeTimeline({ clips: ['photo.png'] });
    nle.applyProbeDurations(timeline, [{ duration: 0, hasVideo: true, hasAudio: false }]);
    assert.equal(timeline.tracks[0].clips[0].duration, nle.DEFAULT_IMAGE_SECONDS);
  });
});

// #endregion

// #region Pure: transitions and duration

describe('nle transition planning', () => {
  it('keeps cuts in one group', () => {
    const groups = nle.planVideoGroups([
      { duration: 2, transition: 'cut' },
      { duration: 3, transition: 'cut' },
      { duration: 4, transition: 'cut' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].duration, 9);
  });

  it('opens a group at every real transition', () => {
    const groups = nle.planVideoGroups([
      { duration: 2, transition: 'fade', transitionDuration: 0.5 },
      { duration: 3, transition: 'wipeleft', transitionDuration: 0.25 },
      { duration: 4, transition: 'cut' },
    ]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups.map((group) => group.transition), ['cut', 'fade', 'wipeleft']);
  });

  it('shortens the timeline by each overlap', () => {
    const timeline = timelineWithDurations({
      tracks: [{ type: 'video', clips: [
        { path: 'a.mp4', out: 2, transition: 'fade', transitionDuration: 0.5 },
        { path: 'b.mp4', out: 3 },
      ] }],
    }, [2, 3]);
    assert.equal(nle.timelineSeconds(timeline), 4.5);
  });

  it('adds cut clips without an overlap', () => {
    const timeline = timelineWithDurations({
      tracks: [{ type: 'video', clips: [{ path: 'a.mp4', out: 2 }, { path: 'b.mp4', out: 3 }] }],
    }, [2, 3]);
    assert.equal(nle.timelineSeconds(timeline), 5);
  });

  it('limits a transition to half of the shorter neighbour', () => {
    assert.equal(nle.effectiveTransition(5, 2, 1), 0.5);
    assert.equal(nle.effectiveTransition(0.2, 10, 10), 0.2);
  });
});

// #endregion

// #region Pure: filter graph

describe('nle filter graph', () => {
  it('builds atempo stages inside the supported range', () => {
    assert.equal(nle.atempoChain(1), '');
    assert.equal(nle.atempoChain(2), 'atempo=2');
    assert.equal(nle.atempoChain(4), 'atempo=2,atempo=2');
    assert.equal(nle.atempoChain(0.25), 'atempo=0.5,atempo=0.5');
  });

  it('fits any frame onto the canvas', () => {
    assert.equal(nle.fitToCanvas(1920, 1080), 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black');
  });

  it('places telops', () => {
    assert.deepEqual(nle.textPosition('center', 640, 480), { x: '(w-text_w)/2', y: '(h-text_h)/2' });
    assert.equal(nle.textPosition('bottom', 640, 480).y, 'h-text_h-38');
    assert.equal(nle.textPosition('top-left', 640, 480).x, '48');
  });

  it('places a picture-in-picture clip', () => {
    assert.deepEqual(nle.overlayPosition('top-left', 20), { x: '20', y: '20' });
    assert.deepEqual(nle.overlayPosition('bottom-right', 20), { x: 'W-w-20', y: 'H-h-20' });
    assert.deepEqual(nle.overlayPosition('center', 20), { x: '(W-w)/2', y: '(H-h)/2' });
  });

  it('writes a drawtext filter that reads its text from a file', () => {
    const filter = nle.drawTextFilter({
      file: 'C:\\Temp\\a b\\t.txt',
      fontFile: 'C:/Windows/Fonts/meiryo.ttc',
      fontSize: 40,
      color: 'white',
      boxColor: 'black@0.5',
      x: '(w-text_w)/2',
      y: 'h-text_h-38',
      enable: [0.5, 2],
    });
    assert.match(filter, /^drawtext=textfile='C\\:\/Temp\/a b\/t\.txt'/u);
    assert.match(filter, /fontfile='C\\:\/Windows\/Fonts\/meiryo\.ttc'/u);
    assert.match(filter, /fontsize=40/u);
    assert.match(filter, /enable='between\(t,0\.5,2\)'/u);
  });

  it('concatenates clips that are joined with a cut', () => {
    const timeline = timelineWithDurations({ width: 640, height: 360, fps: 25, clips: [{ path: 'a.mp4', out: 2 }, { path: 'b.mp4', out: 2 }] }, [2, 2]);
    const graph = graphFor(timeline);
    assert.match(graph.filter, /\[0:v\]trim=start=0:end=2,setpts=PTS-STARTPTS,fps=25/u);
    assert.match(graph.filter, /\[bv0\]\[bv1\]concat=n=2:v=1:a=0\[gv0\]/u);
    assert.equal(graph.video, 'gv0');
    assert.equal(graph.seconds, 4);
  });

  it('cross-fades clips that ask for a transition', () => {
    const timeline = timelineWithDurations({
      width: 640, height: 360, fps: 25,
      tracks: [{ type: 'video', clips: [
        { path: 'a.mp4', out: 2, transition: 'wipeleft', transitionDuration: 0.5 },
        { path: 'b.mp4', out: 3 },
      ] }],
    }, [2, 3]);
    const graph = graphFor(timeline);
    assert.match(graph.filter, /xfade=transition=wipeleft:duration=0.5:offset=1.5\[xv1\]/u);
    assert.equal(graph.seconds, 4.5);
    assert.deepEqual(graph.transitions, [{ name: 'wipeleft', seconds: 0.5 }]);
  });

  it('maps every documented transition onto an xfade name', () => {
    for (const transition of ['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'circleopen']) {
      const timeline = timelineWithDurations({
        tracks: [{ type: 'video', clips: [
          { path: 'a.mp4', out: 2, transition, transitionDuration: 0.4 },
          { path: 'b.mp4', out: 2 },
        ] }],
      }, [2, 2]);
      assert.match(graphFor(timeline).filter, new RegExp(`xfade=transition=${transition}`, 'u'));
    }
  });

  it('mixes the audio tracks and pads the result', () => {
    const timeline = timelineWithDurations({
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', out: 2 }] },
        { type: 'audio', clips: [{ path: 'bgm.wav', out: 2, volume: 0.3, fadeIn: 0.5 }] },
      ],
    }, [2, 2]);
    const graph = graphFor(timeline);
    assert.match(graph.filter, /volume=0\.3/u);
    assert.match(graph.filter, /afade=t=in:st=0:d=0\.5/u);
    assert.match(graph.filter, /amix=inputs=2/u);
    assert.match(graph.filter, /apad\[aout\]/u);
    assert.equal(graph.audio, 'aout');
  });

  it('drops the audio half for a GIF', () => {
    const timeline = timelineWithDurations({
      format: 'gif',
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', out: 2 }] },
        { type: 'audio', clips: [{ path: 'bgm.wav', out: 2 }] },
      ],
    }, [2, 2]);
    const graph = graphFor(timeline);
    assert.equal(graph.audio, undefined);
    assert.match(graph.filter, /palettegen/u);
    assert.match(graph.filter, /paletteuse/u);
    assert.equal(graph.video, 'gifout');
  });

  it('ducks a music bed with a sidechain compressor', () => {
    const timeline = timelineWithDurations({
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', out: 4 }] },
        { type: 'audio', clips: [{ path: 'bgm.wav', out: 4, duck: true }] },
      ],
    }, [4, 4]);
    const graph = graphFor(timeline);
    assert.match(graph.filter, /sidechaincompress=threshold=0\.05:ratio=8/u);
    assert.match(graph.filter, /asplit=2/u);
  });

  it('overlays a picture-in-picture clip in a time window', () => {
    const timeline = timelineWithDurations({
      width: 1280, height: 720, fps: 30,
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', out: 4 }] },
        { type: 'video', clips: [{ path: 'b.mp4', out: 1.5, at: 0.5, scale: 0.25, position: 'top-right' }] },
      ],
    }, [4, 1.5]);
    const graph = graphFor(timeline);
    assert.match(graph.filter, /scale=320:-2/u);
    assert.match(graph.filter, /overlay=x=W-w-50:y=50:enable='between\(t,0\.5,2\)'/u);
  });

  it('burns subtitle cues in as timed drawtext filters', () => {
    const timeline = timelineWithDurations({
      clips: [{ path: 'a.mp4', out: 4 }],
      subtitles: [{ start: 0.5, end: 2, text: 'hello' }],
    }, [4]);
    timeline.subtitles[0].file = 'C:/Temp/cue0.txt';
    const graph = graphFor(timeline);
    assert.match(graph.filter, /drawtext=textfile='C\\:\/Temp\/cue0\.txt'/u);
    assert.match(graph.filter, /enable='between\(t,0\.5,2\)'/u);
  });

  it('generates silence when a clip has no audio stream', () => {
    const timeline = timelineWithDurations({
      tracks: [
        { type: 'video', clips: [{ path: 'a.mp4', out: 2 }] },
        { type: 'audio', clips: [{ path: 'silent.mp4', out: 2 }] },
      ],
    }, [{ duration: 2, hasVideo: true, hasAudio: false }, { duration: 2, hasVideo: true, hasAudio: false }]);
    const graph = graphFor(timeline, [{ hasVideo: true, hasAudio: false }, { hasVideo: true, hasAudio: false }]);
    assert.match(graph.filter, /anullsrc=r=48000:cl=stereo/u);
  });

  it('keeps the audio groups aligned when a base clip is silent', () => {
    const timeline = timelineWithDurations({
      tracks: [{ type: 'video', clips: [
        { path: 'a.mp4', out: 2 },
        { path: 'silent.mp4', out: 2 },
        { path: 'c.mp4', out: 2 },
      ] }],
    }, [
      { duration: 2, hasVideo: true, hasAudio: true },
      { duration: 2, hasVideo: true, hasAudio: false },
      { duration: 2, hasVideo: true, hasAudio: true },
    ]);
    const graph = graphFor(timeline, [
      { hasVideo: true, hasAudio: true },
      { hasVideo: true, hasAudio: false },
      { hasVideo: true, hasAudio: true },
    ]);
    assert.match(graph.filter, /anullsrc=r=48000:cl=stereo,atrim=duration=2/u);
    assert.match(graph.filter, /\[ba0\]\[ba1\]\[ba2\]concat=n=3:v=0:a=1\[ag0\]/u);
  });

  it('describes every input it will hand to ffmpeg', () => {
    const timeline = timelineWithDurations({ clips: [{ path: 'a.mp4', out: 2 }, { path: 'still.png' }] }, [2, 0]);
    const graph = graphFor(timeline);
    assert.equal(graph.inputs.length, 2);
    assert.equal(graph.inputs[0].kind, 'video');
    assert.equal(graph.inputs[1].kind, 'image');
    assert.equal(graph.inputs[1].loop, true);
  });

  it('refuses a timeline with no video track', () => {
    const timeline = nle.normalizeTimeline({ tracks: [{ type: 'video', clips: [{ path: 'a.mp4' }] }] });
    timeline.tracks[0].type = 'audio';
    assert.throws(() => nle.buildFilterComplex(timeline, []), /映像トラックがありません/u);
  });
});

describe('nle ffmpeg command', () => {
  it('writes an H.264 MP4 with AAC audio', () => {
    const timeline = timelineWithDurations({ clips: [{ path: 'a.mp4', out: 2 }] }, [2]);
    const graph = graphFor(timeline);
    const args = nle.buildFfmpegArgs(timeline, graph, 'out.mp4');
    assert.deepEqual(args.slice(0, 4), ['-y', '-nostdin', '-hide_banner', '-loglevel']);
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('aac'));
    assert.deepEqual(args.slice(-3), ['-t', '2', 'out.mp4']);
  });

  it('writes VP9 + Opus for webm', () => {
    const timeline = timelineWithDurations({ format: 'webm', clips: [{ path: 'a.mp4', out: 2 }] }, [2]);
    const args = nle.buildFfmpegArgs(timeline, graphFor(timeline), 'out.webm');
    assert.ok(args.includes('libvpx-vp9'));
    assert.ok(args.includes('libopus'));
  });

  it('loops a still picture for its whole length', () => {
    const timeline = timelineWithDurations({ clips: ['still.png'] }, [0]);
    const args = nle.buildFfmpegArgs(timeline, graphFor(timeline), 'out.mp4');
    assert.deepEqual(args.slice(5, 9), ['-loop', '1', '-t', String(nle.DEFAULT_IMAGE_SECONDS)]);
  });
});

// #endregion

// #region Pure: probe summary

describe('nle probe summary', () => {
  it('reads a frame rate written as a fraction', () => {
    assert.equal(nle.parseRate('30000/1001'), 29.97);
    assert.equal(nle.parseRate('30/1'), 30);
    assert.equal(nle.parseRate('0/0'), undefined);
    assert.equal(nle.parseRate(undefined), undefined);
  });

  it('summarizes an ffprobe document', () => {
    const summary = nle.summarizeProbe({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', pix_fmt: 'yuv420p' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
      ],
      format: { duration: '12.5', size: '1000', bit_rate: '640000', format_name: 'mov,mp4' },
    });
    assert.equal(summary.duration, 12.5);
    assert.equal(summary.width, 1920);
    assert.equal(summary.fps, 30);
    assert.equal(summary.channels, 2);
    assert.equal(summary.hasVideo, true);
    assert.equal(summary.hasAudio, true);
    assert.equal(summary.streams.length, 2);
  });

  it('says so when a file has no audio', () => {
    const summary = nle.summarizeProbe({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }], format: {} });
    assert.equal(summary.hasAudio, false);
    assert.equal(summary.duration, 0);
  });
});

// #endregion

// #region Pure: project documents

describe('nle project documents', () => {
  const spec = {
    width: 640, height: 480, fps: 30,
    tracks: [
      { type: 'video', clips: [{ path: 'C:\\clips\\a.mp4', in: 0.5, out: 2.5 }, { path: 'C:\\clips\\b.mp4', out: 2 }] },
      { type: 'audio', clips: [{ path: 'C:\\clips\\bgm.wav', out: 4, volume: 0.3 }] },
    ],
  };

  it('writes MLT XML with a profile, producers, playlists and a tractor', () => {
    const timeline = timelineWithDurations(spec, [4, 3, 4]);
    const xml = nle.toMlt(timeline, { title: 'Demo' });
    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/u);
    assert.match(xml, /<mlt [^>]*version="7\.0\.0"/u);
    assert.match(xml, /<profile [^>]*width="640"[^>]*height="480"[^>]*frame_rate_num="30"/u);
    assert.equal((xml.match(/<producer /gu) ?? []).length, 3);
    assert.equal((xml.match(/<playlist /gu) ?? []).length, 3);
    assert.match(xml, /<tractor [^>]*title="Demo"/u);
    assert.match(xml, /<property name="resource">C:\/clips\/a\.mp4<\/property>/u);
    assert.ok(xml.trimEnd().endsWith('</mlt>'));
  });

  it('writes an OpenTimelineIO timeline with one track per track', () => {
    const timeline = timelineWithDurations(spec, [4, 3, 4]);
    const document = JSON.parse(nle.toOtio(timeline, { title: 'Demo' }));
    assert.equal(document.OTIO_SCHEMA, 'Timeline.1');
    assert.equal(document.name, 'Demo');
    assert.equal(document.tracks.OTIO_SCHEMA, 'Stack.1');
    assert.equal(document.tracks.children.length, 2);
    const video = document.tracks.children[0];
    assert.equal(video.OTIO_SCHEMA, 'Track.1');
    assert.equal(video.kind, 'Video');
    assert.equal(video.children.length, 2);
    assert.equal(video.children[0].OTIO_SCHEMA, 'Clip.1');
    assert.equal(video.children[0].source_range.duration.value, 60);
    assert.equal(video.children[0].media_reference.target_url, 'file:///C:/clips/a.mp4');
    assert.equal(document.tracks.children[1].kind, 'Audio');
  });

  it('writes FCPXML 1.9 with assets and a spine', () => {
    const timeline = timelineWithDurations(spec, [4, 3, 4]);
    const xml = nle.toFcpxml(timeline, { title: 'Demo' });
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
    assert.match(xml, /<!DOCTYPE fcpxml>/u);
    assert.match(xml, /<fcpxml version="1\.9">/u);
    assert.match(xml, /<format id="r1" [^>]*frameDuration="1\/30s"/u);
    assert.equal((xml.match(/<asset /gu) ?? []).length, 3);
    assert.match(xml, /<asset-clip ref="r2" offset="0s"/u);
    assert.match(xml, /<media-rep kind="original-media" src="file:\/\/\/C:\/clips\/a\.mp4"\/>/u);
    assert.ok(xml.trimEnd().endsWith('</fcpxml>'));
  });

  it('writes a CMX3600 EDL with one event per clip', () => {
    const timeline = timelineWithDurations(spec, [4, 3, 4]);
    const edl = nle.toEdl(timeline, { title: 'Demo' });
    assert.match(edl, /^TITLE: DEMO$/mu);
    assert.match(edl, /^FCM: NON-DROP FRAME$/mu);
    assert.match(edl, /^001 {2}A\s+V\s+C\s+00:00:00:15 00:00:02:15 00:00:00:00 00:00:02:00$/mu);
    assert.match(edl, /^\* FROM CLIP NAME: a\.mp4$/mu);
    assert.equal((edl.match(/^0\d\d /gmu) ?? []).length, 3);
  });

  it('dispatches on the format name', () => {
    const timeline = timelineWithDurations(spec, [4, 3, 4]);
    assert.match(nle.renderTimelineDocument(timeline, 'mlt'), /<mlt/u);
    assert.match(nle.renderTimelineDocument(timeline, 'otio'), /"OTIO_SCHEMA"/u);
    assert.throws(() => nle.renderTimelineDocument(timeline, 'aaf'), /未対応の形式です/u);
  });

  it('escapes XML in a project title', () => {
    const timeline = timelineWithDurations({ clips: [{ path: 'a.mp4', out: 1 }] }, [1]);
    assert.match(nle.toMlt(timeline, { title: 'A & B <x>' }), /title="A &amp; B &lt;x&gt;"/u);
  });
});

// #endregion

// #region Tools

describe('nle tool registration', () => {
  it('registers the four tools synchronously', () => {
    const tools = makeTools('C:/session');
    assert.deepEqual([...tools.keys()].sort(), ['edit_video', 'export_timeline', 'make_subtitles', 'probe_video']);
  });

  it('describes every tool in English and renders in Japanese', () => {
    const tools = makeTools('C:/session');
    for (const tool of tools.values()) {
      assert.equal(JAPANESE.test(tool.description), false, `${tool.name} description must be English`);
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.additionalProperties, false);
      for (const [key, property] of Object.entries(tool.parameters.properties)) {
        assert.equal(typeof property.description, 'string', `${tool.name}.${key} needs a description`);
      }
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.output.presentationMeta, 'function');
      assert.equal(typeof tool.isConcurrencySafe, 'function');
      assert.ok(tool.timeoutMs > 0);
    }
  });

  it('renders a Japanese summary of an edit', () => {
    const tool = makeTools('C:/session').get('edit_video');
    const blocks = tool.output.render({}, {
      width: 1280, height: 720, fps: 30, seconds: 4, clips: 2, tracks: 2,
      format: 'mp4', bytes: 1000, mediaType: 'video/mp4', name: 'x.mp4', path: 'media-studio/x.mp4',
      hasAudio: true, subtitles: 1, transitions: 1,
    });
    assert.match(blocks[0].text, /動画を編集しました/u);
    assert.match(blocks[1].text, /字幕 1 行/u);
  });

  it('presents the file path when there is one', () => {
    const tool = makeTools('C:/session').get('probe_video');
    assert.deepEqual(tool.output.presentationMeta({}, { path: 'media-studio/x.mp4' }), { path: 'media-studio/x.mp4' });
  });
});

// #endregion

// #region Real ffmpeg

describe('nle with a real ffmpeg', { skip: !hasFfmpeg ? 'ffmpeg and ffprobe are not on PATH' : false }, () => {
  let session;
  let media;
  let tools;

  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', ...args], { windowsHide: true, stdio: 'pipe' });
  const probe = (path) => nle.summarizeProbe(JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ], { encoding: 'utf8' })));

  before(async () => {
    session = await mkdtemp(join(tmpdir(), 'dsh-nle-test-'));
    media = join(session, 'media');
    await mkdir(media, { recursive: true });
    await mkdir(join(session, 'media-studio'), { recursive: true });

    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(media, 'a.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'smptebars=s=640x480:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(media, 'b.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-ac', '2', '-ar', '44100', join(media, 'bgm.wav'));
    ffmpeg('-f', 'lavfi', '-i', 'color=c=teal:s=640x480:d=1', '-frames:v', '1', join(media, 'still.png'));
    tools = makeTools(session);
  });

  after(async () => {
    if (session !== undefined) await rm(session, { recursive: true, force: true });
  });

  it('probes a real file', async () => {
    const result = await tools.get('probe_video').execute({ path: 'media/a.mp4' }, {});
    assert.equal(result.width, 640);
    assert.equal(result.height, 480);
    assert.equal(result.fps, 30);
    assert.equal(result.videoCodec, 'h264');
    assert.equal(result.audioCodec, 'aac');
    assert.equal(result.hasAudio, true);
    assert.ok(result.duration > 3.9 && result.duration < 4.1, `duration ${result.duration}`);
    assert.equal(result.path, join('media', 'a.mp4'));
  });

  it('rejects a file that is not there', async () => {
    await assert.rejects(() => tools.get('probe_video').execute({ path: 'media/nope.mp4' }, {}), /ファイルが見つかりません/u);
  });

  it('edits a timeline into an MP4 with transitions, a telop, a subtitle and a music bed', async () => {
    const result = await tools.get('edit_video').execute({
      timeline: {
        width: 640,
        height: 480,
        fps: 30,
        tracks: [
          {
            type: 'video',
            clips: [
              { path: join(media, 'a.mp4'), in: 0.5, out: 2.5, transition: 'fade', transitionDuration: 0.4, text: { value: 'こんにちは NLE', position: 'top' } },
              { path: join(media, 'b.mp4'), in: 0, out: 2, color: { saturation: 1.4 } },
            ],
          },
          { type: 'video', clips: [{ path: join(media, 'b.mp4'), in: 0, out: 1.2, at: 0.5, scale: 0.28, position: 'top-right' }] },
          { type: 'audio', clips: [{ path: join(media, 'bgm.wav'), in: 0, out: 6, volume: 0.25, fadeIn: 0.5, fadeOut: 1, duck: true }] },
        ],
        subtitles: [{ start: 0.2, end: 1.5, text: '最初の字幕' }, { start: 1.6, end: 3.0, text: '二番目の字幕' }],
      },
      name: 'full',
    }, {});

    assert.equal(result.name, 'full.mp4');
    assert.equal(result.width, 640);
    assert.equal(result.height, 480);
    assert.equal(result.fps, 30);
    assert.equal(result.format, 'mp4');
    assert.equal(result.mediaType, 'video/mp4');
    assert.equal(result.tracks, 3);
    assert.equal(result.clips, 4);
    assert.equal(result.hasAudio, true);
    assert.equal(result.subtitles, 2);
    assert.equal(result.transitions, 1);
    assert.equal(result.seconds, 3.6);
    assert.ok(result.bytes > 1000);
    assert.equal(result.path, join('media-studio', 'full.mp4'));

    const written = probe(join(session, 'media-studio', 'full.mp4'));
    assert.equal(written.width, 640);
    assert.equal(written.height, 480);
    assert.equal(written.videoCodec, 'h264');
    assert.equal(written.audioCodec, 'aac');
    assert.equal(written.channels, 2);
    assert.ok(Math.abs(written.duration - 3.6) < 0.15, `duration ${written.duration}`);
    assert.ok(existsSync(join(session, 'media-studio', 'full.mp4')));
  });

  it('trims, speeds up, crops and rotates into a GIF', async () => {
    const result = await tools.get('edit_video').execute({
      clips: [{ path: join(media, 'a.mp4'), in: 0, out: 2, speed: 2, crop: { w: 480, h: 360, x: 80, y: 60 }, rotate: 90 }],
      width: 480,
      height: 360,
      fps: 15,
      format: 'gif',
      name: 'fast',
    }, {});
    assert.equal(result.name, 'fast.gif');
    assert.equal(result.format, 'gif');
    assert.equal(result.mediaType, 'image/gif');
    assert.equal(result.hasAudio, false);
    assert.equal(result.seconds, 1);
    const written = probe(join(session, 'media-studio', 'fast.gif'));
    assert.equal(written.formatName, 'gif');
    assert.equal(written.width, 480);
    assert.equal(written.height, 360);
    assert.ok(Math.abs(written.duration - 1) < 0.2, `duration ${written.duration}`);
  });

  it('joins clips into a WebM', async () => {
    const result = await tools.get('edit_video').execute({
      clips: [join(media, 'a.mp4'), join(media, 'b.mp4')],
      width: 320,
      height: 240,
      fps: 24,
      format: 'webm',
      name: 'small',
    }, {});
    assert.equal(result.name, 'small.webm');
    assert.equal(result.seconds, 7);
    assert.equal(result.hasAudio, true);
    const written = probe(join(session, 'media-studio', 'small.webm'));
    assert.equal(written.videoCodec, 'vp9');
    assert.equal(written.width, 320);
    assert.ok(Math.abs(written.duration - 7) < 0.2, `duration ${written.duration}`);
  });

  it('puts a still picture on the timeline', async () => {
    const result = await tools.get('edit_video').execute({
      clips: [join(media, 'still.png'), { path: join(media, 'b.mp4'), in: 0, out: 1 }],
      width: 320,
      height: 240,
      fps: 15,
      name: 'still',
    }, {});
    assert.equal(result.seconds, nle.DEFAULT_IMAGE_SECONDS + 1);
    const written = probe(join(session, 'media-studio', 'still.mp4'));
    assert.ok(Math.abs(written.duration - 4) < 0.3, `duration ${written.duration}`);
  });

  it('writes every project document so that it parses', async () => {
    const timelineSpec = {
      width: 640,
      height: 480,
      fps: 30,
      tracks: [
        { type: 'video', clips: [{ path: join(media, 'a.mp4'), in: 0.5, out: 2.5 }, { path: join(media, 'b.mp4'), out: 2 }] },
        { type: 'audio', clips: [{ path: join(media, 'bgm.wav'), out: 4, volume: 0.3 }] },
      ],
    };

    const mlt = await tools.get('export_timeline').execute({ format: 'mlt', timeline: timelineSpec, title: 'Demo', name: 'tl' }, {});
    const mltText = await readFile(join(session, 'media-studio', mlt.name), 'utf8');
    assert.match(mltText, /<mlt [^>]*version="7\.0\.0"/u);
    assert.equal(mlt.mediaType, 'application/xml');
    assert.equal(mlt.seconds, 4);

    const otio = await tools.get('export_timeline').execute({ format: 'otio', timeline: timelineSpec, name: 'tl' }, {});
    const otioDoc = JSON.parse(await readFile(join(session, 'media-studio', otio.name), 'utf8'));
    assert.equal(otioDoc.OTIO_SCHEMA, 'Timeline.1');
    assert.equal(otioDoc.tracks.children.length, 2);

    const fcpxml = await tools.get('export_timeline').execute({ format: 'fcpxml', timeline: timelineSpec, name: 'tl' }, {});
    const fcpxmlText = await readFile(join(session, 'media-studio', fcpxml.name), 'utf8');
    assert.match(fcpxmlText, /<fcpxml version="1\.9">/u);
    assert.equal((fcpxmlText.match(/<asset /gu) ?? []).length, 3);

    const edl = await tools.get('export_timeline').execute({ format: 'edl', timeline: timelineSpec, name: 'tl' }, {});
    const edlText = await readFile(join(session, 'media-studio', edl.name), 'utf8');
    assert.match(edlText, /^TITLE: /mu);
    assert.equal((edlText.match(/^0\d\d /gmu) ?? []).length, 3);
  });

  it('writes a subtitle file that reads back', async () => {
    const result = await tools.get('make_subtitles').execute({
      text: '最初の文です。二番目の文です。三番目の文です。',
      duration: 6,
      format: 'srt',
      name: 'subs',
    }, {});
    assert.equal(result.name, 'subs.srt');
    assert.equal(result.format, 'srt');
    assert.equal(result.cues, 3);
    assert.equal(result.seconds, 6);
    assert.equal(result.mediaType, 'application/x-subrip');

    const parsed = nle.parseSubtitles(await readFile(join(session, 'media-studio', 'subs.srt'), 'utf8'));
    assert.equal(parsed.cues.length, 3);
    assert.equal(parsed.cues[0].text, '最初の文です。');
  });

  it('converts a subtitle file to WebVTT', async () => {
    const result = await tools.get('make_subtitles').execute({
      input: join('media-studio', 'subs.srt'),
      format: 'vtt',
      name: 'subs-vtt',
    }, {});
    assert.equal(result.name, 'subs-vtt.vtt');
    const text = await readFile(join(session, 'media-studio', 'subs-vtt.vtt'), 'utf8');
    assert.ok(text.startsWith('WEBVTT'));
    assert.equal(nle.parseSubtitles(text).cues.length, 3);
  });

  it('says clearly when ffmpeg is missing', async () => {
    const broken = makeTools(session, { nle: { ffmpegPath: join(session, 'nope', 'ffmpeg.exe') } });
    await assert.rejects(
      () => broken.get('edit_video').execute({ clips: [join(media, 'a.mp4')] }, {}),
      /ffmpeg が見つかりません/u,
    );
  });

  it('reports a clip with no video stream', async () => {
    await assert.rejects(
      () => tools.get('edit_video').execute({ clips: [join(media, 'bgm.wav')] }, {}),
      /映像ストリームがありません/u,
    );
  });
});

// #endregion

// #region Fixtures sanity

describe('nle constants', () => {
  it('keeps the documented vocabularies', () => {
    assert.deepEqual(nle.NLE_TRANSITIONS, ['cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'circleopen']);
    assert.deepEqual(nle.NLE_FORMATS, ['mp4', 'webm', 'gif']);
    assert.deepEqual(nle.TIMELINE_FORMATS, ['mlt', 'otio', 'fcpxml', 'edl']);
    assert.deepEqual(nle.SUBTITLE_FORMATS, ['srt', 'vtt']);
  });

  it('names every tool once', () => {
    const tools = makeTools('C:/session');
    assert.equal(new Set([...tools.keys()]).size, 4);
  });
});

// #endregion
