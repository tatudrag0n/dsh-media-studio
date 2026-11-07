/**
 * プロンプトの解釈 (prompt understanding).
 *
 * 1 行の自然文から「どの制作領域か」と「主な数値」を決める。ここは決定的な
 * 処理だけで、モデルは呼ばない。だから同じ文からは常に同じ解釈が出て、
 * 何百件でもテストできる。
 *
 * 判定の考え方:
 *
 * - 名詞が制作物を決める。動詞は補助でしかない。「効果音を作る記事を書いて」
 *   は記事であって効果音ではない。日本語は動詞が最後に来るので、**動詞に
 *   最も近い（= 後ろにある）名詞**を主語として選ぶ。
 * - 同点なら具体的な語を優先する（「曲」より「歌詞」、「音」より「効果音」）。
 * - 何も当たらなければ `image` に落とし、confidence を低くして返す。
 */

/** The capabilities a prompt can reach, with the tool each one runs. */
export const CAPABILITIES = {
  image: { label: '画像生成', tool: 'generate_image', icon: 'image' },
  sfx: { label: '効果音', tool: 'generate_sfx', icon: 'waveform' },
  music: { label: '音楽', tool: 'compose_music', icon: 'note' },
  speech: { label: '音声合成', tool: 'generate_speech', icon: 'mic' },
  lyrics: { label: '歌詞', tool: 'write_lyrics', icon: 'text' },
  novel: { label: '小説', tool: 'write_novel', icon: 'book' },
  article: { label: '記事', tool: 'write_article', icon: 'article' },
  motion: { label: 'モーショングラフィックス', tool: 'make_motion_graphic', icon: 'film' },
  chart: { label: 'グラフ', tool: 'render_chart', icon: 'chart' },
  video: { label: '動画', tool: 'generate_video', icon: 'video' },
  edit: { label: '動画編集', tool: 'edit_video', icon: 'film' },
  cad: { label: 'CAD', tool: 'cad_model', icon: 'cube' },
  daw: { label: 'DTM', tool: 'daw_arrange', icon: 'note' },
};

/**
 * Object nouns, in priority order. `weight` breaks ties between a generic word
 * ("音") and a specific one ("効果音"); `specific` marks the narrower reading.
 */
