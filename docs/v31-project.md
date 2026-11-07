# v3.1 `render_project` — テキストのプロジェクトファイルを実行する

コンポーザー下のメディアパネルは廃止予定です。`render_project` はその代わりで、
**制作手順をテキストで書いて上から順に実行する**ためのツールです。手順書は YAML /
JSON / Markdown のどれでもよく、前の手順の成果物を次の手順から `$id` で参照できます。

- 実装: `project.js`（`registerProjectTools(ctx, options, config, helpers)`）
- ツール名: `render_project`
- テスト: `test/project.test.mjs`
- 依存追加なし（YAML は自前のサブセットパーサ）

---

## 1. プロジェクトの形

ルートは `{ version, title, outputDir?, steps[] }` です。`steps[].tool` は
`tools-list.js` にある名前だけ、`steps[].args` はそのツールの引数をそのまま書きます。

### YAML（いちばん普通の書き方）

```yaml
version: 1
title: 夜のドライブ PV
outputDir: media-studio/pv
steps:
  - id: chime
    tool: generate_sfx
    args:
      kind: chime
      duration: 1
      name: chime
  - id: bed
    tool: generate_sfx
    args:
      kind: rain
      duration: 2
      name: rain
  - id: cut
    tool: edit_video
    args:
      name: pv
      timeline:
        width: 320
        height: 180
        fps: 12
        tracks:
          - type: video
            clips:
              - path: poster.png
                duration: 1.5
          - type: audio
            clips:
              - path: $chime
                volume: 0.5
              - path: $bed
                volume: 0.2
                duck: true
```

### JSON

```json
{
  "version": 1,
  "title": "夜のドライブ PV",
  "steps": [
    { "id": "chime", "tool": "generate_sfx", "args": { "kind": "chime", "duration": 1 } },
    { "id": "cut", "tool": "edit_video", "args": { "name": "pv", "timeline": { "tracks": [] } } }
  ]
}
```

### Markdown（手順書として読める形）

`.md` / `.markdown` のときは、**最初の ```` ```yaml ```` か ```` ```json ```` のブロック**
がプロジェクトです。その前後の文章は無視されます。

````markdown
# 夜のドライブ PV の作り方

1. 効果音を作る
2. 映像に載せる

```yaml
version: 1
steps:
  - id: chime
    tool: generate_sfx
    args:
      kind: chime
  - id: cut
    tool: edit_video
    args:
      name: pv
      timeline:
        tracks:
          - type: video
            clips:
              - path: poster.png
          - type: audio
            clips:
              - path: $chime
```
````

`source` に直接プロジェクト本文を渡した場合、`.md` / `.json` / `.yaml` の判定は
できません。そのときは **JSON を先に試し、失敗したら YAML**、それでもだめなら
```` ```yaml ```` / ```` ```json ```` フェンスを探します。

---

## 2. 引数

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `path` | string | — | プロジェクトファイルのパス（セッション相対 or 絶対）。拡張子で読み方を決める |
| `source` | string | — | プロジェクトの中身を直接テキストで渡す。`path` より優先 |
| `dryRun` | boolean | `false` | 実行せず、手順と解決後の引数だけ返す。**ファイルは 1 つも作らない** |
| `stopOnError` | boolean | `true` | 最初の失敗で止める。`false` なら続行して `failures` に積む |

`path` か `source` のどちらかが必須です（両方なければエラー）。

### 戻り値

```js
{
  title: '夜のドライブ PV',
  dryRun: false,
  steps: [{ id, tool, ok, path?, bytes?, error? }],
  artifacts: [{ id, tool, path, bytes, mediaType, view? }],
  failures: [{ id, tool, error }],
  seconds: 3.3,
}
```

- `artifacts` は **作られたファイル 1 つにつき 1 件**。`cad_drawing` のように
  複数ファイル（front / top / iso）を返すツールは、その全件が入ります。
- `render` は日本語で「N ステップ中 M 成功。成果物: …」と要約し、成果物を
  `- <step id>: <path> (<サイズ>) [view]` で並べます。

