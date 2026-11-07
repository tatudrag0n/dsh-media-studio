# v3 / nle.js — 動画編集（NLE）

`dsh-media-studio` v3 の動画編集レイヤ。タイムラインを 1 本の `filter_complex` に落として
ffmpeg を **1 回だけ**起動し、完成ファイルを書き出す。同じタイムラインを Kdenlive /
Shotcut / DaVinci Resolve / Final Cut Pro が開ける形式でも書き出せる。

- モジュール: `nle.js`（依存追加なし・Node 標準ライブラリのみ）
- 登録関数: `export function registerNleTools(ctx, options, config, helpers)`
- テスト: `test/nle.test.mjs`（84 tests、実 ffmpeg を含む）

---

## 1. できること

### `edit_video` — タイムラインを 1 本の動画にする

| 機能 | 指定方法 |
|---|---|
| in/out トリム | `clip.in` / `clip.out` |
| 連結 | 同一トラックに並べる（`transition: "cut"`） |
| トランジション | `cut` / `fade` / `dissolve` / `wipeleft` / `wiperight` / `slideup` / `circleopen`（`xfade`） |
| 速度変更 | `clip.speed`（0.25〜4。音声は `atempo` を多段で追従） |
| クロップ | `clip.crop = {w,h,x,y}` |
| スケール / 回転 | 常にキャンバスへ `scale`+`pad` で収める。`clip.rotate` は 0/90/180/270 |
| ピクチャ・イン・ピクチャ | 2 本目以降の映像トラック + `at` / `scale` / `position` |
| テロップ | `clip.text = {value, position, color, boxColor, fontSize}` |
| 字幕焼き込み | `timeline.subtitles` / `subtitles`（SRT/VTT 相当のキュー） |
| 音声ミックス | `volume` / `fadeIn` / `fadeOut` / `duck`（`sidechaincompress`） |
| 色調整 | `clip.color = {brightness, contrast, saturation, gamma}`（`eq`、LUT 不要） |
| 静止画 | `.png` / `.jpg` などを `-loop 1 -t` で貼る（長さ未指定なら 3 秒） |
| 出力 | `mp4`（libx264 + aac）/ `webm`（libvpx-vp9 + libopus）/ `gif`（palettegen + paletteuse） |

音声は全トラックを 48kHz / stereo / fltp に正規化してから `amix` する。映像クリップに
音声ストリームが無い場合は `anullsrc` で無音を埋めるので、混在していても同期が崩れない。
GIF は音声ストリームを持てないため、GIF のときは音声側のチェーンを丸ごと省く。

### `probe_video` — 中身を読む

`ffprobe -print_format json` を要約して返す。duration / size / bitrate / format /
videoCodec / width / height / fps / pixelFormat / audioCodec / channels / sampleRate と、
ストリームごとの一覧。

### `export_timeline` — 編集ソフト向けに書き出す

| `format` | 出力 | 開けるソフト |
|---|---|---|
| `mlt` | MLT XML 7.0.0（`<mlt><profile/><producer/><playlist/><tractor/>`） | Kdenlive / Shotcut |
| `otio` | OpenTimelineIO JSON（`Timeline.1` / `Stack.1` / `Track.1` / `Clip.1` / `ExternalReference.1`） | Resolve / RV / otioview |
| `fcpxml` | FCPXML 1.9（`<resources><format/><asset/>` + `<spine>`） | Final Cut Pro / DaVinci Resolve |
| `edl` | CMX3600 EDL（`TITLE:` / `FCM: NON-DROP FRAME` / イベント行 + `* FROM CLIP NAME:`） | ほぼすべての NLE |

長さが書かれていないクリップは、書き出す前に ffprobe で実測して埋める。

### `make_subtitles` — 字幕ファイルを作る

`cues`（明示キュー）/ `text` + `duration`（文単位に分割して均等割り付け）/
`transcript`（`transcribe_audio` の結果）/ `input`（既存 SRT・VTT の読み込み・変換）
から `srt` または `vtt` を書き出す。焼き込みは `edit_video` の `subtitles` で行う。

---

## 2. ツール引数

### `edit_video`

| 引数 | 型 | 説明 |
|---|---|---|
| `timeline` | object | `{ width, height, fps, tracks[], subtitles[] }` |
| `clips` | array | 単純連結のショートカット。パス文字列 or クリップオブジェクト |
| `paths` | array | `clips` の別名 |
| `materials` | object | `{ id: path }`。クリップは `materialId` で参照できる |
| `subtitles` | array | `{start,end,text}` の配列（`timeline.subtitles` の代替） |
| `width` / `height` / `fps` | integer | 既定 1280 / 720 / 30 |
| `format` | string | `mp4` / `webm` / `gif`（既定 `mp4`） |
| `name` | string | ファイル名の語幹 |
| `outputDir` | string | セッション配下のディレクトリ（既定 `media-studio`） |