const OBJECTS = [
  // v3: 編集ソフト・CAD・DTM は語がはっきりしているので、専用語だけを高い重みで拾う。
  // 「打ち込み」「ミックス」のような曖昧な語は入れない（音楽のままにする）。
  { capability: 'edit', weight: 7, patterns: [/動画編集/u, /映像編集/u, /動画を編集/u, /動画をつなげ/u, /動画を繋げ/u, /クリップを切/u, /トリミング/u, /タイムライン/u, /字幕を(付け|入|焼)/u, /テロップを焼/u, /\bedit(?:ing)? (?:the )?(?:video|clip)\b/iu, /\btimeline\b/iu, /\bsubtitles?\b/iu] },
  { capability: 'cad', weight: 7, patterns: [/\bcad\b/iu, /３Ｄ|3D/iu, /ソリッドモデル/u, /\bstl\b/iu, /\bdxf\b/iu, /図面/u, /設計図/u, /３Ｄプリンタ|3Dプリンタ/u, /\b3d ?print/iu, /\bparametric\b/iu] },
  { capability: 'daw', weight: 7, patterns: [/\bdtm\b/iu, /\bdaw\b/iu, /\bmidi\b/iu, /マルチトラック/u, /編曲/u, /\bmusicxml\b/iu, /\bmusescore\b/iu, /\blmms\b/iu, /リズムマシン/u, /シーケンサ/u] },
  { capability: 'lyrics', weight: 6, patterns: [/歌詞/u, /作詞/u, /\bサビ\b/u, /\blyrics?\b/iu, /\bverse\b/iu, /\bchorus\b/iu] },
  { capability: 'article', weight: 5, patterns: [/記事/u, /ブログ/u, /コラム/u, /レビュー/u, /解説記事/u, /まとめ記事/u, /比較記事/u, /プレスリリース/u, /\bseo\b/iu, /\barticle\b/iu, /\bblog ?post\b/iu, /\breview\b/iu] },
  { capability: 'novel', weight: 5, patterns: [/小説/u, /物語/u, /ストーリー/u, /短編/u, /掌編/u, /長編/u, /プロット/u, /\bnovel\b/iu, /\bstory\b/iu, /\bfiction\b/iu, /\bchapter\b/iu] },
  { capability: 'sfx', weight: 6, patterns: [/効果音/u, /環境音/u, /\bse\b/iu, /\bsfx\b/iu, /\bsound ?effects?\b/iu] },
  { capability: 'speech', weight: 6, patterns: [/読み上げ/u, /ナレーション/u, /音声合成/u, /\btts\b/iu, /喋らせ/u, /読み聞かせ/u, /\bvoice ?over\b/iu] },
  { capability: 'motion', weight: 6, patterns: [/モーショングラフィックス/u, /モーション/u, /タイトルカード/u, /ロワーサード/u, /テロップ/u, /動く文字/u, /\bmotion ?graphics?\b/iu, /\blower ?third\b/iu, /\btitle ?card\b/iu] },
  { capability: 'chart', weight: 6, patterns: [/グラフ/u, /チャート/u, /棒グラフ/u, /円グラフ/u, /折れ線/u, /散布図/u, /\bchart\b/iu, /\bgraph\b/iu, /\bplot\b/iu] },
  { capability: 'video', weight: 5, patterns: [/動画/u, /映像/u, /クリップ/u, /\bmp4\b/iu, /\bvideo\b/iu, /\bclip\b/iu] },
  { capability: 'image', weight: 4, patterns: [/画像/u, /イラスト/u, /写真/u, /ロゴ/u, /アイコン/u, /バナー/u, /サムネ/u, /\bimage\b/iu, /\bpicture\b/iu, /\billustration\b/iu, /\blogo\b/iu, /\bicon\b/iu, /\bthumbnail\b/iu] },
  { capability: 'music', weight: 4, patterns: [/シティポップ|シティ・ポップ/u, /ロック/u, /バラード/u, /アニソン/u, /フォーク/u, /メタル/u, /エレクトロ/u, /テクノ/u, /アンビエント/u, /チップチューン/u, /ファンク/u, /ソウル/u, /レゲエ/u, /ボサノバ/u, /ワルツ/u, /ジングル/u, /テーマ曲/u, /インスト曲/u, /\bedm\b/iu, /\btechno\b/iu, /\bambient\b/iu, /\blo-?fi\b/iu, /\bjazz\b/iu, /\bhip ?hop\b/iu, /\bballad\b/iu, /\bfunk\b/iu, /\bwaltz\b/iu, /\bjingle\b/iu] },
  { capability: 'music', weight: 3, patterns: [/音楽/u, /\bbgm\b/iu, /作曲/u, /メロディ/u, /伴奏/u, /ピアノ曲/u, /オーケストラ/u, /ローファイ/u, /ジャズ/u, /ヒップホップ/u, /\bmusic\b/iu, /\btrack\b/iu] },
  { capability: 'music', weight: 2, patterns: [/曲/u, /インスト/u, /ギター/u, /ドラム/u, /ピアノ/u, /\bsong\b/iu] },
  { capability: 'sfx', weight: 2, patterns: [/音/u, /\bsound\b/iu, /\bnoise\b/iu] },
];