```
3 ステップ中 3 成功。4.1 秒。
成果物:
- chime: media-studio/chime.wav (171.5 KB)
- bed: media-studio/rain.wav (343.1 KB)
- cut: media-studio/pv.mp4 (58.2 KB)
```

---

## 3. `$id` 参照の規則

引数の文字列の中で、前の手順の結果を参照できます。

| 書き方 | 置き換わるもの |
|---|---|
| `$id` | その手順の結果の `path`（セッション相対のことが多い） |
| `$id.path` | 同じもの（明示） |
| `$id.name` | 結果の `name`（ファイル名など） |
| `$id.bytes` | 結果の `bytes`（無ければ実ファイルのサイズ） |
| `$id.attachmentId` | 添付 id（音声などを Chat で再生するとき） |
| `$id.absPath` | 絶対パスに直したもの |
| `$id.<その他のキー>` | ツールが返した任意のフィールド |
| `{{id.path}}` | 長い文字列の中に埋め込む（`dir/{{id.name}}` など） |
| `$$…` | `$` 1 個のエスケープ（`$$5.00` → `$5.00`） |

規則:

1. **参照できるのは前の手順だけ。** 後ろの手順や存在しない id を指すと、実行前に
   エラーになります（`参照できるのは前の手順だけです` / `id「…」はこのプロジェクトにありません`）。
2. **`$id` は「1 つのパス」を返します。** `files` を返すツール（`cad_drawing` など）を
   `$id` で参照したときは **先頭のファイルの `path`**（`files[0].path`、ふつうは front）が
   返ります。2 件目以降を指したいときは `files` の中身を直接は参照できないので、
   そのツールの別の引数（`views` を 1 つに絞るなど）を使ってください。
3. 結果に `path` が無い手順（`list_media` のような一覧系）を `$id` で参照すると、
   エラーに「ある値: …」として実際のキーを並べます。`$id.<キー>` で指定してください。
4. `dryRun` では参照は解決されず、`$id` のまま表示されます（型チェックも緩めます）。
   ただし参照先が存在するか・前の手順かどうかは、実行前と同じように検査します。

---

## 4. 対応する YAML 構文 / 非対応の構文

### 対応

- コメント `#`（行頭・値の後ろ）、空行
- `key: value`、インデントによる入れ子
- `- item`、`- key: value`、`- { … }` / `- [ … ]`（**リスト項目のフロー形式**）
- クォート文字列 `'...'` / `"..."`（`\n` `\t` `\uXXXX` などのエスケープ込み）
- 数値・真偽値（`true` / `false`）・`null` / `~`
- フロー形式 `[a, b]` / `{k: v}`。**1 行でも複数行でも可**（下記）
- ブロックスカラー `|`（改行そのまま）と `>`（折り返し）。`|-` `|+` `>-` `>+` などの
  チョーミング指定と `|2` のインデント指定も可
- 先頭に 1 回だけ `---`（文書開始マーカー）

複数行のフロー形式は、継続行が「親より深いインデント」であればつなげます:

```yaml
notes:
  - { start: 0, duration: 2,
      pitches: [A4] }
```

### 非対応（行番号付きでエラーになります）

| 書き方 | エラー |
|---|---|
| タブをインデントに使う | `N 行目: タブはインデントに使えません。` |
| アンカー `&x` / エイリアス `*x` / タグ `!tag` | `N 行目: 対応外の構文です。アンカー（&）…` |
| 複合キー `? key` | `N 行目: 対応外の構文です。複合キー…` |
| `a:1`（コロンの後に空白が無い） | `N 行目: 「key: 値」の形になっていません。` |
| 同じキーの重複 | `N 行目: キー「a」が 1 行目と重複しています。` |
| 値の中の `: `（`a: b: c`） | `N 行目: 値の中に「: 」があります。引用符…` |
| 複数行にまたがるクォート文字列 | `N 行目: 対応外の構文です。引用符が閉じられていません…` |
| 複数行にまたがるプレーンな値 | `N 行目: 対応外の構文です。値を次の行に続ける書き方はできません…` |
| キーと同じ深さのリスト（`a:` の次に同じインデントで `- `） | `N 行目: 対応外の構文です。リストはキーより深くインデントしてください。` |
| 1 行に 2 つ以上の `- `（`- - a`） | `N 行目: 対応外の構文です。1 行に 2 つ以上の「- 」…` |
| 文書終端 `...` / 2 個目の `---` | `N 行目: 対応外の構文です。文書終端「...」…` |
| 閉じないフロー形式 | `N 行目: 対応外のフロー形式です。] か } が足りません…` |
| 同じ深さに `key: 値` と `- ` が混在 | `N 行目: 同じ位置に「- 」と「key: 値」が混ざっています。` |

