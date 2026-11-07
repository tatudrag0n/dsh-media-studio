# メディアスタジオ v2 — 追加仕様

対象: `C:\root\dsh-media-studio`（`@local/dsh-media-studio`）。
既存 11 ツール（generate_image / generate_video / make_motion_graphic / produce_video /
attach_material / render_chart / edit_image / generate_speech / generate_music /
compose_music / transcribe_audio）は維持する。**4 領域を追加**し、各業界の専門水準を狙う。

追加する制作領域:

| 領域 | ツール | 実装 | 外部依存 |
| --- | --- | --- | --- |
| 効果音生成 | `generate_sfx` | ローカル DSP（Node のみ） | なし |
| 歌詞生成 | `write_lyrics` | LLM + 作詞理論エンジン | ハーネスの `llm` |
| 小説生成 | `write_novel` | LLM + 日本語組版/連続性管理 | ハーネスの `llm` |
| 記事生成 | `write_article` | LLM + 編集/SEO 構造 | ハーネスの `llm` |

「専門水準」の定義（受け入れ基準）:

1. **再現性**: 同じ入力 + seed は同じ出力。効果音は完全決定的。
2. **物理的/音楽的正しさ**: 効果音はクリック・DC オフセット・位相反転がない。
   歌詞はモーラ数と韻が機械検証できる。小説は行頭禁則など組版規則を満たす。
3. **計測できる**: すべての出力に検証可能な数値（モーラ数・文字数・ピーク・RMS）を返す。
4. **失敗が説明できる**: 前提不足（LLM 未設定・素材なし）は日本語で理由を返す。

---

## 1. `generate_sfx` — ローカル効果音合成

新規ファイル `sfx.js`。**Node の標準機能だけで音を作る**（python も ffmpeg も使わない）。

### DSP 基盤（すべて純関数・Float32Array ベース）

- `mulberry32(seed)` 決定的 PRNG。
- ノイズ: 白 / ピンク（Voss-McCartney か 1/f 近似）/ ブラウン。
- フィルタ: 一次ローパス・ハイパス、バイクアッド（LP/HP/BP/ピーキング, RBJ cookbook）。
- エンベロープ: ADSR、指数減衰、非対称（速い立ち上がり・長い尻尾）。
- 発振: サイン、FM（モジュレータ比と深さ）、加算合成（部分音の減衰を個別に）、
  ピッチスイープ（指数グライド）。
- 空間: Schroeder リバーブ（コム 4 + オールパス 2、RT60 指定）、Haas 遅延、
  ステレオの非相関化。
- 仕上げ: DC ブロッカー → ソフトクリップ（tanh）→ フェードイン/アウト（最低 1ms）→
  ピーク正規化（-1 dBFS）→ ワンショットは RMS を -18 dBFS、アンビエンスは -26 dBFS に寄せる。
- `writeWav({sampleRate, channels, frames})` → RIFF/PCM 16bit。ループ指定時は
  末尾と先頭をクロスフェードして継ぎ目を消す。

### カタログ（`kind`）

`whoosh` `swoosh` `impact` `sub-drop` `riser` `downlifter` `reverse-cymbal`
`transition` `click` `pop` `beep` `notification` `chime` `bell` `alarm`
`laser` `powerup` `coin` `magic` `glitch` `static` `explosion`
`footsteps` `door` `camera-shutter` `typing` `page-turn`
`rain` `wind` `fire` `water` `crowd` `horror-drone` `heartbeat` `engine`

- 未知の `kind` は `whoosh` に落とさず、**候補一覧つきのエラー**にする。
- 各 kind は「物理的な出来事」から設計する（例: whoosh = 帯域ノイズ + 中心周波数の
  上昇/下降 + 短い立ち上がり。impact = 低域サインの急降下 + ノイズの過渡 + 短いリバーブ）。
- `variation`（0..1）で同系統の別テイク、`seed` で完全再現。

### 入力

```
kind: string           必須
duration: number       0.05..60（kind ごとの既定あり）
intensity: number      0..1  既定 0.6
brightness: number     0..1  既定 0.5
seed: integer          既定 1
sampleRate: 44100|48000 既定 44100
channels: 1|2          既定 2
loop: boolean          既定 false
variation: number      0..1  既定 0
name: string           出力ファイル名の語幹
```

### 出力

`{ path, name, kind, duration, sampleRate, channels, peak, rms, lufs, bytes, seed }`
音声プレイヤーで再生できるよう、既存の音声ツールと同じ結果形にする。

---

## 2. `write_lyrics` — 作詞

新規ファイル `writing.js`（3 ツール共通の LLM ブリッジ + 各エンジン）。

### 入力

