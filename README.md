# メディアスタジオ (@local/dsh-media-studio)

DeepSeek Harness に **画像生成**・**動画制作**・**モーショングラフィックス**・**グラフ描画**・**画像加工**・**効果音生成**・**音声合成（TTS）**・**音楽生成／自動作曲**・**歌詞生成**・**小説生成**・**記事生成**・**音声入力（文字起こし）** を追加するプラグインです。音楽は **SoundFont（実録音楽器）** でレンダリングします。動画は **ローカルの diffusers** が絵を作り、**ffmpeg** が MP4 にまとめます。グラフは **Pillow** が直接描き、**ffmpeg** が画像を加工します。モーショングラフィックスも **Pillow** が 1 フレームずつ描き、**ffmpeg** が動画にまとめます。効果音は **Node の DSP** が波形から作り、文章は **ハーネスの `llm`** が書いたものを機械検証します。

**動画は「生成」ではなく「制作」です。** 素材（画像・動画・音楽・ロゴ）をライブラリに入れ、シーン（描画テンプレート・ゆっくり動かした画像・切り詰めた動画素材）を並べて、**ffmpeg** が 1 本の動画にまとめます。キーフレームもローカルで描くので、**動画の経路で外部モデルを呼ばません**。

- エージェント用ツール: `media_create` / `list_media` / `generate_image` / `generate_video` / `make_motion_graphic` / `produce_video` / `attach_material` / `render_chart` / `edit_image` / `generate_sfx` / `generate_speech` / `generate_music` / `compose_music` / `write_lyrics` / `write_novel` / `write_article` / `transcribe_audio`
- **入口はひとつ**: `media_create`（またはパネル上部の入力欄）に**一文**を書けば、種類は自動で判定されます。「雨の効果音を30秒」「夜のドライブ向けのシティポップ、92 BPM」「灯台守の小説の第1章」——ツール名も引数名も覚える必要はありません。
- **エージェントは自分で使える**: `list_media` で過去の制作物を一覧し、返ってきたパスを次の工程（`attach_material` / `produce_video`）に渡して再利用します。システムプロンプトにも常設の案内が入るので、指示がなくても必要なら自分から呼びます。
- Web UI: サイドバーの **メディアスタジオ** パネル。**上部に入力欄が常設**され、一文を書いて「生成」を押すだけで結果（画像・音声・動画・本文）がその場に返ります。その下に従来の 6 タブ（画像 / 制作 / グラフィック / 音声 / 音楽 / 音声入力）が並び、細かく指定したいときに使います。**制作タブ**は「素材 → 構成 → 書き出し」の 3 段構えで、場面の並びをその場で編集できます。音楽タブは **マルチトラックの DAW 風グリッド** と **スコアテキスト** を双方向に切り替えられます。
- チャット: `generate_video` / `make_motion_graphic` / `produce_video` の結果はインラインの動画プレイヤー、`generate_speech` と `generate_music` / `compose_music` / `generate_sfx` の結果は音声プレイヤー、`render_chart` と `edit_image` の結果はそのまま画像として表示されます。歌詞・小説・記事は本文と計測値がそのまま返ります。
- **複数楽器の同時使用**: トラックごとに SoundFont プリセットを持ち、1 曲で同時に鳴らせます。
- **プロンプトから作曲**: `compose_music` に `prompt` を渡すと、普通の言葉（ジャンル・気分・楽器・キー・テンポ・長さ）を読み取って、その内容に沿った曲を作ります。日本語でも英語でも読めます。
- **スコアテキスト形式 (MSX)**: 他 AI にそのまま生成させられる小さな構文。仕様は [SCORE-FORMAT.md](./SCORE-FORMAT.md)。

既定はすべてローカル・キー不要で動きます。API プロバイダを設定すると品質と速度を上げられます。

## 既定のバックエンド

| 機能 | 既定 | 代替 |
| --- | --- | --- |
| 画像生成 | **ローカルの diffusers**（Stable Diffusion 系、`torch` が必要） | ComfyUI（ローカルサーバー）/ OpenAI 互換 / Pollinations |
| 動画 | **ローカルのコード描画**（Pillow が 1 フレームずつ ＋ ffmpeg） | 生成モデル（`generate_video`、`torch`＋`diffusers` が必要） |
| 動画制作 | ローカル ffmpeg（場面をつなぎ合わせる）＋ Pillow（描画） | — |
| グラフ描画 | ローカル Pillow（モデル不要・約 1 秒） | — |
| 画像加工 | ローカル ffmpeg（拡大縮小・回転・変換） | — |
| モーショングラフィックス | ローカル Pillow（1 フレームずつ描画）＋ ffmpeg | — |
| 音声合成 | Windows SAPI（オフライン、日本語の声を自動選択） | OpenAI 互換 `POST /audio/speech` |
| 音楽生成 | `spessasynth_core` + SF2（GeneralUser GS など、オフライン） | 任意の `.sf2` |
| 自動作曲 | ローカル生成（コード進行＋メロディ＋ベース） | — |
| 音声入力 | ハーネスの `speechToText`（voice-input バンドル / SenseVoice） | OpenAI 互換 `POST /audio/transcriptions` |
| 効果音生成 | ローカル DSP（Node のみ・約 0.5 秒/本） | — |
| 歌詞・小説・記事 | ハーネスの `llm`（セッションの既定モデル） | `writing.provider` / `writing.model` |

- **グラフ描画**は、データを渡すと即座に正しいグラフの PNG が返ります。モデルも API キーも不要で、**画像生成に文字を描かせるのと違い文字が崩れません**。棒 / 横棒 / 折れ線 / 面 / 円 / ドーナツ / 散布図 / 積み上げ棒の 8 種類と、ライト・ダークの 2 配色。日本語フォント（Meiryo / Yu Gothic / MS Gothic）を自動選択します。
- **画像加工**は `ffmpeg` で拡大縮小・回転・反転・グレースケール・形式変換（PNG / JPEG / WebP）します。
- **モーショングラフィックス**は、1 フレームずつ Pillow で描いてから ffmpeg で動画にします。タイトルカード・ロワーサード・ロゴ・インフォグラフィック・背景映像・トランジションの 6 種類。イージングとスタガーで要素が順に出入りするので、静止画の連続ではなく<u>動いている</u>グラフィックになります。
- **動画生成**は、このマシンで `diffusers` が絵（フレーム）を描き、`ffmpeg` が MP4 に書き出す構成です。API キーも外部サービスも不要です。初回の実行ではモデルの重みをダウンロードします（Stable Video Diffusion で約 4.3 GB）。生成は GPU 上で動くので、12 GB 显存の显卡でも十分です。テキストだけの場合のキーフレームは**ローカルの描画器が引く**ので、この経路でも外部の画像生成は呼ばれません。
- **動画制作**は、作り込まれたパーツを 1 本にまとめる作業です。場面は 3 種類——描画テンプレート（タイトルカード・ロワーサード等）、ゆっくり動かした画像（Ken Burns）、切り詰めた動画素材——で、隣り合う場面は「カット」か「ディゾルブ」でつながります。音声のナレーションや BGM を混ぜることもできます。すべて ffmpeg の処理なので、外部モデルも API キーも要りません。
- **音声合成**は Windows の `System.Speech` を使うため、ネットワークなしで動きます。日本語の声（Haruka / Ayumi / Ichiro / Sayaka など）が入っていれば、日本語テキストには自動で日本語の声を選びます。
- **音楽生成**は SoundFont（`.sf2`）を `spessasynth_core` でオフライン レンダリングします。ネットワークも API キーも不要です。楽器は GM プリセット（`gm:0` など）で指定します。
- **自動作曲**はコード進行・メロディ・ベースをその場で組み立てます。`style`（pop / ballad / chiptune / ambient / edm）と `key`・`scale`・`seed` を選ぶだけで、パネルのグリッドに反映してすぐ再生できます。
- **音声入力**はプロファイルに `@deepseek-ai/dsh-experimental-voice-input-bundle` が入っている前提です。初回の文字起こし時にローカルモデルをダウンロードします（数分かかることがあります）。コンポーザー右上のマイク（同バンドル）もそのまま使えます。
- API キーはブラウザに渡りません。認証済みの同一オリジン経路 (`/api/media-studio/*`) を Host が中継します。

