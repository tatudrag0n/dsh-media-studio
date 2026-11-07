# 素材ライブラリをテキストで操作する — `list_assets` / `asset_info` / `remove_asset`

コンポーザー下のメディアパネルは廃止予定。パネルがやっていた **素材の一覧・プレビュー・削除** を、
チャットのツール呼び出しだけで届くようにしたのがこの 3 ツールです。
実装は `library.js`（1 ファイル）、ファイルの読み書きはすべて `assets.js` の API に任せています。

| パネルの機能 | テキストでの置き換え |
|---|---|
| 素材の一覧（サムネイル付き） | `list_assets`（id・名前・種類・サイズ・追加日時） |
| 素材のプレビュー | `asset_info`（パスと media type。中身は返さない） |
| 素材の削除 | `remove_asset`（`dryRun` で事故防止） |

## 1. 引数と返り値

### `list_assets` — ライブラリを一覧する

引数:

| 名前 | 型 | 既定 | 説明 |
|---|---|---|---|
| `kind` | string（`image` / `video` / `audio` / `other`） | なし（全部） | この種類だけを返す。 |
| `limit` | integer | 20（`config.library.limit` で変更可）、上限 200 | 新しい順に何件返すか。 |

返り値:

```json
{
  "dir": "C:\\Users\\<user>\\.dsh\\media-studio\\assets",
  "count": 2,
  "total": 3,
  "entries": [
    { "id": "mw2...4bd4", "name": "night.mp4", "kind": "video", "bytes": 4096, "modifiedAt": "2026-11-04T11:56:12.345Z" }
  ]
}
```

- `total` は条件に合った総数、`count` は実際に返した件数。`limit` で切り詰めても `total` は減りません。
- `modifiedAt` は `assets.js` の `createdAt`（追加日時）です。一覧は新しい順。
- `kind` は `assets.js` が付けた値をそのまま返します。**この module は拡張子の表を持ちません。**
- 空のライブラリでもエラーになりません（`total: 0`, `entries: []`）。

### `asset_info` — 素材 1 件の情報（プレビューの代わり）

引数: `id`（string, 必須）— `list_assets` が出した id。

返り値:

```json
{
  "dir": "...",
  "id": "mw2...4bd4",
  "name": "rain.wav",
  "kind": "audio",
  "bytes": 2048,
  "mediaType": "audio/wav",
  "fileName": "mw2...4bd4_rain.wav",
  "path": "C:\\...\\media-studio\\assets\\mw2...4bd4_rain.wav",
  "createdAt": "2026-11-04T11:56:12.345Z"
}
```

- **中身（バイト列）は返しません。** パネルのようにその場で再生・表示はできないので、代わりに
  `path` を返します。`edit_video` / `attach_material` / `produce_video` / ファイル系ツールはこのパスを取れます。
- 知らない id は明確なエラー（`ライブラリにありません`）。ディスク上から消えたファイルも同じ扱いです。

### `remove_asset` — 素材を消す（取り消せない）

引数:

| 名前 | 型 | 既定 | 説明 |
|---|---|---|---|
| `id` | string | — | 必須。消す素材の id。 |
| `dryRun` | boolean | `false` | true なら **消さずに** 「消す予定」だけ返す。 |

返り値:

```json
{ "dir": "...", "id": "...", "name": "night.mp4", "kind": "video", "bytes": 4096,
  "path": "C:\\...\\mw2...4bd4_night.mp4", "removed": true, "dryRun": false }
```

- 消したときの `render` は **「消しました。…この操作は取り消せません。」** とはっきり書きます。
  パネルの削除と違い、テキストでは「押した感」が無いので、結果を読んで分かるようにしています。
- `dryRun: true` は `removed: false` / `dryRun: true` を返し、`render` は
  「まだ消していません (dryRun)。…消す予定です。」と返します。ファイルには触れません。
- 存在しない id は **エラー**（黙って成功にしません）。`dryRun` でも同じです —
  「何も消えるものが無い」を成功と読ませないため。
- `id` が空・未指定もエラーです。
- `isConcurrencySafe: () => false`（削除は直列）。

## 2. 実装上の約束

- **`assets.js` を再利用する。** 保存先は必ず `assetDirectory(options)` で決めます。
  `options.assets.directory` があればそれ、無ければ `$DSH_HOME/media-studio/assets`
  （`DSH_HOME` 未設定なら `~/.dsh/media-studio/assets`）— この判断は `assets.js` の中だけにあります。