/** Sound words that pick a specific effect, longest first. */
const SFX_WORDS = [
  ['reverse-cymbal', /逆シンバル/u],
  ['camera-shutter', /シャッター/u],
  ['horror-drone', /ホラー|不気味|恐怖/u],
  ['powerup', /パワーアップ|強化/u],
  ['notification', /通知/u],
  ['sub-drop', /サブドロップ/u],
  ['downlifter', /ダウンリフター/u],
  ['transition', /トランジション|場面転換/u],
  ['footsteps', /足音/u],
  ['heartbeat', /心臓|鼓動|脈/u],
  ['explosion', /爆発|爆風/u],
  ['page-turn', /ページ|紙をめくる/u],
  ['typing', /タイピング|キーボード|打鍵/u],
  ['engine', /エンジン/u],
  ['glitch', /グリッチ|バグ音/u],
  ['static', /砂嵐|ノイズ音/u],
  ['alarm', /アラーム|警報/u],
  ['chime', /チャイム/u],
  ['bell', /ベル|鐘/u],
  ['coin', /コイン|硬貨/u],
  ['laser', /レーザー|ビーム/u],
  ['magic', /魔法|キラキラ/u],
  ['click', /クリック|カチッ/u],
  ['beep', /ビープ|ピッ/u],
  ['pop', /ポップ|ぽん/u],
  ['whoosh', /ウィッシュ|風切り|シュッ/u],
  ['swoosh', /スワイプ|スウッシュ/u],
  ['riser', /ライザー|盛り上げ/u],
  ['impact', /インパクト|衝撃|打撃/u],
  ['crowd', /群衆|ざわめき|人混み/u],
  ['fire', /焚き火|炎|火の音/u],
  ['water', /水|波|川|海/u],
  ['wind', /風/u],
  ['rain', /雨/u],
  ['door', /扉|ドア/u],
];

/** Aspect phrases. */
const ASPECTS = [
  ['square', /正方形|スクエア|1:1/u],
  ['landscape', /横長|横位置|16:9|ランドスケープ/u],
  ['portrait', /縦長|縦位置|9:16|ポートレート/u],
];

/** Command phrases removed from the text to leave the subject. */
const COMMAND_PATTERNS = [
  /(を|で)?(作って|つくって|作成して|生成して|書いて|かいて|描いて|えがいて|出して|ください|ほしい|欲しい|お願い(します)?|して|してね|してほしい)/gu,
  /^(ちょっと|少し|とりあえず|まず)/u,
  /(という|っていう)/gu,
];

/** Read a duration in the text as seconds. */
function readDuration(text) {
  const seconds = /(?<value>\d+(?:\.\d+)?)\s*(秒|s\b|sec(?:onds?)?)/iu.exec(text);
  if (seconds !== null) return Number(seconds.groups.value);
  const minutes = /(?<value>\d+(?:\.\d+)?)\s*(分|min(?:utes?)?)/iu.exec(text);
  if (minutes !== null) return Number(minutes.groups.value) * 60;
  return undefined;
}

/** Read a tempo in BPM. */
function readTempo(text) {
  const match = /(?<value>\d{2,3})\s*(?:bpm|テンポ)/iu.exec(text);
  if (match === null) return undefined;
  const value = Number(match.groups.value);
  return value >= 40 && value <= 240 ? value : undefined;
}

