# メディアスタジオ v3.1 — テキストだけで全部やる（作業契約）

このファイルは v3.1 作業に参加する全員が最初に読む契約書です。
前提: **コンポーザー下のメディアパネルは廃止予定**。パネルに依存せず、テキスト
（チャットのツール呼び出し／テキストのプロジェクトファイル／CLI）だけで
スタジオの全機能に届くようにします。

v3 までの実装（`index.js` / `extra.js` / `nle.js` / `cad.js` / `daw.js` /
`midi.js` / `client.js` ほか）はそのまま残し、**テキスト側の穴を埋めます**。

---

## 1. 絶対に守る制約

1. **依存を増やさない。** `dependencies` は `spessasynth_core` だけ。YAML が必要なら
   **自前のサブセットパーサ**を書く（`js-yaml` 等は禁止）。
2. **`apply()` の中で外部 I/O を `await` しない。** ツール登録は同期。プロセス起動は
   `execute()` の中だけ。`spawn` はタイムアウト + kill 付き、`windowsHide: true`。
3. **書き込み先は担当ファイルだけ。** 下表の「所有ファイル」以外は編集しない。
   `index.js` / `frontdoor.js` / `tools-list.js` / `package.json` / `locale/*.json` /
   `README.md` / `cordis.patch.yml` / `client.js` / `nle.js` / `cad.js` / `daw.js` /
   `midi.js` は **Lead が所有**。触らない。
4. **循環 import を作らない。** 新モジュールは `index.js` を import しない。
   ツール名の一覧は `tools-list.js`（Lead が用意済み）から import する。
5. **ESM / Node 22+ / Windows。** `node:` プレフィックスの import のみ。
6. **ツール結果はロスレス JSON。** `undefined` を値として返さない（キーごと省く）。
7. **ツール `description` / `parameters[].description` は英語**、`output.render` の文言は日本語。

## 2. 所有ファイル

| 担当 | 所有ファイル |
|---|---|
| project-dev | `project.js`, `test/project.test.mjs`, `docs/v31-project.md` |
| status-dev | `status.js`, `test/status.test.mjs`, `docs/v31-status.md` |
| library-dev | `library.js`, `test/library.test.mjs`, `docs/v31-library.md` |
| lead | `index.js`, `frontdoor.js`, `tools-list.js`, `package.json`, `README.md`, `docs/TEXT-GUIDE.md`, `cli.mjs`, `cordis.patch.yml` |

## 3. 共通の道具

`tools-list.js`（作成済み）:

```js
import { STUDIO_TOOLS, STUDIO_TOOL_NAMES, STUDIO_GROUPS, studioTool, isStudioTool } from './tools-list.js';
```

- `STUDIO_TOOLS` … `{ name, group, summary }` の配列（26 個。`media_create` は含まない）
- `STUDIO_TOOL_NAMES` … 名前の Set
- `studioTool(name)` … 1 件、`isStudioTool(name)` … 真偽

ツールの登録関数は既存の型に合わせる:

```js
export function registerProjectTools(ctx, options, config, helpers) { /* ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`) */ }
```

`helpers` は `{ resolveSessionCwd, formatBytes, safeRelativeDir }`。
`ctx.get('tools').get(name)` で他のツールを取り出して実行できる（`execute(args, exec)`）。

## 4. 各モジュールの要件

### 4.1 `project.js` — テキストのプロジェクトファイルを実行する

**ツール `render_project`**

テキストで書いた制作手順を読み、上から順にツールを実行して成果物を返す。
これが「テキストベース」の中心。

引数:

- `path`（string, 任意）… プロジェクトファイルのパス（セッション相対 or 絶対）。
- `source`（string, 任意）… プロジェクトの中身を直接テキストで渡す（`path` より優先）。
- `dryRun`（boolean, 任意）… 実行せず、ステップと解決後の引数だけ返す。既定 false。
- `stopOnError`（boolean, 任意）… 既定 true。

`path` か `source` のどちらかが必須。

**プロジェクト形式**（`.yaml` / `.yml` / `.json` / `.md`）:

```yaml
version: 1
title: 夜のドライブ PV
steps:
  - id: cover
    tool: generate_image
    args:
      prompt: 夜の海沿いの道路、ネオン、シネマティック
      aspect: landscape
  - id: bgm
    tool: compose_music
    args:
      prompt: シティポップ、92 BPM
      seconds: 20
  - id: cut
    tool: edit_video
    args:
      timeline:
        tracks:
          - type: video
            clips:
              - path: $cover
                duration: 4
          - type: audio
            clips:
              - path: $bgm
                volume: 0.4
      name: night-drive