方針は「黙って誤読するくらいなら、行番号付きで断る」。とくにリストをキーと同じ
深さに書くスタイル（YAML としては合法）は、対応していないことを明示して止めます。

### プロジェクト全体の検査

YAML を読んだあと、`normalizeProject` が次を検査します。

- ルートのキーは `version` / `title` / `outputDir` / `steps` だけ。綴り違いはエラー
- `version` は `1` のみ
- `outputDir` はセッション内の相対パス（絶対パス・`..` はエラー）
- `steps` は 1 件以上、既定の上限 64 件（`config.project.maxSteps` で変更可）
- 各手順のキーは `id` / `tool` / `args` だけ。`id` は省略時 `step1`…、重複不可、
  使える文字は英数字と `_` `-`（`$` 参照の名前になるため `.` は不可）
- `tool` は `tools-list.js` の名前だけ（`render_project` 自身は呼べません）
- `args` は省略時 `{}`（リストは不可）
- 参照先の id が存在し、かつ前の手順であること

実行前には、解決後の引数を **そのツールの `parameters`（JSON Schema）** と突き合わせます。
必須キーの欠落、型違い、`enum` 外、`minItems` / `maxItems`、`additionalProperties: false`
のときの余分なキーを、`args.timeline.tracks[0].type` のようなパス付きで報告します。
対応していないスキーマ語（`oneOf` など）は判定せずに飛ばします。

### その他の挙動

- 実行は**直列**。各ステップには受け取った `exec` をそのまま渡します（セッションを引き継ぐ）。
- `outputDir` をプロジェクトに書くと、そのツールが `outputDir` 引数を持つ場合だけ
  既定値として注入されます（`generate_sfx` のような持たないツールには効きません）。
- ツールの `timeoutMs` は既定 1800000（30 分）。`config.project.timeoutMs` で変更可。

---

## 5. 実測検証ログ

環境: Windows / Node 22 / ffmpeg 9.0.2 / Python 3.14 /
SoundFont `C:\root\instrument-data\GeneralUser-GS.sf2`。

### 5.1 CAD の 2 ステップ（複数ファイルを返す例）

```console
$ cd C:\root\dsh-media-studio
$ node cli.mjs render C:\root\dsh-media-studio\docs\examples\cad-bracket.yaml
2 ステップ中 2 成功。3.3 秒。
成果物:
- part: media-studio/bracket-20261104-210701-f7ec.stl (38.9 KB)
- drawing: media-studio/bracket-drawing-20261104-210703-32fd-front.png (539.3 KB) [front]
- drawing: media-studio/bracket-drawing-20261104-210703-32fd-top.png (1.1 MB) [top]
- drawing: media-studio/bracket-drawing-20261104-210703-32fd-iso.png (881.8 KB) [iso]
```

`cad_drawing` は `path`（front）と `files`（front / top / iso）の両方を返します。
`files` を全件 artifacts に入れ、`path` と重複する front は 1 件にまとめています
（4 件 = stl 1 + png 3）。`C:\root\media-studio` に実ファイルがあることも確認済み。

### 5.2 音楽の 2 ステップ（`docs/examples/song.yaml`）

```console
$ node cli.mjs render C:\root\dsh-media-studio\docs\examples\song.yaml
1 ステップ中 0 成功。0.0 秒。
成果物: なし
失敗:
- mix（daw_arrange）: SoundFont が見つかりません: (未設定)。…
```

