# v3 — DTM (`daw.js` + `midi.js`)

`docs/SPEC-v3.md` 5.3 の実装メモ。担当: daw-dev。
所有ファイル: `daw.js`, `midi.js`, `test/daw.test.mjs`, `docs/v3-daw.md`。

---

## 1. できること

### `daw_arrange` — マルチトラック編曲をミックスして音声にする

- トラックごとに **instrument**（GM プログラム番号 / `gm:<program>` / `gm:<bank>:<program>` /
  GM 名 `piano` `strings` `bass` `pad` `flute` …）/ **`drums: true`**（GM 打楽器チャンネル 10）/
  **`audio`**（WAV をミックス）を選べる。
- ミキサー: `volume` (0..2) / `pan` (-1..1, 等パワー) / `mute` / `solo` /
  `reverb` (0..1, コム 4 本) / `delay` (0..1, 付点 8 分のフィードバックエコー) / `offset`（拍）。
- 曲全体: `tempo` / `timeSignature` / `bars` / `key` / `name`。
- 出力: **ステレオ 44.1 kHz / 16 bit WAV**。`format` に `mp3` / `ogg` を選ぶと
  `execute()` の中だけで ffmpeg を 1 回起動して変換する（タイムアウト + kill、`windowsHide: true`）。
  変換に失敗した場合は WAV を返し、`warnings` に理由を残す。
- ピークが 0.98 を超えたら全体をスケールダウンする（クリップさせない）。
- ノートは **拍（4 分音符 = 1）** 単位。音名は `score.js` と同じ `C4` / `F#3` 表記。

### `export_daw_project` — 同じ編曲を外部フォーマットへ

| `format` | 中身 | 開くソフト |
|---|---|---|
| `mid` | SMF type 1。conductor トラック（テンポ + 拍子）+ 各トラック。program change、CC7（音量）、CC10（パン）、track name、channel prefix 付き | LMMS / MuseScore / DAW 全般 |
| `musicxml` | MusicXML 4.0 partwise。`<attributes>`（divisions / key / time / clef）、テンポ、休符で隙間を埋めた `<measure>`、和音は `<chord/>` | MuseScore |
| `mmp` | LMMS プロジェクト XML（192 tick / 4 分音符、`<pattern>` + `<note pos len key vol pan>`） | LMMS |
| `h2song` | Hydrogen ドラムパターン（48 tick / 4 分音符、1 小節 = 1 パターン、GM 打楽器キーを楽器に割り当て） | Hydrogen |

**どの形式も、書いた直後に自分のパーサで読み戻して件数を数え、`verified` に入れて返す。**
（`mid` → `readSmf`、`musicxml` / `mmp` / `h2song` → 各パーサ + XML の入れ子検査。）

### `import_midi` — SMF を読み戻す

- SMF type 0 / 1、VLQ、**running status**、tempo meta、time signature、program change、
  note on/off（velocity 0 の note on も off 扱い）、CC7 / CC10 を読む。
- 返り値の `arrangement` は **そのまま `daw_arrange` / `export_daw_project` に渡せる**。
  `score` は MSX スコアテキスト（`compose_music` / `generate_music` が読める形）。

### `midi.js` — 純 JS の SMF 読み書き

外部ライブラリなし。エンコードは `writeSmf`、デコードは `readSmf`。
書き出し側も running status で圧縮するので、往復テストがエンコーダとデコーダの両方を同時に証明する。

---

## 2. ツール引数

### `daw_arrange`

| 引数 | 型 | 説明 |
|---|---|---|
| `arrangement` | object | 編曲（下記）。`score` とどちらか必須 |
| `score` | string | MSX スコアテキスト（`arrangement` の代わり） |
| `tempo` / `bars` / `timeSignature` / `name` | — | 編曲より優先される上書き |
| `format` | `wav` \| `mp3` \| `ogg` | 既定 `wav` |

出力: `name` `path` `bytes` `mediaType` `format` `seconds` `sampleRate` `channels` `tracks`
`notes` `bars` `tempo` `peak` `rms` (`muted` / `soloed` / `wavPath`) `warnings`。

