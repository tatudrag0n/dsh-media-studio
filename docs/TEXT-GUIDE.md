# テキストだけでメディアスタジオを使う

コンポーザー下のメディアパネルは廃止予定です。このプラグインは **パネルが無くても
全部できます**。入口は 3 つだけで、どれもテキストです。

| 入口 | 何をする | 使いどころ |
|---|---|---|
| チャットのツール呼び出し | モデルが 1 文から適切なツールを選ぶ | ふだんの制作 |
| **テキストのプロジェクトファイル** | 手順を YAML / Markdown / JSON で書いて上から実行 | 何ステップも連なる制作、再利用、レビュー |
| **CLI** (`node cli.mjs`) | DSH の外から同じツールを叩く | スクリプト、cron、ターミナル作業 |

## 1. まず何ができるか確認する

```
studio_status
```

返ってくるもの:

- **できること** … 登録済みのツール名と必須引数
- **バックエンド** … ffmpeg / ffprobe / Blender / Python の有無とバージョン、SoundFont のプリセット数
- **providers** … 画像・動画・音声合成・文字起こしのどこに繋がっているか
- **上限** … 出力先、音声/動画の上限サイズなど

CLI からは `node cli.mjs status`。`checkBackends: false` を渡すと外部プロセスを起動せず、
設定だけを返します（サンドボックスや CI 用）。

## 2. 1 つのツールで全部やる（`media_create`）

`media_create` は「1 文 → 何か」の入口ですが、**ツール名を直接指定**できます。
これで 26 個のツールすべてに同じ入口から届きます。

```
media_create tool="cad_model" args={"parts":[{"type":"box","size":[40,20,10]},{"type":"hole","diameter":8}],"format":"stl"}
```

```
media_create tool="probe_video" args={"path":"media-studio/clip.mp4"}
```

- `tool` に知らない名前を渡すと、黙って別のものを作らずにエラーになります
  （`studio_status` で名前を確認してください）。
- `prompt` は不要です。`args` はそのツールの JSON Schema で filter されます。

## 3. プロジェクトファイル（本命）

手順をテキストで書いて、上から順に実行します。**これがパネルの代わり**です。

```
render_project path="docs/examples/video-cut.yaml"
```

### 3.1 いちばん短い例

```yaml
version: 1
title: 効果音つきのカット
steps:
  - id: sfx
    tool: generate_sfx
    args:
      kind: whoosh
      duration: 1.5
  - id: cut
    tool: edit_video
    args:
      clips:
        - path: media-studio/demo/title.mp4
          in: 0
          out: 3
      name: with-whoosh
```

### 3.2 前のステップの成果物を使う（`$id`）

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
      bars: 8
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

- `$cover` … そのステップの結果の `path`
- `$cover.path` / `$cover.name` / `$cover.attachmentId` / `$cover.bytes` … 個別のフィールド
- `{{cover.path}}` … 文字列の中に埋め込む

まだ実行していない id を参照するとエラーになります（黙って空文字にしない）。

### 3.3 CAD の例

```yaml
version: 1
title: 穴あきブラケット
steps:
  - id: part
    tool: cad_model
    args:
      parts:
        - type: box
          size: [100, 60, 6]
        - type: hole
          diameter: 10
          position: [30, 20, 0]
        - type: hole
          diameter: 10
          position: [-30, 20, 0]
      format: stl
      name: bracket
  - id: drawing
    tool: cad_drawing
    args:
      parts:
        - type: box
          size: [100, 60, 6]
        - type: hole
          diameter: 10
          position: [30, 20, 0]
      views: [front, top, iso]
      format: png
      name: bracket-drawing
```

### 3.4 DTM の例

```yaml
version: 1
title: 2 小節のスケッチ
steps:
  - id: mix
    tool: daw_arrange
    args:
      arrangement:
        tempo: 96
        timeSignature: [4, 4]
        bars: 2
        tracks:
          - name: melody
            instrument: strings
            notes:
              - { start: 0, duration: 2, pitches: [A4] }
              - { start: 2, duration: 2, pitches: [C5, E5] }
          - name: drums
            drums: true
            notes:
              - { start: 0, duration: 0.25, pitches: [C2] }
      name: sketch
  - id: midi
    tool: export_daw_project
    args:
      format: mid
      name: sketch
      arrangement:
        tempo: 96
        bars: 2
        tracks:
          - name: melody
            instrument: strings
            notes:
              - { start: 0, duration: 2, pitches: [A4] }
```

