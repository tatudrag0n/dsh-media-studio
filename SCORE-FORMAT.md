# Media Studio score text (MSX) — format v1

A tiny, line-oriented, multi-track score format for the Media Studio plugin.
It is designed so that **another AI can generate it from a plain-language
request**, and so that a human can read and edit it by hand.

Everything is measured in **beats**, where 1 beat = one quarter note. Positions
are **absolute**, so tracks are independent and rests are implicit.

## Grammar

```
file        := (line)*
line        := comment | blank | directive | track-header | instrument | note
comment     := "#" ...                      ; "#" only starts a comment at the
                                            ; start of a line or after whitespace
blank       := whitespace only
directive   := ("title" | "tempo" | "bpm") sep value
track-header:= "track" ws name [ws "instrument" ("="|":") instrument]
instrument  := "instrument" [":"|"="] instrument-name
note        := pitch-list ws start ws duration
pitch-list  := pitch ("," pitch)*
pitch       := /[A-Ga-g](#|b)?-?\d+/      ; e.g. C4, F#4, Bb3
start       := non-negative number        ; beats from the beginning
duration    := positive number            ; length in beats
sep         := whitespace or ":" or "="
```

- Unknown or malformed lines are reported as **warnings**, never as errors, so
  a partly wrong answer still renders.
- `rest <start> <duration>` is accepted and ignored (positions are absolute).
- Track and instrument names are free text. `instrument` may appear on the
  `track` line or on its own line inside the track.
- A note line may list several pitches: they start together (a chord).

## Instruments

Every track names a **SoundFont preset**. There is no built-in oscillator
voice; a missing or unrecognised name falls back to the configured default
preset (`gm:0`).

| Form | Meaning |
| --- | --- |
| `gm:<program>` | SoundFont preset, General MIDI program 0–127 (`gm:0` = Grand Piano, `gm:40` = Violin, `gm:48` = Strings Ensemble) |
| `gm:<bank>:<program>` | SoundFont preset in a variation bank (`gm:11:0` = Piano & Str.-Fade) |

Each track is rendered on its own MIDI channel, so several presets sound
together.

## Complete example

```
# Media Studio score v1
title Morning Walk
tempo 96

track melody
instrument gm:40
E4 0 1
G4 1 1
A4 2 2
G4 4 1
E4 5 1
D4 6 2

track harmony
instrument gm:0
C4,E4,G4 0 2
A3,C4,E4 2 2
F3,A3,C4 4 2
G3,B3,D4 6 2

track bass
instrument gm:33
C2 0 2
A1 2 2
F1 4 2
G1 6 2
```

## Prompt snippet for another AI

> Write the music as Media Studio score text. Use one `track` block per
> instrument, `instrument <name>` for the voice (use `gm:<program>` for real
> sampled instruments), and one note per line as
> `<pitch>[,<pitch>...] <start> <duration>`, all in beats (1 beat = quarter
> note) with absolute start positions. Set `tempo <bpm>` at the top. Start the
> reply with `# Media Studio score v1`.

## Editing and round-trips

- The score text is the **source of truth**. The plugin can convert it to the
  step grid (Grid mode) and back (Text mode) in either direction.
- Converting text → grid quantises timing to the grid resolution (1/4, 1/8 or
  1/16) and to a two-octave pitch range; the plugin picks the finest
  resolution and the narrowest range that fit the piece, and reports anything
  it had to drop as a warning.
- Notes outside the chosen range cannot be shown on the grid; keep each track
  inside roughly two octaves if you intend to edit it visually.

## API surface

- `POST /api/media-studio/score` with `{ "action": "parse", "text": "..." }`
  returns `{ tempo, title, tracks, warnings }`.
- `POST /api/media-studio/score` with
  `{ "action": "format", "tempo": 96, "title": "...", "tracks": [...] }`
  returns `{ text }`.
- `generate_music` accepts this text as its `text` parameter.
- `compose_music` returns this text as its `text` field (`output: "text"`
  returns only the text).

## 日本語での要点

- 1 拍 = 4 分音符。位置は**絶対**なので、休符は書かなくてよい。
- 行の種類: `title` / `tempo`（または `bpm`）/ `track <名前>` /
  `instrument <楽器>` / `<音名>[,<音名>…] <開始> <長さ>`。
- `#` は行頭か空白の後ろでのみコメント。`C#4` のような音名は壊れない。
- 楽器は `gm:<program>` / `gm:<bank>:<program>`（SoundFont）のみ。内蔵シンセはありません。
- 解釈できない行は警告になるだけで、生成は続行される。
- テキストが正本。グリッドとの相互変換ができ、テキスト→グリッドでは
  分解能と音域に合わせて量子化される。
