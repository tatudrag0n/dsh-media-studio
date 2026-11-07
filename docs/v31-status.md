# `studio_status` — 何ができるかをテキストで返す

メディアパネル（コンポーザー下）が廃止されるため、パネルが「見せて」いた情報を
テキストで返すツール。パネルを見なくても、チャットの 1 往復で
「何ができるか」「どのバックエンドが生きているか」「上限はいくつか」が分かる。

- 実装: `status.js`
- ツール名: `studio_status`
- テスト: `test/status.test.mjs`（40 tests）
- 登録: `registerStatusTools(ctx, options, config, helpers)`（同期）

## 1. 返す内容

`execute()` の戻り値（ロスレス JSON。`undefined` のキーは持たない）:

| キー | 型 | 中身 |
|---|---|---|
| `checkedBackends` | boolean | 実際に外部プロセスを叩いたか（`checkBackends` の解決後） |
| `tools` | array | `{ name, group, summary, required[], registered }`。`verbose: true` のときだけ `description` と `parameters[{name,type,required,enum?}]` が付く |
| `backends` | array | `{ name, found, command, version?, error? }`。`ffmpeg` / `ffprobe` / `blender` / `python`。`checkBackends: false` のときは `[]` |
| `soundFont` | object | `{ path?, available, bytes?, presets?, error? }` |
| `providers` | object | `{ image, video, speech, transcription }` の provider 名 |
| `limits` | object | `outputDir`, `maxAudioBytes`, `maxSpeechText`, `maxImagePrompt`, `maxVideoPrompt`, `maxNegativePrompt`, `maxChartData`, `maxAssetBytes`（存在するものだけ） |
| `materials` | object | `{ total, byKind: { image: n, ... }, directory }` |
| `seconds` | number | 収集にかかった秒（小数 2 桁） |

`tools` の出どころは 2 つ:

- 名前・group・summary は `tools-list.js`（`STUDIO_TOOLS`）。ツールが未登録でも一覧から消えない。
- `required` は `ctx.get('tools').get(name).parameters.required`。登録済みなら実物、未登録なら `[]` で `registered: false`。

`output.render` は日本語の Markdown 風テキストを返す（節: できること / バックエンド /
プロバイダー / 上限 / 素材ライブラリ）。`verbose: false` ではツール一覧は
「名前 + 必須引数」だけ（1 行 1 ツール）。実測で 66 行 / 1,313 文字に収まった。

## 2. 引数

| 引数 | 型 | 既定 | 意味 |
|---|---|---|---|
| `verbose` | boolean | `false` | 各ツールの説明・全引数・enum を出す |
| `checkBackends` | boolean | `true` | `<backend> --version` を叩いて実体を確認し、SoundFont のプリセット数を読む。`false` は**外部プロセスを一切起動しない**（テストとサンドボックス用） |

`checkBackends: false` のとき `spawn` は呼ばれない。ファイル読み取り
（`listAssets` / `stat` / `soundFontAvailable`）だけが残り、SoundFont の
「有無」は分かるがプリセット数は分からない。

## 3. 実装上の約束

- 登録は同期。`spawn` は `execute()` の中だけ。
- 各バックエンドは 5 秒（`PROBE_TIMEOUT_MS`）でタイムアウトし、`SIGKILL` で止める。
  `windowsHide: true`, `shell: false`, `stdio: ['ignore','pipe','pipe']`。
- 失敗しても例外を投げず `{ found: false, error }` を返す（Blender が無くてもターンは失敗しない）。
- タイムアウト・`ENOENT`・非 0 終了・`run` 自体の throw をすべて握る。
- `config` に `ffmpegPath` / `ffprobePath` / `blenderPath` / `pythonPath` か
  `backends: { ffmpeg: '...' }` があれば、素の名前より先に試す（`video` / `editing` /
  `cad` / `audio` / `image` の各セクションも見る）。
- SoundFont のプリセット読みは 30 秒（`SOUNDFONT_TIMEOUT_MS`）で打ち切る。
  読めなくても `error` に理由を残して続行する。
- 依存追加なし（`node:child_process` / `node:fs/promises` と既存モジュールだけ）。

## 4. 純関数（テスト対象）

`bytesText` / `parseVersion` / `requiredOf` / `toolsRegistry` / `lookupTool` /
`describeTools` / `describeParameters` / `backendCommands` / `describeProviders` /
`describeLimits` / `describeMaterials` / `formatStatusText` / `runVersion` /
`probeBackends` / `collectStatus`。

`collectStatus({ ctx, options, config, args, deps })` は依存（`run`, `listAssets`,
`soundFontAvailable`, `soundFontPresets`, `fileSize`, `now`）を差し替えられる。
テストはここに「呼ばれたら throw する `run`」を渡して、
`checkBackends: false` が本当にプロセスを起動しないことを検証している。

## 5. 実測ログ（このマシン, 2025-11-04）

`checkBackends: true` で実際に実行した結果。