## インストール

```
plugin_manager install_bundle
  target: C:\root\dsh-media-studio
```

インストール後、プロファイルの `package.json` の `dsh.profile.bundles` に行が追加され、`cordis.patch.yml` の設定で上書きできます。変更はこのプロファイルの全セッションに反映されます。

## 設定

行 `media-studio` の `config`（すべて任意）:

```yaml
- id: media-studio
  name: '@local/dsh-media-studio'
  config:
    outputDir: media-studio          # ツールが保存する作業ディレクトリ配下の場所
    image:
      provider: local                # local（diffusers）| comfyui | openai | pollinations
      model: stabilityai/sd-turbo    # ローカルのチェックポイント（HF の ID）
      steps: 4                       # ローカルのサンプリング回数
      pythonPath: ''                 # torch＋diffusers のある Python（'' = 自動探索）
      baseURL: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY      # 資格情報ストア / 環境変数の名前
      apiKey: ''                     # 直接指定する場合（非推奨）
      model: gpt-image-1
      timeoutMs: 120000
    speech:
      provider: system               # system | openai
      baseURL: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
      model: gpt-4o-mini-tts
      voice: ''                      # '' = テキストの言語に合わせて自動
      rate: 0                        # SAPI の速さ -10..10
      format: wav                    # wav | mp3
      timeoutMs: 60000
    transcription:
      provider: harness              # harness | openai
      baseURL: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
      model: whisper-1
      language: ja
      timeoutMs: 180000
      prepareTimeoutMs: 1800000      # 初回モデル準備の待ち時間
    music:
      defaultTempo: 120              # 既定の BPM
      defaultInstrument: gm:0        # SoundFont プリセット（gm:<program>）
      maxNotes: 8192                 # 1曲あたりの最大ノート数
      maxSeconds: 600                # 1曲あたりの最大秒数（10分）
    video:
      provider: local                 # local | comfyui | openai | frames
      baseURL: https://api.openai.com/v1   # openai / comfyui 用のエンドポイント
      apiKeyEnv: OPENAI_API_KEY        # openai プロバイダの資格情報名
      apiKey: ''                       # 直接指定する場合（非推奨）
      model: ''                        # プロバイダのモデル名（未指定ならレシピの既定）
      recipe: svd                      # svd | wan21 | cogvideox | ltx
      pythonPath: ''                   # torch + diffusers のある Python（'' = 自動探索）
      ffmpegPath: C:\ProgramData\ffmpeg.exe   # MP4 の書き出しに使う ffmpeg（'' = 自動探索）
      seconds: 4                       # 既定の長さ
      fps: 8                           # 既定のフレームレート
      width: 1024                      # 既定の横幅
      height: 576                      # 既定の縦幅
      steps: 25                        # ローカルレシピの既定のステップ数
      workflowPath: ''                 # ComfyUI 用ワークフロー JSON
      timeoutMs: 1800000               # 1 回のリクエスト全体の上限
    graphics:
      pythonPath: ''                   # Pillow のある Python（'' = video.pythonPath）
      ffmpegPath: C:\ProgramData\ffmpeg.exe   # 画像加工に使う ffmpeg（'' = 自動探索）
      theme: light                     # light | dark
      width: 1200                      # 既定の横幅
      height: 675                      # 既定の縦幅
      timeoutMs: 120000                # 1 回のリクエスト全体の上限
    motion:
      pythonPath: ''                   # Pillow のある Python（'' = graphics.pythonPath）
      ffmpegPath: C:\ProgramData\ffmpeg.exe   # 動画にまとめる ffmpeg（'' = graphics.ffmpegPath）
      width: 1280                      # 既定の横幅
      height: 720                      # 既定の縦幅
      seconds: 4                       # 既定の長さ
      fps: 30                          # 既定のフレームレート
      timeoutMs: 300000                # 1 回のリクエスト全体の上限
    production:
      pythonPath: ''                   # Pillow のある Python（'' = motion.pythonPath）
      ffmpegPath: C:\ProgramData\ffmpeg.exe   # 場面をつなぎ合わせる ffmpeg（'' = motion.ffmpegPath）
      width: 1280                      # 既定の横幅
      height: 720                      # 既定の縦幅
      fps: 30                          # 既定のフレームレート
      timeoutMs: 900000                # 1 回のリクエスト全体の上限
    assets:
      maxBytes: 268435456              # 1 つの素材の取り込み上限（256 MB）
    sfx:
      sampleRate: 44100                # 44100 | 48000
      channels: 2                      # 1 | 2
      outputDir: media-studio          # 効果音の保存先（'' = outputDir）
    writing:
      provider: ''                     # '' = セッションの既定モデル
      model: ''
      maxTokens: 4096                  # 歌詞・記事の上限（小説は自動で増える）
      temperature: 0.8
      timeoutMs: 180000
      outputDir: media-studio          # 原稿と設定資料の保存先
      directory: ''                    # 素材ライブラリの場所（'' = %DSH_HOME%/media-studio/assets）
    soundfont:
      path: C:\root\instrument-data\GeneralUser-GS.sf2   # '' で SoundFont を無効化
      gain: 1                        # 出力ゲイン
      releaseSeconds: 1.2            # 最終ノート後に鳴らす余韻
    maxAudioBytes: 8388608
    maxSpeechText: 4000
    maxImagePrompt: 2000
    maxVideoPrompt: 2000
    maxNegativePrompt: 1000
    maxChartData: 20000
```

API プロバイダを使う場合は、資格情報をハーネスの資格情報ストア（設定 → モデル → 資格情報）か環境変数 `OPENAI_API_KEY` に置いてください。`apiKeyEnv` を変えれば任意の名前を使えます。

## ツール

### `media_create`（なんでも入口）

一文を書くと、制作領域を判定して適切なツールを実行します。**ツール名も引数も要りません。**

```
media_create prompt="雨の効果音を30秒、ループで"
media_create prompt="夜のドライブ向けのシティポップ、92 BPM、C マイナー"
media_create prompt="終電を逃した二人の歌詞。サビは「まだ帰らないで」"
media_create prompt="1200字の記事で、効果音を自作する手順"
media_create prompt="夜明けの海辺に立つ灯台、横長"
```