`timeline.tracks[].clips[]` のフィールド:
`path` / `materialId` / `in` / `out` / `speed` / `volume` / `fadeIn` / `fadeOut` / `duck` /
`transition` / `transitionDuration` / `crop` / `rotate` / `color` / `text` /
`position` / `scale` / `at`。

返り値: `width, height, fps, seconds, clips, tracks, format, bytes, mediaType, name,
hasAudio, subtitles, transitions, path`。

### `probe_video`

| 引数 | 型 | 説明 |
|---|---|---|
| `path` | string | 調べるファイル（セッション相対 or 絶対） |

返り値: `name, bytes, mediaType, duration, hasVideo, hasAudio, formatName, videoCodec,
width, height, fps, pixelFormat, audioCodec, channels, sampleRate, bitrate, streams, path`。

### `export_timeline`

| 引数 | 型 | 説明 |
|---|---|---|
| `format` | string | **必須**。`mlt` / `otio` / `fcpxml` / `edl` |
| `timeline` / `clips` / `paths` / `materials` | | `edit_video` と同じ |
| `title` | string | ドキュメント内のプロジェクト名 |
| `width` / `height` / `fps` | integer | 既定 1280 / 720 / 30 |
| `name` / `outputDir` | string | 出力先 |

返り値: `format, name, bytes, mediaType, clips, tracks, seconds, width, height, fps, path`。

### `make_subtitles`

| 引数 | 型 | 説明 |
|---|---|---|
| `cues` | array | `{start,end,text}` |
| `text` | string | 分割して `duration` に均等配置する本文 |
| `duration` | number | `text` を流す長さ（既定 5 秒） |
| `transcript` | object | `{segments:[{start,end,text}]}` または `{text,duration}` |
| `input` | string | 既存 `.srt` / `.vtt` のパス |
| `format` | string | `srt` / `vtt`（既定 `srt`） |
| `name` / `outputDir` | string | 出力先 |

返り値: `format, name, bytes, mediaType, cues, seconds, firstCue, path`。

### 設定キー（`cordis.patch.yml`）

| キー | 意味 |
|---|---|
| `nle.ffmpegPath` | ffmpeg のフルパス（未指定なら `video.ffmpegPath` → PATH の順） |
| `nle.ffprobePath` | ffprobe のフルパス（未指定なら ffmpeg と同じディレクトリ → PATH） |
| `nle.fontPath` | 焼き込み用フォント。未指定なら `meiryo.ttc` → `YuGothM.ttc` → `msgothic.ttc` → `segoeui.ttf` → `arial.ttf` |
| `nle.timeoutMs` | 1 レンダーの上限（既定 1800000） |
| `nle.probeTimeoutMs` | ffprobe 1 回の上限（既定 120000） |

外部バイナリが無い場合、`edit_video` / `probe_video` / `export_timeline` は
`ffmpeg が見つかりません。PATH に追加するか、cordis.patch.yml の video.ffmpegPath /
nle.ffmpegPath にフルパスを指定してください。` を投げる。**モジュールの import と
純関数はバイナリ無しでも動く**（テストは ffmpeg 不在なら render 系だけ skip する）。

---

## 3. 純関数（テストから直接叩ける named export）

```
normalizeTimeline / normalizeCues / flattenTimeline / baseVideoTrackIndex
planVideoGroups / effectiveTransition / timelineSeconds / applyProbeDurations
materialMap / isImagePath
buildFilterComplex / buildFfmpegArgs / atempoChain / fitToCanvas
textPosition / overlayPosition / drawTextFilter
toMlt / toOtio / toFcpxml / toEdl / renderTimelineDocument
timelinePlan / otioRationalTime / otioTimeRange
parseSubtitles / toSrt / toVtt / cuesFromText
formatSrtTime / formatVttTime / formatEdlTimecode / formatFcpxmlTime / formatMltTime
escapeXml / escapeFilterPath / toFileUrl
summarizeProbe / parseRate / resolveBinaries / resolveFont
```

`buildFilterComplex(timeline, sources, {fontFile})` は `sources`（`flattenTimeline` と
同じ並びの `{hasVideo, hasAudio}`）を受け取り、`{filter, video, audio, seconds, inputs,
transitions}` を返す。ディスクにもプロセスにも触れないので、ffmpeg の無い環境でも
グラフの形を検証できる。

---

## 4. 実測検証ログ

