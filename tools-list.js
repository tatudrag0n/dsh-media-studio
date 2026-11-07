/**
 * スタジオのツール一覧 (the single source of truth for tool names).
 *
 * パネルを廃止してテキストだけで使う運用に移るため、「どのツールを名前で
 * 呼べるか」を 1 か所に集める。`index.js`（パネルのルート）、`frontdoor.js`
 * （`media_create` の `tool`）、`project.js`（テキストのプロジェクトファイル）、
 * `status.js`（できることの一覧）が同じ配列を見る。
 *
 * `media_create` 自身はここに入れない。名前で呼べるようにすると自分を呼べて
 * しまうため。`summary` は 1 行の説明で、ツールが未登録のときの案内と
 * ドキュメントにだけ使う（実際の説明はツール定義が持っている）。
 */

/** Groups used by the text guide and by `studio_status`. */
export const STUDIO_GROUPS = [
  'image',
  'video',
  'editing',
  'graphics',
  'audio',
  'music',
  'writing',
  'cad',
  'library',
];

/** Every tool a text command may name, grouped by what it makes. */
export const STUDIO_TOOLS = [
  { name: 'generate_image', group: 'image', summary: '画像を生成する' },
  { name: 'edit_image', group: 'image', summary: '画像を加工する（切り抜き・色・合成）' },
  { name: 'generate_video', group: 'video', summary: '動画を生成する（text/image to video）' },
  { name: 'produce_video', group: 'video', summary: 'シーンを並べて 1 本の動画に仕上げる' },
  { name: 'make_motion_graphic', group: 'video', summary: 'モーショングラフィックスを描く' },
  { name: 'edit_video', group: 'editing', summary: 'タイムラインを編集して 1 本に書き出す（ffmpeg）' },
  { name: 'probe_video', group: 'editing', summary: '動画/音声の実体を調べる（ffprobe）' },
  { name: 'export_timeline', group: 'editing', summary: '編集を MLT/OTIO/FCPXML/EDL に書き出す' },
  { name: 'make_subtitles', group: 'editing', summary: 'SRT/VTT を作る' },
  { name: 'render_chart', group: 'graphics', summary: 'グラフを描く' },
  { name: 'generate_speech', group: 'audio', summary: '読み上げ音声を作る（TTS）' },
  { name: 'transcribe_audio', group: 'audio', summary: '音声を文字起こしする' },
  { name: 'generate_sfx', group: 'audio', summary: '効果音を作る' },
  { name: 'generate_music', group: 'music', summary: 'ノート列から曲を鳴らす' },
  { name: 'compose_music', group: 'music', summary: 'プロンプトから自動作曲する' },
  { name: 'daw_arrange', group: 'music', summary: 'マルチトラック編曲をミックスして WAV にする' },
  { name: 'export_daw_project', group: 'music', summary: 'MIDI/MusicXML/LMMS/Hydrogen に書き出す' },
  { name: 'import_midi', group: 'music', summary: 'MIDI を読んで編曲に戻す' },
  { name: 'write_lyrics', group: 'writing', summary: '歌詞を書く' },
  { name: 'write_novel', group: 'writing', summary: '小説を書く' },
  { name: 'write_article', group: 'writing', summary: '記事を書く' },
  { name: 'cad_model', group: 'cad', summary: 'パラメトリック 3D を作り STL/OBJ/GLB/PLY に出す' },
  { name: 'cad_drawing', group: 'cad', summary: '三面図を描く（PNG/SVG）' },
  { name: 'cad_export', group: 'cad', summary: '部品仕様を別形式に書き出す（DXF/SVG 含む）' },
  { name: 'attach_material', group: 'library', summary: '素材をライブラリに取り込む' },
  { name: 'list_media', group: 'library', summary: 'このセッションが作ったものを一覧する' },
  { name: 'list_assets', group: 'library', summary: '素材ライブラリを一覧する' },
  { name: 'remove_asset', group: 'library', summary: '素材ライブラリから消す（--dry-run あり）' },
  { name: 'asset_info', group: 'library', summary: '素材 1 件の情報を返す' },
  { name: 'studio_status', group: 'library', summary: 'できること・バックエンドの生存を返す' },
];

/** Every name a text command may use, as a set. */
export const STUDIO_TOOL_NAMES = new Set(STUDIO_TOOLS.map((tool) => tool.name));

/** One tool's catalogue entry, or undefined. */
export function studioTool(name) {
  return STUDIO_TOOLS.find((tool) => tool.name === name);
}

/** True when `name` is one of the studio's own tools. */
export function isStudioTool(name) {
  return typeof name === 'string' && STUDIO_TOOL_NAMES.has(name);
}