判定は決定的な規則で行います（モデルは呼びません）。名詞が制作物を決め、日本語は動詞が最後に来るので**動詞に最も近い名詞**を主語にします。だから「効果音を作る記事を書いて」は記事になります。同点なら具体的な語（「曲」より「歌詞」、「音」より「効果音」）を優先します。

文中の数値も読み取ります。

| 書いたもの | 読み取るもの |
| --- | --- |
| `30秒` / `1分` | 長さ |
| `92 BPM` / `テンポ 92` | テンポ |
| `C マイナー` / `F# major` | キーとスケール |
| `横長` / `縦長` / `正方形` / `16:9` | アスペクト比 |
| `雨` `風` `爆発` `足音` `扉` … | 効果音の種類 |
| `A 10、B 20、C 30` | グラフのデータ |

結果は「解釈: 効果音 / rain / 30 秒 として 「雨」 を作ります」のように、**何として解釈したか**を添えて返ります。判定が違うときは `hint` で領域を固定できます。

### `list_media`（制作物の一覧）
このセッションが作ったものを新しい順に返します。**作り直す前に見る**ための道具です。

```
list_media                      # 全部（新しい順・20 件）
list_media kind=audio           # 音だけ
list_media query=雨             # 名前に「雨」を含むもの
```

返るのは `path` / `name` / `kind`（audio・image・video・text）/ `bytes` / `modifiedAt` です。`path` はそのまま `attach_material`・`produce_video`・`generate_video` に渡せます。`.md` や `.json` は通常のファイル読み取りで中身を確認できます。

制作物はすべて `<作業ディレクトリ>/media-studio/` に置かれます。

### `generate_image`

```json
{ "prompt": "a quiet mountain lake at sunrise, soft watercolour", "aspect": "landscape" }
```

- `aspect`: `square` / `landscape` / `portrait`（既定 `square`）
- `width` / `height`: 256–1536 の明示サイズ
- `seed`: 再現用シード
- 結果はチャットに画像として表示され、作業ディレクトリ `<cwd>/media-studio/` にも PNG が保存されます。

### `generate_video`

```json
{ "prompt": "a paper boat drifting down a rain gutter, slow push-in", "aspect": "landscape", "seconds": 4 }
```

- `prompt`: 動画の中身（被写体・動き・カメラ）。英語のプロンプトのほうが結果が出やすくなります。
- `negativePrompt`: 避けたい要素（`blurry, watermark` など）。
- `mode`: `text`（既定）か `image`。`image` のときは `image` にパスを渡します。
- `image`: 動かす画像のパス（絶対パス、または作業ディレクトリからの相対パス）。
- `aspect`: `landscape` / `portrait` / `square`、`width` / `height` で明示サイズも指定できます。
- `seconds` / `fps` / `frames`: 長さ。フレーム数はモデルが求める `4n+1` 個に丸められます。
- `steps`: サンプリング回数（多いほど遅く、丁寧になります）。
- `seed`: 再現用シード、`recipe`: ローカルレシピ（`svd` / `wan21` / `cogvideox` / `ltx`）。
- 結果は MP4 として保存され、チャットに動画プレイヤーが出ます。

### `attach_material`

```json
{ "path": "C:\\root\\media-studio\\logo.png" }
```

- 作業ディレクトリのファイルを**素材ライブラリ**にコピーします（コピーなので元のファイルはそのまま）。絶対パスでも相対パスでも可。
- 画像・音声・動画・そのほかのファイルが入ります。ライブラリはハーネスのホーム（`%DSH_HOME%/media-studio/assets/`）に 1 つあり、**パネルとエージェントで同じもの**を見ます。ハーネスを再起動しても残ります。
- 場面の `materialId` / `backgroundImageId` / `logoId` には、ここで得た `id` を渡します。

### `produce_video`

```json
{
  "scenes": [
    { "type": "template", "template": "title", "text": "ハーネス映画夜", "duration": 3, "transition": "fade" },
    { "type": "template", "template": "lower_third", "text": "第 12 回", "duration": 3 },
    { "type": "image", "materialId": "m_3f2a", "duration": 4 }
  ],
  "narration": "今宵はハーネスで組んだ映像です。"
}
```

- `scenes`: 場面の並び。`type` は `template`（描画）/ `image`（画像をゆっくり動かす）/ `clip`（動画素材を切る）。
- `template`: 描画するテンプレート（`title` / `lower_third` / `ident` / `chart` / `shapes` / `stinger`）。
- `duration`: その場面の秒数（既定 3、最大 30）。`transition`: 次の場面へのつなぎ方（`cut` / `fade`、既定 `cut`）。
- `materialId`: 使う素材。`backgroundImageId` / `logoId` は描画テンプレートの背景とロゴ。
- `labels` / `series` / `data`: `chart` テンプレートのグラフデータ。
- `narration`: 音声のナレーション。`voice` で声、`musicMaterialId` で BGM の素材を指定できます。
- `width` / `height` / `fps` / `format`（`mp4` / `webm`）で書き出しの種類を決めます。
- 結果は MP4 として保存され、チャットに動画プレイヤーが出ます。

### 動画の裏側（どの経路で生成されるか）

`video.provider` で経路を切り替えます。

| provider | 動き | 必要なもの |
| --- | --- | --- |
| `local` | このマシンで `diffusers` がフレームを描き、`ffmpeg` が MP4 にまとめる | `torch` + `diffusers` のある Python、`ffmpeg`、GPU（推奨） |
| `comfyui` | ComfyUI のワークフローを実行して MP4 を受け取る | 起動中の ComfyUI と動画モデル、`video.workflowPath` |
| `openai` | OpenAI 互換の `POST /videos` に job を作り、完了を待って MP4 を取得 | API キー（`OPENAI_API_KEY` など） |
| `frames` | モデル不要。PNG フレーム列、または 1 枚の画像をゆっくりズームして MP4 に | `ffmpeg` のみ |

ローカルレシピ:

| recipe | 方式 | モデル | ダウンロード量 |
| --- | --- | --- | --- |
| `svd`（既定） | 画像 → 動画 | `stabilityai/stable-video-diffusion-img2vid-xt` | 約 4.3 GB |
| `wan21` | テキスト → 動画 | `Wan-AI/Wan2.1-T2V-1.3B-Diffusers` | 約 27 GB |
| `cogvideox` | テキスト → 動画 | `THUDM/CogVideoX-2b` | 約 12.8 GB |
| `ltx` | テキスト → 動画 | `Lightricks/LTX-Video` | 約 15 GB |

- 既定の `svd` は「1 枚の絵を動かす」方式です。テキストだけを渡すと、**このマシンでキーフレームを 1 枚描いて**（`motion` の描画器。タイトルカードと同じ明朝体・余白・カメラ）それを動かします。**外部の画像生成は呼ばれません**。テキストから直接動画を作る場合は `recipe: wan21` など、テキスト → 動画に対応したレシピを選んでください。
- ローカル生成には Python が必要です。`python` が PATH にない場合は `video.pythonPath` に `python.exe` のフルパスを指定してください。
- MP4 の書き出しには `ffmpeg` が必要です。`video.ffmpegPath` に `ffmpeg.exe` のフルパスを指定できます（未指定なら PATH と代表的な置き場所を探します）。
- ComfyUI を使う場合、`video.workflowPath` に ComfyUI で書き出したワークフロー JSON を置きます。文字列の中の `{{prompt}}` `{{negative}}` `{{seed}}` `{{width}}` `{{height}}` `{{frames}}` `{{fps}}` `{{image}}` がリクエストの値で置き換えられます。