環境: Windows / Node v24.22.1 / **ffmpeg 9.0.2-full_build-www.gyan.dev** / ffprobe 9.0.2。
作業ディレクトリ `C:\root\dsh-media-studio`。

### 4.1 素材の生成

```powershell
ffmpeg -y -nostdin -loglevel error -f lavfi -i "testsrc2=s=640x480:r=30:d=4" `
  -f lavfi -i "sine=frequency=440:duration=4" `
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest a.mp4
ffmpeg -y -nostdin -loglevel error -f lavfi -i "smptebars=s=640x480:r=30:d=3" `
  -f lavfi -i "sine=frequency=660:duration=3" `
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest b.mp4
ffmpeg -y -nostdin -loglevel error -f lavfi -i "sine=frequency=220:duration=8" -ac 2 -ar 44100 bgm.wav
ffmpeg -y -nostdin -loglevel error -f lavfi -i "color=c=teal:s=640x480:d=1" -frames:v 1 still.png
```

### 4.2 `edit_video`（全部入り）

タイムライン: a.mp4(0.5–2.5, fade 0.4s, テロップ) → b.mp4(0–2, saturation 1.4) の映像
トラック、b.mp4 を PiP（at 0.5, scale 0.28, top-right）で重ね、bgm.wav を
volume 0.25 / fadeIn 0.5 / fadeOut 1 / duck:true でミックス、字幕 2 行を焼き込み。

```
結果: {"width":640,"height":480,"fps":30,"seconds":3.6,"clips":4,"tracks":3,
      "format":"mp4","bytes":380996,"mediaType":"video/mp4","name":"full.mp4",
      "hasAudio":true,"subtitles":2,"transitions":1,"path":"media-studio\\full.mp4"}

$ ffprobe -v error -print_format json -show_format -show_streams full.mp4
  duration   = 3.600000
  size       = 380996
  bit_rate   = 846657
  video      = h264 640x480 yuv420p 30fps
  audio      = aac 2ch 48000Hz
```

期待値どおり **3.6 秒**（2.0 + 2.0 − fade 0.4）、音声 2ch、映像 640×480。

目視でも確認（`-ss 0.6` のフレームを PNG に落として読む）:
テロップ「こんにちは NLE」が上部、字幕「最初の字幕」が下部、右上に PiP のカラーバー、
日本語は Meiryo で正しく描画されていた（豆腐にならない）。

### 4.3 `edit_video`（トリム + 速度 + クロップ + 回転 + GIF）

入力 a.mp4 の 0–2 秒、`speed: 2`、`crop 480x360 @ (80,60)`、`rotate: 90`、`480x360 / 15fps / gif`。

```
結果: {"seconds":1,"format":"gif","mediaType":"image/gif","hasAudio":false,
      "width":480,"height":360,"fps":15,"name":"fast.gif"}
$ ffprobe fast.gif → format=gif, 480x360, duration 1.000000
```

2 秒 ÷ speed 2 = **1.0 秒**。GIF は音声ストリームを持たないので `hasAudio:false`。

### 4.4 `edit_video`（連結 + WebM）

a.mp4(4s) + b.mp4(3s) を 320×240 / 24fps / webm で連結。

```
結果: {"seconds":7,"format":"webm","bytes":716638,"hasAudio":true,"name":"small.webm"}
$ ffprobe small.webm → video=vp9 320x240, audio=opus, duration 7.0
```

### 4.5 `probe_video`

```
$ probe_video { path: "media-studio/full.mp4" }
{"name":"full.mp4","bytes":380996,"mediaType":"video/mp4","duration":3.6,
 "hasVideo":true,"hasAudio":true,"videoCodec":"h264","width":640,"height":480,
 "fps":30,"pixelFormat":"yuv420p","audioCodec":"aac","channels":2,"sampleRate":48000,
 "bitrate":846657, "streams":[{"index":0,"type":"video",...},{"index":1,"type":"audio",...}]}
```

### 4.6 `export_timeline`（4 形式すべてパース検証）

タイムライン: 映像 2 クリップ（a.mp4 0.5–2.5, b.mp4 0–2）+ 音声 1 クリップ（bgm.wav 0–4）。

| 形式 | bytes | パース検証 |
|---|---|---|
| `mlt` | 1708 | `[xml]` でロード成功。root=`mlt` version=`7.0.0`、`<producer>` 3 個 |
| `otio` | 4413 | `JSON.parse` 成功。`OTIO_SCHEMA=Timeline.1`、`tracks.children` 2 本、`Clip.1` |
| `fcpxml` | 1422 | `[xml]` でロード成功。root=`fcpxml` version=`1.9`、`<asset>` 3 個 |
| `edl` | 378 | イベント行 3 本、`TITLE:` / `FCM: NON-DROP FRAME` / `* FROM CLIP NAME:` を確認 |

