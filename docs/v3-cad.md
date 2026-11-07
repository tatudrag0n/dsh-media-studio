# v3 `cad.js` — Blender バックエンドのパラメトリック CAD

このファイルは `docs/SPEC-v3.md` 5.2 の実装記録です。実装は `cad.js`（ホスト側）と
`cad_blender.py`（Blender 内で走る Python）の 2 枚構成です。

- 追加ツール: `cad_model` / `cad_drawing` / `cad_export`
- 登録関数: `export function registerCadTools(ctx, options, config, helpers)`
- 単位: **mm**。すべてのプリミティブは自分の `position` を中心に作られます。
- 出力先: セッション作業ディレクトリ配下 `join(cwd, outputDir)`（既定 `media-studio`）。
- 依存追加: なし（`package.json` は未変更）。Node の標準ライブラリ + Blender だけ。

---

## 1. できること

### ソリッド（`cad_model`）

パーツ列を順に合成して 1 つのソリッドを作り、メッシュに書き出します。

| 区分 | 内容 |
|---|---|
| プリミティブ | `box` / `cylinder` / `sphere` / `cone` / `torus` / `wedge`（ランプ）/ `prism`（多角柱） |
| ブーリアン | `union`（既定）/ `difference` / `intersect`。パーツ順に適用 |
| 変形 | `position`（中心, mm）/ `rotation`（XYZ オイラー, 度）/ `scale` / `mirror`（x・y・z 面で反転コピー追加） |
| 繰り返し | `array`（`count` + `offset` もしくは `direction` + `spacing`） |
| 穴あけ | `type: "hole"`（円柱 subtract のショートカット。`depth` 省略で板を貫通） |
| 書き出し | `stl`（バイナリ, mm）/ `obj` / `glb` / `ply` |
| 返り値 | `triangles` / `vertices` / `bbox`（x・y・z の min・max・size, `size` 配列, `center`）/ `bytes` / `path` |

### 図面（`cad_drawing`）

| 区分 | 内容 |
|---|---|
| PNG | Blender の正投影カメラで `front` / `top` / `right` / `iso` をレンダー（既定 4 面） |
| 描画エンジン | `workbench`（既定, 白背景 + キャビティ陰影 + 輪郭線）/ `freestyle`（白背景 + 黒線画） |
| SVG | **純 JS で自前生成**。正面図・平面図・右側面図 + 寸法線 + 表題欄（図名・単位・尺度・外形・パーツ数・三角形数・日付） |
| 寸法 | 各ビューの外形（bbox）から自動算出。数値は mm |
| 隠れ線 | 穴（difference 形状）は破線。**外形の内側にクリップ**して描く |

SVG は Blender 無しでも生成できます（`format: "svg"`）。PNG だけが Blender 必須です。

### 書き出し（`cad_export`）

`parts` 仕様から**決定的に再生成**します（`.blend` のような持ち回る状態はありません）。

| 形式 | バックエンド | 備考 |
|---|---|---|
| `stl` / `obj` | JS（union のみ）/ Blender（ブーリアンあり） | バイナリ STL、座標は mm |
| `glb` / `ply` | Blender | glTF 2.0 GLB / binary PLY |
| `dxf` | 純 JS | R12 ASCII、1 単位 = 1 mm（`$INSUNITS` = 4）、レイヤー `OUTLINE` / `HIDDEN` / `DIM` / `TEXT` |
| `svg` | 純 JS | `cad_drawing` と同じ図面 |

### バックエンドの選び方

```
parts に difference / intersect / hole がある?  → Blender 必須
format が glb / ply?                          → Blender 必須
それ以外（union だけの stl / obj）             → Node だけで書き出せる
dxf / svg                                     → 常に Node だけ
```

Blender が見つからないときのエラー文（実測）:

```
ブーリアン演算（difference / intersect / hole）と GLB / PLY の書き出しには Blender が必要です。
Blender が見つかりませんでした。cordis.patch.yml の cad.blenderPath か環境変数 BLENDER_PATH に
blender.exe のフルパスを指定してください。 Boolean operations and GLB / PLY export need Blender;
a plain union of primitives can be written as STL or OBJ without it.
```

---

## 2. ツール引数