- 読み書きは `listAssets` / `readAsset` / `removeAsset` のみ。**`fs` を直接触りません。**
- 種類判定は `assets.js` の `ASSET_KINDS` / `assetKind` の結果（レコードの `kind`）を使います。
  `kind` の enum も `Object.keys(ASSET_KINDS)` + `other` から組み立てるので、拡張子表の二重管理はありません。
- 登録は同期。`ctx.effect(() => ctx.tools.register(tool), ...)` を呼ぶだけで、`await` も外部プロセスもありません。
  （`library.js` は `node:fs` も `child_process` も import しません。）
- `index.js` を import しません（循環参照を作らない）。`helpers.formatBytes` は受け取って使うだけで、
  無い場合は最小の自前整形にフォールバックします。
- ツール `description` / `parameters[].description` は英語、`output.render` は日本語。
- `undefined` を値として返しません（キーごと省く）。

## 3. テスト

`test/library.test.mjs` は 16 テスト。すべて `saveAsset` で一時ディレクトリに本物の素材を作り、
本物のツールを `execute` して確認します（モックなし）。

- 登録・description が英語・render が日本語・`kind` の enum
- 一覧の並び（新しい順）・件数・`limit` の切り詰め・`kind` フィルタ
- `assetDirectory()` が保存先を決めていること（`options.assets.directory` → `$DSH_HOME` の順）
- 空ディレクトリはエラーにならず、**読み取りがディレクトリを作らない**こと
- `asset_info` がパスと media type を返し、バイト列を返さないこと
- `remove_asset` の `dryRun` が消さないこと／本実行が消すこと／知らない id がエラーになること
- 裏で消えたファイルに対して `asset_info` がエラーになること

```
cd C:\root\dsh-media-studio
node --test test/library.test.mjs
```

## 4. 実測ログ（このマシン, 2026-11-04）

再現手順: 下のスクリプトを `%TEMP%\v31-library-check.mjs` に保存して実行します
（リポジトリの中に検証用ファイルを増やさないため）。

```js
// %TEMP%\v31-library-check.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = pathToFileURL('C:/root/dsh-media-studio/').href;
const { listAssets, saveAsset } = await import(`${plugin}assets.js`);
const { registerLibraryTools } = await import(`${plugin}library.js`);

const directory = await mkdtemp(join(tmpdir(), 'v31-library-check-'));
const registered = new Map();
const ctx = {
  effect(callback) { callback(); },
  tools: { register(tool) { registered.set(tool.name, tool); } },
};
const helpers = { resolveSessionCwd: async () => process.cwd(), formatBytes: (n) => `${n} B`, safeRelativeDir: (v) => v };
registerLibraryTools(ctx, { assets: { maxBytes: 256 * 1024 * 1024, directory } }, {}, helpers);
console.log('登録:', [...registered.keys()].join(', '));
console.log('ライブラリ:', directory);

const poster = await saveAsset(directory, { name: 'poster.png', data: Buffer.alloc(1024, 1) });
const track = await saveAsset(directory, { name: 'rain.wav', data: Buffer.alloc(2048, 2) });
const clip = await saveAsset(directory, { name: 'night.mp4', data: Buffer.alloc(4096, 3) });
console.log('素材 id:', [poster.id, track.id, clip.id].join(', '));

const show = async (name, args) => {
  const tool = registered.get(name);
  const value = await tool.execute(args, {});
  console.log(`\n[${name} ${JSON.stringify(args)}]`);
  console.log('value:', JSON.stringify(value));
  console.log('render:\n' + tool.output.render(args, value).map((block) => block.text).join('\n'));
};

await show('list_assets', {});
await show('list_assets', { kind: 'audio', limit: 5 });
await show('asset_info', { id: track.id });
await show('remove_asset', { id: clip.id, dryRun: true });
console.log('\ndryRun 後の件数:', (await listAssets(directory)).length);
await show('remove_asset', { id: clip.id });
console.log('\n削除後の件数:', (await listAssets(directory)).length);
await show('list_assets', { kind: 'video' });

for (const [label, args] of [['未知の id', { id: 'nope' }], ['id なし', {}]]) {
  try {
    await registered.get('remove_asset').execute(args, {});
    console.log(`${label}: エラーにならなかった (NG)`);
  } catch (error) {
    console.log(`${label} → Error: ${error.message}`);
  }
}

await rm(directory, { recursive: true, force: true });
console.log('\ndone');
```