### `export_daw_project`

| 引数 | 型 | 説明 |
|---|---|---|
| `format` | `mid` \| `musicxml` \| `mmp` \| `h2song` | **必須** |
| `arrangement` / `score` | — | `daw_arrange` と同じ |
| `tempo` / `bars` / `timeSignature` / `name` | — | 上書き |
| `ticksPerQuarter` | integer | `.mid` の分解能（既定 480） |

出力: `name` `path` `bytes` `mediaType` `format` `tracks` `notes` `tempo` `bars`
`timeSignature` `verified` `warnings`。

### `import_midi`

| 引数 | 型 | 説明 |
|---|---|---|
| `path` | string | **必須**。セッションからの相対パス、または絶対パス |
| `name` / `tempo` | — | 上書き |

出力: `name` `sourcePath` `tracks` `notes` `tempo` `bars` `timeSignature` `format`
`ticksPerQuarter` `arrangement` `score` `warnings`。

---

## 3. 編曲 JSON の例

```json
{
  "name": "Verification Suite",
  "tempo": 100,
  "timeSignature": [4, 4],
  "bars": 4,
  "key": "Am",
  "tracks": [
    {
      "name": "melody",
      "instrument": "strings",
      "volume": 1,
      "pan": -0.4,
      "reverb": 0.3,
      "notes": [
        { "start": 0, "duration": 2, "pitches": ["A4"] },
        { "start": 4, "duration": 2, "pitches": ["A4", "E5"], "velocity": 110 }
      ]
    },
    {
      "name": "bass",
      "instrument": "gm:33",
      "volume": 0.9,
      "pan": 0.2,
      "notes": [{ "start": 0, "duration": 4, "pitches": ["A2"] }]
    },
    {
      "name": "drums",
      "drums": true,
      "volume": 0.85,
      "notes": [
        { "start": 0, "duration": 0.25, "pitches": ["C2"] },
        { "start": 0.5, "duration": 0.25, "pitches": ["F#2"] },
        { "start": 1, "duration": 0.25, "pitches": ["D2"] }
      ]
    },
    {
      "name": "click",
      "audio": "media-studio/tone.wav",
      "volume": 0.3,
      "offset": 4
    }
  ]
}
```

- `notes[].pitches` は和音（同時発音）。`pitch: "C4"` の単数指定も通る。
- `steps` + `stepBeats` を渡すと、`compose_music` のステップ格子をそのまま使える。
- `drums: true` のトラックは `gm:128:<program>` として扱われ、MIDI ではチャンネル 10、
  音源では channel 9 の打楽器プリセットで鳴る。
- 音声トラックは `audio` に WAV パス。`baseDir`（セッション作業ディレクトリ）からの相対パス。
- 同じ編曲を `daw_arrange` と `export_daw_project` にそのまま渡せる。

### SoundFont が無いときの挙動（明示）

`options.soundfont.path` が空、またはファイルが無い場合:

- **音源トラック（`instrument` / `drums`）がある** → 明示的なエラー。
  `SoundFont が見つかりません: (未設定)。 音源トラックを鳴らすには config の soundfont.path に .sf2 を指定してください。`
- **音声トラックだけ** → SoundFont 無しでもミックスできる（WAV を読んでパン・音量だけ適用）。

合成器は **一切持っていない**。鳴らすのは `soundfont.js` の `renderSoundFontTracks` だけで、
`daw.js` はトラックごとに 1 回それを呼び、モノラル波形にエフェクト → パン → ミックスを掛ける。
（トラック本数ぶんの合成になるので、長い曲は時間がかかる。`timeoutMs` は 30 分。）

---

## 4. 実測検証ログ（2026-11-03 / Windows / Node v24.22.1）

### 4.1 テスト

```
cd C:\root\dsh-media-studio
node --test test/daw.test.mjs
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ skipped 0
```

```
cd C:\root\dsh-media-studio
node --test
ℹ tests 297
ℹ pass 297
ℹ fail 0
ℹ skipped 0
```

（ベースライン 188 に、この担当分 25 + 他担当分が加わった数字。同時進行の他モジュールが
テストを足すので総数は動く。既存テストは壊していない。`daw.test.mjs` 単体は 25/25。）