### `cad_model`

```jsonc
{
  "parts": [ /* パーツ仕様（下記） */ ],   // 必須, 1..256
  "format": "stl",                        // stl | obj | glb | ply（既定 stl）
  "name": "plate"                         // ファイル名の語幹（既定 cad）
}
```

返り値: `name` / `path` / `bytes` / `mediaType` / `format` / `triangles` / `vertices` /
`parts` / `backend`（`javascript` | `blender`）/ `bbox`。

### `cad_drawing`

```jsonc
{
  "parts": [ /* パーツ仕様 */ ],           // 必須
  "views": ["front", "top", "right", "iso"], // 既定は 4 面すべて
  "format": "both",                       // png | svg | both（既定 both）
  "width": 1600,                          // 既定は config の cad.width
  "height": 1200,                         // 既定は config の cad.height
  "engine": "workbench",                  // workbench | freestyle
  "title": "穴あき板 100×60×6",            // 表題欄の図名
  "name": "drawing"                       // ファイル名の語幹
}
```

返り値: `files[]`（各要素 `name` / `path` / `bytes` / `mediaType` / `view`）/ `bbox` /
`triangles` / `vertices` / `parts` / `backend`。`name` / `path` / `bytes` / `mediaType` は
先頭ファイル（PNG があればその 1 枚）。

### `cad_export`

```jsonc
{
  "parts": [ /* パーツ仕様 */ ],           // 必須
  "format": "dxf",                        // stl | obj | glb | ply | dxf | svg（必須）
  "views": ["front", "top", "right"],     // dxf / svg のときのビュー
  "title": "CAD 図面",
  "name": "plate"
}
```

返り値は `cad_model` と同じ形（`format` だけが実際の形式）。

### パーツ仕様のフィールド

| キー | 型 | 説明 |
|---|---|---|
| `type` | string | `box` / `cylinder` / `sphere` / `cone` / `torus` / `wedge` / `prism` / `hole` |
| `operation` | string | `union`（既定）/ `difference` / `intersect`。**最初のパーツは union のみ** |
| `size` | [w,d,h] | box / wedge の寸法（mm） |
| `radius` / `diameter` | number | 半径 / 直径（mm）。cone・prism は底面半径・外接円半径、torus はリング半径 |
| `height` | number | cylinder / cone / prism の高さ（mm） |
| `radiusTop` | number | 円錐台の上端半径（既定 0 = 点） |
| `tube` | number | torus の管半径 |
| `tubeSegments` | integer | torus の管方向の分割 |
| `sides` | integer | prism の角数 |
| `segments` | integer | 曲面方向の分割（既定 48, 3..192） |
| `rings` | integer | sphere の緯度方向の分割 |
| `position` | [x,y,z] | 中心座標（mm） |
| `rotation` | [rx,ry,rz] | XYZ オイラー角（度） |
| `scale` | [sx,sy,sz] | 回転前に掛ける倍率（正の値。反転は `mirror`） |
| `mirror` | "x"\|"y"\|"z" | 指定軸で反転したコピーを追加 |
| `axis` | "x"\|"y"\|"z" | hole の穴軸（既定 z） |
| `depth` | number | hole の深さ（mm）。省略で貫通 |
| `array` | object | `{ count, offset }` または `{ count, direction, spacing }` |

---

## 3. パーツ仕様の JSON 例

### 3.1 穴あき板（100 × 60 × 6、φ10 の貫通穴 4 つ）

```json
{
  "parts": [
    { "type": "box", "size": [100, 60, 6] },
    { "type": "hole", "diameter": 10, "position": [30, 20, 0] },
    { "type": "hole", "diameter": 10, "position": [-30, 20, 0] },
    { "type": "hole", "diameter": 10, "position": [30, -20, 0] },
    { "type": "hole", "diameter": 10, "position": [-30, -20, 0] }
  ]
}
```

同じ穴を 1 パーツで書く（array + mirror が展開されます）:

```json
{
  "parts": [
    { "type": "box", "size": [100, 60, 6] },
    { "type": "hole", "diameter": 10, "position": [30, 20, 0], "mirror": "x",
      "array": { "count": 2, "offset": [0, -40, 0] } }
  ]
}
```