### このマシンでの実測

RTX 3060（12 GB）+ torch 2.14 / diffusers 0.41 で `svd` レシピを実行した結果です。**この GPU は通常の 3060 より 10 分の 1 ほどしか吞吐が出ません**（fp16 行列積で 2.9 TFLOPS 程度。普通の 3060 なら 30 TFLOPS 前後です）。

| 設定 | 実測時間 |
| --- | --- |
| 512×288 / 9 フレーム / 8 ステップ | 約 45–140 秒 |
| 1024×576 / 25 フレーム / 25 ステップ | 約 30 分（サンプリング 1 ステップあたり約 77 秒） |

- 目安として、**時間はピクセル数 × ステップ数にほぼ比例**します。急ぐときは 512×288 で 8〜10 ステップ程度が現実的です。
- 初回は重みのダウンロード（`svd` で約 4.3 GB）が入ります。2 回目以降は Hugging Face のキャッシュから読み込むだけ（このマシンでは約 5 秒）。
- `wan21` / `cogvideox` / `ltx` はコード上の対応は済んでいますが、**このマシンでは重みのダウンロードと実測をしていません**。ディスクの空き（当時約 67 GB）と時間が要るので、必要に応じて使ってください。
- `frames` プロバイダ（ffmpeg だけの低速な経路）なら 1 枚画像から数秒で MP4 を作れます。作画の安定を確かめたいときや、動作確認用の簡易テストに向いています。

### `render_chart`

```json
{
  "type": "bar",
  "title": "月別売上",
  "subtitle": "2026年上半期（万円）",
  "labels": ["1月", "2月", "3月", "4月", "5月", "6月"],
  "series": [{ "name": "売上", "values": [120, 148, 131, 175, 162, 198] }]
}
```

- `type`: `bar` / `hbar` / `line` / `area` / `pie` / `donut` / `scatter` / `stacked`
- `theme`: `light`（既定）/ `dark`
- `data`: `labels` と `series` の代わりに、生データ（CSV / TSV / JSON）でも渡せます。1 行目が見出しなら見出しとして扱います。
  - CSV / TSV: `月,売上\n1月,120\n2月,148`
  - JSON: `{"labels": [...], "series": [{"name": "...", "values": [...]}]}` / `[{"label": "1月", "value": 120}]` / `{"1月": 120}`
- 軸の目盛は 1 / 2 / 2.5 / 5 × 10ⁿ の読みやすい刻みに自動で丸められます。
- 結果は PNG として保存され、チャットにそのまま表示されます。**モデルを使わないので約 0.3 秒**です。文字も数字も正確です。

### `edit_image`

```json
{ "path": "C:\\root\\media-studio\\chart.png", "width": 600, "format": "jpeg" }
```

- `width` / `height`: 片方だけなら縦横比を保ったまま、もう片方を指定すると全体に合わせて余白を埋めます。
- `format`: `png`（既定）/ `jpeg` / `webp`
- `quality`: JPEG / WebP の品質 1–100（既定 90）
- `rotate`: 0 / 90 / 180 / 270、`flip`: `h` / `v`、`grayscale`: true
- 結果はチャットに画像として表示されます。

### `make_motion_graphic`

モーショングラフィックス（動くグラフィック）を作ります。静的な画像ではなく、時間とともに形を変える要素 — 文字、図形、ロゴ、グラフ、ロワーサード — を、モーションデザイナーの流儀で keys します。

```json
{
  "template": "title",
  "text": "ハーネス映画夜",
  "subtitle": "第 12 回 · 2026年10月",
  "style": "smooth",
  "format": "mp4"
}
```

**テンプレート（依頼の種類そのもの）**

| template | 用途 | 業界での呼び方 |
| --- | --- | --- |
| `title` | 文字が動くタイトルカード | kinetic typography / title sequence |
| `lower_third` | 画面下部の名前＋肩書き | lower third / chyron / name strap |
| `ident` | ロゴや局マークが組み立てられる | logo animation / station ident |
| `chart` | グラフが自分で描かれる | infographic animation |
| `shapes` | 図形が流れる抽象背景 | motion background / video bed |
| `stinger` | 短い演出用の切り替え | stinger / bumper / transition |

- `style`: `smooth`（既定・落ち着いた）/ `snappy`（オーバーシュート）/ `dramatic`（ゆっくりとした重厚さ）
- `format`: `mp4`（既定）/ `webm` / `gif`（Web 用スタンプ）
- `narration`: ナレーションの文。合成音声を動画にミックスします（`voice` で声を選べます）。
- `chart` テンプレートは `labels` と `series`（または `data` の CSV / TSV / JSON）が必要です。
- `background` / `foreground` / `accent` は `#rrggbb` で指定できます。

**描画のつくり方**

- すべての要素はイージング付き（`ease-out` / `ease-in-out` / オーバーシュート）で動きます。線形補間は使いません。
- 要素は **スタガー** して、1 つずつ順番に入ります（全部が同時に出ない）。
- 文字が **完成した** 後は **カメラがゆっくり寄る**（push-in + わずかなドリフト）ので、静止画のループにはなりません。
- 放送の **title-safe** 領域（上下 8%）をロワーサードは守ります。
- 文字は Windows のフォント（Meiryo / Yu Gothic など）で日本語もそのまま出ます。
- 1 フレームずつ Pillow で描いてから ffmpeg が MP4 にまとめます。**モデルも API キーも不要**、1280×720・4 秒・30 fps でおよそ 4–8 秒です。

結果はチャットにインラインの動画プレイヤーとして出ます。

### `generate_speech`

```json
{ "text": "こんにちは。今日もいい天気ですね。", "rate": 0 }
```

- `voice`: インストール済みの声（既定は言語に合わせて自動）
- `rate`: SAPI の速さ -10–10
- 結果は WAV/MP3 として保存され、チャットに音声プレイヤーが出ます。

### `generate_music`

```json
{
  "score": "C4:1 E4:1 G4:1 C5:2 rest:1 G4:1 E4:1 C4:2",
  "tempo": 120,
  "instrument": "piano",
  "title": "my-melody"
}
```

- `score`: `音名:拍数` を空白区切りで指定（例: `C4:1 D4:1`）。`rest` は休符、和音は1トークン内でカンマ区切り（例: `C4,E4,G4:2`）。
- `notes`: `score` の代わりに `{ "pitch": "C4", "beats": 1 }` の配列でも指定できます。
- `instrument`: SoundFont プリセット `gm:<program>`（0–127）／`gm:<bank>:<program>`（例 `gm:0` = Grand Piano、`gm:48` = Strings Ensemble）
- `tempo`: BPM（既定 120）。`volume`: 0.0–1.0（既定 0.7）。
- 結果は WAV として保存され、チャットに音声プレイヤーが出ます。

### マルチトラック（複数楽器の同時使用）