```
cd C:\root\dsh-media-studio
node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp
dsh-media-studio: 0 error(s), 0 warning(s), 0 note(s)
```

テストが証明していること:

- VLQ の往復（0 / 0x7f / 0x80 / 0x4000 / 0x0fffffff）。
- running status と velocity 0 の note on を、手で組んだバイト列から読めること。
- type 1 の書き出し → 読み戻しで、テンポ・拍子・曲名・program・CC7・CC10・ノート位置が一致。
- **編曲 → SMF → 読み戻し → 再書き出しがバイト単位で一致**（`Buffer.equals`）。
- MusicXML / mmp / h2song が XML として閉じていて、件数が編曲と一致。
- WAV のヘッダ・長さ・ピーク・左右差（パン）。
- ミュートで RMS が下がる / ソロで他トラックが落ちる。
- SoundFont 無しのとき、音源トラックは明確なエラー・音声トラックだけなら通る。
- ffmpeg がある環境では mp3 が本物の MP3 ヘッダで出て、WAV も残る。

### 4.2 実際に 1 回ずつ実行した記録

検証用の編曲（4 トラック / 32 ノート / 100 BPM / 4 小節 / Am）で、
`scratch` スクリプトから 3 ツールを実際に呼んだ結果。

| 生成物 | サイズ | 確認したこと |
|---|---|---|
| `verification-suite.wav` | 1,905,164 B | `daw_arrange`。`ffprobe`: `pcm_s16le` / 44100 Hz / 2ch / `duration=10.800000`。ピーク 0.98、RMS 0.140 |
| `verification-suite.mp3` | 158,700 B | `daw_arrange format=mp3`。`ffprobe`: `mp3` / 44100 Hz / 2ch / `duration=10.800000`。WAV も `wavPath` に残る |
| `verification-suite.mid` | 456 B | 先頭 `MThd`。`readSmf` で type 1 / 5 トラック（conductor + 4）/ 32 ノート / テンポ 100 / 4-4、program は ch1=48 (strings), ch2=33, ch3=89 (pad), ch10=0（打楽器） |
| `verification-suite.musicxml` | 13,285 B | 4 part / 4 小節 / 32 ノート / divisions 480 / `<sound tempo="100">`。Python `xml.etree.ElementTree` でパース成功（root `score-partwise`） |
| `verification-suite.mmp` | 4,187 B | 4 トラック / 32 ノート / bpm 100。Python `ElementTree` でパース成功（root `lmms-project`） |
| `verification-suite.h2song` | 6,532 B | 4 パターン（1 小節 1 パターン, size=192 tick）/ 20 打楽器ノート / 3 楽器。Python `ElementTree` でパース成功（root `hydrogen_song`） |

`import_midi` に `media-studio/verification-suite.mid` を渡した結果:
`tracks 4` / `notes 32` / `tempo 100` / `format 1` / `timeSignature [4,4]` / `warnings []`。
返ってきた `arrangement` をそのまま `daw_arrange` に渡すと **再レンダリングできた**
（`reimported.wav`、32 ノート、6.0 秒、ピーク 0.964）。

XML の妥当性は自作の入れ子検査に加えて、Python の `xml.etree` でも独立に確認している
（`mid` は `readSmf` と `ffprobe`、音声は `ffprobe`）。

再現コマンド（スクラッチは temp に置いた使い捨て）:

```
node daw-verify.mjs          # 3 ツールを実行して 7 ファイルを生成
ffprobe -v error -show_entries format=duration,size,format_name \
  -show_entries stream=codec_name,channels,sample_rate \
  -of default=noprint_wrappers=1 verification-suite.wav
python -c "import xml.etree.ElementTree as ET; ET.parse('verification-suite.musicxml')"
```

---

## 5. 既知の制限

- **音源は SoundFont が必須**（音源トラックがある場合）。フォールバックの自前シンセは持たない
  （合成器の二重実装を避けるため、意図的にこうしている）。
