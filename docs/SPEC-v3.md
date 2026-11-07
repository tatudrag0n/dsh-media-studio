# メディアスタジオ v3 — クリエイティブ統合仕様（作業契約）

このファイルは v3 作業に参加する全員が最初に読む契約書です。
v2 までの実装（`index.js` / `extra.js` / `media.js` / `music.js` / `sfx.js` / `video.js` /
`motion.js` / `graphics.js` / `production.js` / `writing.js`）はそのまま残し、
**3 つの新しい制作領域を追加**します。

- `nle.js`  … 動画編集（NLE）。タイムライン編集とレンダリング、編集ソフト向け書き出し。
- `cad.js`  … CAD。パラメトリック 3D ソリッド、2D 図面、STL/OBJ/GLB/DXF/SVG 書き出し。
- `daw.js`  … DTM。マルチトラック編曲、ミキサー、MIDI/MusicXML/LMMS 入出力。

---

## 1. 絶対に守る制約

1. **依存を増やさない。** `package.json` の `dependencies` は `spessasynth_core` だけ。
   npm install が必要な実装は禁止。標準ライブラリと同梱の Python / ffmpeg / Blender だけで動かす。
2. **`apply()` の中で外部 I/O を `await` しない。** ツール登録は同期。プロセス起動は
   `execute()` の中だけで行う。`spawn` は必ずタイムアウトと kill を持つ。
3. **書き込み先は担当ファイルだけ。** 下表の「所有ファイル」以外は編集しない。
   `index.js` / `package.json` / `locale/*.json` / `README.md` / `cordis.patch.yml` /
   `client.js` / `frontdoor.js` / `intent.js` は **Lead が配線する**。触らない。
4. **循環 import を作らない。** 新モジュールは `index.js` を import しない。
   必要な小さな道具は引数（`helpers`）で受け取る。
5. **ESM / Node 22+ / Windows。** `node:` プレフィックスの import のみ。
   `child_process.spawn` は `windowsHide: true`、`shell: false` を基本とする。
6. **ツール結果はロスレス JSON。** `undefined` を値として返さない（キーごと省く）。
7. **日本語 UI。** ツールの `description` と `parameters[].description` は英語（既存に合わせる）。
   `output.render` が返すユーザー向け文言は日本語。

## 2. 所有ファイル（write scope）

| 担当 | 所有ファイル |
|---|---|
| nle-dev | `nle.js`, `test/nle.test.mjs`, `docs/v3-nle.md` |
| cad-dev | `cad.js`, `cad_blender.py`, `test/cad.test.mjs`, `docs/v3-cad.md` |
| daw-dev | `daw.js`, `midi.js`, `test/daw.test.mjs`, `docs/v3-daw.md` |
| lead | `index.js`, `package.json`, `cordis.patch.yml`, `locale/*.json`, `README.md`, `frontdoor.js`, `intent.js`, `client.js` |

## 3. このマシンで使えるバックエンド（実測済み）

| ツール | 状態 |
|---|---|
| `ffmpeg` / `ffprobe` | **あり** — ffmpeg 9.0.2 full build (gyan.dev), `C:\Users\tatud\AppData\Local\Microsoft\WindowsApps\ffmpeg.exe` |
| Blender | **あり** — 5.2, `C:\Users\tatud\AppData\Local\Programs\Blender Foundation\Blender 5.2\blender.exe` |
| Python | **あり** — 3.14.7, `C:\Users\tatud\AppData\Local\Programs\Python\Python314\python.exe` |
| Node | あり |
| FreeCAD / OpenSCAD / LMMS / MuseScore / Kdenlive / Shotcut / Ardour / Hydrogen / fluidsynth / sox / ImageMagick | **なし** |

→ 無いものは「書き出し（ファイル生成）」で対応する。インストールは求めない。
生成した `.mlt` / `.mid` / `.musicxml` / `.mmp` / `.h2song` は、ユーザーがそのソフトで開ける。
**実行時に外部ソフトが無くても動くこと**を必須条件にする（無い場合は ffmpeg / Blender /
同梱 SoundFont で完結する）。

## 4. ツール定義の形（既存 `productionTool` と同じ）

`index.js` の `productionTool` を必ず読んで形を合わせること。要点:

```js
function someTool(ctx, options, cache) {
  return {
    name: 'edit_video',                       // snake_case, 既存と重複しない
    description: ['...'].join(' '),           // 英語。何を/いつ使うか
    parameters: {                             // JSON Schema (object)
      type: 'object',
      additionalProperties: false,
      required: ['...'],
      properties: { /* ... */ },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: [...], properties: {...} },
      render(_args, value) {                  // 日本語のテキストブロック
        return [{ type: 'text', text: `...` }];
      },
      presentationMeta(_args, value) {        // { path } or { name }
        return value.path === undefined ? { name: value.name } : { path: value.path };
      },
    },
    timeoutMs: 1800000,
    isConcurrencySafe: () => true,
    async execute(args, exec) { /* 実処理 */ },
    presentCall(args) { /* 省略可 */ },
  };
}
```