`generate_music` は 3 通りの入力を取れます。優先順位は `text` → `tracks` → `notes`/`score`（後方互換）。

1. `text` — スコアテキスト（MSX）。構文は [SCORE-FORMAT.md](./SCORE-FORMAT.md)。
2. `tracks` — `[{ name, instrument, notes: [{ pitch|pitches, start, duration }] }]`。位置は拍の絶対値。
3. `notes` / `score` + `instrument` — 従来の単一トラック指定。

```json
{
  "text": "tempo 100\ntrack melody\ninstrument gm:40\nE4 0 1\nG4 1 1\ntrack bass\ninstrument gm:33\nC2 0 2",
  "title": "duo"
}
```

- トラックごとに別の SoundFont プリセットを使えます。SoundFont のトラックは 1 本ずつ別 MIDI チャンネルで鳴ります。
- 戻り値には `trackCount` / `instruments` / `text`（正規化したスコアテキスト）が含まれます。

### `compose_music`（自動作曲）

音符を入力せずに曲を自動生成します。**melody / harmony / bass の 3 トラック**を作り、同じ `seed` なら常に同じ曲になります。

```json
{ "style": "pop", "key": "C", "scale": "major", "bars": 4, "tempo": 112, "output": "audio",
  "melodyInstrument": "gm:40", "harmonyInstrument": "gm:0", "bassInstrument": "gm:33", "seed": 7 }
```

- `style`: `pop` / `ballad` / `chiptune` / `ambient` / `edm` / `jazz` / `rock` / `cinematic` / `lofi` / `house` / `techno` / `trance` / `classical` / `blues` / `funk` / `soul` / `boss` / `drone` / `meditation` / `horror`
- `key`: `C` `C#` `D` … `B`、`scale`: `major` / `minor` / `pentatonic` / `dorian` / `mixolydian`
- `bars`: 1–256（4/4 拍子）、`seed`: 再現用の整数。3 分の曲なら 100 BPM で 75 小節、120 BPM で 90 小節です。
- `melodyInstrument` / `harmonyInstrument` / `bassInstrument`: トラックごとの SoundFont プリセット（既定はスタイルごとのプリセット）。`instrument` を指定すると 3 トラックすべてがそのプリセットになります。
- `output`: `audio`（既定、WAV を生成）または `text`（**スコアテキストだけを返し、音声は生成しない**）
- 戻り値の `text` は MSX スコアです。そのまま `generate_music` の `text` に渡せば手直しできます。

### `compose_music`（プロンプトから作曲）

`prompt` に普通の言葉で書くと、**その内容に沿った曲**が作られます。日本語でも英語でも読めます。

```json
{ "prompt": "dark ambient piano in D minor, slow, 8 bars", "seed": 7 }
{ "prompt": "静かな朝の lo-fi ピアノ, 30 秒", "output": "audio" }
{ "prompt": "epic cinematic strings, 3 minutes, 100 bpm" }
```

プロンプトから読み取れるもの:

| 種類 | 読み取る例 | 反映先 |
| --- | --- | --- |
| ジャンル | `ambient` `jazz` `cinematic` `lofi` `house` `funk` `boss` `8bit` | コード進行・リズム・友達の楽器 |
| 気分 | `sad` `dark` `epic` `calm` `romantic` `energetic` `tense` | スケール・テンポ・密度・テクスチャ |
| 楽器 | `piano` `strings` `guitar` `synth` `choir` `bass` `flute` | トラックごとの SoundFont プリセット |
| 拍と長さ | `90 bpm` `slow` `fast` `8 bars` `30 seconds` `3 minutes` `3分` | テンポと小節数 |
| キー | `D minor` `F# major` `Bbm` | キーとスケール |
| 打ち方 | `arpeggio` `staccato` `legato` `sparse` | アルペジオ／短音／疎な旋律 |
| ドラム | `with drums` `beat` `percussion` | GM ドラムトラック（`gm:128:0`） |

- 読み取り結果は戻り値の `plan`（例: `ballad / D minor / 72 BPM / 8 bars / sad`）と `cues` に出ます。**何理解为生成したか**がそのまま，可以用できます。
- 明示した引数（`style` `key` `scale` `tempo` `bars` `drums` `*Instrument`）はプロンプトより優先されます。
- 判定はローカル辞書のキーワード照合です。API キーもネットワークも使いません。読めない語は無視され、既定値（`pop` / `C major` / 設定のテンポ）へ落ちます。
- 生成物は通常の MSX スコアです。`text` を取り出して `generate_music` に渡せば、手で直せます。

### 長い曲（3 分くらい）

- 曲の長さは **小節数**（`bars`、1–256）で決めます。3 分なら 100 BPM で 75 小節、120 BPM で 90 小節です。
- プロンプトなら `3 minutes` / `3分` / `180 seconds` と書けば、テンポから小節数を計算します（`3 minutes, 100 bpm` のようにテンポも一緒に書けます）。
- 1 曲の上限は `music.maxSeconds`（既定 600 秒）と `music.maxNotes`（既定 8192 音符）です。3 分の曲では音符 800 前後・WAV 約 16 MB・生成に 10〜15 秒かかります。
- 3 分の曲を **プロンプト** で作ると、コード進行とリズムは 8〜16 小節単位のループが繰り返されます。完全に新しい旋律が 3 分分並ぶわけではありません。
- パネルでは 32 小節を超えると、編集しづらいグリッドの代わりに **スコアテキスト** に表示します。長さの入力欄は 1〜256 小節です。

### `transcribe_audio`

```json
{ "path": "recording.wav", "language": "ja" }
```

- `path`: 絶対パス、またはセッションの作業ディレクトリからの相対パス
- ハーネス内蔵エンジンは 16kHz モノラル WAV を受け付けます（パネルの録音・アップロードは自動変換）。MP3 等は `transcription.provider: openai` を使ってください。

### `generate_sfx`

ローカルの DSP で効果音を合成し、WAV に書き出します。**外部プロセスもモデルもネットワークも使いません**。35 種類を用意しています。

```
kind         whoosh / swoosh / impact / sub-drop / riser / downlifter / reverse-cymbal
             transition / click / pop / beep / notification / chime / bell / alarm
             laser / powerup / coin / magic / glitch / static / explosion
             footsteps / door / camera-shutter / typing / page-turn
             rain / wind / fire / water / crowd / horror-drone / heartbeat / engine
duration     0.05〜60 秒（種類ごとの自然な長さが既定）
intensity    0..1  音の強さとトランジェントの硬さ
brightness   0..1  スペクトルの中心（0 = 暗く重い / 1 = 明るく軽い）
seed         同じ seed と同じ入力からは常に同じ波形
variation    同系統の別テイク
loop         末尾と先頭をクロスフェードして継ぎ目を消す（環境音の既定）
```

設計は「音」ではなく「物理的な出来事」から起こしています。`whoosh` は帯域ノイズと中心周波数の移動、`impact` は低域サインの急降下とノイズの過渡と短い残響、`rain` は層になったノイズの上を水滴のトランジェントが走る音、という具合です。