### 3.5 Markdown に埋め込む

`.md` ファイルなら、最初の ```` ```yaml ```` か ```` ```json ```` のフェンスブロックを
プロジェクトとして読みます。手順書と一緒に管理できます。

````markdown
# 夜のドライブ PV の作り方

1. カバー画像を生成
2. BGM を作る
3. 2 つを合わせる

```yaml
version: 1
steps:
  - id: cover
    tool: generate_image
    args: { prompt: 夜の海沿いの道路、ネオン }
```
````

### 3.6 実行前に確認する

```
render_project path="night-drive.yaml" dryRun=true
```

何も作らず、各ステップの解決後の引数だけを返します。**大きなレンダリングの前に必ず一度**。

### 3.7 途中で失敗したとき

既定は `stopOnError: true` で、失敗したステップで止まり、`failures` に件数が入ります。
`stopOnError: false` にすると続行し、失敗したステップだけ `error` に残ります。

## 4. 素材ライブラリ（パネルの素材タブの代わり）

| やりたいこと | テキスト |
|---|---|
| 一覧する | `list_assets` / `node cli.mjs list` |
| 画像だけ | `list_assets kind="image"` / `node cli.mjs list --kind image` |
| 1 件の情報 | `asset_info id="…"` |
| 取り込む | `attach_material path="C:\pictures\a.png"` |
| 消す | `remove_asset id="…"` |
| 消す前に確認 | `remove_asset id="…" dryRun=true` |

`remove_asset` は取り返しがつかないので、`dryRun` を用意しています。

## 5. CLI

```
node cli.mjs help
node cli.mjs status
node cli.mjs tools
node cli.mjs run probe_video --args '{"path":"media-studio/a.mp4"}'
node cli.mjs run cad_model --args @parts.json --dir C:\work
node cli.mjs render docs/examples/video-cut.yaml
node cli.mjs render docs/examples/video-cut.yaml --dry-run
node cli.mjs list --kind image
node cli.mjs remove <asset-id> --dry-run
```

- `--args` は JSON。`@ファイル` でファイルから読めます。
- `--dir` で作業ディレクトリを変えられます（既定はカレント）。
- `--json` で機械可読な JSON も一緒に出します。
- `--config <file.json>` で行設定を明示できます。省略すると、同梱の
  `cordis.patch.yml` と `~/.dsh/profiles/*/cordis.patch.yml` から
  SoundFont / ffmpeg / Blender のパスを拾います（DSH と同じ値を使う）。
  環境変数 `MEDIA_STUDIO_CONFIG` に JSON を入れても渡せます。
- 終了コードは 0 = 成功、1 = 失敗。

## 6. パネルを消すときの手順

パネルは `client.js`（`dsh.client`）です。廃止するときは次の 2 つだけ:

1. `package.json` から `"dsh": { "client": ... }` を外す（パネルが出なくなる）
2. 使わなくなった `/api/media-studio/*` のルートを `index.js` から外す

**ツールと CLI はこれらに依存していません。** ルートを全部外しても
`studio_status` / `render_project` / CLI は動きます（テストで確認しています）。

## 7. 困ったとき

| 症状 | 原因と直し方 |
|---|---|
| `render_project` が「ツールがスタジオのものではない」 | `steps[].tool` の名前違い。`studio_status` か `node cli.mjs tools` で確認 |
| `$id` で「まだ実行していない」 | 参照先のステップを上に移す（実行は上から順） |
| YAML のエラー | 行番号付きで出ます。対応外の構文（アンカー `&`、複数ドキュメント `---` など）は使えません。JSON で書くのも手 |
| ffmpeg / Blender が見つからない | `studio_status` の `backends` を見る。`config.nle.ffmpegPath` / `config.cad.blenderPath` で指定できます |
| SoundFont が無い | DTM の音源トラックは SoundFont 必須。`config.soundfont.path` に `.sf2` を置く |