```

- ルートは `{ version, title, outputDir?, steps[] }`。`steps[].id` は省略可（`step1`…）。
- `steps[].tool` は `tools-list.js` の名前だけ許可（`isStudioTool`）。それ以外は明確なエラー。
- `steps[].args` はそのままツールに渡す。`args` 省略時は `{}`。
- **参照**: 文字列が `$<id>` なら、そのステップの結果の `path` に置き換える。
  `$<id>.path` / `$<id>.name` / `$<id>.attachmentId` / `$<id>.bytes` も可。
  文字列中に `{{<id>.path}}` のように埋め込むこともできる。
  まだ実行していない id を参照したらエラー。
- **Markdown**: 拡張子が `.md` / `.markdown` のときは、最初の ```` ```yaml ```` または
  ```` ```json ```` のフェンスブロックの中身をプロジェクトとして読む。
- **YAML**: 依存を足せないので **自前のサブセットパーサ**を `project.js` 内に書く。
  対応するもの: コメント `#`、`key: value`、インデントによる入れ子、`- item`、
  `- key: value`（マップのリスト）、クォート文字列（`'...'` / `"..."`）、
  数値・真偽値・null、フロー形式 `[a, b]` / `{k: v}`（1 階層で十分）、
  ブロックスカラー `|` と `>`。対応外の構文は行番号付きで明確にエラーにする。
  **`JSON.parse` を先に試し、失敗したら YAML サブセットで読む**（`.json` は JSON のみ）。
- 出力: `{ title, steps: [{ id, tool, ok, path?, bytes?, error? }], artifacts: [{ id, tool, path, bytes, mediaType }], failures, seconds }`。
  `render` は日本語で「N ステップ中 M 成功。成果物: …」のように要約し、各成果物のパスを並べる。
- 実行は**直列**。1 ステップの失敗で全体を止める（`stopOnError: false` なら続行し `failures` に積む）。
- 各ステップの `exec` は受け取った `exec` をそのまま渡す（セッションを引き継ぐ）。
- タイムアウトは 1800000。

### 4.2 `status.js` — 何ができるかをテキストで返す

**ツール `studio_status`**

引数: `verbose`（boolean, 任意）。`checkBackends`（boolean, 任意, 既定 true）。

返すもの:

- `tools` … 登録済みツールの `{ name, group, summary, required[] }`（`ctx.get('tools')` から
  実際の `parameters.required` を取る。未登録なら `tools-list.js` の summary だけ）。
- `backends` … `ffmpeg` / `ffprobe` / `blender` / `python` の有無とバージョン、
  SoundFont の有無とプリセット数（`options.soundfont.path`）。
  バージョンは `--version` の 1 行目だけ。**各 5 秒でタイムアウト**し、失敗しても落とさない。
- `providers` … `options.image.provider` / `video.provider` / `speech.provider` / `transcription.provider`。
- `limits` … `options` の上限値（`maxAudioBytes` など）と `outputDir`。
- `materials` … ライブラリの件数（`assets.js` の `listAssets` と `assetDirectory` を使う）。
- `render` は日本語の Markdown 風テキスト（「できること」「バックエンド」「上限」）。

**重要**: `checkBackends: false` のときは外部プロセスを一切起動しない（テストと
サンドボックス用）。`execute` の中だけで spawn する。

### 4.3 `library.js` — 素材ライブラリをテキストで操作する

**ツール `list_assets`** … 引数 `kind`（任意: image/audio/video/other）、`limit`（既定 20）。
`assets.js` の `listAssets` / `assetDirectory` を使い、`{ count, total, entries: [{ id, name, kind, bytes, modifiedAt }] }` を返す。

**ツール `remove_asset`** … 引数 `id`（必須）。`removeAsset` で消し、`{ id, removed }` を返す。
消せないときは明確なエラー（存在しない id）。

**ツール `asset_info`** … 引数 `id`（必須）。`readAsset` で `{ id, name, bytes, mediaType, path }` を返す
（パネルの素材プレビューの代わり。中身は返さずパスだけ）。

3 つとも `render` は日本語。

## 5. テスト

- 実行: `cd C:\root\dsh-media-studio; node --test`（`node --test test/` は Windows で失敗する）
- ベースライン: **334 tests / 334 pass**。減らさない。
- 外部バイナリに依存するテストは `ffmpeg` / `blender` の有無で skip 可能にする。ただし
  このマシンでは実際に走らせて通すこと（skip で逃げない）。
- 純関数（YAML サブセット、参照解決、ステップ正規化、ステータスの整形）は必ずテストする。
- `project.js` のテストは **実際に 2〜3 ステップのプロジェクトを実行**し、
  生成物のパスとサイズを確認する（例: `generate_sfx` → `edit_video`、`cad_model` → `cad_drawing`）。

## 6. 完了条件

- `node --test` が全 pass（334 + 追加分）。
- 各ツールを実際に 1 回実行した記録を `docs/v31-<area>.md` に残す（コマンド・出力・確認結果）。
- `node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp` が error 0。
- `docs/v31-<area>.md` に README / TEXT-GUIDE へ転記する短い日本語説明を含める。