- SMF の SMPTE division は非対応（読むと明確なエラー）。
- ベロシティは MIDI 書き出しにだけ効く。SoundFont 経由の WAV では一定ベロシティで鳴る
  （`renderSoundFontTracks` の仕様）。
- `bars` は `.mid` に保存されないので、`import_midi` の `bars` はノートの終端から再計算される
  （ノートが無い小節は落ちる）。
- mmp に音声トラックは埋め込めない（XML コメントとして残す）。LMMS のサンプラー設定は書かない。
- h2song は打楽器トラックだけを書く（他は `warnings` に「入りません」と出す）。
  Hydrogen の tick 解像度は 48 / 4 分音符と仮定している（実機の Hydrogen では未検証）。
- MusicXML は 1 声部（`<voice>1</voice>`）のみ。タイ・連符・強弱記号は書かない。
  小節をまたぐノートは小節末で切る。
- 音声トラックのリサンプリングは線形補間。
- リバーブ／ディレイは簡易実装（コム 4 本 / 単一タップ）。業務用の IR ではない。

---

## 6. `index.js` への配線（Lead 向け）

```js
import { registerDawTools } from './daw.js';
// ...
registerDawTools(ctx, options, config, helpers);
```

`helpers` は既存の `{ resolveSessionCwd, formatBytes, safeRelativeDir }` をそのまま渡す。

追加する config セクション（すべて省略可。`index.js` 側で `config?.daw ?? {}` を読む）:

| キー | 既定 | 意味 |
|---|---|---|
| `daw.outputDir` | `options.outputDir`（`media-studio`） | 出力先。セッション配下に閉じる |
| `daw.defaultInstrument` | `options.music.defaultInstrument`（`gm:0`） | 楽器未指定トラックの音色 |
| `daw.maxSeconds` | `options.music.maxSeconds`（600） | 1 曲の上限秒 |
| `daw.maxNotes` | 20000 | ノート数上限 |
| `daw.maxTracks` | 32 | トラック数上限 |
| `daw.ffmpegPath` | `options.video.ffmpegPath` | mp3 / ogg 変換用。空なら PATH の `ffmpeg` |
| `daw.ffmpegTimeoutMs` | 180000 | ffmpeg のタイムアウト |
| `daw.mp3Quality` | 2 | `libmp3lame -q:a` |
| `daw.oggQuality` | 6 | `libvorbis -q:a` |
| `daw.ticksPerQuarter` | 480 | `.mid` の分解能 |

`options.soundfont.path` / `.gain` / `.releaseSeconds` は既存のものを使う（新設不要）。

`config.daw` を zod スキーマに足す場合の形:

```js
daw: z.object({
  outputDir: z.string().optional(),
  defaultInstrument: z.string().optional(),
  maxSeconds: z.number().optional(),
  maxNotes: z.number().optional(),
  maxTracks: z.number().optional(),
  ffmpegPath: z.string().optional(),
  ffmpegTimeoutMs: z.number().optional(),
  mp3Quality: z.number().optional(),
  oggQuality: z.number().optional(),
  ticksPerQuarter: z.number().optional(),
}).optional(),
```

---

## 7. README 用の短い日本語説明（Lead が転記）

> **DTM（編曲・ミックス・DAW 連携）** — `daw_arrange` / `export_daw_project` / `import_midi`
>
> 複数トラックの編曲をそのまま 1 曲にミックスして WAV（必要なら mp3 / ogg）で書き出せます。
> トラックごとに音色（General MIDI の番号でも名前でも）、音量、パン、ミュート、ソロ、
> リバーブ、ディレイを指定でき、ドラムは GM 打楽器チャンネル、手持ちの WAV は音声トラックとして
> 混ぜられます。同じ編曲は標準 MIDI ファイル（type 1）、MusicXML（MuseScore）、
> LMMS プロジェクト、Hydrogen ドラムパターンへ書き出せるので、書いたものをそのまま
> 本物の DAW で続きから編集できます。逆に `.mid` を読み込んで編曲として取り込むこともできます。
> 書き出したファイルは、その場で自分で読み戻してノート数・テンポ・プログラムが一致することを
> 確かめてから返します。音源には設定済みの SoundFont をそのまま使います。