登録は各モジュールが自分で行う。`index.js` から次の 1 関数だけ呼ぶ:

```js
export function registerNleTools(ctx, options, config, helpers) { /* ctx.effect(() => ctx.tools.register(tool), ...) */ }
export function registerCadTools(ctx, options, config, helpers) { /* ... */ }
export function registerDawTools(ctx, options, config, helpers) { /* ... */ }
```

- `ctx` … プラグインコンテキスト（`ctx.effect`, `ctx.tools.register`, `ctx.get`）
- `options` … 解決済みオプション（`options.outputDir`, `options.video.ffmpegPath`,
  `options.soundfont.path`, `options.assets.directory` など）
- `config` … 行設定の生オブジェクト。担当セクションは `config?.nle ?? {}` のように読む
- `helpers` … `{ resolveSessionCwd, formatBytes, safeRelativeDir }`
  - `resolveSessionCwd(ctx, exec)` → セッション作業ディレクトリ（絶対パス）
  - `formatBytes(n)` → `"1.2 MB"`
  - `safeRelativeDir(dir)` → セッション配下に閉じた相対ディレクトリ

出力ファイルは必ず **セッション作業ディレクトリ配下** `join(cwd, <outputDir>)` に書く
（`outputDir` 既定は `media-studio`）。返り値には `path`（cwd からの相対表示）と
`name`, `bytes`, `mediaType` を含める。

## 5. 各モジュールの要件

### 5.1 `nle.js` — 動画編集

ツール（最低限）:

1. `edit_video`
   - 入力: `timeline`（下記スキーマ）または `clips`（単純連結）+ `materials`/`paths`。
   - できること: クリップの in/out トリム、連結、速度変更、クロップ/スケール/回転、
     ピクチャ・イン・ピクチャ重ね、トランジション（cut / fade / dissolve / wipeleft /
     wiperight / slideup / circleopen）、テロップ（テキストオーバーレイ、位置/色/サイズ）、
     音声ミックス（BGM 音量、ダッキング、フェードイン/アウト）、字幕焼き込み（SRT/VTT）、
     色調整（brightness/contrast/saturation/gamma、LUT なしで可）。
   - 出力: mp4 / webm / gif、`width` `height` `fps`、`seconds`、`path`。
2. `probe_video` — `ffprobe -print_format json` の要約（duration, streams, fps, codec, bitrate, size）。
3. `export_timeline` — 同じタイムラインを **オープンソース編集ソフト向け**に書き出す。
   - `mlt` … Kdenlive / Shotcut が開ける MLT XML（`<mlt><producer/><playlist/><tractor/>`）
   - `otio` … OpenTimelineIO JSON（`.otio`）
   - `fcpxml` … FCPXML 1.9（Final Cut Pro / DaVinci Resolve）
   - `edl` … CMX3600 EDL
   - 出力はテキストファイル。**開ける形式であること**を XML/JSON としてパースして検証する。
4. `make_subtitles` — 音声/動画から SRT/VTT を組み立てる（`transcribe_audio` の結果や
   テキスト+タイミング指定から）。焼き込みは `edit_video` の `subtitles` で行う。

タイムライン JSON（この形を `edit_video` / `export_timeline` で共有）:

```json
{
  "width": 1920, "height": 1080, "fps": 30,
  "tracks": [
    { "type": "video", "clips": [ { "path": "a.mp4", "in": 0, "out": 3.5, "speed": 1,
      "transition": "fade", "transitionDuration": 0.5, "text": {"value":"...", "position":"bottom"},
      "crop": {"w":1280,"h":720,"x":320,"y":180}, "volume": 1 } ] },
    { "type": "audio", "clips": [ { "path": "bgm.wav", "in": 0, "out": 10, "volume": 0.3,
      "fadeIn": 1, "fadeOut": 1, "duck": true } ] }
  ],
  "subtitles": [ { "start": 0.5, "end": 2.0, "text": "..." } ]
}
```

実装方針: `filter_complex` を 1 本組み立てて ffmpeg を 1 回起動する（中間ファイルは
一時ディレクトリ、終了時に削除）。長時間素材でも破綻しないよう `-y -nostdin`、
`-loglevel error` を使う。

### 5.2 `cad.js` — CAD

Blender 5.2 をヘッドレスで駆動する（`blender -b --factory-startup --python <script> -- <args>`）。
`cad_blender.py` は Blender 側で走る Python。bpy で
プリミティブ生成 → boolean（union/difference/intersect）→ 変形（move/rotate/scale/array/mirror）
→ エクスポート（STL binary / OBJ / GLB / PLY）→ レンダー（PNG, 3 面図/アイソメ）を行う。