パースと参照解決は通っています（1 ステップとして読めている）。止まっているのは
**cli.mjs が `apply(context, {})` で行設定を渡さない**ため、`soundfont.path` が
空になるからです。実際の行設定（`C:\root\instrument-data\GeneralUser-GS.sf2`）を
渡すと通ります:

```js
plugin.apply(ctx, { soundfont: { path: 'C:/root/instrument-data/GeneralUser-GS.sf2' } });
// → 2 ステップ中 2 成功。0.4 秒。
//    - mix: media-studio\sketch.wav (1.0 MB)
//    - midi: media-studio\sketch.mid (112 B)
```

`song.yaml` は `- { start: 0, duration: 4, pitches: [A2] }` という**リスト項目の
フロー形式**を使っているので、この形が読めることが前提です（§4 で対応済み）。

### 5.3 3 ステップの実ファイル実行（テスト内）

`test/project.test.mjs` の「runs a three step project for real and leaves the files
on disk」が、一時セッションで実際に実行します。

```
generate_sfx(kind: chime) → $chime
generate_sfx(kind: rain)  → $bed
edit_video(timeline: $chime + $bed + poster.png) → pv.mp4
```

結果: 3 ステップ中 3 成功、artifacts 3 件。

```
- chime: media-studio/chime.wav (audio/wav)
- bed:   media-studio/rain.wav  (audio/wav)
- cut:   media-studio/pv.mp4    (video/mp4, > 1 KB)
```

`fs.stat` で実ファイルのサイズと `artifacts[].bytes` が一致すること、
`pv.mp4` が 0 バイトでないことを検証しています。

`dryRun` の検証は同ファイルの「creates nothing at all on a dry run」で、実行前後
の**ファイル数が変わらないこと**（再帰カウント）を確認しています。

### 5.4 テストと静的検査

```console
$ cd C:\root\dsh-media-studio
$ node --test
# tests 483
# pass 483
# fail 0

$ node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp
dsh-media-studio: 0 error(s), 0 warning(s), 0 note(s)
```

`test/project.test.mjs` 単体では 93 tests / 93 pass（外部バイナリが無い環境では
実ファイル実行の 1 件だけ自動 skip。このマシンでは skip 0）。

---

## 6. README / TEXT-GUIDE に載せる短い説明

> **プロジェクトを実行する（`render_project`）**
> 作り方をテキストで書いておけば、上から順に実行して成果物をまとめて返します。
> ファイルは YAML・JSON・Markdown のコードブロックのどれでも。手順は
> `- id: 名前` / `tool: ツール名` / `args: { … }` の 3 行で、前の手順のファイルは
> `$名前`（`{{名前.path}}` で文字列に埋め込み）で渡せます。
> `dryRun: true` なら何も作らず、手順と引数だけ確認できます。
> 例: `render_project: { path: "docs/recipe.yaml" }` /
> `render_project: { source: "steps:\n  - tool: generate_sfx\n    args:\n      kind: click" }`

> **`dryRun` で下見する**
> `dryRun: true` を付けると、実行せずに「どのツールにどの引数が渡るか」を返します。
> ファイルは 1 つも作られません。`$id` は `$id` のまま表示されるので、
> 参照のつもりで書いた文字列がそのままツールに渡らないか確認できます。

> **失敗したとき**
> 既定（`stopOnError: true`）は最初の失敗で止まり、`failures` に理由が入ります。
> `stopOnError: false` にすると最後まで走り、成功した成果物と失敗の一覧を両方返します。

---

## 7. 既知の制限

- リストをキーと同じ深さに書く YAML（合法）は非対応。深くインデントしてください。
- 複数行にまたがるプレーンな値・クォート文字列は非対応（`|` / `>` を使ってください）。
- YAML 1.1 の `yes` / `no` / `on` / `off` は真偽値にしません（文字列になります）。
  `true` / `false` を使ってください。
- `files` を返すステップを `$id.<n>` のように「2 件目のファイル」で参照する書き方は
  ありません（`$id` は先頭ファイル）。必要になったら `$id.files` を配列として
  参照できるよう拡張する余地があります。
- `outputDir` の注入は、そのツールが `outputDir` 引数を持つ場合だけ。