書き出しは常に同じ仕上げを通ります: DC 除去 → ソフトクリップ → RMS を基準にした音量合わせ → ピーク -1 dBFS → 端のフェード。だから**クリックも直流成分も出ません**。計測値（ピーク / RMS / 概算 LUFS）は結果にそのまま返るので、複数の効果音の音量を揃える作業が数値でできます。

```
generate_sfx kind=whoosh intensity=0.8 brightness=0.7
generate_sfx kind=rain duration=6 loop=true
generate_sfx kind=impact seed=42
```

### `write_lyrics`

歌詞を書き、**書いた歌詞を機械で検証**します。モデルはハーネスの `llm`（既定はセッションのモデル）を使います。

```
brief              主題・感情・物語（必須）
language           ja | en | auto
genre              jpop / rock / ballad / rap / edm / folk / citypop / anison / metal / rnb
structure          jpop-standard / western-pop / aaba / rap-16 / edm-drop / ballad / 12-bar
                   または "Intro > Verse > Chorus" のような自由な並び
rhyme              none | loose | tight
syllablesPerLine   1 行のモーラ数（日本語）／音節数（英語）の予算
hook               サビで必ず落とす語句
bannedWords        追加で避けたい語
melody             メロディ骨子（MSX）も返す（既定 true）
```

検証は推測ではなく数え上げです。

- **モーラ数**: かなを数えます。小書きの `ゃゅょ` は前のモーラに付き、`っ` `ん` `ー` は各 1。日本語ではモデルに**読み仮名（YOMI）**を出させ、その読みを数えます。漢字 1 文字を 1 モーラと数えると必ず過少になるためです。読みが無い場合は概算であることを警告に明記します。
- **韻**: 日本語は行末 3 モーラの母音列、英語は末尾の音節。`tight` は完全一致、`loose` は母音の骨格一致。
- **フック**: サビの 1 行目にあるか、歌詞に存在するかを検査します。
- **陳腐語**: `永遠` `奇跡` `運命` `絆` などの既定リストを検出します。

出力は歌詞本文、行ごとのモーラ数・韻・読みの表、警告、そして `generate_music` にそのまま渡せる **MSX のメロディ骨子**（1 モーラ 1 音、I–V–vi–IV のベース付き）です。原稿は `<作業ディレクトリ>/media-studio/<名前>.lyrics.md` に保存されます。

```
write_lyrics brief="終電を逃した二人。言えなかったことをホームで初めて言う夜。" \
  genre=jpop structure="Verse 1 > Chorus" syllablesPerLine=9 hook="まだ帰らないで"
```

### `write_novel`

小説を書きます。モードは 4 つです。

| mode | すること |
| --- | --- |
| `outline` | 設定資料とビート表を **厳密な JSON** で作り、`.bible.json` として保存 |
| `draft` | ビート 1 つを章として書く |
| `continue` | 直前の文を読んで続きを書く |
| `revise` | 指定の文体・長さ・視点へ書き直す |

`outline` が返す JSON は `logline` / `theme` / `characters[]`（name・role・want・wound・secret・arc）/ `setting` / `timeline[]` / `beats[]` / `foreshadowing[]` です。保存した設定資料は次の章のプロンプトに注入されるので、**章をまたいでも人物と伏線が食い違いません**。

日本語の原稿は必ず組版を通します。行頭禁則（`、。」』` や小書きかなを行頭に置かず前行へぶら下げる）、`...` → `……`、`--` → `——`、`!?` の後の全角スペース、段落頭の全角 1 字下げ、連続空行の圧縮。**同じ文章に二度かけても結果は変わりません**。

出力は本文、文字数、読了時間、保存先、設定資料のパスです。

```
write_novel mode=outline brief="離島の灯台守が、灯りを消してはいけない理由を祖母の遺品から知る。" genre=mystery
write_novel mode=draft bible="media-studio/灯りを消す夜.bible.json" outline="第1章: 航海日誌を見つける" targetLength=900
```

### `write_article`

記事を書きます。モードは `brief` / `outline` / `draft` / `rewrite` / `seo`。形式は 10 種類で、**それぞれの業界の実際の作法**に従います（news = 逆ピラミッド、howto = 手順と前提、comparison = 判断基準と読者タイプ別の結論、press-release = データラインと引用、など）。

編集規則はプロンプトに明記しています。最初の 1 文で事実を言う（「現代では」で始めない）、1 段落 1 アイデア、**与えられた出典に無い数値・統計・引用を作らない**（必要な主張には `[要出典]` を付ける）、見出しは飾らず内容を書く。

`seo` は厳密な JSON を返します: タイトル案（**文字数付き**）、メタディスクリプション、スラッグ、見出し構成、FAQ、キーワード。日本語のメタディスクリプションは 120 字以内を狙います。

出力は本文（Markdown）、文字数、読了時間、`[要出典]` の件数、保存先です。

```
write_article mode=draft topic="効果音を自作してゲームに組み込む最短手順" format=howto targetLength=1200
write_article mode=seo topic="..." keywords=["効果音 自作","ゲーム 効果音"]
```

### 文章ツールのモデル

文章系はハーネスの `llm` サービスに書かせます。使うモデルは次の順で決まります。

1. `writing.provider` と `writing.model`（`cordis.patch.yml`）
2. セッションの既定モデル（`agentDefaultModel`）

どちらも無ければ、設定方法を書いた日本語のエラーで止まります。プロバイダが要求する `sessionId` は呼び出し元のセッションから引き継ぎます。

## クリエイティブ統合（v3）

オープンソースの制作ツールと繋がる 3 領域を追加しました。どれも **外部ソフトが入っていなくても動く**
ように作り、無いものは「ファイル書き出し」で対応します（Kdenlive / Shotcut / MuseScore / LMMS /
Hydrogen / Blender などが後から開ける形式で保存します）。

### 動画編集（NLE）— `edit_video` / `probe_video` / `export_timeline` / `make_subtitles`

生成ではなく **編集** です。タイムラインを 1 本の ffmpeg `filter_complex` に落として、1 回の
ffmpeg 起動で描画します。

- クリップの in/out トリム、連結、速度（0.25〜4 倍）、クロップ、回転、色調整
- トランジション 7 種（cut / fade / dissolve / wipeleft / wiperight / slideup / circleopen）
- ピクチャ・イン・ピクチャ（`position` + `scale` + `at`）
- テロップ（位置・色・背景・文字サイズ）。日本語は Meiryo で描画
- BGM ミックス（音量・フェードイン/アウト・声に合わせたダッキング）
- 字幕の焼き込み（`make_subtitles` が作った SRT/VTT をそのまま渡せる）
- 出力は mp4 / webm / gif

`export_timeline` は同じ編集を **編集ソフト向け** に書き出します。

| 形式 | 開けるソフト |
|---|---|
| `mlt` | Kdenlive / Shotcut |
| `otio` | DaVinci Resolve / OpenTimelineIO 対応ツール |
| `fcpxml` | Final Cut Pro / DaVinci Resolve |
| `edl` | 多くの NLE（CMX3600） |

タイムラインの形:

```json
{ "width": 1920, "height": 1080, "fps": 30,
  "tracks": [
    { "type": "video", "clips": [
      { "path": "a.mp4", "in": 0, "out": 3.5, "transition": "fade", "transitionDuration": 0.4,
        "text": { "value": "こんにちは", "position": "bottom" } } ] },
    { "type": "audio", "clips": [
      { "path": "bgm.wav", "in": 0, "out": 10, "volume": 0.3, "fadeIn": 1, "fadeOut": 1, "duck": true } ] }
  ],
  "subtitles": [ { "start": 0.5, "end": 2.0, "text": "最初の字幕" } ] }
```

### CAD — `cad_model` / `cad_drawing` / `cad_export`

Blender をヘッドレスで駆動するパラメトリック CAD です。単位は mm。

- 部品: box / cylinder / sphere / cone / torus / wedge / prism
- 演算: union / difference / intersect、mirror、array、穴あけ
- 出力: STL（binary, 3D プリント用）/ OBJ / GLB / PLY。`bbox` と三角形数を返す
- `cad_drawing`: 正面・上面・側面・アイソメの図（PNG）と DXF / SVG

Blender が無い環境でも、プリミティブだけなら **純 JS のメッシュ生成** で STL/OBJ を書けます
（boolean だけは Blender が必要です）。

### DTM — `daw_arrange` / `export_daw_project` / `import_midi`

マルチトラックの打ち込みとミックスです。音源は設定済みの SoundFont を使います。

- トラック: 音源（GM 番号・名前）/ ドラム（ch10）/ WAV 音声
- ミキサー: volume / pan / mute / solo / reverb / delay
- 曲: tempo / 拍子 / 小節 / キー
- 出力: WAV（44.1k ステレオ）、mp3、ogg

`export_daw_project` は同じ編曲を外部形式へ。**書いた直後に自分で読み戻して検証** します。

| 形式 | 開けるソフト |
|---|---|
| `mid` | すべての DAW（SMF type 1） |
| `musicxml` | MuseScore / Finale / Sibelius |
| `mmp` | LMMS |
| `h2song` | Hydrogen |

`import_midi` は既存の MIDI を読み、そのまま `daw_arrange` に渡せる編曲に戻します
（`export → import → 再 export` がバイト一致することもテストで確認しています）。

### 一発で呼ぶ

`media_create` の `hint` に `edit` / `cad` / `daw` を渡し、構造化引数を `args` に入れると、
上のツールへそのまま流れます。

```
media_create hint="edit" args={ "timeline": { ... } } prompt="この素材をつないで"
```

### テキストだけで使う（パネルは廃止予定）

パネルは廃止予定です。**パネルが無くても全部できます。** 詳しくは
[docs/TEXT-GUIDE.md](docs/TEXT-GUIDE.md) にあります。入口は 3 つです。

| 入口 | 何をする |
|---|---|
| ツール呼び出し | `studio_status` で何ができるか確認し、各ツールを呼ぶ |
| `media_create tool="…"` | 26 ツールを名前で直接呼ぶ（`args` で引数） |
| `render_project` | 手順を YAML / Markdown / JSON で書いて上から実行 |
| `node cli.mjs …` | DSH の外から同じツールを叩く |

- `studio_status` … できること・バックエンド（ffmpeg / ffprobe / Blender / Python / SoundFont）の
  生存とバージョン・providers・上限を返す。`checkBackends: false` で外部プロセスを起動しない。
- `render_project path="project.yaml"` … テキストのプロジェクトファイルを直列実行。
  `$id` で前のステップの成果物を参照（`$cover.path` / `{{cover.path}}`）。`dryRun` で確認だけ。
- `list_assets` / `asset_info` / `remove_asset` … 素材ライブラリをテキストで操作
  （`remove_asset` は `dryRun` あり）。
- `node cli.mjs status|tools|run|render|list|remove` … ターミナルから同じツール。

例は [docs/examples/](docs/examples/) にあります（映像・CAD・DTM・Markdown 埋め込み）。

パネルを消すときは `package.json` の `dsh.client` を外すだけです。ツールと CLI は
`/api/media-studio/*` のルートを経由しません（`tool.execute` を直接呼びます）。

## SoundFont（実録音楽器）