ツール（最低限）:

1. `cad_model` — パラメトリックにソリッドを作る。
   - 部品: `box` / `cylinder` / `sphere` / `cone` / `torus` / `wedge` / `prism`（多角柱）
   - 演算: `union` / `difference` / `intersect`
   - 変形: `translate` / `rotate` / `scale` / `mirror` / `array`（n 個, 方向, 間隔）
   - 穴あけ: `hole`（円柱 subtract のショートカット）
   - 出力: `stl`（binary, mm）/ `obj` / `glb` / `ply`。`bytes`, `triangles`, `bbox` を返す。
2. `cad_drawing` — 2D 図面。Blender の orthographic カメラで
   `front` / `top` / `right` / `iso` を PNG レンダー（線画寄りの設定: 白背景・Workbench・
   cavity）。加えて SVG（寸法線つき簡易図）を自前で書く（寸法は bbox から算出）。
3. `cad_export` — 既存モデル（`.blend` を持ち回すのではなく、`cad_model` の
   `parts` 仕様を再入力）から別形式へ変換。**同じ `parts` 仕様から決定的に再生成**する。

実装方針:
- Blender は起動が重い（数秒）。`timeoutMs` は 300000。失敗時は stderr の末尾 2KB を返す。
- Blender が無い環境では明確なエラー（`cad_model` は `stl`/`obj` を自前で書くフォールバックを持つと
  さらに良い。余力があれば **自前の三角形メッシュ生成**で box/cylinder/sphere を
  STL/OBJ に落とす純 JS 経路を入れる。boolean は Blender 必須）。
- 単位は **mm**。`bbox` を返して寸法を確認できるようにする。

### 5.3 `daw.js` + `midi.js` — DTM

`music.js` / `score.js` / `soundfont.js` は既にある（ノート列 → SoundFont で WAV 合成）。
v3 では **DAW 的な編曲・ミックス・外部形式入出力**を足す。

ツール（最低限）:

1. `daw_arrange` — マルチトラック編曲を 1 曲にレンダリングする。
   - トラック: `instrument`（GM program 番号 or 名前）/ `drums`（channel 10）/ `audio`（wav パス）
   - 各トラック: `volume`(0..2) / `pan`(-1..1) / `mute` / `solo` / `reverb` / `delay`
   - 曲全体: `tempo`, `timeSignature`, `bars`, `key`
   - 出力: WAV（ステレオ 44.1k）+ 任意で mp3/ogg（ffmpeg）
   - 既存の `music.js` の合成器を再利用する（重複実装しない）。
2. `export_daw_project` — 編曲を外部形式に書き出す。
   - `mid` … 標準 MIDI ファイル（SMF type 1, マルチトラック, テンポマップ, プログラムチェンジ, CC7/CC10）
   - `musicxml` … MusicXML 4.0（MuseScore が開ける。partwise）
   - `mmp` … LMMS プロジェクト XML
   - `h2song` … Hydrogen ドラムパターン
   - どの形式も **自分で書き出したものを自分で読み戻して検証**する（`midi.js` にパーサを持つ）。
3. `import_midi` — SMF を読み、ノート列 + テンポ + プログラムに分解して
   `daw_arrange` / `compose_music` に渡せる形で返す。

`midi.js` は純 JS の SMF 読み書き（variable-length quantity、running status、
tempo meta、program change、note on/off、CC）。**外部ライブラリ禁止。**

## 6. テスト（各担当が必ず書く）

- 実行: `cd C:\root\dsh-media-studio; node --test`（`node --test test/` は Windows で失敗するので使わない）
- ベースライン: 188 tests / 188 pass。**減らさない。**
- 各モジュールのテストは、外部バイナリが無い環境でも落ちないように
  `ffmpeg` / `blender` の有無を判定して skip 可能にする（`t.skip()`）。
  ただし **このマシンでは実際に走らせて通すこと**（skip で逃げない）。
- 純関数（タイムライン正規化、フィルタ生成、SMF エンコード/デコード、MLT 生成）は
  バイナリ不要で必ずテストする。

## 7. 完了条件

- `node --test` が全 pass（既存 188 + 追加分）。
- 各ツールを **実際に 1 回実行**し、生成物を `ffprobe` / パース / 再読み込みで検証した記録を
  `docs/v3-<area>.md` に残す（実行コマンド、出力サイズ、確認結果）。
- `node C:\root\tools\plugin-doctor\index.mjs C:\root\dsh-media-studio --mcp` が error 0。
- README 追記用の短い説明（日本語）を `docs/v3-<area>.md` に含める（Lead が README に転記）。