```
brief: string          必須（主題・感情・物語）
language: 'ja'|'en'|'auto'   既定 auto
genre: jpop|rock|ballad|rap|edm|folk|citypop|anison|metal|rnb
structure: string      プリセット名 or セクション列
mood, perspective, rhyme('none'|'loose'|'tight'), syllablesPerLine, hook,
bannedWords[], length('short'|'standard'|'long'), tempo, meter, seed
melody: boolean        既定 true（MSX のメロディ骨子も返す）
```

### 作詞エンジン（機械検証する部分）

- **モーラ数**: かな→モーラ。小書き `ゃゅょぁぃぅぇぉゎ` は前と 1、`っ` `ん` `ー` は各 1、
  長音は直前の母音を伸ばす。行ごとのモーラ数を数え、`syllablesPerLine` ±1 を外れたら
  警告（自動修正はしない）。
- **韻**: 日本語は行末 3 モーラの母音列、英語は末尾音節。`tight` は完全一致、
  `loose` は母音の骨格一致。行ごとに韻グループ ID を振る。
- **フック**: サビ 1 行目と最終行に置く。12 モーラ以下を推奨。
- **構成**: `jpop-standard` = intro / verse / pre-chorus / chorus / verse /
  pre-chorus / chorus / bridge / final-chorus / outro。
- **禁止語**: 陳腐語（`永遠` `奇跡` `運命` `絆` `キミ` の乱用など）を既定で抑制。

### 出力

歌詞本文（`[Verse 1]` 等のセクションタグ付き）、行ごとのモーラ/音節数表、韻マップ、
フック検査、`melody`（MSX スコア文字列。`generate_music` にそのまま渡せる）、
`warnings[]`。

---

## 3. `write_novel` — 小説

### モード

- `outline` — 設定資料（登場人物・世界・年表・テーマ）とビート表（三幕 / 起承転結 / Save the Cat）。
- `draft` — ビート 1 つを章として書く。
- `continue` — 既存本文の続き。直前の文を読んで連続性を保つ。
- `revise` — 指定の文体・長さ・視点へ書き直す。

### 入力

```
mode, brief, genre, pov('first'|'third-limited'|'third-omniscient'|'second'),
tense('past'|'present'), style, targetLength(文字数), bible(JSON か path),
outline, previous(path か本文), chapterIndex, rating, language
```

### 日本語組版の後処理（必ず通す）

- 行頭禁則（`、。」』）』】〕〉》!?…ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ` を
  行頭に置かない。直前の行末へぶら下げる）。
- `...` → `……`、`--` / `—` → `——`、`!?` の後に全角スペース。
- 段落冒頭の全角 1 字下げ。
- 連続する空行を 1 つに。
- 数字・英単語の前後の全角スペースを整える。

### 連続性

`bible` は `outputDir/<slug>.bible.json` に保存し、次の章のプロンプトへ注入する
（人物・場所・時系列・伏線・既出の小道具）。`draft` の出力は
`<slug>.ch<NN>.md` に保存する。

---

## 4. `write_article` — 記事

### モード

`brief` `outline` `draft` `rewrite` `seo`

### 入力

```
mode, topic, format(news|howto|listicle|comparison|review|thought-leadership|
press-release|product-page|column|tutorial), audience, tone, language,
keywords[], targetLength, sources[], brand, cta, previous, outline
```

### 出力

タイトル案（文字数付き）、メタディスクリプション（ja ≤120 字 / en ≤155 字）、スラッグ、
見出し構成（H2/H3）、本文 Markdown、FAQ（JSON-LD 付き）、内部/外部リンク候補、
`[要出典]` フラグ、読了時間。**数値・統計を作らない**（出典にある数値だけを使い、
無い場合は主張を弱める）。

---

## 5. 共通: LLM ブリッジ（`writing.js`）

- ルート解決: `config.writing.provider/model` → 無ければ `ctx.get('agentDefaultModel')`
  の `currentSelection()`。どちらも無ければ日本語で理由を返して失敗。
- `ctx.get('llm')` の `prepareCall` を使い、`stream()` のチャンクを集約する。
  `finish.reason.kind` が `error` / `aborted` / `max-tokens` なら理由付きで失敗。
- `AbortController` + タイムアウト（既定 120 秒）。
- JSON を取り出す `extractJson()`（コードフェンス・前後の地の文を許容）。
- ツール引数の `signal` を尊重する。

## 6. 統合

- `index.js`: `Config` に `sfx` と `writing` を追加、`resolveOptions` に反映、
  `apply` で 4 ツールを `ctx.effect(() => ctx.tools.register(...))` で登録。
- `locale/ja.json` / `locale/en.json`: 4 ツールのタイトルと説明。
- `README.md`: 各ツールの節、既定バックエンド表の更新。
- `test/`: `sfx.test.mjs`、`writing.test.mjs`（LLM はフェイクで注入）。
- `client.js`: `generate_sfx` のチャット表示（既存の音声プレイヤーを再利用）。