音楽のレンダリングは **SoundFont のみ**です。設定した `.sf2` を [spessasynth_core](https://github.com/spessasus/spessasynth_core)（Apache-2.0）でオフライン レンダリングします。内蔵の波形シンセは持ちません。

- 例: `{"score":"C4:1 E4:1 G4:1","instrument":"gm:0"}` → 実録音のグランドピアノ
- `gm:<bank>:<program>` でバリエーション音色も選べます（例 `gm:11:0` = Piano & Str.-Fade）
- 打ち込みグリッドの **楽器** セレクトには SoundFont の GM プリセットが並びます（ドラムキットは除外）。
- グリッドのクリック試聴だけは、32MB のバンクをブラウザへ読み込まないため Web Audio の簡易音で鳴らします（GM 音色ファミリーに近い声へ自動マップ）。実際の音は **生成** で確認してください。
- `soundfont.path` が空、またはファイルが無い場合、音楽生成はエラーになります（シンセへのフォールバックはありません）。

### 同梱しない理由と入手先

サウンドフォント本体はライセンスとサイズの都合でこのパッケージには含めていません。既定では
`C:\root\instrument-data\GeneralUser-GS.sf2` を参照します（詳細は
`C:\root\instrument-data\README.md`）。

- GeneralUser GS — 独自 License v2.0（音楽制作は私用・商用可、改変・再配布可）。作者の配布ファイルへの直リンクは禁止。
- VSCO 2 CE / VCSL — CC0。SFZ 形式のため本バージョンでは未使用（SF2 化すれば利用可能）。

## UI

- サイドバーの **メディアスタジオ** アイコンでパネルを開きます。
  - **画像**: 説明と比率を選んで生成し、プレビュー・ダウンロード。
  - **動画**: 説明（または動かす画像）、比率、長さ、フレームレート、モデル、シードを選んで生成し、その場で再生・ダウンロード。
  - **グラフィック**: **グラフ** / **画像加工** / **アニメーション**を切り替えます。グラフはデータ（CSV / TSV / JSON）を貼るだけ、画像はパスと幅・高さ・形式を指定するだけです。アニメーションはテンプレート（タイトルカード・ロワーサード・ロゴ・インフォグラフィック・背景映像・トランジション）を選んだら、テキストと秒数を決めて実行するだけです。プレビュー・ダウンロードできます。
  - **音声**: テキスト・声・速さを選んで生成し、その場で再生・ダウンロード。
  - **音楽**: DAW 風のステップグリッドで打ち込み、その場で再生・ダウンロード。**自動作曲**とテキスト（スコア文字列）入力にも切り替えられます。
  - **音声入力**: 録音（最大120秒）または音声ファイルを選び、文字起こし。結果はそのまま編集・コピーできます。
- コンポーザーのマイク（voice-input バンドル）は従来どおり、話した内容を下書きに直接挿入します。

### 音楽タブの打ち込み（グリッド）

- 縦軸が音高（2オクターブ、黒鍵は色分け）、横軸がステップです。セルを**クリックまたはドラッグ**して音符を置きます（もう一度クリックで削除）。
- **トラック**を複数持てます。トラックごとに名前と**SoundFont プリセット**を設定し、グリッドは選択中のトラックを編集します（● が編集中のトラック）。
- 音符を置くと**その音程がその場で鳴ります**（Web Audio で即時プレビュー、選択中のトラックの楽器の音色）。左の音名ラベルをクリックしても同じ音を確認できます。
- 同じ列に複数の音符を置くと**和音**になります。列をまたいで同じ音を置くと1つの長い音にまとめられます。
- コントロール: **音域**（C2–B3 〜 C5–B6）、**小節数**（1〜256）、**分解能**（1/4・1/8・1/16）、**楽器**、**テンポ**、**クリア**。
- **楽器**は SoundFont の GM プリセットから選びます（0 Grand Piano 〜 127 Gun Shot、バリエーション バンクも含む）。
- 生成した音声の再生中は、再生位置の列がハイライトされます。
- **テキスト**モードでは MSX スコア（`track melody` / `instrument gm:40` / `C4 0 1` の行形式）を直接編集できます。構文は [SCORE-FORMAT.md](./SCORE-FORMAT.md)。

### テキストモードと双方向切り替え

- **グリッド → テキスト**: 切り替えると現在のトラック構成がスコアテキストに変換されます。
- **テキスト → グリッド**: 切り替えるとテキストを解析してトラックに反映します。このとき、**分解能（1/4・1/8・1/16）と音域（2オクターブ）に合う最小構成へ自動調整**し、収まらない音は警告として表示します。
- つまりテキストが正本で、グリッドはその編集ビューです。他 AI にスコアテキストを書かせて貼り付け、グリッドで仕上げる、という使い方ができます。

### 音楽タブの自動作曲

- **スタイル**・**キー**・**スケール**・**シード**を選び、**自動作曲**を押すと、melody / harmony / bass の 3 トラックを生成してグリッドに流し込み、そのまま再生します。既存トラックは**名前が一致すればその楽器設定を保ったまま**埋められます。
- **別の案**を押すとシードを進めて別の曲を作ります。同じシードは常に同じ曲です。
- 生成された曲はスコアテキストとしても保持されるので、テキストモードに切り替えてそのまま編集・他 AI への引き渡しができます。

### 音楽タブのプロンプト生成

- 音楽タブ上部の **プロンプト** 欄に普通の言葉（例: `dark ambient piano in D minor, slow, 8 bars` / `静かな朝の lo-fi ピアノ, 30 秒`）を書いて **プロンプトから生成** を押すと、その内容대로曲が作られ、グリッドに流れます。
- 読み取った内容（ジャンル・気分・キー・テンポ・長さ・楽器）は生成直後に **解釈結果** として表示されます。意図と違えば語を変えるか、引数で直接指定してください。
- プロンプト解釈はローカル辞書の照合です。ネットワークや API キーは使いません。
- ドラムを求めた場合は GM ドラムトラック（`gm:128:0`）が加わります。ドラム音はグリッド（2オクターブ）には表示されませんが、音声には含まれます。
- 長さの指定は **小節数**（1〜256）でも、**プロンプトの長さ**（`3 minutes` / `3分`）でもできます。100 BPM で 75 小節が約 3 分です。
- 32 小節を超えると、編集しづらいグリッドの代わりに **スコアテキスト** に表示します（テキストが正本なので再生・編集はできます）。

## プライバシーと保存先

- 生成物はハーネスの添付サービス（設定されている場合）と `<cwd>/media-studio/` に保存されます。
- チャットの音声・動画プレイヤーは Host のメモリ上のキャッシュから配信するため、**ハーネス再起動後に古いターンの音声や動画は再生できません**（ファイル自体は残ります）。
- Pollinations はプロンプトを外部サービスへ送ります。完全ローカルにしたい場合は `image.provider` を OpenAI 互換のローカル画像サーバーへ向けてください。
- ローカル動画生成（`video.provider: local`）はプロンプトを外部へ送りません。ただし `svd` レシピでテキストだけを渡すと、**キーフレームのために画像生成が 1 回走ります**。その画像が外部を通るかどうかは `image.provider` の設定で決まります。
- **グラフ描画（`render_chart`）は完全にローカル**です。データもタイトルも外部へ送られず、Python がローカルに描画します。生成物は `<cwd>/media-studio/` に保存されます。
- **画像加工（`edit_image`）はローカル**です。ffmpeg が指定のファイルを読み書きします。パスはセッションの作業ディレクトリからの相対パスでも指定できます。
- **モーショングラフィックス（`make_motion_graphic`）は完全にローカル**です。1 フレームずつ Pillow が描き、ffmpeg が動画にまとめます。ナレーションを付けた場合も音声合成もこのマシン内で行われ、外部へ出ません。

## トラブルシューティング

- **「Windows の音声合成を利用できません」** — SAPI の声がありません。Windows の設定 → 時刻と言語 → 音声 で音声を追加するか、`speech.provider: openai` を使ってください。
- **音声入力が「準備中」のまま** — ローカルモデルのダウンロード中です。`transcription.provider: openai` にすると即時に切り替わります。
- **文字起こしで 415** — ハーネス内蔵エンジンは WAV のみです。パネルの録音・アップロードは自動で WAV に変換されます。
- **画像生成が 502** — Pollinations が混雑しているか、ネットワークが遮断されています。時間を置くか API プロバイダを設定してください。
- **動画生成が「ffmpeg が見つかりません」** — `video.ffmpegPath` に `ffmpeg.exe` のフルパス（このマシンでは `C:\ProgramData\ffmpeg.exe`）を指定してください。
- **動画生成が Python で失敗する** — `torch` と `diffusers` が入っている Python を `video.pythonPath` に指定してください。`python -c "import torch, diffusers"` で確認できます。
- **動画生成がタイムアウトする** — このマシンの GPU は遅いため、1024×576 / 25 ステップだと 30 分近くかかります。512×288 程度・ステップ 8〜10 に下げるか、`video.timeoutMs` を上げてください。
- **グラフが「Python が見つかりません」になる** — `Pillow` が入っている Python を `graphics.pythonPath` に指定してください（未指定なら `video.pythonPath` が使われます）。`python -c "import PIL"` で確認できます。
- **グラフの文字が化ける** — フォントは `C:\Windows\Fonts` から Meiryo → Yu Gothic → MS Gothic の順で探します。日本語フォントが無い環境では英文のフォントにフォールバックします。
- **グラフの系列がずれる** — `labels` の数と `series[].values` の数が揃っているか確認してください。揃っていない場合は短い系列を 0 で埋めます。

## 開発

```
cd C:\root\dsh-media-studio
node --test
```

`test/media.test.mjs` は純粋な変換ロジック、`test/music.test.mjs` は音名・スコア・自動作曲・WAV エンコード、`test/score.test.mjs` はスコアテキストの解析と整形、`test/soundfont.test.mjs` は SF2 の読み込みと実レンダリング、`test/video.test.mjs` は動画レシピの表・フレーム数計算・ffmpeg での実 MP4 書き出し、`test/graphics.test.mjs` はグラフのデータ読み取り（CSV / TSV / JSON）と実 PNG 描画・画像加工、`test/plugin.test.mjs` は Host の登録・経路・実際の SAPI 合成、`test/client.test.mjs` は Client のスロット登録とグリッド変換を検証します。SF2 が無い環境では SoundFont 系のテストは自動でスキップされます。

## ライセンス

MIT — `LICENSE` を参照してください。