```js
// node -e "import('./status.js').then(async (m) => {
//   const s = await m.collectStatus({ options: { soundfont: { path: 'C:/root/instrument-data/GeneralUser-GS.sf2' }, ... }, args: {} });
//   console.log(JSON.stringify({ backends: s.backends, sf: s.soundFont, sec: s.seconds }));
// })"
{
  "backends": [
    { "name": "ffmpeg",  "found": true, "command": "ffmpeg",  "version": "ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers" },
    { "name": "ffprobe", "found": true, "command": "ffprobe", "version": "ffprobe version 9.0.2-full_build-www.gyan.dev Copyright (c) 2007-2026 the FFmpeg developers" },
    { "name": "blender", "found": true, "command": "blender", "version": "Blender 5.2.2 LTS" },
    { "name": "python",  "found": true, "command": "python",  "version": "Python 3.14.7" }
  ],
  "sf": {
    "available": true,
    "path": "C:/root/instrument-data/GeneralUser-GS.sf2",
    "bytes": 32319396,
    "presets": 287
  },
  "sec": 1.22
}
```

確認できたこと:

- ffmpeg / ffprobe ともに **9.0.2-full_build**（gyan.dev ビルド）が PATH 上にある。
- Blender は **5.2.2 LTS**（想定の "5.2" の実体）。
- Python は **3.14.7**（`python` で見つかった。`python3` フォールバックは未使用）。
- SoundFont `C:\root\instrument-data\GeneralUser-GS.sf2` は **32,319,396 bytes (30.8 MB)**、
  プリセット **287 個**。一覧読み込み込みで全体 1.22 秒。

同じ設定で `formatStatusText` が出したテキストの該当部分:

```text
## バックエンド
- ffmpeg: ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
- ffprobe: ffprobe version 9.0.2-full_build-www.gyan.dev Copyright (c) 2007-2026 the FFmpeg developers
- blender: Blender 5.2.2 LTS
- python: Python 3.14.7
- SoundFont: あり (287 プリセット, 30.8 MB) C:/root/instrument-data/GeneralUser-GS.sf2

## プロバイダー
- 画像: openai
- 動画: local
- 読み上げ: system
- 文字起こし: harness

## 上限
- 出力先: media-studio
- 音声ファイルの上限: 25.0 MB
- 読み上げの文字数: 2000 文字

## 素材ライブラリ
C:\Users\tatud\.dsh\media-studio\assets に 0 件
```

`node --test`（cwd = `C:\root\dsh-media-studio`）: **390 tests / 390 pass / 0 fail**
（ベースライン 334 から 56 件増。うち `test/status.test.mjs` が 40 件、
残りは他担当分）。`test/status.test.mjs` 単体は **40 tests / 40 pass**（0.32 秒）。
`node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp` は
**0 error(s) / 0 warning(s)**。

## 6. Lead が `index.js` に配線するために必要な情報

```js
// index.js の import 群
import { registerStatusTools } from './status.js';
```

既存の `registerExtraTools(ctx, options, audioCache, config, helpers)` と同じ場所
（`helpers` が定義された後）で、同期に 1 回呼ぶ:

```js
registerStatusTools(ctx, options, config, helpers);
```

- `ctx` / `options` / `config` / `helpers` は他モジュールと同一のものをそのまま渡す。
  `helpers` は現状 `status.js` では未使用（既存の呼び出し形に合わせているだけ）。
- 新しい config キーは**不要**。既存の
  `options.image.provider` / `video.provider` / `speech.provider` / `transcription.provider`、
  `options.soundfont.path`、`options.outputDir`、`options.max*`、`options.assets.maxBytes`
  をそのまま読む。
- 任意: `config.ffmpegPath`（または `config.video.ffmpegPath` など）で
  バックエンドの実体を上書きできる。未設定なら `ffmpeg` / `ffprobe` / `blender` / `python`。
- `tools-list.js` の `STUDIO_TOOLS` に `studio_status` が入っているので、
  `isStudioTool('studio_status')` は真、`render_project` のステップとして
  呼ぶこともできる（副作用なし）。
- ルート追加・`client.js` 変更は不要。パネル側の `/capabilities` はそのまま残る。

## 7. README / TEXT-GUIDE に載せる短い日本語説明

> **何ができるか** — `studio_status` を呼ぶと、その場で使えるツール一覧（必須引数つき）、
> 入っているバックエンド（ffmpeg / ffprobe / Blender / Python のバージョン）、
> SoundFont のプリセット数、画像・動画・音声のプロバイダー、文字数や容量の上限、
> 素材ライブラリの件数が日本語のテキストで返ります。パネルを開く必要はありません。
> `verbose: true` で引数の一覧と選択肢まで、`checkBackends: false` で
> 外部プロセスを起動せず設定だけで答えます。

## 8. 既知の制限

- `checkBackends: true` は 5 秒 × 最大 5 コマンド + SoundFont 読み込み（30 秒上限）だけ
  待つことがある。実測は 1.2 秒。
- SoundFont のプリセット数は `spessasynth_core` でバンクを実際にパースして数える。
  32 MB のバンクで数百 ms。極端に大きいバンクは 30 秒で打ち切り `error` を返す。
- `tools` の `required` は registry から取るため、ハーネス起動直後など
  ツール未登録のターンでは `[]` + `registered: false` になる（一覧自体は消えない）。
- バックエンドの「バージョン」は `--version` の 1 行目のみ（120 文字で切る）。
  Blender のビルド日時などは出さない。
- ffmpeg のフィルタ有無（`-filters`）や Blender のアドオン一覧までは見ない。
  パネルの `/capabilities` が返していた aspect / recipe / chart type の全量は、
  `verbose: true` の各ツール引数（enum）から読む形にしている。