実行:

```
cd C:\root\dsh-media-studio
node $env:TEMP\v31-library-check.mjs
```

実際の出力（このマシンの生ログ）:

```
登録: list_assets, asset_info, remove_asset
ライブラリ: C:\Users\tatud\AppData\Local\Temp\v31-library-check-4Vz0wx
素材 id: mw229em2e4ae77, mw229em411837e, mw229em448bcd4

[list_assets {}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","count":3,"total":3,"entries":[{"id":"mw229em448bcd4","name":"night.mp4","kind":"video","bytes":4096,"modifiedAt":"2026-11-04T11:56:15.292Z"},{"id":"mw229em411837e","name":"rain.wav","kind":"audio","bytes":2048,"modifiedAt":"2026-11-04T11:56:15.291Z"},{"id":"mw229em2e4ae77","name":"poster.png","kind":"image","bytes":1024,"modifiedAt":"2026-11-04T11:56:15.290Z"}]}
render:
素材 3 件のうち 3 件 (新しい順):
- night.mp4 (video, 4096 B, id mw229em448bcd4, 2026-11-04 11:56)
- rain.wav (audio, 2048 B, id mw229em411837e, 2026-11-04 11:56)
- poster.png (image, 1024 B, id mw229em2e4ae77, 2026-11-04 11:56)

[list_assets {"kind":"audio","limit":5}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","count":1,"total":1,"entries":[{"id":"mw229em411837e","name":"rain.wav","kind":"audio","bytes":2048,"modifiedAt":"2026-11-04T11:56:15.291Z"}]}
render:
素材 1 件のうち 1 件 (新しい順):
- rain.wav (audio, 2048 B, id mw229em411837e, 2026-11-04 11:56)

[asset_info {"id":"mw229em411837e"}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","id":"mw229em411837e","name":"rain.wav","kind":"audio","bytes":2048,"mediaType":"audio/wav","fileName":"mw229em411837e_rain.wav","path":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx\\mw229em411837e_rain.wav","createdAt":"2026-11-04T11:56:15.291Z"}
render:
rain.wav (audio) — id mw229em411837e
サイズ: 2048 B / 種類: audio/wav
パス: C:\Users\tatud\AppData\Local\Temp\v31-library-check-4Vz0wx\mw229em411837e_rain.wav
追加: 2026-11-04 11:56
中身は返していません。プレビューが必要ならこのパスを開いてください。

[remove_asset {"id":"mw229em448bcd4","dryRun":true}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","id":"mw229em448bcd4","name":"night.mp4","kind":"video","bytes":4096,"path":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx\\mw229em448bcd4_night.mp4","removed":false,"dryRun":true}
render:
まだ消していません (dryRun)。素材 night.mp4 を消す予定です。
id: mw229em448bcd4
サイズ: 4096 B (video)
元のパス: C:\Users\tatud\AppData\Local\Temp\v31-library-check-4Vz0wx\mw229em448bcd4_night.mp4
本当に消すときは dryRun を付けずに、もう一度 remove_asset を呼んでください。

dryRun 後の件数: 3

[remove_asset {"id":"mw229em448bcd4"}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","id":"mw229em448bcd4","name":"night.mp4","kind":"video","bytes":4096,"path":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx\\mw229em448bcd4_night.mp4","removed":true,"dryRun":false}
render:
消しました。素材 night.mp4 をライブラリから削除しました。
id: mw229em448bcd4
サイズ: 4096 B (video)
元のパス: C:\Users\tatud\AppData\Local\Temp\v31-library-check-4Vz0wx\mw229em448bcd4_night.mp4
この操作は取り消せません。

削除後の件数: 2

[list_assets {"kind":"video"}]
value: {"dir":"C:\\Users\\tatud\\AppData\\Local\\Temp\\v31-library-check-4Vz0wx","count":0,"total":0,"entries":[]}
render:
素材ライブラリ C:\Users\tatud\AppData\Local\Temp\v31-library-check-4Vz0wx は空です。素材を追加してからもう一度 list_assets を呼んでください。
未知の id → Error: id "nope" の素材はライブラリにありません。消す前に list_assets で id を確認してください。
id なし → Error: id が必要です。list_assets で素材の id を確認してください。

done
```

確認できたこと:

1. `saveAsset` で作った 3 件（png / wav / mp4）が `list_assets` に出て、`kind` が image / audio / video に分かれた。
2. `list_assets { kind: 'audio' }` が audio の 1 件だけを返した（`total` は絞った後の件数）。
3. `asset_info` が `path` と `mediaType` を返し、バイト列を返さなかった。
4. `remove_asset { dryRun: true }` の後も件数は **3 のまま**（消していない）。
5. `remove_asset` 本実行の後は **2 件**。`list_assets { kind: 'video' }` が 0 件になった。
6. 知らない id と id 未指定は、どちらも日本語の明確なエラーになった。

`node --test`（cwd = `C:\root\dsh-media-studio`, v3.1 の全モジュール込み）:

```
ℹ tests 390 | ℹ pass 390 | ℹ fail 0 | ℹ cancelled 0 | ℹ skipped 0 | ℹ todo 0 | ℹ duration_ms 12738
```

（ベースライン 334 に、project / status / library の追加分を足した数。既存テストは壊れていません。）

## 5. Lead が `index.js` に配線するために必要な情報

```js
// index.js の import 群、`./extra.js` の近く
import { registerLibraryTools } from './library.js';
```

```js
// registerXxxTools が並んでいる場所（`const studioHelpers = ...` の後ろが自然）
registerLibraryTools(ctx, options, config, studioHelpers);
```

- シグネチャは `registerLibraryTools(ctx, options, config, helpers)`（`nle.js` / `cad.js` / `daw.js` と同じ形）。
- `helpers` は既存の `studioHelpers`（`{ resolveSessionCwd, formatBytes, safeRelativeDir }`）をそのまま渡せます。
  `formatBytes` は render のサイズ表示にだけ使うので、無くても動きます。
- 読む `options` は **`options.assets.directory` だけ**（`index.js` が既に解決済みの値）。
  新しいオプション解決は増やしていません。
- 読む `config` は **`config.library.limit`**（任意, `list_assets` の既定件数, 既定 20, 有効範囲 1–200）。
  未設定なら `{}` でも動きます。
- `cordis.patch.yml` に新しいキーを足す必要はありません（`library` は任意）。
- `tools-list.js` の 3 エントリ（`group: 'library'`）と名前が一致しています:
  `list_assets` / `remove_asset` / `asset_info`。

## 6. README / TEXT-GUIDE に載せる短い日本語説明

> **素材ライブラリ（`list_assets` / `asset_info` / `remove_asset`）**
> 取り込んだ画像・音・動画は `list_assets` で一覧できます（`kind` で種類を絞る、`limit` で件数を制限）。
> `asset_info` に id を渡すと、サイズ・種類・**絶対パス**が返ります。パネルのプレビューの代わりです
> （中身は返しません）。消すときは `remove_asset`。**取り消せない**ので、まず `dryRun: true` で
> 消える予定を確認してください。存在しない id はエラーになります。素材は消しても
> ディスクからしか消えないので、使っている制作物のパスを先に確かめてください。

## 7. 既知の制限

- **プレビューはできない。** `asset_info` はパスと media type を返すだけです。画像をその場で見たい
  場合は、パスをファイル系ツール（画像表示）に渡してください。
- **一覧にパスは載せていません。** 仕様どおり `entries` は `{ id, name, kind, bytes, modifiedAt }`。
  パスが要る素材だけ `asset_info` を呼んでください（ライブラリが大きいときの応答を軽くするため）。
- **`asset_info` は `readAsset` を使うため、ファイルを一度メモリに読みます。** 実運用の素材は数 MB なので
  問題ありませんが、上限（256 MB）近い動画 1 本に対して呼ぶと、その分のメモリを使います。
  メタ情報だけで足りる場面が増えたら、`assets.js` 側に stat だけの API を足すのが本筋です
  （この module の所有外なので、ここでは `assets.js` の API を尊重しています）。
- **`remove_asset` はゴミ箱に入れません。** `assets.js` の `removeAsset`（`unlink`）をそのまま使うので、
  OS のゴミ箱からは復元できません。`dryRun` がそのための安全弁です。
- ライブラリの `dir` は絶対パスで返ります（`$DSH_HOME` 配下）。サンドボックスによっては
  そこへの書き込みが制限されますが、読み取りは影響を受けません。
- 素材の**取り込み**（パネルのドラッグ＆ドロップ相当）はこの module の担当外です。
  既存の `attach_material` / アップロード経路が担います。