/** Read the musical key, for example `C`, `F#`, `Bb`. */
function readKey(text) {
  // The key must be followed by a mode word and preceded by a boundary, or
  // "BGM" would read as the key G.
  const match = /(?:^|[\s、,（(])(?<key>[A-G](?:#|b)?)\s*(?:メジャー|マイナー|major|minor|dur|moll)/iu.exec(text);
  return match === null ? undefined : match.groups.key;
}

/** Read the scale, mapping Japanese to the engine's names. */
function readScale(text) {
  if (/マイナー|minor|moll|短調/iu.test(text)) return 'minor';
  if (/メジャー|major|dur|長調/iu.test(text)) return 'major';
  return undefined;
}

/** Read an aspect phrase. */
function readAspect(text) {
  for (const [value, pattern] of ASPECTS) {
    if (pattern.test(text)) return value;
  }
  return undefined;
}

/** Pick the effect a prompt is asking for. */
export function readSfxKind(text) {
  for (const [kind, pattern] of SFX_WORDS) {
    if (pattern.test(text)) return kind;
  }
  return undefined;
}

/** Guess the writing language: kana or kanji means Japanese. */
export function readLanguage(text) {
  return /[\u3040-\u30ff\u4e00-\u9fff]/u.test(text) ? 'ja' : 'en';
}

/** Read simple label/number pairs, so a chart can be described in prose. */
function readChartData(text) {
  const pairs = [...text.matchAll(/(?<label>[^\s,、:：0-9]{1,20})\s*[:：=]?\s*(?<value>-?\d+(?:\.\d+)?)/gu)];
  if (pairs.length < 2) return undefined;
  return { labels: pairs.map((match) => match.groups.label), values: pairs.map((match) => Number(match.groups.value)) };
}

/** Which motion template a prompt is describing. */
function readMotionTemplate(text) {
  if (/ローワーサード|lower ?third|名前|肩書/u.test(text)) return 'lower_third';
  if (/ロゴ|アイデント|ident/u.test(text)) return 'ident';
  if (/グラフ|チャート|chart/u.test(text)) return 'chart';
  if (/背景|ループ|素材|shapes/u.test(text)) return 'shapes';
  if (/トランジション|切り替え|スティンガー|stinger/u.test(text)) return 'stinger';
  return 'title';
}

/** Capabilities that want the whole prompt as their brief. */
const WRITING = new Set(['lyrics', 'novel', 'article']);

/** Trailing particles and filler left over after cutting a noun phrase. */
const TRAILING = /[のをにがはで、,・\s]+$/u;

/** Words that describe the format rather than the subject. */
const FORMAT_WORDS = /正方形|横長|縦長|スクエア|ランドスケープ|ポートレート|ループ|繰り返し|縦位置|横位置/gu;

/** The text inside 「」 or 『』, when the prompt quotes a title. */
function readQuoted(text) {
  return /[「『](?<body>[^」』]{1,80})[」』]/u.exec(text)?.groups?.body?.trim();
}

/**
 * What the thing is about.
 *
 * For writing, the whole prompt is the brief. For generated media the noun
 * phrase before the artifact noun is the subject: "雨の効果音" is about 雨.
 */
function extractSubject(text, capability, nounIndex) {
  const cleaned = (value) =>
    value
      .replace(/\d+(?:\.\d+)?\s*(秒|s\b|sec(?:onds?)?|分|min(?:utes?)?)/giu, ' ')
      .replace(/\d{2,3}\s*(?:bpm|テンポ)/giu, ' ')
      .replace(FORMAT_WORDS, ' ')
      .replace(/^(この|その|あの|ちょっと|少し|とりあえず|まず)/u, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  if (WRITING.has(capability)) {
    let brief = text;
    for (const pattern of COMMAND_PATTERNS) brief = brief.replace(pattern, ' ');
    const result = cleaned(brief).replace(/[、,。．.!！?？]+$/gu, '');
    return result === '' ? text.trim() : result;
  }
  const quoted = readQuoted(text);
  if (quoted !== undefined && (capability === 'motion' || nounIndex <= 0)) return quoted;
  const head = nounIndex > 0 ? text.slice(0, nounIndex) : '';
  let candidate = cleaned(head).replace(TRAILING, '').replace(FORMAT_WORDS, '').trim();
  // A one-character subject such as 雨 or 風 is perfectly valid.
  // Music is described by a clause, not by a noun: 'a short bright jingle'
  // must not reduce to the adjective 短い.
  if (capability === 'music' && candidate.length < 4) candidate = cleaned(text).replace(/[、,。．\s]+$/u, '');
  if (candidate === '') candidate = cleaned(text).replace(/[、,。．.!！?？]+$/gu, '');
  if (candidate === '') candidate = text.trim();
  return candidate;
}

/**
 * Read one natural-language prompt.
 *
 * @param {string} text - what the user typed.
 * @param {object} [options] - `hint` forces a capability (a chip the user clicked).
 * @returns {{ capability: string, label: string, tool: string, confidence: number,
 *   matched: string[], subject: string, params: object, alternatives: string[] }}
 */
export function parseIntent(text, options = {}) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (prompt === '') {
    throw new Error('プロンプトが空です。何を作りたいか書いてください。The prompt is empty.');
  }
  const hint = typeof options.hint === 'string' && CAPABILITIES[options.hint] !== undefined ? options.hint : undefined;
  // Score every object noun by weight and by how late it appears. A trailing
  // noun is the head of the Japanese phrase, so it wins.
  const hits = [];
  for (const entry of OBJECTS) {
    for (const pattern of entry.patterns) {
      const match = pattern.exec(prompt);
      if (match === null) continue;
      hits.push({ capability: entry.capability, weight: entry.weight, index: match.index, word: match[0] });
    }
  }
  let capability;
  let confidence;
  let headIndex = -1;
  const matched = hits.map((hit) => hit.word);
  if (hint !== undefined) {
    capability = hint;
    confidence = 1;
    headIndex = hits.find((hit) => hit.capability === hint)?.index ?? -1;
  } else if (hits.length === 0) {
    capability = 'image';
    confidence = 0.2;
  } else {
    // The head of a Japanese phrase sits last, so the noun whose right edge is
    // latest decides; at equal edges the more specific word wins ("効果音"
    // beats the bare "音" inside it). A weak word ("音") only wins when no
    // stronger noun follows it.
    const rightEdge = (hit) => hit.index + hit.word.length;
    const head = hits.reduce((left, right) => {
      if (rightEdge(right) !== rightEdge(left)) return rightEdge(right) > rightEdge(left) ? right : left;
      return right.weight > left.weight ? right : left;
    });
    const strongest = hits.reduce((left, right) => (right.weight > left.weight ? right : left));
    // A weak word ("音", "sound") describes the topic, not the artifact, so it
    // only decides when no real artifact noun is present.
    const chosen = head.weight >= 3 ? head : strongest;
    capability = chosen.capability;
    headIndex = chosen.index;
    confidence = Math.min(1, 0.45 + 0.15 * hits.filter((hit) => hit.capability === capability).length);
  }
  const params = {};
  const duration = readDuration(prompt);
  // The duration is kept as asked; each tool clamps to its own limits, and an
  // effect can be 30 seconds while a piece is two minutes.
  if (duration !== undefined) params.duration = Math.min(600, Math.max(0.05, duration));
  const tempo = readTempo(prompt);
  if (tempo !== undefined) params.tempo = tempo;
  const key = readKey(prompt);
  if (key !== undefined) params.key = key;
  const scale = readScale(prompt);
  if (scale !== undefined) params.scale = scale;
  const aspect = readAspect(prompt);
  if (aspect !== undefined) params.aspect = aspect;
  params.language = readLanguage(prompt);
  if (capability === 'sfx') {
    const kind = readSfxKind(prompt);
    if (kind !== undefined) params.kind = kind;
  }
  if (capability === 'video' || capability === 'motion') {
    params.motionTemplate = readMotionTemplate(prompt);
  }
  if (capability === 'chart') {
    const data = readChartData(prompt);
    if (data !== undefined) {
      params.labels = data.labels;
      params.values = data.values;
    }
  }
  const alternatives = [...new Set(hits.filter((hit) => hit.capability !== capability).map((hit) => hit.capability))];
  return {
    capability,
    label: CAPABILITIES[capability].label,
    tool: CAPABILITIES[capability].tool,
    confidence: Math.round(confidence * 100) / 100,
    matched,
    subject: extractSubject(prompt, capability, headIndex),
    params,
    alternatives,
  };
}

/**
 * One sentence a person can check before the work starts.
 *
 * @param {object} intent - the result of `parseIntent`.
 * @returns {string} a short Japanese description.
 */
export function describeIntent(intent) {
  const bits = [intent.label];
  if (intent.params.kind !== undefined) bits.push(intent.params.kind);
  if (intent.params.duration !== undefined) bits.push(`${intent.params.duration} 秒`);
  if (intent.params.tempo !== undefined) bits.push(`${intent.params.tempo} BPM`);
  if (intent.params.key !== undefined) bits.push(`${intent.params.key}${intent.params.scale === 'minor' ? 'm' : ''}`);
  if (intent.params.aspect !== undefined) bits.push(intent.params.aspect);
  const subject = intent.subject === '' ? '' : `「${intent.subject}」`;
  return `${bits.join(' / ')}${subject === '' ? '' : ` として ${subject} を作ります`}`;
}

/**
 * The tool arguments for one intent.
 *
 * @param {object} intent - the result of `parseIntent`.
 * @returns {{ tool: string, args: object }}
 */
export function planIntent(intent) {
  const subject = intent.subject;
  const language = intent.params.language;
  switch (intent.capability) {
    case 'sfx':
      return {
        tool: 'generate_sfx',
        args: {
          kind: intent.params.kind ?? 'whoosh',
          // The effect engine accepts at most one minute per sound.
          ...(intent.params.duration === undefined ? {} : { duration: Math.min(60, intent.params.duration) }),
          name: shortTitle(subject) === '' ? undefined : shortTitle(subject),
        },
      };
    case 'music':
      return {
        tool: 'compose_music',
        args: {
          prompt: subject,
          ...(intent.params.tempo === undefined ? {} : { tempo: intent.params.tempo }),
          ...(intent.params.key === undefined ? {} : { key: intent.params.key }),
          ...(intent.params.scale === undefined ? {} : { scale: intent.params.scale }),
          title: shortTitle(subject) === '' ? undefined : shortTitle(subject),
        },
      };
    case 'speech':
      return { tool: 'generate_speech', args: { text: subject, language } };
    case 'lyrics':
      return {
        tool: 'write_lyrics',
        args: { brief: subject, language, ...(intent.params.tempo === undefined ? {} : { tempo: intent.params.tempo }) },
      };
    case 'novel':
      return { tool: 'write_novel', args: { mode: 'draft', brief: subject, language, title: shortTitle(subject) } };
    case 'article':
      return { tool: 'write_article', args: { mode: 'draft', topic: subject, language, title: shortTitle(subject) } };
    case 'motion':
      return { tool: 'make_motion_graphic', args: { text: shortTitle(subject, 40), template: 'title', ...(intent.params.duration === undefined ? {} : { seconds: intent.params.duration }) } };
    case 'chart':
      return {
        tool: 'render_chart',
        args: {
          title: subject,
          ...(intent.params.labels === undefined ? {} : { labels: intent.params.labels, values: intent.params.values }),
        },
      };
    case 'video':
      // 動画はコードで描く（Pillow + ffmpeg）。生成モデルは任意の追加手段として残す。
      return {
        tool: 'make_motion_graphic',
        args: {
          text: shortTitle(subject, 40),
          template: intent.params.motionTemplate ?? 'title',
          ...(intent.params.duration === undefined ? {} : { seconds: Math.min(10, Math.max(1, intent.params.duration)) }),
        },
      };
    // v3 の 3 領域は、タイムライン・部品仕様・編曲という構造を 1 文から作れない。
    // 呼び出し側が `args` に構造を渡す前提で、ツールだけを決める。
    case 'edit':
      return { tool: 'edit_video', args: {} };
    case 'cad':
      return { tool: 'cad_model', args: {} };
    case 'daw':
      return { tool: 'daw_arrange', args: {} };
    default:
      return {
        tool: 'generate_image',
        args: { prompt: subject, ...(intent.params.aspect === undefined ? {} : { aspect: intent.params.aspect }) },
      };
  }
}

/**
 * A short name for a file or a title.
 *
 * A whole brief makes an unusable file name, so the first clause is used and
 * the rest is dropped.
 *
 * @param {string} subject - what the prompt is about.
 * @param {number} [max] - longest accepted length.
 * @returns {string} a name of at most `max` characters.
 */
export function shortTitle(subject, max = 24) {
  const text = typeof subject === 'string' ? subject.trim() : '';
  if (text === '') return '';
  const first = text.split(/[、。,.!?！？\n]/u)[0].trim();
  const chosen = first === '' ? text : first;
  return chosen.length <= max ? chosen : `${chosen.slice(0, max)}`;
}

/** Example prompts the panel shows as chips. */
export const EXAMPLES = [  { hint: 'sfx', text: '雨の効果音を30秒、ループで' },
  { hint: 'music', text: '夜のドライブ向けのシティポップ、92 BPM、C マイナー' },
  { hint: 'lyrics', text: '終電を逃した二人の歌詞。サビのフックは「まだ帰らないで」' },
  { hint: 'novel', text: '離島の灯台守が、灯りを消してはいけない理由を知る小説の第1章' },
  { hint: 'article', text: '効果音を自作してゲームに組み込む手順を、1200字の記事で' },
  { hint: 'image', text: '夜明けの海辺に立つ灯台、横長、静かな色調' },
  { hint: 'speech', text: 'この案内文を落ち着いた声で読み上げて' },
  { hint: 'motion', text: 'タイトルカード「MEDIA STUDIO」を4秒' },
];