XML は .NET の `System.Xml.XmlDocument` でロードして well-formed であることを確認した
（正規表現だけの判定ではない）。`seconds` はいずれも 4。

### 4.7 `make_subtitles`

```
$ make_subtitles { text: "最初の文です。二番目の文です。三番目の文です。", duration: 6, format: "srt" }
{"format":"srt","name":"subs.srt","bytes":170,"mediaType":"application/x-subrip",
 "cues":3,"seconds":6,"firstCue":"最初の文です。"}

読み戻し: [{"start":0,"end":2,"text":"最初の文です。"},
           {"start":2,"end":4,"text":"二番目の文です。"},
           {"start":4,"end":6,"text":"三番目の文です。"}]

$ make_subtitles { cues: [...], format: "vtt" } → 95 bytes / 2 cues
$ make_subtitles { input: "media-studio/subs.srt", format: "vtt" } → SRT→VTT 変換も確認
```

### 4.8 外部バイナリが無いとき

```
$ edit_video with config.nle.ffmpegPath = "C:/nope/ffmpeg.exe"
→ "ffmpeg が見つかりません: C:/nope/ffmpeg.exe"
```

`import` と純関数は ffmpeg 無しでも動く（テストの render 系だけ `skip` する作り）。

### 4.9 テスト

```
$ cd C:\root\dsh-media-studio
$ node --test test/nle.test.mjs
ℹ tests 84 / pass 84 / fail 0 / skipped 0

$ node --test
ℹ tests 297 / pass 297 / fail 0 / skipped 0 / duration_ms 26405
```

`node --test test/` は Windows で失敗するので使っていない。84 件のうち render 系は
実 ffmpeg を回す（`skip` 0 はこのマシンで全部走ったという意味）。フル実行の 297 件は
v3 の他担当（cad / daw）の追加分を含む同時実行時の値。

```
$ node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp
dsh-media-studio: 0 error(s), 0 warning(s), 0 note(s)
```


---

## 5. README に載せる短い日本語説明

> **動画編集（NLE）** — `edit_video` はタイムラインを 1 本の動画に仕上げます。クリップの
> トリム・連結・速度変更・クロップ・回転、フェードやワイプなどのトランジション、
> ピクチャ・イン・ピクチャ、テロップと字幕の焼き込み、BGM の音量・フェード・ダッキング、
> 明るさ・コントラスト・彩度の調整までを 1 回の ffmpeg 実行で処理し、MP4 / WebM / GIF で
> 書き出します。`probe_video` は duration・解像度・コーデック・音声チャンネルを読み取り、
> `export_timeline` は同じタイムラインを Kdenlive / Shotcut（`.mlt`）、OpenTimelineIO
> （`.otio`）、Final Cut Pro / Resolve（`.fcpxml`）、CMX3600（`.edl`）として書き出すので、
> そのまま編集ソフトで開いて続きを編集できます。`make_subtitles` はテキストや
> `transcribe_audio` の結果から SRT / WebVTT を組み立てます。外部ソフトは不要で、
> 必要なのは ffmpeg だけです。

---

## 6. 実装メモ / 既知の制限

- 映像は **1 本目の映像トラックがベース**、2 本目以降は PiP オーバーレイとして重なる。
  ベース内のクリップは `transition` で cut（`concat`）と xfade（`xfade`）に振り分ける。
- 音声は 48kHz / stereo / fltp に正規化してから `amix`（`normalize=0`）。duck は
  `sidechaincompress`（threshold 0.05 / ratio 8 / attack 20 / release 300）。
- テロップと字幕は `drawtext` + `textfile=` で描く。テキストをフィルタ文字列に埋め込まない
  ので、`:` `'` `%` `,` を含む日本語や絵文字でもエスケープ事故が起きない。
- 字幕は 1 キュー 1 `drawtext`。焼き込み上限は 300 キュー（`MAX_BURNED_CUES`）。
- 制限: 音声トラックのクリップは**並び順に連結**される（`at` による配置は未対応）。
  ベース映像トラック以外でのトランジションは無視される。LUT・カラーキー・モザイク・
  手ぶれ補正・クロマキーは未対応。GIF は音声を持てない。
- 1 レンダーの上限は `MAX_NLE_SECONDS = 600` 秒、クリップ数は `MAX_NLE_CLIPS = 60`。
- 一時ディレクトリは `mkdtemp` で作り、`finally` で必ず削除する。`spawn` は
  `windowsHide: true` / `shell: false` で、タイムアウト時に `SIGKILL` する。