### 3.2 ボス付きブラケット（union + difference + prism）

```json
{
  "parts": [
    { "type": "box", "size": [80, 50, 8] },
    { "type": "cylinder", "radius": 14, "height": 24, "position": [0, 0, 16] },
    { "type": "cylinder", "radius": 8, "height": 40, "position": [0, 0, 16], "operation": "difference" },
    { "type": "hole", "diameter": 6, "position": [30, 18, 0] },
    { "type": "hole", "diameter": 6, "position": [-30, 18, 0] },
    { "type": "prism", "sides": 6, "radius": 5, "height": 10, "position": [30, -15, 9] }
  ]
}
```

### 3.3 交差だけを残す（intersect）

```json
{
  "parts": [
    { "type": "box", "size": [30, 30, 30] },
    { "type": "sphere", "radius": 18, "operation": "intersect" }
  ]
}
```

### 3.4 回転・スケール・ランプ

```json
{
  "parts": [
    { "type": "wedge", "size": [60, 40, 25] },
    { "type": "box", "size": [20, 10, 4], "position": [0, 0, 15], "rotation": [0, 0, 30], "scale": [1, 2, 1] }
  ]
}
```

---

## 4. 実測検証ログ

環境: Windows / Node **v24.22.1** / Blender **5.2.2 LTS**（build 2026-09-15,
`C:\Users\tatud\AppData\Local\Programs\Blender Foundation\Blender 5.2\blender.exe`）。

### 4.1 Blender の素性を先に確認した（実装前）

```powershell
& $blender -b --factory-startup --python probe.py -- out.stl
# HAS_WM_STL_EXPORT True / STL_OK 684 / ENGINES ['BLENDER_EEVEE'] /
# BOOL_MOD ['object','operation','solver','use_self','use_hole_tolerant']
```

分かったこと（v3 実装に反映済み）:

- STL/OBJ/PLY の書き出しは `bpy.ops.wm.stl_export` / `wm.obj_export` / `wm.ply_export`、
  glTF は `bpy.ops.export_scene.gltf`。旧 `export_mesh.stl` は無い。
- レンダー可能エンジンは `BLENDER_EEVEE` / `BLENDER_WORKBENCH` / `CYCLES`。
  `BLENDER_EEVEE_NEXT` という名前は 5.2 には存在しない。
- 既定の view transform は **AgX**。白 (1.0) が **#c4c4c4** になるため、
  `scene.view_settings.view_transform = 'Standard'` にして図面の紙を白にした
  （修正後、PNG 左上の画素は `255,255,255`）。
- Freestyle の lineset は `linestyle` が **None**。`bpy.data.linestyles.new()` で
  作らないと線が出ない。`select_silhouette` 等は `exclude_silhouette` 系に改名。
- バックグラウンドでは `bpy.context.view_layer.objects` の反復が None を返すことがある。
  `bpy.data.objects` を使う。

### 4.2 穴あき板を STL に書き出す

```powershell
cd C:\root\dsh-media-studio; node --test test/cad.test.mjs
# pass 32 / fail 0 / skipped 0（Blender 必須の 3 本も skip せず実行）
```

テストと同じ経路を直接叩いた結果（`C:\root\cad-verify.mjs`）:

| 項目 | 実測値 |
|---|---|
| `cad_model`（blender） | `triangles 1580` / `vertices 784` / `backend blender` |
| bbox | x `-50..50`（100）, y `-30..30`（60）, z `-3..3`（6） |
| STL ファイル | **79,084 バイト** = 84 + 1,580 × 50（形式の定義と一致） |
| 書き出した STL を読み戻す | `triangles 1580` / bbox `[-50,-30,-3]..[50,30,3]` / `degenerate 0` / `zeroNormals 0` |
| 表示文言 | `3D モデルを作成しました（5 パーツ, 1580 三角形, 100 × 60 × 6 mm, 77.2 KB）: media-studio/plate-…stl` |

### 4.3 三面図 PNG をレンダーする

```jsonc
{ "parts": [ /* 4.2 と同じ板 */ ], "format": "png", "views": ["front","top","right","iso"],
  "width": 1200, "height": 900, "engine": "workbench" }
```

| view | ファイル | バイト数 | 画像サイズ |
|---|---|---|---|
| front | `drawing-…-front.png` | 312,511 | 1200 × 900 PNG |
| top | `drawing-…-top.png` | 642,829 | 1200 × 900 PNG |
| right | `drawing-…-right.png` | 337,994 | 1200 × 900 PNG |
| iso | `drawing-…-iso.png` | 553,678 | 1200 × 900 PNG |
| sheet | `drawing-…-svg`（`format: both` 時） | 10,249 | SVG |

PNG は署名 `PNG` と IHDR の幅・高さを読み取って検証（テストでも同じことを確認）。
中身は目視でも確認済み: 平面図に φ10 の穴 4 つ、アイソメ図に板厚と貫通穴、
白背景・黒線（freestyle）または陰影（workbench）。

### 4.4 SVG 図面と DXF を読み戻す

| 項目 | 実測値 |
|---|---|
| SVG | 10,184 バイト。`正面図` / `平面図` / `右側面図` の 3 ビュー、寸法 `100` `60` `6`、穴は `stroke-dasharray="6 4"` の破線（外形内にクリップ）、表題欄に `単位: mm` `尺度: 1:0.47` `外形: 100 × 60 × 6 mm` |
| DXF | `$ACADVER AC1009` / `$INSUNITS 4`（mm）/ **LINE 254 本** / TEXT 9 件（`100`, `6`, `正面図`, `100`, `60`, `平面図`, `60`, `6`, …） / レイヤー `OUTLINE`・`HIDDEN` を確認 |
| DXF の座標 | すべて実寸 mm（1 図形単位 = 1 mm）、ビューは横並び |

### 4.5 他の形式

| 形式 | 経路 | 実測 |
|---|---|---|
| `obj` | 純 JS（union） | 4,178 バイト / 204 三角形 / `# DSH Media Studio CAD (mm)`、`v` 106 行・`f` 204 行 |
| `obj` | Blender（穴あり） | 16,719 バイト / 408 三角形 / 先頭 `# Blender 5.2.2 LTS` |
| `ply` | Blender | 7,971 バイト / 408 三角形 / 先頭 `ply` + `format binary_little_endian` |
| `glb` | Blender | 58,356 バイト / マジック `glTF` / バージョン 2 |

### 4.6 Blender 無しでも落ちないこと

`cad.blenderPath` を存在しないパスに差し替えて検証（Blender が無い環境の再現）:

| ケース | 結果 |
|---|---|
| box + cylinder の union を `stl` | **成功**（JS フォールバック, 204 三角形, 10.0 KB, bbox 40 × 30 × 30） |
| 同じものを `obj` | 成功（JS） |
| `difference` を含む板を `stl` | 意図どおり失敗: 「ブーリアン演算…には Blender が必要です」+ 設定方法を案内 |
| `glb` | 意図どおり失敗: 「GLB / PLY の書き出しには Blender が必要です」 |
| `cad_drawing` `format: "svg"` | **成功**（SVG のみ、Blender 不要） |
| `cad_drawing` `format: "png"` | 意図どおり失敗（`format: svg` を案内） |

### 4.7 全体テスト

```powershell
cd C:\root\dsh-media-studio; node --test
# 329 tests / 329 pass / 0 fail / 0 skipped（ベースライン 188 + 各担当分。cad は 32 本）
```

`node --test test/` は Windows で失敗するので使わない（SPEC 6 のとおり）。

---

## 5. Lead が `index.js` に配線するための情報

```js
// import
import { registerCadTools } from './cad.js';

// 登録（既存の nle / daw と同じ並び）
registerCadTools(ctx, options, config, { resolveSessionCwd, formatBytes, safeRelativeDir });
```

- 署名は `registerCadTools(ctx, options, config, helpers)`（SPEC 4 のとおり）。
  `helpers` が無くても落ちません（`process.cwd()` と内蔵の整形にフォールバック）。
- **config キー**: `config.cad`（行設定の生オブジェクト）
  - `blenderPath` … `blender.exe` のフルパス。省略時は自動解決
  - `outputDir` … 既定 `options.outputDir`（`media-studio`）
  - `timeoutMs` … Blender 起動タイムアウト（既定 300000）
  - `width` / `height` … 図面の既定ピクセル数（1600 / 1200）
  - `segments` … 既定のテッセレーション（48）
  - `engine` … `workbench`（既定）| `freestyle`
  - `lineWidth` … freestyle の線幅（既定 1.6）
- **Blender パスの既定解決**（`findBlender(configured)`）: 次の順で最初に見つかったもの
  1. `config.cad.blenderPath`
  2. 環境変数 `BLENDER_PATH`
  3. `%LOCALAPPDATA%\Programs\Blender Foundation\Blender *\blender.exe`（新しい版が先）
  4. `C:\Program Files\Blender Foundation\Blender *\blender.exe`
  5. PATH 上の `blender`（`blender --version` で確認）
- `package.json` の `files` / `exports` に `cad.js` と `cad_blender.py` を追加してください
  （`cad_blender.py` は `fileURLToPath(new URL('./cad_blender.py', import.meta.url))` で
  参照するので、同梱しないと本番で失敗します）。`package.json` は Lead の所有なので触っていません。
- README / locale へ追記する文言は下の 6 章を使ってください。

---

## 6. README 用の短い日本語説明

> **パラメトリック CAD（v3）**
> box / cylinder / sphere / cone / torus / wedge / prism を組み合わせ、ブーリアン
> （union / difference / intersect）・回転・スケール・配列・鏡像・貫通穴で 3D ソリッドを作り、
> STL（バイナリ, mm）・OBJ・GLB・PLY に書き出します。三面図とアイソメ図を PNG で
> レンダーし、寸法線つきの SVG 図面と DXF（R12, mm）も出力します。単位は mm、
> 結果には三角形数と bbox を返すので寸法をその場で確認できます。ブーリアン演算と
> GLB / PLY・PNG レンダーには Blender を使い、単純な union の STL / OBJ と
> SVG / DXF は Blender 無しでも生成できます。

ツール一覧向け（1 行ずつ）:

- `cad_model` — パラメトリックにソリッドを作り、STL / OBJ / GLB / PLY に書き出す
- `cad_drawing` — 正面・平面・右側面・アイソメの図を PNG で、寸法入り図面を SVG で作る
- `cad_export` — 同じパーツ仕様から STL / OBJ / GLB / PLY / DXF / SVG へ再書き出しする

---

## 7. 既知の制限

1. **SVG / DXF はシルエット投影**。各パーツの凸包を投影して描くので、凹形状の
   隠れ線除去はしません（穴は破線で表現し、外形の内側にクリップしています）。
   アイソメ図は PNG のみ（SVG / DXF には入りません）。
2. **`bbox` の出どころ**。Blender 経由では CSG 評価後の実測値、純 JS 経路では
   union パーツの外形です。`intersect` を JS 側で評価できないため、JS 経路の
   bbox は「上限」になります（`intersect` は Blender 必須なので実際には発生しません）。
3. **ブーリアンは EXACT ソルバー依存**。面が完全一致する位置でのカットなど、
   境界が退化する形状は失敗することがあります。その場合は 0.1 mm ずらしてください。
4. **GLB の単位**。Blender の glTF エクスポーターは数値をそのまま書き出すため、
   glTF の慣習（1 単位 = 1 m）で読むビューアでは 100 mm の板が 100 m に見えます。
   プリントや CAD 用途は STL / OBJ / DXF を推奨。
5. **DXF の日本語**。R12 ASCII なので、ビュー名（`正面図` など）は UTF-8 のまま
   入ります。古い CAD では文字化けする可能性があります（寸法値は ASCII なので影響なし）。
6. **穴の長さ**。`depth` 省略時は「その軸の外形 × 4 + 20 mm」で貫通させます。
   極端に薄い板を斜めに貫通させたい場合は `depth` を明示してください。
7. **テッセレーション**。既定 `segments: 48`。STL はフラットシェーディングの
   三角形なので、丸い面は分割数なりの多角形になります。滑らかさが必要なら
   `segments` を上げてください（上限 192、頂点上限 600,000）。
8. **状態を持たない**。`cad_export` は呼び出しごとに `parts` から作り直します。
   `.blend` や中間ファイルは残しません（`mkdtemp` して `finally` で削除）。
