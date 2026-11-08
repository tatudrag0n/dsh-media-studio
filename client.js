/**
 * Media Studio — Client half.
 *
 * Registers:
 *   - a sidebar panel ("メディアスタジオ" / "Media Studio") with three tabs:
 *     image generation, speech synthesis, and voice input (record or upload,
 *     then transcribe);
 *   - an audio player for the `generate_speech` tool call in the conversation;
 *   - its own locale dictionaries.
 *
 * Every value comes from the Host half's authenticated same-origin routes, so
 * no provider credential reaches the browser. Recording produces canonical
 * 16 kHz mono PCM16 WAV, the format the Host's speech-to-text provider accepts. */
window.__ModuleLoader__.load({
  id: '@local/dsh-media-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /** Locale namespace owned by this plugin. */
    const NS = 'media-studio';
    /** Sidebar panel id and the `main` slot key it selects. */
    const PANEL_ID = 'media-studio';
    /** Document-relative route prefix, so a mounted app keeps working. */
    const ROUTE = 'api/media-studio';
    /** Longest recording the panel keeps; the Host enforces its own ceiling. */
    const MAX_RECORD_SECONDS = 120;
    const DICTIONARIES = {
      en: {
        'panel.title': 'Media Studio',
        'panel.subtitle': 'Generate images, speech and multi-track music, and turn voice into text. Nothing leaves this machine unless you configure an API provider.',
        'panel.close': 'Close Media Studio',
        'tab.prompt': 'Prompt',
        'tab.image': 'Image',
        'tab.speech': 'Speech',
        'tab.transcribe': 'Voice input',
        'image.prompt': 'Describe the image',
        'image.placeholder': 'A quiet mountain lake at sunrise, soft watercolour',
        'image.aspect': 'Aspect',
        'image.aspect.square': 'Square',
        'image.aspect.landscape': 'Landscape',
        'image.aspect.portrait': 'Portrait',
        'image.generate': 'Generate image',
        'image.generating': 'Generating…',
        'image.empty': 'The generated image appears here.',
        'image.provider': 'Provider: {provider}',
        'image.download': 'Download PNG',
        'speech.text': 'Text to speak',
        'speech.placeholder': 'こんにちは。今日もいい天気ですね。',
        'speech.voice': 'Voice',
        'speech.rate': 'Rate',
        'speech.generate': 'Generate speech',
        'speech.generating': 'Generating…',
        'speech.empty': 'The generated audio appears here.',
        'speech.provider': 'Provider: {provider}',
        'speech.download': 'Download audio',
        'transcribe.record': 'Record',
        'transcribe.stop': 'Stop and transcribe',
        'transcribe.recording': 'Recording… {seconds}s',
        'transcribe.transcribing': 'Transcribing…',
        'transcribe.upload': 'Upload an audio file',
        'transcribe.empty': 'The transcript appears here; it stays editable.',
        'transcribe.provider': 'Engine: {provider}',
        'transcribe.language': 'Language',
        'transcribe.copy': 'Copy transcript',
        'transcribe.copied': 'Copied',
        'transcribe.preparing': 'The local speech model is not ready yet. The first transcription downloads it and can take several minutes.',
        'transcribe.micDenied': 'Microphone access was refused. Allow the microphone for this app, or upload a file instead.',
        'tab.music': 'Music',
        'music.score': 'Notes / score',
        'music.placeholder': 'C4:1 E4:1 G4:1 C5:2 rest:1 G4:1 E4:1 C4:2',
        'music.hint': 'Write "pitch:beats" tokens, e.g. C4:1. Separate chord notes with commas (C4,E4,G4). 1 beat = a quarter note.',
        'music.instrument': 'Instrument',
        'music.tempo': 'Tempo (BPM)',
        'music.generate': 'Generate music',
        'music.generating': 'Generating…',
        'music.empty': 'The generated music appears here.',
        'music.provider': 'Instrument: {instrument}, {tempo} BPM',
        'music.download': 'Download WAV',
        'music.mode': 'Input mode',
        'music.mode.grid': 'Grid',
        'music.mode.text': 'Text',
        'music.range': 'Range',
        'music.bars': 'Bars',
        'music.barsHint': '1-256 bars (4/4). 75 bars at 100 BPM is about 3 minutes.',
        'music.longPiece': 'This piece runs {bars} bars, so it stays in the score text. The step grid is for short pieces.',
        'music.resolution': 'Resolution',
        'music.clear': 'Clear',
        'music.gridHint': 'Click or drag cells to place notes; notes in one column play together.',
        'music.gridTruncated': 'The grid shows the first {shown} of {total} steps; the score text holds the whole piece.',
        'music.emptyGrid': 'Place at least one note on the grid.',
        'music.style': 'Style',
        'music.key': 'Key',
        'music.scale': 'Scale',
        'music.seed': 'Seed',
        'music.compose': 'Auto-compose',
        'music.composing': 'Composing…',
        'music.composeAgain': 'Another',
        'music.prompt': 'Prompt',
        'music.promptPlaceholder': 'dark ambient piano in D minor, slow, 8 bars',
        'music.promptHint': 'Describe the music in words: genre, mood, instruments, key, tempo, length. Japanese and English both work.',
        'music.promptGenerate': 'Generate from prompt',
        'music.promptGenerating': 'Reading the prompt…',
        'music.promptPlan': 'Read as',
        'music.group.synth': 'Synth',
        'music.group.soundfont': 'SoundFont (GM)',
        'music.drumKit': 'Drum kit',
        'music.soundfontActive': 'SoundFont bank (recorded instruments)',
        'music.tracks': 'Tracks',
        'music.track.add': 'Add track',
        'music.track.remove': 'Remove track',
        'music.track.name': 'Track name',
        'music.track.instrument': 'Track instrument',
        'music.track.select': 'Edit this track',
        'music.switching': 'Switching…',
        'music.warnings': 'Warnings',
        'music.textHint': 'The score text is the source of truth. Switching to Grid applies it (timing is quantised to the grid resolution).',
        'common.retry': 'Retry',
        'common.download': 'Download',
        'common.error': 'Something went wrong',
        'tab.video': 'Video',
        'video.prompt': 'Describe the video',
        'video.placeholder': 'A paper boat drifting down a rain gutter, slow push-in, soft watercolour animation',
        'video.negative': 'Avoid',
        'video.negativePlaceholder': 'blurry, distorted, watermark, text',
        'video.mode': 'Source',
        'video.modeText': 'From text',
        'video.modeImage': 'From a picture',
        'video.image': 'Picture to animate',
        'video.imageHint': 'Path of the picture in the workspace, or a full path on this machine.',
        'video.aspect': 'Aspect',
        'video.aspect.landscape': 'Landscape',
        'video.aspect.portrait': 'Portrait',
        'video.aspect.square': 'Square',
        'video.seconds': 'Length (seconds)',
        'video.fps': 'Frames per second',
        'video.recipe': 'Model',
        'video.seed': 'Seed',
        'video.generate': 'Generate video',
        'video.generating': 'Generating… this can take a few minutes on the first run',
        'video.empty': 'The generated video appears here.',
        'video.provider': 'Backend: {provider} · {model}',
        'video.recipeHint': '{note}',
        'video.download': 'Download MP4',
        'tab.graphics': 'Graphics',
        'graphics.mode.chart': 'Chart',
        'graphics.mode.edit': 'Edit a picture',
        'graphics.data': 'Data',
        'graphics.dataPlaceholder': 'Month\tSales\nJan\t120\nFeb\t148\nMar\t131',
        'graphics.dataRequired': 'Enter the chart data first.',
        'graphics.title': 'Title',
        'graphics.subtitle': 'Subtitle',
        'graphics.type': 'Chart',
        'graphics.type.bar': 'Bar',
        'graphics.type.hbar': 'Horizontal bar',
        'graphics.type.line': 'Line',
        'graphics.type.area': 'Area',
        'graphics.type.pie': 'Pie',
        'graphics.type.donut': 'Donut',
        'graphics.type.scatter': 'Scatter',
        'graphics.type.stacked': 'Stacked bar',
        'graphics.theme': 'Theme',
        'graphics.theme.light': 'Light',
        'graphics.theme.dark': 'Dark',
        'graphics.path': 'Picture',
        'graphics.pathRequired': 'Enter the picture path first.',
        'graphics.width': 'Width',
        'graphics.height': 'Height',
        'graphics.format': 'Format',
        'graphics.format.png': 'PNG',
        'graphics.format.jpeg': 'JPEG',
        'graphics.format.webp': 'WebP',
        'graphics.draw': 'Draw chart',
        'graphics.apply': 'Apply',
        'graphics.working': 'Working…',
        'graphics.empty': 'The result appears here.',
        'graphics.download': 'Download',
        'graphics.mode.motion': 'Animation',
        'motion.template': 'Template',
        'motion.template.title': 'Title card',
        'motion.template.lower_third': 'Lower third',
        'motion.template.ident': 'Logo ident',
        'motion.template.chart': 'Infographic',
        'motion.template.shapes': 'Motion background',
        'motion.template.stinger': 'Transition',
        'motion.text': 'Text',
        'motion.subtitle': 'Subtitle',
        'motion.style': 'Timing',
        'motion.style.smooth': 'Smooth',
        'motion.style.snappy': 'Snappy',
        'motion.style.dramatic': 'Dramatic',
        'motion.format': 'Format',
        'motion.format.mp4': 'MP4',
        'motion.format.webm': 'WebM',
        'motion.format.gif': 'GIF',
        'motion.seconds': 'Seconds',
        'motion.accent': 'Accent',
        'motion.data': 'Data',
        'motion.dataRequired': 'Enter the chart data first.',
        'motion.create': 'Create animation',
        'motion.working': 'Drawing frames…',
        'tab.production': 'Production',
        'tab.studio': 'Studio',
        'studio.intro': 'Run a studio tool directly: pick the tool, write its arguments as JSON, then run it.',
        'studio.tool': 'Tool',
        'studio.tool.edit_video': 'Timeline into one video file',
        'studio.tool.probe_video': 'Read the streams of a video file',
        'studio.tool.export_timeline': 'Write an editor project (MLT, OTIO, FCPXML, EDL)',
        'studio.tool.make_subtitles': 'Turn text into SRT or VTT subtitles',
        'studio.tool.cad_model': 'Build parametric 3D solids',
        'studio.tool.cad_drawing': 'Draw a 2D sheet from the parts',
        'studio.tool.cad_export': 'Write STL, OBJ, GLB, DXF or SVG',
        'studio.tool.daw_arrange': 'Render a multitrack arrangement to audio',
        'studio.tool.export_daw_project': 'Write MIDI, MusicXML, LMMS or Hydrogen',
        'studio.tool.import_midi': 'Read a MIDI file into an arrangement',
        'studio.args': 'Arguments (JSON)',
        'studio.argsPlaceholder': '{ "format": "mlt", "clips": ["clip.mp4"] }',
        'studio.sample': 'Fill an example',
        'studio.clear': 'Clear',
        'studio.run': 'Run',
        'studio.running': 'Running…',
        'studio.result': 'Result',
        'studio.path': 'File',
        'studio.empty': 'The result appears here.',
        'studio.badJson': 'Write the arguments as a JSON object.',
        'studio.unknownTool': 'Unknown tool.',
        'studio.error': 'The run failed.',
        'production.intro': 'Cut a video together from materials and drawn scenes. Nothing is generated by a remote model: every frame is drawn or shot here.',
        'production.materials': 'Materials',
        'production.materialsHint': 'Pictures, clips, music and logos. They are kept in the workspace, so a later production can reuse them.',
        'production.pick': 'Choose files to add',
        'production.uploading': 'Adding…',
        'production.materialsEmpty': 'No materials yet.',
        'production.removeMaterial': 'Remove this material',
        'production.scenes': 'Scenes',
        'production.scenesHint': 'The order of the scenes is the order of the video. A drawn scene, a picture with a slow move, or a trimmed clip.',
        'production.sceneType': 'Kind',
        'production.type.template': 'Drawn',
        'production.type.image': 'Picture',
        'production.type.clip': 'Clip',
        'production.template': 'Template',
        'production.material': 'Material',
        'production.materialNone': 'None',
        'production.text': 'Text',
        'production.textPlaceholder': 'The line on screen',
        'production.duration': 'Seconds',
        'production.transition': 'Transition',
        'production.transition.cut': 'Cut',
        'production.transition.fade': 'Dissolve',
        'production.data': 'Chart data',
        'production.extras': 'Background and logo',
        'production.backgroundNone': 'No background picture',
        'production.logoNone': 'No logo',
        'production.moveUp': 'Move up',
        'production.moveDown': 'Move down',
        'production.removeScene': 'Remove this scene',
        'production.addScene': 'Add a scene',
        'production.export': 'Export',
        'production.width': 'Width',
        'production.height': 'Height',
        'production.fps': 'Frames per second',
        'production.format': 'Format',
        'production.narration': 'Narration',
        'production.narrationPlaceholder': 'The words spoken over the video',
        'production.create': 'Produce the video',
        'production.working': 'Cutting the scenes together…',
        'production.empty': 'The finished video appears here.',
        'production.download': 'Download the video',
      },
      ja: {
        'panel.title': 'メディアスタジオ',
        'panel.subtitle': '画像生成・音声合成・マルチトラックの音楽制作・音声入力（文字起こし）をここで試せます。API プロバイダを設定しない限り、データはこのマシンの外に出ません。',
        'panel.close': 'メディアスタジオを閉じる',
        'tab.prompt': 'プロンプト',
        'tab.image': '画像',
        'tab.speech': '音声',
        'tab.transcribe': '音声入力',
        'image.prompt': '画像の説明',
        'image.placeholder': '夜明けの静かな山あいの湖、やわらかな水彩',
        'image.aspect': '比率',
        'image.aspect.square': '正方形',
        'image.aspect.landscape': '横長',
        'image.aspect.portrait': '縦長',
        'image.generate': '画像を生成',
        'image.generating': '生成中…',
        'image.empty': '生成した画像がここに表示されます。',
        'image.provider': 'プロバイダ: {provider}',
        'image.download': 'PNG をダウンロード',
        'speech.text': '読み上げるテキスト',
        'speech.placeholder': 'こんにちは。今日もいい天気ですね。',
        'speech.voice': '声',
        'speech.rate': '速さ',
        'speech.generate': '音声を生成',
        'speech.generating': '生成中…',
        'speech.empty': '生成した音声がここに表示されます。',
        'speech.provider': 'プロバイダ: {provider}',
        'speech.download': '音声をダウンロード',
        'transcribe.record': '録音',
        'transcribe.stop': '停止して文字起こし',
        'transcribe.recording': '録音中… {seconds}秒',
        'transcribe.transcribing': '文字起こし中…',
        'transcribe.upload': '音声ファイルを選択',
        'transcribe.empty': '文字起こしの結果がここに表示されます。そのまま編集できます。',
        'transcribe.provider': 'エンジン: {provider}',
        'transcribe.language': '言語',
        'transcribe.copy': '文字起こしをコピー',
        'transcribe.copied': 'コピーしました',
        'transcribe.preparing': 'ローカル音声モデルがまだ準備できていません。初回の文字起こしでダウンロードするため、数分かかることがあります。',
        'transcribe.micDenied': 'マイクへのアクセスが拒否されました。このアプリにマイクを許可するか、ファイルをアップロードしてください。',
        'tab.music': '音楽',
        'music.score': '音符 / スコア',
        'music.placeholder': 'C4:1 E4:1 G4:1 C5:2 rest:1 G4:1 E4:1 C4:2',
        'music.hint': '「音名:拍数」を並べます（例: C4:1）。和音はカンマ区切り（C4,E4,G4）。1拍 = 4分音符。',
        'music.instrument': '楽器',
        'music.tempo': 'テンポ (BPM)',
        'music.generate': '音楽を生成',
        'music.generating': '生成中…',
        'music.empty': '生成した音楽がここに表示されます。',
        'music.provider': '楽器: {instrument}, {tempo} BPM',
        'music.download': 'WAV をダウンロード',
        'music.mode': '入力モード',
        'music.mode.grid': 'グリッド',
        'music.mode.text': 'テキスト',
        'music.range': '音域',
        'music.bars': '小節数',
        'music.barsHint': '1〜256 小節（4/4）。100 BPM で 75 小節 ≒ 3 分です。',
        'music.longPiece': 'この曲が {bars} 小節と長いため、スコアテキストで保持しています。グリッドは短い曲向けです。',
        'music.resolution': '分解能',
        'music.clear': 'クリア',
        'music.gridHint': 'セルをクリック／ドラッグで音符を置きます。同じ列の音符は同時に鳴ります。',
        'music.gridTruncated': 'グリッドは {total} ステップのうち先頭 {shown} まで表示します。曲全体はスコアテキストに残ります。',
        'music.emptyGrid': 'グリッドに音符を1つ以上置いてください。',
        'music.style': 'スタイル',
        'music.key': 'キー',
        'music.scale': 'スケール',
        'music.seed': 'シード',
        'music.compose': '自動作曲',
        'music.composing': '作曲中…',
        'music.composeAgain': '別の案',
        'music.prompt': 'プロンプト',
        'music.promptPlaceholder': '暗いアンビエントのピアノ、D マイナー、ゆっくり、8 小節',
        'music.promptHint': '音楽の内容を手書きで指定します。ジャンル・気分・楽器・キー・テンポ・長さ。日本語でも英語でもOK。',
        'music.promptGenerate': 'プロンプトから生成',
        'music.promptGenerating': 'プロンプトを解釈中…',
        'music.promptPlan': '解釈結果',
        'music.group.synth': 'シンセ',
        'music.group.soundfont': 'SoundFont (GM)',
        'music.drumKit': 'ドラムキット',
        'music.soundfontActive': 'SoundFont（実録音の楽器）',
        'music.tracks': 'トラック',
        'music.track.add': 'トラックを追加',
        'music.track.remove': 'トラックを削除',
        'music.track.name': 'トラック名',
        'music.track.instrument': 'トラックの楽器',
        'music.track.select': 'このトラックを編集',
        'music.switching': '切り替え中…',
        'music.warnings': '警告',
        'music.textHint': 'スコアテキストが正本です。グリッドに切り替えると内容が反映されます（タイミングはグリッド分解能に量子化されます）。',
        'common.retry': '再試行',
        'common.download': 'ダウンロード',
        'common.error': '問題が発生しました',
        'tab.video': '動画',
        'video.prompt': '動画の説明',
        'video.placeholder': '雨樋を流れる紙のボート、ゆっくり寄るカメラ、やわらかな水彩アニメーション',
        'video.negative': '避けたい要素',
        'video.negativePlaceholder': 'ぼやけ、歪み、透かし、文字',
        'video.mode': '入力',
        'video.modeText': 'テキストから',
        'video.modeImage': '画像から',
        'video.image': '動かす画像',
        'video.imageHint': 'ワークスペース内の画像パス、またはこのマシンのフルパスを指定します。',
        'video.aspect': '比率',
        'video.aspect.landscape': '横長',
        'video.aspect.portrait': '縦長',
        'video.aspect.square': '正方形',
        'video.seconds': '長さ (秒)',
        'video.fps': 'フレームレート',
        'video.recipe': 'モデル',
        'video.seed': 'シード',
        'video.generate': '動画を生成',
        'video.generating': '生成中… 初回の実行は数分かかることがあります',
        'video.empty': '生成した動画がここに表示されます。',
        'video.provider': 'バックエンド: {provider} · {model}',
        'video.recipeHint': '{note}',
        'video.download': 'MP4 をダウンロード',
        'tab.graphics': 'グラフィック',
        'graphics.mode.chart': 'グラフ',
        'graphics.mode.edit': '画像加工',
        'graphics.data': 'データ',
        'graphics.dataPlaceholder': '月\t売上\n1月\t120\n2月\t148\n3月\t131',
        'graphics.dataRequired': '先にグラフのデータを入力してください。',
        'graphics.title': 'タイトル',
        'graphics.subtitle': 'サブタイトル',
        'graphics.type': 'グラフの種類',
        'graphics.type.bar': '棒',
        'graphics.type.hbar': '横棒',
        'graphics.type.line': '折れ線',
        'graphics.type.area': '面',
        'graphics.type.pie': '円',
        'graphics.type.donut': 'ドーナツ',
        'graphics.type.scatter': '散布図',
        'graphics.type.stacked': '積み上げ棒',
        'graphics.theme': '配色',
        'graphics.theme.light': 'ライト',
        'graphics.theme.dark': 'ダーク',
        'graphics.path': '画像',
        'graphics.pathRequired': '先に画像のパスを入力してください。',
        'graphics.width': '幅',
        'graphics.height': '高さ',
        'graphics.format': '形式',
        'graphics.format.png': 'PNG',
        'graphics.format.jpeg': 'JPEG',
        'graphics.format.webp': 'WebP',
        'graphics.draw': 'グラフを描く',
        'graphics.apply': '加工する',
        'graphics.working': '処理中…',
        'graphics.empty': '結果がここに表示されます。',
        'graphics.download': 'ダウンロード',
        'graphics.mode.motion': 'アニメーション',
        'motion.template': 'テンプレート',
        'motion.template.title': 'タイトルカード',
        'motion.template.lower_third': 'ロワーサード',
        'motion.template.ident': 'ロゴ',
        'motion.template.chart': 'インフォグラフィック',
        'motion.template.shapes': '背景映像',
        'motion.template.stinger': 'トランジション',
        'motion.text': 'テキスト',
        'motion.subtitle': 'サブタイトル',
        'motion.style': 'タイミング',
        'motion.style.smooth': 'スムーズ',
        'motion.style.snappy': 'スナッピー',
        'motion.style.dramatic': 'ドラマティック',
        'motion.format': '形式',
        'motion.format.mp4': 'MP4',
        'motion.format.webm': 'WebM',
        'motion.format.gif': 'GIF',
        'motion.seconds': '秒数',
        'motion.accent': 'アクセント',
        'motion.data': 'データ',
        'motion.dataRequired': '先にグラフのデータを入力してください。',
        'motion.create': 'アニメーションを作る',
        'motion.working': 'フレームを描画中…',
        'tab.production': '制作',
        'tab.studio': 'スタジオ',
        'studio.intro': 'メディアスタジオのツールを直接実行します。ツールを選び、引数を JSON で書いて実行してください。',
        'studio.tool': 'ツール',
        'studio.tool.edit_video': 'タイムラインから動画を書き出す',
        'studio.tool.probe_video': '動画ファイルの情報を調べる',
        'studio.tool.export_timeline': '編集ソフト用プロジェクトを書き出す（MLT / OTIO / FCPXML / EDL）',
        'studio.tool.make_subtitles': 'テキストから字幕を作る（SRT / VTT）',
        'studio.tool.cad_model': 'パラメトリックな 3D ソリッドを作る',
        'studio.tool.cad_drawing': '部品から 2D 図面を描く',
        'studio.tool.cad_export': 'STL / OBJ / GLB / DXF / SVG に書き出す',
        'studio.tool.daw_arrange': 'マルチトラック編曲を音声にする',
        'studio.tool.export_daw_project': 'MIDI / MusicXML / LMMS / Hydrogen に書き出す',
        'studio.tool.import_midi': 'MIDI ファイルを編曲として読み込む',
        'studio.args': '引数 (JSON)',
        'studio.argsPlaceholder': '{ "format": "mlt", "clips": ["clip.mp4"] }',
        'studio.sample': '例を入れる',
        'studio.clear': 'クリア',
        'studio.run': '実行',
        'studio.running': '実行中…',
        'studio.result': '結果',
        'studio.path': 'ファイル',
        'studio.empty': '結果がここに表示されます。',
        'studio.badJson': '引数は JSON のオブジェクトで書いてください。',
        'studio.unknownTool': '知らないツールです。',
        'studio.error': '実行に失敗しました。',
        'production.intro': '素材と描いたシーンを切って動画にします。外部のモデルでは生成しないので、どのフレームもここで描画的・撮影されたものです。',
        'production.materials': '素材',
        'production.materialsHint': '画像・動画・音楽・ロゴです。ワークスペースに保存されるので、あとから使い回せます。',
        'production.pick': 'ファイルを選んで追加',
        'production.uploading': '追加中…',
        'production.materialsEmpty': 'まだ素材がありません。',
        'production.removeMaterial': 'この素材を削除',
        'production.scenes': '構成',
        'production.scenesHint': 'シーンの並びがそのまま動画の並びになります。描いたシーン・ゆっくり動かした画像・切り詰めた動画。',
        'production.sceneType': '種類',
        'production.type.template': '描画',
        'production.type.image': '画像',
        'production.type.clip': '動画素材',
        'production.template': 'テンプレート',
        'production.material': '素材',
        'production.materialNone': 'なし',
        'production.text': 'テキスト',
        'production.textPlaceholder': '画面に出る一文',
        'production.duration': '秒数',
        'production.transition': 'つなぎ方',
        'production.transition.cut': 'カット',
        'production.transition.fade': 'ディゾルブ',
        'production.data': 'グラフデータ',
        'production.extras': '背景とロゴ',
        'production.backgroundNone': '背景画像はなし',
        'production.logoNone': 'ロゴはなし',
        'production.moveUp': '上へ',
        'production.moveDown': '下へ',
        'production.removeScene': 'このシーンを削除',
        'production.addScene': 'シーンを追加',
        'production.export': '書き出し',
        'production.width': '幅',
        'production.height': '高さ',
        'production.fps': 'フレームレート',
        'production.format': '形式',
        'production.narration': 'ナレーション',
        'production.narrationPlaceholder': '動画の上で喋る台詞',
        'production.create': '動画を制作する',
        'production.working': 'シーンを連結中…',
        'production.empty': '完成した動画がここに表示されます。',
        'production.download': '動画をダウンロード',
      },
    };
    const CSS = `.mstudio-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.mstudio-shell{max-width:920px;margin:0 auto;padding:28px 28px 64px;display:flex;flex-direction:column;gap:18px;box-sizing:border-box}
.mstudio-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.mstudio-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.01em}
.mstudio-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;max-width:64ch}
.mstudio-close{appearance:none;flex:none;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mstudio-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mstudio-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mstudio-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:9px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.mstudio-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.mstudio-tab:hover{color:var(--dsw-alias-label-primary)}
.mstudio-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:18px;display:flex;flex-direction:column;gap:12px}
.mstudio-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mstudio-input,.mstudio-textarea,.mstudio-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;padding:9px 11px}
.mstudio-input:focus-visible,.mstudio-textarea:focus-visible,.mstudio-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mstudio-textarea{min-height:96px;resize:vertical;line-height:1.5}
.mstudio-textarea.short{min-height:64px}
.mstudio-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.mstudio-field{display:flex;flex-direction:column;gap:5px;min-width:150px}
.mstudio-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;text-decoration:none}
.mstudio-button:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.mstudio-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mstudio-button:disabled{opacity:.55;cursor:default}
.mstudio-button.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.mstudio-button.primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}
.mstudio-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;white-space:pre-wrap;margin:0}
.mstudio-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:0}
.mstudio-preview{display:flex;align-items:center;justify-content:center;min-height:120px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.mstudio-image{max-width:100%;max-height:460px;border-radius:8px;display:block}
.mstudio-video{width:100%;max-height:460px;border-radius:8px;display:block;background:#000}
.mstudio-audio{width:100%}
.mstudio-meter{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.mstudio-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:mstudio-pulse 1s ease-in-out infinite}
@keyframes mstudio-pulse{0%,100%{opacity:1}
50%{opacity:.35}
}
.mstudio-tool{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.mstudio-tool-title{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5}
.mstudio-tool-pending{color:var(--dsw-alias-label-secondary);flex-direction:row;align-items:center}
.mstudio-tool-hint{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.mstudio-glyph{display:inline-flex;align-items:center;justify-content:center}
.mstudio-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.mstudio-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px 12px;cursor:pointer}
.mstudio-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mstudio-gridwrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);max-height:420px;padding:8px}
.mstudio-grid{display:grid;gap:2px;width:max-content}
.mstudio-cell{appearance:none;box-sizing:border-box;padding:0;width:20px;height:15px;border:1px solid var(--dsw-alias-border-l1);border-radius:3px;background:var(--dsw-alias-bg-base);cursor:pointer}
.mstudio-cell:hover{border-color:var(--dsw-alias-label-secondary)}
.mstudio-cell.black{background:var(--dsw-alias-bg-layer-2)}
.mstudio-cell.bar{border-left:2px solid var(--dsw-alias-border-l2)}
.mstudio-cell.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.mstudio-cell.play{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-warn-primary)}
.mstudio-key{font-size:10px;line-height:15px;height:15px;color:var(--dsw-alias-label-secondary);text-align:right;padding-right:6px;white-space:nowrap;user-select:none;cursor:pointer}
.mstudio-key:hover{color:var(--dsw-alias-label-primary)}
.mstudio-key.black{opacity:.62}
.mstudio-step{font-size:9px;line-height:14px;height:14px;color:var(--dsw-alias-label-secondary);text-align:center;user-select:none}
.mstudio-step.bar{color:var(--dsw-alias-label-primary)}
.mstudio-tracks{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-layer-1)}
.mstudio-track{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:8px}
.mstudio-track.active{outline:1px solid var(--dsw-alias-brand-primary)}
.mstudio-track-pick{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:13px;line-height:1;cursor:pointer;padding:0 4px}
.mstudio-track-name{flex:0 1 150px;min-width:80px}
.mstudio-score-text{min-height:260px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre}
.mstudio-section{display:flex;flex-direction:column;gap:10px}
.mstudio-heading{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em}
.mstudio-subheading{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.mstudio-file{appearance:none;display:block;width:100%;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:14px;text-align:center;cursor:pointer}
.mstudio-file:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.mstudio-materials{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.mstudio-material{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px;background:var(--dsw-alias-bg-layer-2)}
.mstudio-thumb{width:46px;height:34px;flex:none;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-base)}
.mstudio-thumbicon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.mstudio-materialmeta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.mstudio-materialname{font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mstudio-materialsize{font-size:11px;color:var(--dsw-alias-label-secondary)}
.mstudio-scene{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-2)}
.mstudio-scene .mstudio-field{flex:1 1 130px;min-width:110px}
.mstudio-scene .mstudio-wide{flex:1 1 100%}
.mstudio-sceneindex{width:22px;height:22px;flex:none;border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;display:inline-flex;align-items:center;justify-content:center}
.mstudio-sceneactions{display:flex;gap:4px;align-items:center}
.mstudio-iconbtn{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.mstudio-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.mstudio-iconbtn:disabled{opacity:.4;cursor:default}
`;
    /** Locale service face captured at apply time. */
    let localeFace;
    /** Local dictionary text, preferring the registered locale dictionaries. */
    function translate(key, params) {
      try {
        if (localeFace !== undefined && typeof localeFace.bind === 'function') {
          const bound = localeFace.bind(NS);
          const value = bound(key, params);
          if (typeof value === 'string' && value !== '' && value !== key) return value;
        }
      } catch {
        // Fall through to the bundled dictionary.
      }
      const browser = typeof navigator !== 'undefined' ? navigator.language : 'en';
      const language = String(browser ?? 'en').toLowerCase().split('-')[0];
      const dictionary = DICTIONARIES[language] ?? DICTIONARIES.en;
      const text = dictionary[key] ?? DICTIONARIES.en[key] ?? key;
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }
    /** Bound translator for a component, honouring the framework-provided `t`. */
    function translatorFor(props) {
      return typeof props?.t === 'function' ? props.t : translate;
    }
    const ICON_PATHS = {
      image: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z', 'M4 16l4.5-4.5 3.5 3.5 3-3L20 16', 'M9 9.5h.01'],
      video: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h9A1.5 1.5 0 0 1 16 6.5v11A1.5 1.5 0 0 1 14.5 19h-9A1.5 1.5 0 0 1 4 17.5z', 'M16 10l4-2.5v9L16 14z'],
      chart: ['M4 19h16', 'M7 19v-6', 'M12 19V7', 'M17 19v-9'],
      waveform: ['M4 12h2', 'M8 8v8', 'M12 5v14', 'M16 9v6', 'M20 12h1'],
      note: ['M9 17V5l11-2v12', 'M9 17a3 3 0 1 1-6 0a3 3 0 0 1 6 0', 'M20 15a3 3 0 1 1-6 0a3 3 0 0 1 6 0'],
      sparkles: ['M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z', 'M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z'],
      mic: ['M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v3', 'M9 20h6'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      download: ['M12 4v10', 'M8 11l4 4 4-4', 'M5 19h14'],
      copy: ['M9 9h9v11H9z', 'M6 15V4h9'],
    };
    /** Shared inline icon; inherits the surrounding text color. */
    function Icon({ name, size = 16 }) {
      const paths = ICON_PATHS[name] ?? ICON_PATHS.image;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        className: 'mstudio-glyph',
      }, paths.map((d) => h('path', { key: d, d })));
    }
    /** Inline stylesheet, unmounted with the panel. */
    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }
    // #region Transport helpers
    /** Parse a JSON error body into a message. */
    async function failureMessage(response) {
      try {
        const payload = await response.json();
        const message = payload?.error?.message;
        if (typeof message === 'string' && message !== '') return message;
      } catch {
        // Fall through to the status line.
      }
      return `HTTP ${response.status}`;
    }
    /** GET a JSON document from the Host half. */
    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(await failureMessage(response));
      return await response.json();
    }
    /** POST a JSON body and return the binary response as a Blob. */
    async function postJsonForBlob(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      return await response.blob();
    }
    /** POST a JSON body and return the JSON response. */
    async function postJsonForJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      return await response.json();
    }
    /** POST canonical WAV bytes and return the transcript object. */
    async function postWavForText(bytes, language) {
      const query = typeof language === 'string' && language !== '' ? `?language=${encodeURIComponent(language)}` : '';
      const response = await fetch(`${ROUTE}/transcribe${query}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: bytes,
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      return await response.json();
    }
    // #endregion
    // #region Audio capture and WAV encoding
    /** Write a little-endian ASCII tag into a byte array. */
    function writeAscii(bytes, offset, value) {
      for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
    }
    /** Encode mono Float32 samples as a canonical 16 kHz PCM16 WAV. */
    function encodeWav16k(samples) {
      const frames = samples.length;
      const bytes = new Uint8Array(44 + frames * 2);
      const view = new DataView(bytes.buffer);
      writeAscii(bytes, 0, 'RIFF');
      view.setUint32(4, 36 + frames * 2, true);
      writeAscii(bytes, 8, 'WAVE');
      writeAscii(bytes, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(bytes, 36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let index = 0; index < frames; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      }
      return bytes;
    }
    /** Decode any browser-decodable audio into 16 kHz mono PCM16 WAV. */
    async function toWav16k(input) {
      const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
      const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
      if (typeof AudioContextClass !== 'function') throw new Error('この環境では音声をデコードできません。');
      const decoder = new AudioContextClass();
      let decoded;
      try {
        decoded = await decoder.decodeAudioData(buffer.slice(0));
      } finally {
        await decoder.close?.().catch?.(() => {});
      }
      const seconds = Math.min(decoded.duration, MAX_RECORD_SECONDS);
      const frames = Math.max(1, Math.floor(seconds * 16000));
      const renderer = new OfflineAudioContext(1, frames, 16000);
      const source = renderer.createBufferSource();
      source.buffer = decoded;
      source.connect(renderer.destination);
      source.start();
      const rendered = await renderer.startRendering();
      return encodeWav16k(rendered.getChannelData(0));
    }
    // #endregion
    // #region Panel components
    /** The sidebar glyph: an image frame crossed with a waveform. */
    function MediaStudioIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        className: 'mstudio-glyph',
      }, [
        h('rect', { key: 'frame', x: 3.5, y: 4, width: 17, height: 12.5, rx: 2.4 }),
        h('path', { key: 'hill', d: 'M5 14.5l3.6-3.6 2.8 2.8 2.4-2.4L19 16' }),
        h('circle', { key: 'sun', cx: 8.2, cy: 7.8, r: 1.1 }),
        h('path', { key: 'wave', d: 'M6 20.2v-1.4M9.6 20.2v-2.8M13.2 20.2v-1.9M16.8 20.2v-3.4M20.4 20.2v-1.4' }),
      ]);
    }
    /** Full-panel page registered into the `main` slot. */
    /**
     * One prompt, any capability: the front door of the studio.
     *
     * The user writes a sentence; the Host decides which tool to run and
     * returns the finished file. Nothing here needs a tool name or a parameter
     * form, which is the point.
     */
    /** Kinds the sound-effect editor offers, most useful first. */
    const SFX_KIND_LIST = ['rain', 'wind', 'fire', 'water', 'whoosh', 'impact', 'click', 'pop', 'beep', 'notification', 'chime', 'bell', 'alarm', 'laser', 'powerup', 'coin', 'magic', 'glitch', 'static', 'explosion', 'footsteps', 'door', 'camera-shutter', 'typing', 'page-turn', 'crowd', 'horror-drone', 'heartbeat', 'engine', 'riser', 'downlifter', 'transition', 'reverse-cymbal', 'swoosh', 'sub-drop'];

    /** Styles the music editor offers. */
    const MUSIC_STYLE_LIST = ['pop', 'ballad', 'chiptune', 'ambient', 'edm'];

    /** Keys the music editor offers. */
    const MUSIC_KEY_LIST = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    /** Starting values for the editor of one result. */
    function editorDefaults(result) {
      const params = result?.params ?? {};
      if (result?.capability === 'music') {
        return {
          style: 'pop',
          key: params.key ?? 'C',
          scale: params.scale ?? 'major',
          tempo: params.tempo ?? 120,
          bars: 8,
        };
      }
      return {
        kind: params.kind ?? 'whoosh',
        duration: params.duration ?? 1,
        intensity: 0.6,
        brightness: 0.5,
        variation: 0,
        loop: false,
      };
    }

    /** One labelled control row. */
    function EditorField({ label, children }) {
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', margin: '3px 0' } }, [
        h('span', { key: 'l', style: { minWidth: '68px', opacity: 0.75 } }, label),
        h('span', { key: 'c', style: { flex: 1, display: 'flex', alignItems: 'center', gap: '6px' } }, children),
      ]);
    }

    /** Inline controls for the knobs a person actually turns. */
    function MediaEditor({ result, busy, onRerun }) {
      const [values, setValues] = React.useState(() => editorDefaults(result));
      const signature = `${result?.capability ?? ''}:${result?.summary ?? ''}`;
      React.useEffect(() => {
        setValues(editorDefaults(result));
      }, [signature]);
      if (result === undefined) return null;
      const capability = result.capability;
      if (capability !== 'sfx' && capability !== 'music') return null;
      const update = (patch) => setValues((current) => ({ ...current, ...patch }));
      const controls =
        capability === 'music'
          ? [
              h(EditorField, { key: 'style', label: 'スタイル' },
                h('select', { value: values.style, onChange: (event) => update({ style: event.target.value }) },
                  MUSIC_STYLE_LIST.map((name) => h('option', { key: name, value: name }, name)))),
              h(EditorField, { key: 'key', label: 'キー' },
                h('select', { value: values.key, onChange: (event) => update({ key: event.target.value }) },
                  MUSIC_KEY_LIST.map((name) => h('option', { key: name, value: name }, name))),
                h('select', { value: values.scale, onChange: (event) => update({ scale: event.target.value }) },
                  h('option', { value: 'major' }, 'メジャー'),
                  h('option', { value: 'minor' }, 'マイナー'))),
              h(EditorField, { key: 'tempo', label: 'テンポ' },
                h('input', {
                  type: 'range', min: 40, max: 200, step: 1, value: values.tempo,
                  onChange: (event) => update({ tempo: Number(event.target.value) }),
                  style: { flex: 1 },
                }),
                h('span', { style: { width: '58px', textAlign: 'right' } }, `${values.tempo} BPM`)),
              h(EditorField, { key: 'bars', label: '小節数' },
                h('input', {
                  type: 'number', min: 1, max: 64, value: values.bars,
                  onChange: (event) => update({ bars: Math.max(1, Math.min(64, Number(event.target.value) || 1)) }),
                  style: { width: '70px' },
                })),
            ]
          : [
              h(EditorField, { key: 'kind', label: '種類' },
                h('select', { value: values.kind, onChange: (event) => update({ kind: event.target.value }) },
                  SFX_KIND_LIST.map((name) => h('option', { key: name, value: name }, name)))),
              h(EditorField, { key: 'duration', label: '長さ' },
                h('input', {
                  type: 'number', min: 0.05, max: 60, step: 0.05, value: values.duration,
                  onChange: (event) => update({ duration: Math.max(0.05, Math.min(60, Number(event.target.value) || 0.05)) }),
                  style: { width: '80px' },
                }),
                h('span', { style: { opacity: 0.6 } }, '秒'),
                h('label', { style: { marginLeft: '8px', display: 'flex', alignItems: 'center', gap: '4px' } },
                  h('input', { type: 'checkbox', checked: values.loop, onChange: (event) => update({ loop: event.target.checked }) }),
                  h('span', null, 'ループ'))),
              h(EditorField, { key: 'intensity', label: '強さ' },
                h('input', {
                  type: 'range', min: 0, max: 1, step: 0.05, value: values.intensity,
                  onChange: (event) => update({ intensity: Number(event.target.value) }),
                  style: { flex: 1 },
                }),
                h('span', { style: { width: '34px', textAlign: 'right' } }, values.intensity.toFixed(2))),
              h(EditorField, { key: 'brightness', label: '明るさ' },
                h('input', {
                  type: 'range', min: 0, max: 1, step: 0.05, value: values.brightness,
                  onChange: (event) => update({ brightness: Number(event.target.value) }),
                  style: { flex: 1 },
                }),
                h('span', { style: { width: '34px', textAlign: 'right' } }, values.brightness.toFixed(2))),
              h(EditorField, { key: 'variation', label: '別テイク' },
                h('input', {
                  type: 'range', min: 0, max: 1, step: 0.05, value: values.variation,
                  onChange: (event) => update({ variation: Number(event.target.value) }),
                  style: { flex: 1 },
                }),
                h('span', { style: { width: '34px', textAlign: 'right' } }, values.variation.toFixed(2))),
            ];
      return h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(127,127,127,0.25)' } }, [
        h('div', { key: 'title', style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, '調整して作り直す'),
        ...controls,
        h('button', {
          key: 'rerun',
          type: 'button',
          disabled: busy,
          style: {
            marginTop: '8px',
            padding: '6px 14px',
            borderRadius: '8px',
            border: 'none',
            background: busy ? 'rgba(127,127,127,0.4)' : 'var(--dsh-accent, #4a7dff)',
            color: '#fff',
            font: 'inherit',
            fontSize: '12px',
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
          },
          onClick: () => onRerun(values),
        }, busy ? '生成中…' : 'この設定で作り直す'),
      ]);
    }

    function PromptTab() {
      const [text, setText] = React.useState('');
      const [hint, setHint] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [result, setResult] = React.useState(undefined);
      const chips = [
        ['効果音', '雨の効果音を30秒、ループで', 'sfx'],
        ['音楽', '夜のドライブ向けのシティポップ、92 BPM、C マイナー', 'music'],
        ['歌詞', '終電を逃した二人の歌詞。サビは「まだ帰らないで」', 'lyrics'],
        ['小説', '離島の灯台守が、灯りを消してはいけない理由を知る小説の第1章', 'novel'],
        ['記事', '効果音を自作してゲームに組み込む手順を、1200字の記事で', 'article'],
        ['画像', '夜明けの海辺に立つ灯台、横長、静かな色調', 'image'],
        ['読み上げ', 'ようこそ、メディアスタジオへ。', 'speech'],
        ['モーション', 'タイトルカード「MEDIA STUDIO」を4秒', 'motion'],
      ];
      const run = async (overrides) => {
        const prompt = text.trim();
        if (prompt === '' || busy) return;
        setBusy(true);
        setError(undefined);
        try {
          setResult(await postJsonForJson(`${ROUTE}/run`, { prompt, hint, args: overrides }));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      };
      const media = result?.media;
      const source = media?.base64 === undefined ? undefined : `data:${media.mime};base64,${media.base64}`;
      const mime = media === undefined ? '' : String(media.mime);
      const preview =
        source === undefined
          ? result?.text === undefined || result.text === ''
            ? null
            : h('pre', { style: { whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: '12px', lineHeight: 1.6 } }, result.text)
          : mime.startsWith('audio/')
            ? h('audio', { controls: true, src: source, style: { width: '100%', marginTop: '8px' } })
            : mime.startsWith('video/')
              ? h('video', { controls: true, src: source, style: { width: '100%', marginTop: '8px' } })
              : h('img', { src: source, alt: result?.summary ?? '', style: { maxWidth: '100%', marginTop: '8px', borderRadius: '8px' } });
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h(
          'p',
          { key: 'lead', style: { margin: 0, fontSize: '12px', opacity: 0.75 } },
          '作りたいものを一文で書いてください。種類は自動で判定します。',
        ),
        h('textarea', {
          key: 'input',
          value: text,
          rows: 3,
          placeholder: '例: 雨の効果音を30秒、ループで',
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: '13px',
          },
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void run();
            }
          },
        }),
        h(
          'div',
          { key: 'chips', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          chips.map(([label, example, key]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                title: example,
                style: {
                  padding: '4px 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
                  background: hint === key ? 'var(--dsh-accent, #4a7dff)' : 'transparent',
                  color: hint === key ? '#fff' : 'inherit',
                  font: 'inherit',
                  fontSize: '12px',
                  cursor: 'pointer',
                },
                onClick: () => {
                  setText(example);
                  setHint(key);
                },
              },
              label,
            ),
          ),
        ),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
          h(
            'button',
            {
              key: 'run',
              type: 'button',
              disabled: busy,
              style: {
                padding: '7px 18px',
                borderRadius: '8px',
                border: 'none',
                background: busy ? 'rgba(127,127,127,0.4)' : 'var(--dsh-accent, #4a7dff)',
                color: '#fff',
                font: 'inherit',
                fontSize: '13px',
                fontWeight: 600,
                cursor: busy ? 'default' : 'pointer',
              },
              onClick: () => void run(),
            },
            busy ? '生成中…' : '生成',
          ),
          h('span', { key: 'hint', style: { fontSize: '11px', opacity: 0.6 } }, busy ? '実行しています…' : 'Ctrl + Enter でも実行'),
        ]),
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        result === undefined
          ? null
          : h('div', { key: 'result', style: { padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,0.08)' } }, [
              h('p', { key: 'summary', style: { margin: 0, fontSize: '12px', fontWeight: 600 } }, `解釈: ${result.summary}`),
              result.note === undefined ? null : h('p', { key: 'note', style: { margin: '4px 0 0', fontSize: '11px', opacity: 0.75 } }, result.note),
              preview,
              h(MediaEditor, { key: 'editor', result, busy, onRerun: (args) => run(args) }),
            ]),
      ]);
    }

    function MediaStudioPage(props) {
      const t = translatorFor(props);
      const [tab, setTab] = React.useState('image');
      const [showTabs, setShowTabs] = React.useState(false);
      const [capabilities, setCapabilities] = React.useState(undefined);
      const [capabilityError, setCapabilityError] = React.useState(undefined);
      React.useEffect(() => {
        let cancelled = false;
        getJson(`${ROUTE}/capabilities`)
          .then((value) => {
            if (!cancelled) setCapabilities(value);
          })
          .catch((cause) => {
            if (!cancelled) setCapabilityError(String(cause?.message ?? cause));
          });
        return () => {
          cancelled = true;
        };
      }, []);
      const close = typeof props.close === 'function' ? props.close : undefined;
      const tabs = [];
      return h('div', { className: 'mstudio-root' }, [
        h(Styles, { key: 'styles' }),
        h('div', { key: 'shell', className: 'mstudio-shell' }, [
          h('header', { key: 'head', className: 'mstudio-head' }, [
            h('div', { key: 'copy' }, [
              h('h1', { key: 'title', className: 'mstudio-title' }, t('panel.title')),
              h('p', { key: 'sub', className: 'mstudio-sub' }, t('panel.subtitle')),
            ]),
            close === undefined
              ? null
              : h('button', {
                key: 'close',
                type: 'button',
                className: 'mstudio-close',
                title: t('panel.close'),
                'aria-label': t('panel.close'),
                onClick: () => close(),
              }, h(Icon, { name: 'close', size: 16 })),
          ]),
          null,
          null,
          null,
          capabilityError === undefined
            ? null
            : h('p', { key: 'capa-error', className: 'mstudio-error' }, capabilityError),
          null,
          null,
          null,
          null,
          null,
          null,
        ]),
      ]);
    }
    /** Tools the studio tab lists, in display order. */
    const STUDIO_TOOLS = Object.freeze([
      { name: 'edit_video' },
      { name: 'probe_video' },
      { name: 'export_timeline' },
      { name: 'make_subtitles' },
      { name: 'cad_model' },
      { name: 'cad_drawing' },
      { name: 'cad_export' },
      { name: 'daw_arrange' },
      { name: 'export_daw_project' },
      { name: 'import_midi' },
    ]);

    /** The smallest argument object each tool accepts, used by "fill an example". */
    const STUDIO_SAMPLES = Object.freeze({
      edit_video: { clips: ['clip.mp4'] },
      probe_video: { path: 'clip.mp4' },
      export_timeline: { format: 'mlt', clips: ['clip.mp4'] },
      make_subtitles: { text: 'こんにちは。今日はいい天気ですね。', duration: 4 },
      cad_model: { parts: [{ type: 'box' }] },
      cad_drawing: { parts: [{ type: 'box' }] },
      cad_export: { parts: [{ type: 'box' }], format: 'stl' },
      daw_arrange: { score: 'C4:1 E4:1 G4:1 C5:2', tempo: 120 },
      export_daw_project: { format: 'mid', score: 'C4:1 E4:1', tempo: 120 },
      import_midi: { path: 'clip.mid' },
    });

    /** The tools the studio tab offers, in display order. */
    function studioTools() {
      return STUDIO_TOOLS.map((entry) => ({ name: entry.name }));
    }

    /** Every listed tool is reachable through the panel's tool route. */
    function studioRunnable(name) {
      return STUDIO_TOOLS.some((entry) => entry.name === name);
    }

    /** Pretty-printed minimal arguments for one tool, or '' when the tool is unknown. */
    function studioSample(name) {
      return Object.hasOwn(STUDIO_SAMPLES, name) ? JSON.stringify(STUDIO_SAMPLES[name], null, 2) : '';
    }

    /** The tool-route body for one tool; a thrown message is a locale key. */
    function studioRequest(name, text) {
      if (!STUDIO_TOOLS.some((candidate) => candidate.name === name)) throw new Error('studio.unknownTool');
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '') return { tool: name, args: {} };
      let args;
      try {
        args = JSON.parse(trimmed);
      } catch {
        throw new Error('studio.badJson');
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('studio.badJson');
      return { tool: name, args };
    }

    /**
     * Studio tab: run one of the edit, CAD and DTM tools with JSON arguments.
     *
     * The Host's tool route runs any tool this plugin registers, so every tool
     * the tab lists is runnable; the arguments travel as one JSON object.
     */
    function StudioTab({ t = (key) => key } = {}) {
      const [toolName, setToolName] = React.useState(STUDIO_TOOLS[0].name);
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [result, setResult] = React.useState(undefined);
      const [errorKey, setErrorKey] = React.useState(undefined);
      const entry = STUDIO_TOOLS.find((candidate) => candidate.name === toolName) ?? STUDIO_TOOLS[0];

      /** Put a working argument object in the box. */
      function fillSample() {
        setText(studioSample(entry.name));
        setErrorKey(undefined);
      }

      /** Send the box to the run route and show what came back. */
      async function run() {
        setErrorKey(undefined);
        setResult(undefined);
        let request;
        try {
          request = studioRequest(entry.name, text);
        } catch (error) {
          setErrorKey(typeof error?.message === 'string' && error.message !== '' ? error.message : 'studio.error');
          return;
        }
        setBusy(true);
        try {
          setResult(await postJsonForJson(`${ROUTE}/tool`, request));
        } catch (error) {
          setErrorKey(typeof error?.message === 'string' && error.message !== '' ? error.message : 'studio.error');
        } finally {
          setBusy(false);
        }
      }

      const media = result?.media;
      const mime = typeof media?.mime === 'string' ? media.mime : '';
      const source = typeof media?.base64 === 'string' ? `data:${mime};base64,${media.base64}` : undefined;
      const preview = source === undefined
        ? null
        : mime.startsWith('video/')
          ? h('video', { key: 'preview', className: 'mstudio-video', src: source, controls: true })
          : mime.startsWith('audio/')
            ? h('audio', { key: 'preview', className: 'mstudio-audio', src: source, controls: true })
            : mime.startsWith('image/')
              ? h('img', { key: 'preview', className: 'mstudio-image', src: source, alt: t('studio.result') })
              : null;
      const outputPath = typeof result?.value?.path === 'string' ? result.value.path : undefined;

      return h('div', { className: 'mstudio-section' },
        h('p', { className: 'mstudio-label' }, t('studio.intro')),
        h('label', { className: 'mstudio-field', htmlFor: 'mstudio-studio-tool' },
          h('span', { className: 'mstudio-label' }, t('studio.tool')),
          h('select', {
            id: 'mstudio-studio-tool',
            className: 'mstudio-select',
            value: entry.name,
            onChange: (event) => {
              setToolName(event.target.value);
              setErrorKey(undefined);
              setResult(undefined);
            },
          }, STUDIO_TOOLS.map((candidate) => h('option', {
            key: candidate.name,
            value: candidate.name,
          }, `${candidate.name} — ${t(`studio.tool.${candidate.name}`)}`)))),
        h('label', { className: 'mstudio-field', htmlFor: 'mstudio-studio-json' },
          h('span', { className: 'mstudio-label' }, t('studio.args')),
          h('textarea', {
            id: 'mstudio-studio-json',
            className: 'mstudio-textarea',
            rows: 10,
            spellCheck: false,
            placeholder: t('studio.argsPlaceholder'),
            value: text,
            onChange: (event) => setText(event.target.value),
          })),
        h('div', { className: 'mstudio-row' },
          h('button', { key: 'sample', type: 'button', className: 'mstudio-button', onClick: fillSample }, t('studio.sample')),
          h('button', { key: 'clear', type: 'button', className: 'mstudio-button', onClick: () => setText('') }, t('studio.clear')),
          h('button', {
            key: 'run',
            type: 'button',
            className: 'mstudio-button',
            disabled: busy,
            onClick: run,
          }, busy ? t('studio.running') : t('studio.run'))),
        errorKey === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, t(errorKey)),
        result === undefined
          ? h('p', { key: 'empty', className: 'mstudio-label' }, t('studio.empty'))
          : h('div', { key: 'result', className: 'mstudio-card' },
            h('h3', { className: 'mstudio-subheading' }, t('studio.result')),
            h('p', { className: 'mstudio-label' }, `${result.tool ?? entry.name} · ${result.summary ?? ''}`.trim()),
            typeof result.text === 'string' && result.text !== ''
              ? h('pre', { key: 'text', className: 'mstudio-textarea' }, result.text)
              : null,
            outputPath === undefined
              ? null
              : h('p', { key: 'path', className: 'mstudio-label' }, `${t('studio.path')}: ${outputPath}`),
            preview));
    }

    /** Image generation tab. */
    function ImageTab({ t, capabilities }) {
      const [prompt, setPrompt] = React.useState('');
      const [aspect, setAspect] = React.useState('square');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [result, setResult] = React.useState(undefined);
      const urlRef = React.useRef(undefined);
      React.useEffect(() => () => revokeUrl(urlRef), []);
      const provider = capabilities?.image?.provider ?? '…';
      const aspects = capabilities?.image?.aspects ?? ['square', 'landscape', 'portrait'];
      async function generate() {
        if (busy) return;
        const text = prompt.trim();
        if (text === '') {
          setError(t('image.prompt'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/image`, { prompt: text, aspect });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({ url, bytes: blob.size, type: blob.type || 'image/png' });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      return h('section', { className: 'mstudio-card' }, [
        h('label', { key: 'label', className: 'mstudio-label', htmlFor: 'mstudio-image-prompt' }, t('image.prompt')),
        h('textarea', {
          key: 'prompt',
          id: 'mstudio-image-prompt',
          className: 'mstudio-textarea',
          placeholder: t('image.placeholder'),
          value: prompt,
          onChange: (event) => setPrompt(event.target.value),
        }),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('div', { key: 'aspect', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-aspect' }, t('image.aspect')),
            h('select', {
              key: 's',
              id: 'mstudio-aspect',
              className: 'mstudio-select',
              value: aspect,
              onChange: (event) => setAspect(event.target.value),
            }, aspects.map((entry) => h('option', { key: entry, value: entry }, t(`image.aspect.${entry}`)))),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: generate,
          }, h(Icon, { name: 'image', size: 15 }), busy ? t('image.generating') : t('image.generate')),
        ]),
        h('p', { key: 'provider', className: 'mstudio-note' }, t('image.provider', { provider })),
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        h('div', { key: 'preview', className: 'mstudio-preview' },
          result === undefined
            ? t('image.empty')
            : h('img', { className: 'mstudio-image', src: result.url, alt: prompt })),
        result === undefined
          ? null
          : h('div', { key: 'actions', className: 'mstudio-row' }, [
            h('a', {
              key: 'download',
              className: 'mstudio-button',
              href: result.url,
              download: `media-studio-${Date.now()}.${result.type === 'image/jpeg' ? 'jpg' : 'png'}`,
            }, h(Icon, { name: 'download', size: 15 }), t('image.download')),
          ]),
      ]);
    }
    /** Video production tab: materials, a scene list, and the export. */
    function VideoTab({ t, capabilities }) {
      const [materials, setMaterials] = React.useState([]);
      const [scenes, setScenes] = React.useState([newScene('title')]);
      const [width, setWidth] = React.useState(String(capabilities?.production?.defaultWidth ?? 1280));
      const [height, setHeight] = React.useState(String(capabilities?.production?.defaultHeight ?? 720));
      const [fps, setFps] = React.useState(String(capabilities?.production?.defaultFps ?? 30));
      const [format, setFormat] = React.useState('mp4');
      const [narration, setNarration] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [uploading, setUploading] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [result, setResult] = React.useState(undefined);
      const urlRef = React.useRef(undefined);

      React.useEffect(() => () => revokeUrl(urlRef), []);

      const templates = Array.isArray(capabilities?.production?.templates) ? capabilities.production.templates : ['title', 'lower_third', 'ident', 'chart', 'shapes', 'stinger'];
      const sceneTypes = Array.isArray(capabilities?.production?.sceneTypes) ? capabilities.production.sceneTypes : ['template', 'image', 'clip'];
      const transitions = Array.isArray(capabilities?.production?.transitions) ? capabilities.production.transitions : ['cut', 'fade'];
      const formats = Array.isArray(capabilities?.production?.formats) ? capabilities.production.formats : ['mp4', 'webm'];
      const chartTypes = Array.isArray(capabilities?.production?.chartTypes) ? capabilities.production.chartTypes : ['bar', 'line', 'area', 'pie'];
      const maxScenes = capabilities?.production?.maxScenes ?? 12;

      const images = materials.filter((entry) => entry.kind === 'image');
      const videos = materials.filter((entry) => entry.kind === 'video');

      /** Read the material library. */
      async function refreshMaterials() {
        try {
          const payload = await getJson(`${ROUTE}/assets`);
          setMaterials(Array.isArray(payload?.assets) ? payload.assets : []);
        } catch {
          setMaterials([]);
        }
      }

      React.useEffect(() => {
        refreshMaterials();
      }, []);

      /** Put the picked files into the library. */
      async function upload(event) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length === 0) return;
        setUploading(true);
        setError(undefined);
        try {
          for (const file of files) {
            const buffer = await file.arrayBuffer();
            const response = await fetch(`${ROUTE}/assets`, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream', 'x-file-name': file.name },
              body: buffer,
            });
            if (!response.ok) throw new Error(await failureMessage(response));
          }
          await refreshMaterials();
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setUploading(false);
        }
      }

      /** Remove one material from the library. */
      async function removeMaterial(id) {
        try {
          await postJsonForJson(`${ROUTE}/asset-delete`, { id });
          await refreshMaterials();
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }

      /** Change one scene. */
      function updateScene(index, patch) {
        setScenes((current) => current.map((scene, position) => (position === index ? { ...scene, ...patch } : scene)));
      }

      /** Add a scene after the last one. */
      function addScene() {
        setScenes((current) => (current.length >= maxScenes ? current : [...current, newScene('title')]));
      }

      /** Remove one scene. */
      function removeScene(index) {
        setScenes((current) => (current.length <= 1 ? current : current.filter((_scene, position) => position !== index)));
      }

      /** Move a scene up or down. */
      function moveScene(index, delta) {
        setScenes((current) => {
          const target = index + delta;
          if (target < 0 || target >= current.length) return current;
          const next = [...current];
          const [scene] = next.splice(index, 1);
          next.splice(target, 0, scene);
          return next;
        });
      }

      /** Cut the production together. */
      async function produce() {
        if (busy) return;
        setBusy(true);
        setError(undefined);
        try {
          const payload = scenes.map((scene) => ({
            type: scene.type,
            ...(scene.type === 'template' ? { template: scene.template } : {}),
            ...(scene.text.trim() === '' ? {} : { text: scene.text.trim() }),
            ...(scene.subtitle.trim() === '' ? {} : { subtitle: scene.subtitle.trim() }),
            duration: Number(scene.duration),
            transition: scene.transition,
            ...(scene.type === 'template' ? {} : { materialId: scene.materialId }),
            ...(scene.type === 'template' && scene.template === 'chart' ? { chartType: scene.chartType, data: scene.data } : {}),
            ...(scene.backgroundImageId === '' ? {} : { backgroundImageId: scene.backgroundImageId }),
            ...(scene.logoId === '' ? {} : { logoId: scene.logoId }),
          }));
          const blob = await postJsonForBlob(`${ROUTE}/production`, {
            scenes: payload,
            width: Number(width),
            height: Number(height),
            fps: Number(fps),
            format,
            ...(narration.trim() === '' ? {} : { narration: narration.trim() }),
          });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({ url, bytes: blob.size });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }

      const materialRow = h('div', { key: 'materials', className: 'mstudio-section' }, [
        h('h3', { key: 'h', className: 'mstudio-heading' }, t('production.materials')),
        h('p', { key: 'hint', className: 'mstudio-subheading' }, t('production.materialsHint')),
        h('label', { key: 'pick', className: 'mstudio-file' }, [
          h('input', {
            key: 'input',
            type: 'file',
            multiple: true,
            style: { display: 'none' },
            onChange: upload,
          }),
          uploading ? t('production.uploading') : t('production.pick'),
        ]),
        materials.length === 0
          ? h('p', { key: 'empty', className: 'mstudio-subheading' }, t('production.materialsEmpty'))
          : h('div', { key: 'list', className: 'mstudio-materials' }, materials.map((entry) => h('div', { key: entry.id, className: 'mstudio-material' }, [
            entry.kind === 'image'
              ? h('img', { key: 'thumb', className: 'mstudio-thumb', src: `${ROUTE}/asset-file?id=${encodeURIComponent(entry.id)}`, alt: entry.name })
              : h('span', { key: 'icon', className: 'mstudio-thumb mstudio-thumbicon' }, h(Icon, { name: entry.kind === 'video' ? 'video' : entry.kind === 'audio' ? 'waveform' : 'image', size: 16 })),
            h('span', { key: 'meta', className: 'mstudio-materialmeta' }, [
              h('span', { key: 'name', className: 'mstudio-materialname', title: entry.name }, entry.name),
              h('span', { key: 'size', className: 'mstudio-materialsize' }, formatBytes(entry.bytes)),
            ]),
            h('button', {
              key: 'remove',
              type: 'button',
              className: 'mstudio-iconbtn',
              title: t('production.removeMaterial'),
              onClick: () => removeMaterial(entry.id),
            }, '✕'),
          ]))),
      ]);

      const sceneRows = h('div', { key: 'scenes', className: 'mstudio-section' }, [
        h('h3', { key: 'h', className: 'mstudio-heading' }, t('production.scenes')),
        h('p', { key: 'hint', className: 'mstudio-subheading' }, t('production.scenesHint')),
        ...scenes.map((scene, index) => h('div', { key: `scene-${index}`, className: 'mstudio-scene' }, [
          h('span', { key: 'index', className: 'mstudio-sceneindex' }, String(index + 1)),
          h('div', { key: 'type', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label' }, t('production.sceneType')),
            h('select', {
              key: 's',
              className: 'mstudio-select',
              value: scene.type,
              onChange: (event) => updateScene(index, { type: event.target.value }),
            }, sceneTypes.map((entry) => h('option', { key: entry, value: entry }, t(`production.type.${entry}`)))),
          ]),
          scene.type === 'template'
            ? h('div', { key: 'template', className: 'mstudio-field' }, [
              h('label', { key: 'l', className: 'mstudio-label' }, t('production.template')),
              h('select', {
                key: 's',
                className: 'mstudio-select',
                value: scene.template,
                onChange: (event) => updateScene(index, { template: event.target.value }),
              }, templates.map((entry) => h('option', { key: entry, value: entry }, t(`motion.template.${entry}`)))),
            ])
            : h('div', { key: 'material', className: 'mstudio-field' }, [
              h('label', { key: 'l', className: 'mstudio-label' }, t('production.material')),
              h('select', {
                key: 's',
                className: 'mstudio-select',
                value: scene.materialId,
                onChange: (event) => updateScene(index, { materialId: event.target.value }),
              }, [
                h('option', { key: 'none', value: '' }, t('production.materialNone')),
                ...(scene.type === 'clip' ? videos : images).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
              ]),
            ]),
          h('div', { key: 'text', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label' }, t('production.text')),
            h('input', {
              key: 'i',
              className: 'mstudio-input',
              value: scene.text,
              placeholder: t('production.textPlaceholder'),
              onChange: (event) => updateScene(index, { text: event.target.value }),
            }),
          ]),
          h('div', { key: 'duration', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label' }, t('production.duration')),
            h('input', {
              key: 'i',
              className: 'mstudio-input',
              type: 'number',
              min: 0.5,
              max: 30,
              step: 0.5,
              value: scene.duration,
              onChange: (event) => updateScene(index, { duration: event.target.value }),
            }),
          ]),
          index < scenes.length - 1
            ? h('div', { key: 'transition', className: 'mstudio-field' }, [
              h('label', { key: 'l', className: 'mstudio-label' }, t('production.transition')),
              h('select', {
                key: 's',
                className: 'mstudio-select',
                value: scene.transition,
                onChange: (event) => updateScene(index, { transition: event.target.value }),
              }, transitions.map((entry) => h('option', { key: entry, value: entry }, t(`production.transition.${entry}`)))),
            ])
            : null,
          scene.type === 'template' && scene.template === 'chart'
            ? h('div', { key: 'data', className: 'mstudio-field mstudio-wide' }, [
              h('label', { key: 'l', className: 'mstudio-label' }, t('production.data')),
              h('div', { key: 'row', className: 'mstudio-row' }, [
                h('select', {
                  key: 'type',
                  className: 'mstudio-select',
                  value: scene.chartType,
                  onChange: (event) => updateScene(index, { chartType: event.target.value }),
                }, chartTypes.map((entry) => h('option', { key: entry, value: entry }, t(`graphics.type.${entry}`)))),
                h('textarea', {
                  key: 'text',
                  className: 'mstudio-textarea short',
                  placeholder: '1月,2月,3月\n120,148,131',
                  value: scene.data,
                  onChange: (event) => updateScene(index, { data: event.target.value }),
                }),
              ]),
            ])
            : null,
          scene.type === 'template'
            ? h('div', { key: 'extras', className: 'mstudio-field mstudio-wide' }, [
              h('label', { key: 'l', className: 'mstudio-label' }, t('production.extras')),
              h('div', { key: 'row', className: 'mstudio-row' }, [
                h('select', {
                  key: 'bg',
                  className: 'mstudio-select',
                  value: scene.backgroundImageId,
                  onChange: (event) => updateScene(index, { backgroundImageId: event.target.value }),
                }, [
                  h('option', { key: 'none', value: '' }, t('production.backgroundNone')),
                  ...images.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
                ]),
                h('select', {
                  key: 'logo',
                  className: 'mstudio-select',
                  value: scene.logoId,
                  onChange: (event) => updateScene(index, { logoId: event.target.value }),
                }, [
                  h('option', { key: 'none', value: '' }, t('production.logoNone')),
                  ...images.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
                ]),
              ]),
            ])
            : null,
          h('div', { key: 'actions', className: 'mstudio-sceneactions' }, [
            h('button', {
              key: 'up',
              type: 'button',
              className: 'mstudio-iconbtn',
              title: t('production.moveUp'),
              disabled: index === 0,
              onClick: () => moveScene(index, -1),
            }, '↑'),
            h('button', {
              key: 'down',
              type: 'button',
              className: 'mstudio-iconbtn',
              title: t('production.moveDown'),
              disabled: index === scenes.length - 1,
              onClick: () => moveScene(index, 1),
            }, '↓'),
            h('button', {
              key: 'remove',
              type: 'button',
              className: 'mstudio-iconbtn',
              title: t('production.removeScene'),
              disabled: scenes.length <= 1,
              onClick: () => removeScene(index),
            }, '✕'),
          ]),
        ])),
        h('div', { key: 'add', className: 'mstudio-row' }, [
          h('button', {
            key: 'add',
            type: 'button',
            className: 'mstudio-button',
            disabled: scenes.length >= maxScenes,
            onClick: addScene,
          }, h(Icon, { name: 'sparkles', size: 15 }), t('production.addScene')),
        ]),
      ]);

      const exportRow = h('div', { key: 'export', className: 'mstudio-section' }, [
        h('h3', { key: 'h', className: 'mstudio-heading' }, t('production.export')),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('div', { key: 'width', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-production-width' }, t('production.width')),
            h('input', {
              key: 'i',
              id: 'mstudio-production-width',
              className: 'mstudio-input',
              type: 'number',
              min: 240,
              max: 1920,
              step: 2,
              value: width,
              onChange: (event) => setWidth(event.target.value),
            }),
          ]),
          h('div', { key: 'height', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-production-height' }, t('production.height')),
            h('input', {
              key: 'i',
              id: 'mstudio-production-height',
              className: 'mstudio-input',
              type: 'number',
              min: 240,
              max: 1920,
              step: 2,
              value: height,
              onChange: (event) => setHeight(event.target.value),
            }),
          ]),
          h('div', { key: 'fps', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-production-fps' }, t('production.fps')),
            h('select', {
              key: 's',
              id: 'mstudio-production-fps',
              className: 'mstudio-select',
              value: fps,
              onChange: (event) => setFps(event.target.value),
            }, [24, 25, 30, 60].map((entry) => h('option', { key: entry, value: String(entry) }, String(entry)))),
          ]),
          h('div', { key: 'format', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-production-format' }, t('production.format')),
            h('select', {
              key: 's',
              id: 'mstudio-production-format',
              className: 'mstudio-select',
              value: format,
              onChange: (event) => setFormat(event.target.value),
            }, formats.map((entry) => h('option', { key: entry, value: entry }, entry.toUpperCase()))),
          ]),
        ]),
        h('div', { key: 'narration', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-production-narration' }, t('production.narration')),
          h('input', {
            key: 'i',
            id: 'mstudio-production-narration',
            className: 'mstudio-input',
            placeholder: t('production.narrationPlaceholder'),
            value: narration,
            onChange: (event) => setNarration(event.target.value),
          }),
        ]),
        h('div', { key: 'actions', className: 'mstudio-row' }, [
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: produce,
          }, h(Icon, { name: 'video', size: 15 }), busy ? t('production.working') : t('production.create')),
        ]),
      ]);

      return h('section', { className: 'mstudio-card' }, [
        h('p', { key: 'intro', className: 'mstudio-note' }, t('production.intro')),
        materialRow,
        sceneRows,
        exportRow,
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        h('div', { key: 'preview', className: 'mstudio-preview' },
          result === undefined
            ? t('production.empty')
            : h('video', { className: 'mstudio-video', controls: true, preload: 'metadata', src: result.url })),
        result === undefined
          ? null
          : h('div', { key: 'downloadrow', className: 'mstudio-row' }, [
            h('a', {
              key: 'download',
              className: 'mstudio-button',
              href: result.url,
              download: `media-studio-production-${Date.now()}.${format}`,
            }, h(Icon, { name: 'download', size: 15 }), t('production.download')),
          ]),
      ]);
    }

    /** A fresh scene for the production list. */
    function newScene(template) {
      return {
        type: 'template',
        template,
        text: '',
        subtitle: '',
        duration: '3',
        transition: 'fade',
        materialId: '',
        backgroundImageId: '',
        logoId: '',
        chartType: 'bar',
        data: '',
      };
    }
    /** Chart drawing and picture editing tab. */
    function GraphicsTab({ t, capabilities }) {
      const [mode, setMode] = React.useState('chart');
      const [chartType, setChartType] = React.useState('bar');
      const [title, setTitle] = React.useState('');
      const [subtitle, setSubtitle] = React.useState('');
      const [data, setData] = React.useState('');
      const [theme, setTheme] = React.useState('light');
      const [imagePath, setImagePath] = React.useState('');
      const [imageWidth, setImageWidth] = React.useState('');
      const [imageHeight, setImageHeight] = React.useState('');
      const [imageFormat, setImageFormat] = React.useState('png');
      const [motionTemplate, setMotionTemplate] = React.useState('title');
      const [motionStyle, setMotionStyle] = React.useState('smooth');
      const [motionFormat, setMotionFormat] = React.useState('mp4');
      const [motionText, setMotionText] = React.useState('');
      const [motionSubtitle, setMotionSubtitle] = React.useState('');
      const [motionData, setMotionData] = React.useState('');
      const [motionChartType, setMotionChartType] = React.useState('bar');
      const [motionSeconds, setMotionSeconds] = React.useState('4');
      const [motionAccent, setMotionAccent] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [result, setResult] = React.useState(undefined);
      const urlRef = React.useRef(undefined);
      React.useEffect(() => () => revokeUrl(urlRef), []);
      React.useEffect(() => {
        const preferred = capabilities?.graphics?.defaultTheme;
        if (typeof preferred === 'string' && preferred !== '') setTheme(preferred);
      }, [capabilities]);
      const chartTypes = Array.isArray(capabilities?.graphics?.chartTypes)
        ? capabilities.graphics.chartTypes
        : ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked'];
      const themes = Array.isArray(capabilities?.graphics?.themes) ? capabilities.graphics.themes : ['light', 'dark'];
      const formats = Array.isArray(capabilities?.graphics?.imageFormats) ? capabilities.graphics.imageFormats : ['png', 'jpeg', 'webp'];
      const motionTemplates = Array.isArray(capabilities?.motion?.templates)
        ? capabilities.motion.templates
        : ['title', 'lower_third', 'ident', 'chart', 'shapes', 'stinger'];
      const motionStyles = Array.isArray(capabilities?.motion?.styles) ? capabilities.motion.styles : ['smooth', 'snappy', 'dramatic'];
      const motionFormats = Array.isArray(capabilities?.motion?.formats) ? capabilities.motion.formats : ['mp4', 'webm', 'gif'];
      async function drawChart() {
        if (busy) return;
        if (data.trim() === '') {
          setError(t('graphics.dataRequired'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/chart`, {
            type: chartType,
            ...(title.trim() === '' ? {} : { title: title.trim() }),
            ...(subtitle.trim() === '' ? {} : { subtitle: subtitle.trim() }),
            ...(data.trim() === '' ? {} : { data: data }),
            theme,
          });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({ url, bytes: blob.size, name: `chart-${Date.now()}.png` });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      /** Draw the frames of a motion graphic and play the result. */
      async function renderMotion() {
        if (busy) return;
        if (motionTemplate === 'chart' && motionData.trim() === '') {
          setError(t('motion.dataRequired'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/motion`, {
            template: motionTemplate,
            ...(motionText.trim() === '' ? {} : { text: motionText.trim() }),
            ...(motionSubtitle.trim() === '' ? {} : { subtitle: motionSubtitle.trim() }),
            style: motionStyle,
            format: motionFormat,
            ...(motionTemplate === 'chart' ? { data: motionData, chartType: motionChartType } : {}),
            ...(motionAccent.trim() === '' ? {} : { accent: motionAccent.trim() }),
            ...(motionSeconds.trim() === '' ? {} : { seconds: Number(motionSeconds) }),
          });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({
            url,
            bytes: blob.size,
            name: `motion-${Date.now()}.${motionFormat === 'gif' ? 'gif' : motionFormat}`,
            kind: motionFormat === 'gif' ? 'image' : 'video',
          });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      async function applyEdit() {
        if (busy) return;
        if (imagePath.trim() === '') {
          setError(t('graphics.pathRequired'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/edit-image`, {
            path: imagePath.trim(),
            ...(imageWidth.trim() === '' ? {} : { width: Number(imageWidth) }),
            ...(imageHeight.trim() === '' ? {} : { height: Number(imageHeight) }),
            format: imageFormat,
          });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({ url, bytes: blob.size, name: `image-${Date.now()}.${imageFormat === 'jpeg' ? 'jpg' : imageFormat}` });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      const chartForm = h('div', { key: 'chart' }, [
        h('label', { key: 'label', className: 'mstudio-label', htmlFor: 'mstudio-chart-data' }, t('graphics.data')),
        h('textarea', {
          key: 'data',
          id: 'mstudio-chart-data',
          className: 'mstudio-textarea',
          placeholder: t('graphics.dataPlaceholder'),
          value: data,
          onChange: (event) => setData(event.target.value),
        }),
        h('label', { key: 'tlabel', className: 'mstudio-label', htmlFor: 'mstudio-chart-title' }, t('graphics.title')),
        h('input', {
          key: 'title',
          id: 'mstudio-chart-title',
          className: 'mstudio-input',
          value: title,
          onChange: (event) => setTitle(event.target.value),
        }),
        h('label', { key: 'slabel', className: 'mstudio-label', htmlFor: 'mstudio-chart-subtitle' }, t('graphics.subtitle')),
        h('input', {
          key: 'subtitle',
          id: 'mstudio-chart-subtitle',
          className: 'mstudio-input',
          value: subtitle,
          onChange: (event) => setSubtitle(event.target.value),
        }),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('div', { key: 'type', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-chart-type' }, t('graphics.type')),
            h('select', {
              key: 's',
              id: 'mstudio-chart-type',
              className: 'mstudio-select',
              value: chartType,
              onChange: (event) => setChartType(event.target.value),
            }, chartTypes.map((entry) => h('option', { key: entry, value: entry }, t(`graphics.type.${entry}`)))),
          ]),
          h('div', { key: 'theme', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-chart-theme' }, t('graphics.theme')),
            h('select', {
              key: 's',
              id: 'mstudio-chart-theme',
              className: 'mstudio-select',
              value: theme,
              onChange: (event) => setTheme(event.target.value),
            }, themes.map((entry) => h('option', { key: entry, value: entry }, t(`graphics.theme.${entry}`)))),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: drawChart,
          }, h(Icon, { name: 'chart', size: 15 }), busy ? t('graphics.working') : t('graphics.draw')),
        ]),
      ]);
      const editForm = h('div', { key: 'edit' }, [
        h('label', { key: 'label', className: 'mstudio-label', htmlFor: 'mstudio-edit-path' }, t('graphics.path')),
        h('input', {
          key: 'path',
          id: 'mstudio-edit-path',
          className: 'mstudio-input',
          placeholder: 'C:\\root\\media-studio\\image.png',
          value: imagePath,
          onChange: (event) => setImagePath(event.target.value),
        }),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('div', { key: 'width', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-edit-width' }, t('graphics.width')),
            h('input', {
              key: 'i',
              id: 'mstudio-edit-width',
              className: 'mstudio-input',
              type: 'number',
              min: 1,
              placeholder: 'auto',
              value: imageWidth,
              onChange: (event) => setImageWidth(event.target.value),
            }),
          ]),
          h('div', { key: 'height', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-edit-height' }, t('graphics.height')),
            h('input', {
              key: 'i',
              id: 'mstudio-edit-height',
              className: 'mstudio-input',
              type: 'number',
              min: 1,
              placeholder: 'auto',
              value: imageHeight,
              onChange: (event) => setImageHeight(event.target.value),
            }),
          ]),
          h('div', { key: 'format', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-edit-format' }, t('graphics.format')),
            h('select', {
              key: 's',
              id: 'mstudio-edit-format',
              className: 'mstudio-select',
              value: imageFormat,
              onChange: (event) => setImageFormat(event.target.value),
            }, formats.map((entry) => h('option', { key: entry, value: entry }, t(`graphics.format.${entry}`)))),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: applyEdit,
          }, h(Icon, { name: 'image', size: 15 }), busy ? t('graphics.working') : t('graphics.apply')),
        ]),
      ]);
      const motionForm = h('div', { key: 'motion' }, [
        h('div', { key: 'row1', className: 'mstudio-row' }, [
          h('div', { key: 'template', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-template' }, t('motion.template')),
            h('select', {
              key: 's',
              id: 'mstudio-motion-template',
              className: 'mstudio-select',
              value: motionTemplate,
              onChange: (event) => setMotionTemplate(event.target.value),
            }, motionTemplates.map((entry) => h('option', { key: entry, value: entry }, t(`motion.template.${entry}`)))),
          ]),
          h('div', { key: 'style', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-style' }, t('motion.style')),
            h('select', {
              key: 's',
              id: 'mstudio-motion-style',
              className: 'mstudio-select',
              value: motionStyle,
              onChange: (event) => setMotionStyle(event.target.value),
            }, motionStyles.map((entry) => h('option', { key: entry, value: entry }, t(`motion.style.${entry}`)))),
          ]),
          h('div', { key: 'format', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-format' }, t('motion.format')),
            h('select', {
              key: 's',
              id: 'mstudio-motion-format',
              className: 'mstudio-select',
              value: motionFormat,
              onChange: (event) => setMotionFormat(event.target.value),
            }, motionFormats.map((entry) => h('option', { key: entry, value: entry }, t(`motion.format.${entry}`)))),
          ]),
        ]),
        motionTemplate === 'chart'
          ? h('div', { key: 'chartdata' }, [
            h('label', { key: 'dlabel', className: 'mstudio-label', htmlFor: 'mstudio-motion-data' }, t('motion.data')),
            h('textarea', {
              key: 'data',
              id: 'mstudio-motion-data',
              className: 'mstudio-textarea',
              placeholder: t('graphics.dataPlaceholder'),
              value: motionData,
              onChange: (event) => setMotionData(event.target.value),
            }),
            h('div', { key: 'crow', className: 'mstudio-row' }, [
              h('div', { key: 'ctype', className: 'mstudio-field' }, [
                h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-charttype' }, t('graphics.type')),
                h('select', {
                  key: 's',
                  id: 'mstudio-motion-charttype',
                  className: 'mstudio-select',
                  value: motionChartType,
                  onChange: (event) => setMotionChartType(event.target.value),
                }, chartTypes.map((entry) => h('option', { key: entry, value: entry }, t(`graphics.type.${entry}`)))),
              ]),
            ]),
          ])
          : h('div', { key: 'texts' }, [
            h('label', { key: 'tlabel', className: 'mstudio-label', htmlFor: 'mstudio-motion-text' }, t('motion.text')),
            h('input', {
              key: 'text',
              id: 'mstudio-motion-text',
              className: 'mstudio-input',
              value: motionText,
              onChange: (event) => setMotionText(event.target.value),
            }),
            h('label', { key: 'slabel', className: 'mstudio-label', htmlFor: 'mstudio-motion-subtitle' }, t('motion.subtitle')),
            h('input', {
              key: 'subtitle',
              id: 'mstudio-motion-subtitle',
              className: 'mstudio-input',
              value: motionSubtitle,
              onChange: (event) => setMotionSubtitle(event.target.value),
            }),
          ]),
        h('div', { key: 'row2', className: 'mstudio-row' }, [
          h('div', { key: 'seconds', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-seconds' }, t('motion.seconds')),
            h('input', {
              key: 'i',
              id: 'mstudio-motion-seconds',
              className: 'mstudio-input',
              type: 'number',
              min: 1,
              max: 20,
              step: 0.5,
              value: motionSeconds,
              onChange: (event) => setMotionSeconds(event.target.value),
            }),
          ]),
          h('div', { key: 'accent', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-motion-accent' }, t('motion.accent')),
            h('input', {
              key: 'i',
              id: 'mstudio-motion-accent',
              className: 'mstudio-input',
              placeholder: '#38bdf8',
              value: motionAccent,
              onChange: (event) => setMotionAccent(event.target.value),
            }),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: renderMotion,
          }, h(Icon, { name: 'video', size: 15 }), busy ? t('motion.working') : t('motion.create')),
        ]),
      ]);
      return h('section', { className: 'mstudio-card' }, [
        h('div', { key: 'modes', className: 'mstudio-row' }, [
          h('button', {
            key: 'chartmode',
            type: 'button',
            className: mode === 'chart' ? 'mstudio-button primary' : 'mstudio-button',
            onClick: () => setMode('chart'),
          }, h(Icon, { name: 'chart', size: 15 }), t('graphics.mode.chart')),
          h('button', {
            key: 'editmode',
            type: 'button',
            className: mode === 'edit' ? 'mstudio-button primary' : 'mstudio-button',
            onClick: () => setMode('edit'),
          }, h(Icon, { name: 'image', size: 15 }), t('graphics.mode.edit')),
          h('button', {
            key: 'motionmode',
            type: 'button',
            className: mode === 'motion' ? 'mstudio-button primary' : 'mstudio-button',
            onClick: () => setMode('motion'),
          }, h(Icon, { name: 'video', size: 15 }), t('graphics.mode.motion')),
        ]),
        mode === 'chart' ? chartForm : mode === 'edit' ? editForm : motionForm,
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        h('div', { key: 'preview', className: 'mstudio-preview' },
          result === undefined
            ? t('graphics.empty')
            : result.kind === 'video'
              ? h('video', { className: 'mstudio-video', controls: true, preload: 'metadata', src: result.url })
              : h('img', { className: 'mstudio-image', src: result.url, alt: result.name })),
        result === undefined
          ? null
          : h('div', { key: 'downloadrow', className: 'mstudio-row' }, [
            h('a', {
              key: 'download',
              className: 'mstudio-button',
              href: result.url,
              download: result.name,
            }, h(Icon, { name: 'download', size: 15 }), t('graphics.download')),
          ]),
      ]);
    }
    /** Speech synthesis tab. */
    function SpeechTab({ t, capabilities }) {
      const [text, setText] = React.useState('');
      const [voice, setVoice] = React.useState('');
      const [rate, setRate] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [result, setResult] = React.useState(undefined);
      const urlRef = React.useRef(undefined);
      React.useEffect(() => () => revokeUrl(urlRef), []);
      React.useEffect(() => {
        const preferred = capabilities?.speech?.defaultVoice;
        if (typeof preferred === 'string' && preferred !== '') setVoice(preferred);
        const configuredRate = capabilities?.speech?.defaultRate;
        if (Number.isFinite(configuredRate)) setRate(configuredRate);
      }, [capabilities]);
      const provider = capabilities?.speech?.provider ?? '…';
      const voices = Array.isArray(capabilities?.speech?.voices) ? capabilities.speech.voices : [];
      async function generate() {
        if (busy) return;
        const value = text.trim();
        if (value === '') {
          setError(t('speech.text'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/speech`, {
            text: value,
            ...(voice === '' ? {} : { voice }),
            rate,
          });
          const url = URL.createObjectURL(blob);
          revokeUrl(urlRef);
          urlRef.current = url;
          setResult({ url, bytes: blob.size });
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      return h('section', { className: 'mstudio-card' }, [
        h('label', { key: 'label', className: 'mstudio-label', htmlFor: 'mstudio-speech-text' }, t('speech.text')),
        h('textarea', {
          key: 'text',
          id: 'mstudio-speech-text',
          className: 'mstudio-textarea',
          placeholder: t('speech.placeholder'),
          value: text,
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('div', { key: 'voice', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-voice' }, t('speech.voice')),
            h('select', {
              key: 's',
              id: 'mstudio-voice',
              className: 'mstudio-select',
              value: voice,
              onChange: (event) => setVoice(event.target.value),
            }, voices.map((entry) => h('option', { key: entry.name, value: entry.name }, entry.name))),
          ]),
          h('div', { key: 'rate', className: 'mstudio-field' }, [
            h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-rate' }, `${t('speech.rate')} (${rate})`),
            h('input', {
              key: 'i',
              id: 'mstudio-rate',
              className: 'mstudio-input',
              type: 'range',
              min: -10,
              max: 10,
              step: 1,
              value: rate,
              onChange: (event) => setRate(Number(event.target.value)),
            }),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy,
            onClick: generate,
          }, h(Icon, { name: 'waveform', size: 15 }), busy ? t('speech.generating') : t('speech.generate')),
        ]),
        h('p', { key: 'provider', className: 'mstudio-note' }, t('speech.provider', { provider })),
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        h('div', { key: 'preview', className: 'mstudio-preview' },
          result === undefined
            ? t('speech.empty')
            : h('audio', { className: 'mstudio-audio', controls: true, src: result.url })),
        result === undefined
          ? null
          : h('div', { key: 'actions', className: 'mstudio-row' }, [
            h('a', {
              key: 'download',
              className: 'mstudio-button',
              href: result.url,
              download: `media-studio-speech-${Date.now()}.wav`,
            }, h(Icon, { name: 'download', size: 15 }), t('speech.download')),
          ]),
      ]);
    }
    /** Pitch ranges offered by the step grid (two octaves each). */
    const MUSIC_RANGES = [
      { id: 'low', label: 'C2–B3', base: 2 },
      { id: 'mid', label: 'C3–B4', base: 3 },
      { id: 'high', label: 'C4–B5', base: 4 },
      { id: 'top', label: 'C5–B6', base: 5 },
    ];
    /** Grid resolutions: label, steps per 4/4 bar, and beats per step. */
    const MUSIC_RESOLUTIONS = [
      { id: '1/4', stepsPerBar: 4, beats: 1 },
      { id: '1/8', stepsPerBar: 8, beats: 0.5 },
      { id: '1/16', stepsPerBar: 16, beats: 0.25 },
    ];
    /** Bar counts offered by the step grid. */
    const MUSIC_BARS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    /** Longest piece the panel accepts, in 4/4 bars. */
    const MAX_BARS = 256;
    /**
  
  
 * Above this many bars the step grid becomes too wide to edit by hand,
  
  
 * so the panel keeps a long piece in the score text instead.     */
    const GRID_TEXT_BARS = 32;
    /** Most step columns the grid draws at once, so a long piece stays usable. */
    const GRID_MAX_COLUMNS = 384;
    /** Semitone names, used to build the pitch rows. */
    const SEMITONES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    /** Top-to-bottom pitch rows for a range whose lowest octave is `base`. */
    function musicRows(base) {
      const rows = [];
      for (let octave = base + 1; octave >= base; octave -= 1) {
        for (let semitone = 11; semitone >= 0; semitone -= 1) {
          rows.push({ name: `${SEMITONES[semitone]}${octave}`, black: SEMITONES[semitone].includes('#') });
        }
      }
      return rows;
    }
    /** Round a beat count to three decimals, avoiding float noise. */
    function roundBeats(value) {
      return Math.round(value * 1000) / 1000;
    }
    /** Compress the step grid into a compact "pitch:beats" score, merging held steps. */
    function gridToScore(cells, rows, steps, stepBeats) {
      const groups = [];
      for (let col = 0; col < steps; col += 1) {
        const key = rows.filter((row) => cells[`${row.name}:${col}`] === true).map((row) => row.name).join(',');
        const last = groups[groups.length - 1];
        if (last !== undefined && last.key === key) last.steps += 1;
        else groups.push({ key, steps: 1 });
      }
      return groups
        .map((group) => `${group.key === '' ? 'rest' : group.key}:${roundBeats(group.steps * stepBeats)}`)
        .join(' ');
    }
    /** Nearest built-in preview voice for a SoundFont selection, by GM family. */
    function previewVoiceFor(instrument) {
      if (typeof instrument !== 'string' || !instrument.startsWith('gm:')) return instrument;
      const match = instrument.match(/^gm:(?:\d+:)?(\d+)$/u);
      const program = match === null ? 0 : Number(match[1]);
      if (program <= 7) return 'piano';
      if (program <= 15) return 'bell';
      if (program <= 23) return 'organ';
      if (program <= 31) return 'guitar';
      if (program <= 39) return 'bass';
      if (program <= 47) return 'violin';
      if (program <= 55) return 'pad';
      if (program <= 63) return 'trumpet';
      if (program <= 79) return 'flute';
      if (program <= 87) return 'saw';
      if (program <= 111) return program <= 103 ? 'pad' : 'guitar';
      if (program <= 119) return 'marimba';
      return 'bell';
    }
    /** `gm:<program>` for bank 0, `gm:<bank>:<program>` for a variation bank. */
    function gmOptionValue(preset) {
      return preset.bankMSB === 0 ? `gm:${preset.program}` : `gm:${preset.bankMSB}:${preset.program}`;
    }
    /** Semitone offsets within an octave (C = 0), for the audible preview. */
    const SEMITONE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    /** Voice recipes for the click preview: oscillator type, ratio and gain. */
    const MUSIC_VOICES = {
      sine: [{ type: 'sine', ratio: 1, gain: 1 }],
      square: [{ type: 'square', ratio: 1, gain: 0.5 }],
      saw: [{ type: 'sawtooth', ratio: 1, gain: 0.5 }],
      triangle: [{ type: 'triangle', ratio: 1, gain: 0.9 }],
      piano: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2, gain: 0.42 }, { type: 'sine', ratio: 3, gain: 0.2 }],
      organ: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2, gain: 0.5 }, { type: 'sine', ratio: 3, gain: 0.24 }],
      bell: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2.5, gain: 0.45 }],
      flute: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2, gain: 0.28 }],
      guitar: [{ type: 'triangle', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2, gain: 0.4 }, { type: 'sine', ratio: 3, gain: 0.22 }],
      harp: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 2, gain: 0.4 }, { type: 'sine', ratio: 4, gain: 0.15 }],
      marimba: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 4, gain: 0.3 }],
      music_box: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 3, gain: 0.5 }, { type: 'sine', ratio: 5.4, gain: 0.28 }],
      violin: [{ type: 'sawtooth', ratio: 1, gain: 0.6 }, { type: 'sine', ratio: 2, gain: 0.25 }],
      cello: [{ type: 'sawtooth', ratio: 1, gain: 0.55 }, { type: 'sine', ratio: 0.5, gain: 0.4 }],
      trumpet: [{ type: 'square', ratio: 1, gain: 0.4 }, { type: 'sine', ratio: 2, gain: 0.45 }, { type: 'sine', ratio: 3, gain: 0.3 }],
      pad: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 1.005, gain: 0.6 }, { type: 'sine', ratio: 2, gain: 0.3 }],
      bass: [{ type: 'sine', ratio: 1, gain: 1 }, { type: 'sine', ratio: 0.5, gain: 0.6 }],
    };
    /** Frequency in Hz for a pitch name such as "C#4"; null for a rest or garbage. */
    function pitchToHz(name) {
      if (typeof name !== 'string') return null;
      const text = name.trim().toLowerCase();
      if (text === '' || text === 'rest' || text === 'r' || text === '-') return null;
      const match = text.match(/^([a-g])([#b]?)(-?\d+)$/u);
      if (match === null) return null;
      let semitone = SEMITONE_OFFSETS[match[1].toUpperCase()];
      if (match[2] === '#') semitone += 1;
      else if (match[2] === 'b') semitone -= 1;
      const midi = semitone + (Number(match[3]) + 1) * 12;
      return 440 * Math.pow(2, (midi - 69) / 12);
    }
    /** Monotonic id source for panel tracks. */
    let trackIdSeq = 0;
    /** One editable track: a name, an instrument, and step cells keyed "pitch:col". */
    function makeTrack(name, instrument, cells) {
      trackIdSeq += 1;
      return { id: `t${trackIdSeq}`, name, instrument, cells: cells ?? {} };
    }
    /** MIDI note number for a pitch name, or null. */
    function pitchToMidi(name) {
      if (typeof name !== 'string') return null;
      const match = name.trim().toLowerCase().match(/^([a-g])([#b]?)(-?\d+)$/u);
      if (match === null) return null;
      let semitone = SEMITONE_OFFSETS[match[1].toUpperCase()];
      if (match[2] === '#') semitone += 1;
      else if (match[2] === 'b') semitone -= 1;
      return semitone + (Number(match[3]) + 1) * 12;
    }
    /** True when `value` is an exact multiple of `unit`. */
    function isMultiple(value, unit) {
      const ratio = value / unit;
      return Math.abs(ratio - Math.round(ratio)) < 1e-6;
    }
    /** Cells of one track into absolute notes, merging held steps. */
    function cellsToNotes(cells, rows, steps, stepBeats) {
      const open = new Map();
      const notes = [];
      for (let col = 0; col < steps; col += 1) {
        const present = new Set(rows.filter((row) => cells[`${row.name}:${col}`] === true).map((row) => row.name));
        for (const [pitch, index] of [...open]) {
          if (present.has(pitch)) continue;
          notes[index].duration = roundBeats(col * stepBeats - notes[index].start);
          open.delete(pitch);
        }
        for (const pitch of present) {
          if (open.has(pitch)) continue;
          notes.push({ pitch, start: roundBeats(col * stepBeats), duration: roundBeats(stepBeats) });
          open.set(pitch, notes.length - 1);
        }
      }
      for (const index of open.values()) {
        notes[index].duration = roundBeats(steps * stepBeats - notes[index].start);
      }
      return notes.filter((note) => note.duration > 0);
    }
    /** Absolute notes onto step cells, keeping only pitches the grid can show. */
    function notesToCells(notes, stepBeats, steps, allowed) {
      const cells = {};
      for (const note of Array.isArray(notes) ? notes : []) {
        const pitches = Array.isArray(note.pitches) ? note.pitches : (typeof note.pitch === 'string' ? [note.pitch] : []);
        const start = Number.isFinite(note.start) ? note.start : 0;
        const duration = Number.isFinite(note.duration) ? note.duration : (Number.isFinite(note.beats) ? note.beats : 1);
        const startCol = Math.max(0, Math.round(start / stepBeats));
        const endCol = Math.max(startCol + 1, Math.round((start + duration) / stepBeats));
        for (let col = startCol; col < endCol && col < steps; col += 1) {
          for (const pitch of pitches) {
            if (allowed.has(pitch)) cells[`${pitch}:${col}`] = true;
          }
        }
      }
      return cells;
    }
    /** One track's step grid into cells. */
    function stepsToCells(steps, rows) {
      const cells = {};
      (Array.isArray(steps) ? steps : []).forEach((pitches, col) => {
        for (const pitch of Array.isArray(pitches) ? pitches : []) {
          cells[`${pitch}:${col}`] = true;
        }
      });
      return cells;
    }
    /** Coarsest resolution that can express every start and duration. */
    function chooseResolution(notes) {
      for (const entry of MUSIC_RESOLUTIONS) {
        const fits = notes.every((note) => isMultiple(note.start, entry.beats) && isMultiple(note.duration, entry.beats));
        if (fits) return entry.id;
      }
      return '1/16';
    }
    /** Narrowest pitch range that contains every note, or null. */
    function chooseRange(notes) {
      const midis = [];
      for (const note of notes) {
        const pitches = Array.isArray(note.pitches) ? note.pitches : [];
        for (const pitch of pitches) {
          const midi = pitchToMidi(pitch);
          if (midi !== null) midis.push(midi);
        }
      }
      if (midis.length === 0) return null;
      const low = Math.min(...midis);
      const high = Math.max(...midis);
      for (const entry of MUSIC_RANGES) {
        const bottom = (entry.base + 1) * 12;
        if (low >= bottom && high <= bottom + 23) return entry.id;
      }
      return null;
    }
    /** Music tab: a multi-track step grid plus a bidirectional score-text editor. */
    function MusicTab({ t, capabilities }) {
      const [mode, setMode] = React.useState('grid');
      const [tracks, setTracks] = React.useState(() => [makeTrack('melody', 'gm:0', {})]);
      const [activeId, setActiveId] = React.useState('');
      const [scoreText, setScoreText] = React.useState('');
      const [tempo, setTempo] = React.useState(120);
      const [range, setRange] = React.useState('mid');
      const [bars, setBars] = React.useState(2);
      const [resolution, setResolution] = React.useState('1/8');
      const [composeStyle, setComposeStyle] = React.useState('pop');
      const [composeKey, setComposeKey] = React.useState('C');
      const [composeScale, setComposeScale] = React.useState('major');
      const [composeSeed, setComposeSeed] = React.useState(1);
      const [promptText, setPromptText] = React.useState('');
      const [promptPlan, setPromptPlan] = React.useState('');
      const [longNote, setLongNote] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [composing, setComposing] = React.useState(false);
      const [prompting, setPrompting] = React.useState(false);
      const [switching, setSwitching] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [warnings, setWarnings] = React.useState([]);
      const [result, setResult] = React.useState(undefined);
      const [playing, setPlaying] = React.useState(false);
      const [playStep, setPlayStep] = React.useState(-1);
      const urlRef = React.useRef(undefined);
      const audioRef = React.useRef(undefined);
      const paintRef = React.useRef(undefined);
      const previewCtxRef = React.useRef(undefined);
      const lastPreviewRef = React.useRef(0);
      React.useEffect(() => () => revokeUrl(urlRef), []);
      React.useEffect(() => {
        const preferredInstrument = capabilities?.music?.defaultInstrument;
        if (typeof preferredInstrument === 'string' && preferredInstrument !== '') {
          setTracks((current) => current.map((track) => (track.instrument === 'gm:0' ? { ...track, instrument: preferredInstrument } : track)));
        }
        const configuredTempo = capabilities?.music?.defaultTempo;
        if (Number.isFinite(configuredTempo)) setTempo(configuredTempo);
      }, [capabilities]);
      React.useEffect(() => {
        const stop = () => { paintRef.current = undefined; };
        window.addEventListener('mouseup', stop);
        return () => window.removeEventListener('mouseup', stop);
      }, []);
      React.useEffect(() => () => {
        const context = previewCtxRef.current;
        if (context !== undefined) {
          try { context.close(); } catch { /* already closed */ }
        }
      }, []);
      const rangeDef = MUSIC_RANGES.find((entry) => entry.id === range) ?? MUSIC_RANGES[1];
      const rows = musicRows(rangeDef.base);
      const resolutionDef = MUSIC_RESOLUTIONS.find((entry) => entry.id === resolution) ?? MUSIC_RESOLUTIONS[1];
      const steps = bars * resolutionDef.stepsPerBar;
      const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
      const stepSeconds = (resolutionDef.beats * 60) / safeTempo;
      const activeTrack = tracks.find((track) => track.id === activeId) ?? tracks[0];
      const composeStyles = Array.isArray(capabilities?.music?.styles) && capabilities.music.styles.length > 0
        ? capabilities.music.styles
        : ['pop', 'ballad', 'chiptune', 'ambient', 'edm'];
      const composeKeys = Array.isArray(capabilities?.music?.keys) && capabilities.music.keys.length > 0
        ? capabilities.music.keys
        : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const composeScales = Array.isArray(capabilities?.music?.scales) && capabilities.music.scales.length > 0
        ? capabilities.music.scales
        : ['major', 'minor', 'pentatonic', 'dorian', 'mixolydian'];
      const soundFont = capabilities?.music?.soundFont;
      const soundFontGroups = [];
      if (soundFont?.available === true && Array.isArray(soundFont.presets)) {
        const byBank = new Map();
        for (const preset of soundFont.presets) {
          if (preset.drum === true) continue;
          const bank = Number.isFinite(preset.bankMSB) ? preset.bankMSB : 0;
          if (!byBank.has(bank)) byBank.set(bank, []);
          byBank.get(bank).push(preset);
        }
        for (const bank of [...byBank.keys()].sort((left, right) => left - right)) {
          soundFontGroups.push({ bank, presets: byBank.get(bank) });
        }
      }
      const instrumentOptions = soundFontGroups.map((group) => h('optgroup', {
        key: `sf-${group.bank}`,
        label: group.bank === 0 ? t('music.group.soundfont') : `${t('music.group.soundfont')} · bank ${group.bank}`,
      }, group.presets.map((preset) => h('option', {
        key: `sf-${group.bank}-${preset.program}`,
        value: gmOptionValue(preset),
      }, `${preset.program} ${preset.name}`))));
      const activeInstrument = activeTrack?.instrument ?? 'gm:0';
      const usingSoundFont = typeof activeInstrument === 'string' && activeInstrument.startsWith('gm:');
      /** The preset list, plus the track's own value when the list lacks it (drums). */
      function optionsForTrack(track) {
        const value = track.instrument;
        if (typeof value !== 'string' || value === '') return instrumentOptions;
        const known = soundFontGroups.some((group) => group.presets.some((preset) => gmOptionValue(preset) === value));
        if (known) return instrumentOptions;
        const label = value === 'gm:128:0' ? t('music.drumKit') : value;
        return [h('option', { key: 'own', value }, label), ...instrumentOptions];
      }
      const filledCells = tracks.reduce((sum, track) => sum + Object.keys(track.cells).length, 0);
      React.useEffect(() => {
        if (mode !== 'grid' || !playing) {
          setPlayStep(-1);
          return undefined;
        }
        let frame = 0;
        const tick = () => {
          const element = audioRef.current;
          if (element !== undefined && element !== null) {
            const index = Math.floor(element.currentTime / stepSeconds);
            setPlayStep(index >= 0 && index < steps ? index : -1);
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
      }, [mode, playing, stepSeconds, steps]);
      /** Play one short preview tone for a pitch, so a click is audible at once. */
      function previewNote(name) {
        const frequency = pitchToHz(name);
        if (frequency === null) return;
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (Ctor === undefined) return;
        const stamp = performance.now();
        if (stamp - lastPreviewRef.current < 45) return;
        lastPreviewRef.current = stamp;
        try {
          let context = previewCtxRef.current;
          if (context === undefined) {
            context = new Ctor();
            previewCtxRef.current = context;
          }
          if (context.state === 'suspended') context.resume();
          const start = context.currentTime;
          const envelope = context.createGain();
          envelope.connect(context.destination);
          envelope.gain.setValueAtTime(0, start);
          envelope.gain.linearRampToValueAtTime(0.22, start + 0.008);
          envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
          const voice = MUSIC_VOICES[previewVoiceFor(activeInstrument)] ?? MUSIC_VOICES.piano;
          for (const partial of voice) {
            const oscillator = context.createOscillator();
            oscillator.type = partial.type;
            oscillator.frequency.setValueAtTime(frequency * partial.ratio, start);
            const gain = context.createGain();
            gain.gain.setValueAtTime(partial.gain, start);
            oscillator.connect(gain).connect(envelope);
            oscillator.start(start);
            oscillator.stop(start + 0.5);
          }
          window.setTimeout(() => {
            try { envelope.disconnect(); } catch { /* already torn down */ }
          }, 800);
        } catch {
          // A browser that refuses Web Audio simply stays silent.
        }
      }
      function updateTrack(id, patch) {
        setTracks((current) => current.map((track) => (track.id === id ? { ...track, ...patch } : track)));
      }
      function addTrack() {
        const track = makeTrack(`track ${tracks.length + 1}`, capabilities?.music?.defaultInstrument ?? 'gm:0', {});
        setTracks((current) => [...current, track]);
        setActiveId(track.id);
      }
      function removeTrack(id) {
        setTracks((current) => {
          const next = current.filter((track) => track.id !== id);
          if (next.length === 0) return current;
          if (id === activeId) setActiveId(next[0].id);
          return next;
        });
      }
      function applyCell(rowName, col, value) {
        if (activeTrack === undefined) return;
        const id = activeTrack.id;
        setTracks((current) => current.map((track) => {
          if (track.id !== id) return track;
          const key = `${rowName}:${col}`;
          if ((track.cells[key] === true) === value) return track;
          const cells = { ...track.cells };
          if (value) cells[key] = true;
          else delete cells[key];
          return { ...track, cells };
        }));
      }
      function onCellDown(row, col) {
        if (activeTrack === undefined) return;
        const target = activeTrack.cells[`${row.name}:${col}`] !== true;
        paintRef.current = target;
        applyCell(row.name, col, target);
        if (target) previewNote(row.name);
      }
      function onCellEnter(row, col) {
        if (paintRef.current === undefined) return;
        applyCell(row.name, col, paintRef.current);
        if (paintRef.current === true) previewNote(row.name);
      }
      /** Current tracks as the host's multi-track payload. */
      function tracksToPayload() {
        return tracks.map((track) => ({
          name: track.name,
          instrument: track.instrument,
          notes: cellsToNotes(track.cells, rows, steps, resolutionDef.beats),
        }));
      }
      async function showResult(blob) {
        const url = URL.createObjectURL(blob);
        revokeUrl(urlRef);
        urlRef.current = url;
        setResult({ url, bytes: blob.size });
      }
      async function generate() {
        if (busy || switching) return;
        if (mode === 'grid' ? filledCells === 0 : scoreText.trim() === '') {
          setError(mode === 'grid' ? t('music.emptyGrid') : t('music.score'));
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const blob = await postJsonForBlob(`${ROUTE}/music`, mode === 'grid'
            ? { tracks: tracksToPayload(), tempo }
            : { text: scoreText, tempo });
          await showResult(blob);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      /** Move a parsed piece onto the grid: fit resolution, bars and range, then load cells. */
      function applyParsed(response) {
        const parsedTracks = Array.isArray(response?.tracks) ? response.tracks : [];
        const notes = parsedTracks.flatMap((track) => (Array.isArray(track.notes) ? track.notes : []));
        const nextResolution = chooseResolution(notes);
        const nextResolutionDef = MUSIC_RESOLUTIONS.find((entry) => entry.id === nextResolution) ?? MUSIC_RESOLUTIONS[1];
        let endBeats = 0;
        for (const note of notes) {
          const start = Number.isFinite(note.start) ? note.start : 0;
          const duration = Number.isFinite(note.duration) ? note.duration : 1;
          endBeats = Math.max(endBeats, start + duration);
        }
        const nextBars = Math.min(MUSIC_BARS[MUSIC_BARS.length - 1], Math.max(1, Math.ceil(endBeats / 4)));
        const nextRange = chooseRange(notes) ?? range;
        const nextRangeDef = MUSIC_RANGES.find((entry) => entry.id === nextRange) ?? MUSIC_RANGES[1];
        const nextRows = musicRows(nextRangeDef.base);
        const allowed = new Set(nextRows.map((row) => row.name));
        const nextSteps = nextBars * nextResolutionDef.stepsPerBar;
        const nextTracks = parsedTracks.map((track, index) => makeTrack(
          typeof track.name === 'string' && track.name !== '' ? track.name : `track ${index + 1}`,
          typeof track.instrument === 'string' && track.instrument !== '' ? track.instrument : 'gm:0',
          notesToCells(Array.isArray(track.notes) ? track.notes : [], nextResolutionDef.beats, nextSteps, allowed),
        ));
        const parsedTempo = Number(response?.tempo);
        setTempo(Number.isFinite(parsedTempo) && parsedTempo > 0 ? Math.min(300, Math.max(30, Math.round(parsedTempo))) : tempo);
        setResolution(nextResolution);
        setBars(nextBars);
        setRange(nextRange);
        setTracks(nextTracks.length > 0 ? nextTracks : [makeTrack('melody', activeInstrument, {})]);
        setActiveId(nextTracks.length > 0 ? nextTracks[0].id : '');
        setWarnings(Array.isArray(response?.warnings) ? response.warnings : []);
      }
      /** Switch between the grid and the score text, carrying the piece across. */
      async function switchMode(next) {
        if (next === mode || switching) return;
        setError(undefined);
        setSwitching(true);
        try {
          if (next === 'text') {
            const response = await postJsonForJson(`${ROUTE}/score`, {
              action: 'format',
              tempo,
              tracks: tracksToPayload(),
            });
            setScoreText(typeof response?.text === 'string' ? response.text : '');
          } else {
            const response = await postJsonForJson(`${ROUTE}/score`, { action: 'parse', text: scoreText });
            applyParsed(response);
          }
          setMode(next);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setSwitching(false);
        }
      }
      /** Compose a piece, drop it on the tracks, and play it right away. */
      async function autoCompose(seedOverride) {
        if (busy || composing || switching) return;
        const useSeed = Number.isFinite(seedOverride) ? seedOverride : composeSeed;
        setComposing(true);
        setError(undefined);
        try {
          const piece = await postJsonForJson(`${ROUTE}/compose`, {
            style: composeStyle,
            key: composeKey,
            scale: composeScale,
            bars,
            stepsPerBar: resolutionDef.stepsPerBar,
            rangeBase: rangeDef.base,
            seed: useSeed,
            tempo,
          });
          if (Number.isFinite(seedOverride)) setComposeSeed(useSeed);
          const composed = Array.isArray(piece?.tracks) ? piece.tracks : [];
          const next = [...tracks];
          composed.forEach((part, index) => {
            const cells = stepsToCells(part.steps, rows);
            const byName = next.findIndex((track) => track.name === part.name);
            const target = byName >= 0 ? byName : (index < next.length ? index : -1);
            if (target >= 0) next[target] = { ...next[target], cells };
            else next.push(makeTrack(part.name ?? `track ${index + 1}`, part.instrument ?? 'gm:0', cells));
          });
          setTracks(next);
          setActiveId(next[0]?.id ?? '');
          if (typeof piece?.text === 'string' && piece.text !== '') setScoreText(piece.text);
          const pieceBars = Number(piece?.bars);
          if (Number.isFinite(pieceBars) && pieceBars > GRID_TEXT_BARS) {
            setMode('text');
            setLongNote(t('music.longPiece', { bars: Math.round(pieceBars) }));
          } else {
            setLongNote('');
          }
          const blob = await postJsonForBlob(`${ROUTE}/music`, typeof piece?.text === 'string' && piece.text !== ''
            ? { text: piece.text, tempo }
            : { tracks: composed.map((part) => ({
              name: part.name,
              instrument: part.instrument,
              notes: cellsToNotes(stepsToCells(part.steps, rows), rows, part.steps.length, resolutionDef.beats),
            })), tempo });
          await showResult(blob);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setComposing(false);
        }
      }
      /**
  
  
  
 * Read a plain-language prompt, drop the piece on the tracks, and play it.
  
  
  
 *
  
  
  
 * The host answers with the plan it read (so the panel can show it) and
  
  
  
 * the score text, which is rendered as it is.       */
      async function generateFromPrompt() {
        if (busy || composing || prompting || switching) return;
        const prompt = promptText.trim();
        if (prompt === '') {
          setError(t('music.prompt'));
          return;
        }
        setPrompting(true);
        setError(undefined);
        try {
          // The length comes from the prompt, so `bars` is not sent: the
          // panel's grid width must not override what the text asked for.
          const piece = await postJsonForJson(`${ROUTE}/prompt`, {
            prompt,
            seed: composeSeed,
            stepsPerBar: resolutionDef.stepsPerBar,
            rangeBase: rangeDef.base,
          });
          const plan = piece?.plan ?? undefined;
          setPromptPlan(typeof plan?.summary === 'string' ? plan.summary : '');
          const composed = Array.isArray(piece?.tracks) ? piece.tracks : [];
          const next = [...tracks];
          composed.forEach((part, index) => {
            const cells = stepsToCells(part.steps, rows);
            const byName = next.findIndex((track) => track.name === part.name);
            const target = byName >= 0 ? byName : (index < next.length ? index : -1);
            if (target >= 0) next[target] = { ...next[target], cells };
            else next.push(makeTrack(part.name ?? `track ${index + 1}`, part.instrument ?? 'gm:0', cells));
          });
          setTracks(next);
          setActiveId(next[0]?.id ?? '');
          if (typeof piece?.text === 'string' && piece.text !== '') setScoreText(piece.text);
          const pieceTempo = Number(piece?.tempo);
          if (Number.isFinite(pieceTempo) && pieceTempo > 0) setTempo(Math.round(pieceTempo));
          const pieceBars = Number(piece?.bars);
          if (Number.isFinite(pieceBars) && pieceBars > 0) setBars(Math.min(MAX_BARS, Math.round(pieceBars)));
          if (Number.isFinite(pieceBars) && pieceBars > GRID_TEXT_BARS) {
            setMode('text');
            setLongNote(t('music.longPiece', { bars: Math.round(pieceBars) }));
          } else {
            setLongNote('');
          }
          const blob = await postJsonForBlob(`${ROUTE}/music`, typeof piece?.text === 'string' && piece.text !== ''
            ? { text: piece.text, tempo: pieceTempo }
            : { tracks: composed.map((part) => ({
              name: part.name,
              instrument: part.instrument,
              notes: cellsToNotes(stepsToCells(part.steps, rows), rows, part.steps.length, resolutionDef.beats),
            })), tempo: pieceTempo });
          await showResult(blob);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setPrompting(false);
        }
      }
      function modeButton(id, label) {
        return h('button', {
          key: id,
          type: 'button',
          'aria-pressed': mode === id,
          disabled: switching,
          onClick: () => switchMode(id),
        }, label);
      }
      const promptExamples = Array.isArray(capabilities?.music?.promptExamples) ? capabilities.music.promptExamples : [];
      const promptRow = h('div', { key: 'prompt', className: 'mstudio-field' }, [
        h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-prompt' }, t('music.prompt')),
        h('textarea', {
          key: 'p',
          id: 'mstudio-music-prompt',
          className: 'mstudio-textarea short',
          rows: 2,
          value: promptText,
          placeholder: t('music.promptPlaceholder'),
          onChange: (event) => setPromptText(event.target.value),
        }),
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy || composing || prompting || switching,
            onClick: generateFromPrompt,
          }, h(Icon, { name: 'sparkles', size: 15 }), prompting ? t('music.promptGenerating') : t('music.promptGenerate')),
          promptPlan !== '' ? h('span', { key: 'plan', className: 'mstudio-note' }, `${t('music.promptPlan')}: ${promptPlan}`) : null,
        ]),
        promptExamples.length > 0
          ? h('div', { key: 'examples', className: 'mstudio-row' }, promptExamples.map((example) => h('button', {
            key: example,
            type: 'button',
            className: 'mstudio-button',
            disabled: busy || composing || prompting || switching,
            onClick: () => setPromptText(example),
          }, example)))
          : null,
        h('p', { key: 'hint', className: 'mstudio-note' }, t('music.promptHint')),
      ]);
      const composeRow = h('div', { key: 'compose', className: 'mstudio-row' }, [
        h('div', { key: 'style', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-compose-style' }, t('music.style')),
          h('select', {
            key: 's',
            id: 'mstudio-compose-style',
            className: 'mstudio-select',
            value: composeStyle,
            onChange: (event) => setComposeStyle(event.target.value),
          }, composeStyles.map((entry) => h('option', { key: entry, value: entry }, entry))),
        ]),
        h('div', { key: 'key', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-compose-key' }, t('music.key')),
          h('select', {
            key: 's',
            id: 'mstudio-compose-key',
            className: 'mstudio-select',
            value: composeKey,
            onChange: (event) => setComposeKey(event.target.value),
          }, composeKeys.map((entry) => h('option', { key: entry, value: entry }, entry))),
        ]),
        h('div', { key: 'scale', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-compose-scale' }, t('music.scale')),
          h('select', {
            key: 's',
            id: 'mstudio-compose-scale',
            className: 'mstudio-select',
            value: composeScale,
            onChange: (event) => setComposeScale(event.target.value),
          }, composeScales.map((entry) => h('option', { key: entry, value: entry }, entry))),
        ]),
        h('div', { key: 'seed', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-compose-seed' }, t('music.seed')),
          h('input', {
            key: 'i',
            id: 'mstudio-compose-seed',
            className: 'mstudio-input',
            type: 'number',
            step: 1,
            value: composeSeed,
            onChange: (event) => setComposeSeed(Math.trunc(Number(event.target.value)) || 0),
          }),
        ]),
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h('button', {
          key: 'auto',
          type: 'button',
          className: 'mstudio-button primary',
          disabled: busy || composing || switching,
          onClick: () => autoCompose(),
        }, h(Icon, { name: 'sparkles', size: 15 }), composing ? t('music.composing') : t('music.compose')),
        h('button', {
          key: 'again',
          type: 'button',
          className: 'mstudio-button',
          disabled: busy || composing || switching,
          onClick: () => autoCompose(composeSeed + 1),
        }, t('music.composeAgain')),
      ]);
      const trackList = h('div', { key: 'tracks', className: 'mstudio-tracks' }, [
        h('div', { key: 'head', className: 'mstudio-row' }, [
          h('span', { key: 'label', className: 'mstudio-label' }, t('music.tracks')),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'add',
            type: 'button',
            className: 'mstudio-button',
            disabled: switching,
            onClick: addTrack,
          }, t('music.track.add')),
        ]),
        ...tracks.map((track) => h('div', {
          key: track.id,
          className: `mstudio-track${track.id === (activeTrack?.id ?? '') ? ' active' : ''}`,
        }, [
          h('button', {
            key: 'pick',
            type: 'button',
            className: 'mstudio-track-pick',
            'aria-pressed': track.id === (activeTrack?.id ?? ''),
            title: t('music.track.select'),
            onClick: () => setActiveId(track.id),
          }, track.id === (activeTrack?.id ?? '') ? '●' : '○'),
          h('input', {
            key: 'name',
            className: 'mstudio-input mstudio-track-name',
            value: track.name,
            'aria-label': t('music.track.name'),
            onChange: (event) => updateTrack(track.id, { name: event.target.value }),
          }),
          h('select', {
            key: 'instrument',
            className: 'mstudio-select',
            value: track.instrument,
            'aria-label': t('music.track.instrument'),
            onChange: (event) => updateTrack(track.id, { instrument: event.target.value }),
          }, optionsForTrack(track)),
          h('button', {
            key: 'remove',
            type: 'button',
            className: 'mstudio-button',
            disabled: tracks.length <= 1 || switching,
            title: t('music.track.remove'),
            onClick: () => removeTrack(track.id),
          }, '×'),
        ])),
      ]);
      const controlFields = [
        h('div', { key: 'tempo', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-tempo' }, t('music.tempo')),
          h('input', {
            key: 'i',
            id: 'mstudio-music-tempo',
            className: 'mstudio-input',
            type: 'number',
            min: 30,
            max: 300,
            step: 1,
            value: tempo,
            onChange: (event) => setTempo(Number(event.target.value) || 120),
          }),
        ]),
        h('div', { key: 'range', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-range' }, t('music.range')),
          h('select', {
            key: 's',
            id: 'mstudio-music-range',
            className: 'mstudio-select',
            value: range,
            onChange: (event) => setRange(event.target.value),
          }, MUSIC_RANGES.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))),
        ]),
        h('div', { key: 'bars', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-bars' }, t('music.bars')),
          h('input', {
            key: 'n',
            id: 'mstudio-music-bars',
            className: 'mstudio-input',
            type: 'number',
            min: 1,
            max: MAX_BARS,
            step: 1,
            value: String(bars),
            onChange: (event) => {
              const value = Math.round(Number(event.target.value));
              setBars(Number.isFinite(value) ? Math.min(MAX_BARS, Math.max(1, value)) : 1);
            },
          }),
          h('p', { key: 'hint', className: 'mstudio-note' }, t('music.barsHint')),
        ]),
        h('div', { key: 'resolution', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-resolution' }, t('music.resolution')),
          h('select', {
            key: 's',
            id: 'mstudio-music-resolution',
            className: 'mstudio-select',
            value: resolution,
            onChange: (event) => setResolution(event.target.value),
          }, MUSIC_RESOLUTIONS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.id))),
        ]),
      ];
      // A long piece would need tens of thousands of cells, so the grid shows
      // the first stretch of it and the score text keeps the whole thing.
      const gridSteps = Math.min(steps, GRID_MAX_COLUMNS);
      const grid = h('div', { key: 'gridwrap', className: 'mstudio-gridwrap' },
        h('div', {
          key: 'grid',
          className: 'mstudio-grid',
          style: { gridTemplateColumns: `56px repeat(${gridSteps}, 20px)` },
        }, [
          h('div', { key: 'head-key', className: 'mstudio-step' }, ''),
          ...Array.from({ length: gridSteps }, (_, col) => h('div', {
            key: `head-${col}`,
            className: `mstudio-step${col % resolutionDef.stepsPerBar === 0 ? ' bar' : ''}`,
          }, col % resolutionDef.stepsPerBar === 0 ? String(Math.floor(col / resolutionDef.stepsPerBar) + 1) : '')),
          ...rows.flatMap((row) => [
            h('div', {
              key: `key-${row.name}`,
              className: `mstudio-key${row.black ? ' black' : ''}`,
              title: row.name,
              onClick: () => previewNote(row.name),
            }, row.name),
            ...Array.from({ length: gridSteps }, (_, col) => {
              const on = activeTrack?.cells[`${row.name}:${col}`] === true;
              const classes = ['mstudio-cell'];
              if (row.black) classes.push('black');
              if (col % resolutionDef.stepsPerBar === 0) classes.push('bar');
              if (on) classes.push('on');
              if (col === playStep) classes.push('play');
              return h('button', {
                key: `${row.name}-${col}`,
                type: 'button',
                className: classes.join(' '),
                'aria-label': `${row.name} ${col + 1}`,
                'aria-pressed': on,
                onMouseDown: (event) => { event.preventDefault(); onCellDown(row, col); },
                onMouseEnter: () => onCellEnter(row, col),
              });
            }),
          ]),
        ]));
      const editor = mode === 'grid'
        ? grid
        : h('div', { key: 'text', className: 'mstudio-field' }, [
          h('label', { key: 'l', className: 'mstudio-label', htmlFor: 'mstudio-music-score' }, t('music.score')),
          h('textarea', {
            key: 'score',
            id: 'mstudio-music-score',
            className: 'mstudio-textarea mstudio-score-text',
            spellCheck: false,
            value: scoreText,
            onChange: (event) => setScoreText(event.target.value),
          }),
          h('p', { key: 'hint', className: 'mstudio-note' }, t('music.textHint')),
        ]);
      return h('section', { className: 'mstudio-card' }, [
        h('div', { key: 'modes', className: 'mstudio-row' }, [
          h('div', { key: 'seg', className: 'mstudio-seg', role: 'group', 'aria-label': t('music.mode') }, [
            modeButton('grid', t('music.mode.grid')),
            modeButton('text', t('music.mode.text')),
          ]),
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          switching ? h('span', { key: 'switching', className: 'mstudio-note' }, t('music.switching')) : null,
          mode === 'grid'
            ? h('button', {
              key: 'clear',
              type: 'button',
              className: 'mstudio-button',
              disabled: busy || filledCells === 0,
              onClick: () => updateTrack(activeTrack?.id, { cells: {} }),
            }, t('music.clear'))
            : null,
        ]),
        promptRow,
        mode === 'grid' ? composeRow : null,
        mode === 'grid' ? trackList : null,
        mode === 'grid' ? h('div', { key: 'controls', className: 'mstudio-row' }, controlFields) : null,
        mode === 'grid'
          ? h('p', { key: 'hint', className: 'mstudio-note' },
            `${t('music.gridHint')} (${steps}) · ${activeTrack?.name ?? ''}`
            + (steps > gridSteps ? ` · ${t('music.gridTruncated', { shown: gridSteps, total: steps })}` : ''))
          : null,
        editor,
        longNote !== '' ? h('p', { key: 'long', className: 'mstudio-note' }, longNote) : null,
        h('div', { key: 'run', className: 'mstudio-row' }, [
          h('button', {
            key: 'go',
            type: 'button',
            className: 'mstudio-button primary',
            disabled: busy || switching,
            onClick: generate,
          }, h(Icon, { name: 'note', size: 15 }), busy ? t('music.generating') : t('music.generate')),
          h('p', { key: 'provider', className: 'mstudio-note' },
            `${t('music.provider', { instrument: activeInstrument, tempo })}${usingSoundFont ? ` · ${t('music.soundfontActive')}` : ''}`),
        ]),
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        warnings.length === 0 ? null : h('div', { key: 'warnings', className: 'mstudio-note' }, [
          h('strong', { key: 'label' }, `${t('music.warnings')}: `),
          ...warnings.map((warning, index) => h('div', { key: `w-${index}` }, warning)),
        ]),
        h('div', { key: 'preview', className: 'mstudio-preview' },
          result === undefined
            ? t('music.empty')
            : h('audio', {
              className: 'mstudio-audio',
              controls: true,
              src: result.url,
              ref: audioRef,
              onPlay: () => setPlaying(true),
              onPause: () => setPlaying(false),
              onEnded: () => { setPlaying(false); setPlayStep(-1); },
            })),
        result === undefined
          ? null
          : h('div', { key: 'download', className: 'mstudio-row' }, [
            h('a', {
              key: 'download',
              className: 'mstudio-button',
              href: result.url,
              download: `media-studio-music-${Date.now()}.wav`,
            }, h(Icon, { name: 'download', size: 15 }), t('music.download')),
          ]),
      ]);
    }
    /** Voice input tab: record or upload audio, then transcribe. */
    function TranscribeTab({ t, capabilities }) {
      const [recording, setRecording] = React.useState(false);
      const [elapsed, setElapsed] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [transcript, setTranscript] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const captureRef = React.useRef(undefined);
      const provider = capabilities?.transcription?.providerName ?? capabilities?.transcription?.provider ?? '…';
      const ready = capabilities?.transcription?.ready !== false;
      const language = capabilities?.transcription?.language ?? 'ja';
      React.useEffect(() => () => stopCapture(captureRef), []);
      async function transcribeBytes(bytes) {
        setBusy(true);
        setError(undefined);
        try {
          const payload = await postWavForText(bytes, language);
          setTranscript(typeof payload?.text === 'string' ? payload.text : '');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }
      async function startRecording() {
        if (recording || busy) return;
        setError(undefined);
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
          const recorder = new MediaRecorder(stream);
          const chunks = [];
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          const startedAt = Date.now();
          const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 250);
          const stopTimer = setTimeout(() => {
            void finishRecording(captureRef);
          }, MAX_RECORD_SECONDS * 1000);
          captureRef.current = { stream, recorder, chunks, timer, stopTimer };
          recorder.start();
          setElapsed(0);
          setRecording(true);
        } catch (cause) {
          setError(cause?.name === 'NotAllowedError' || cause?.name === 'SecurityError'
            ? t('transcribe.micDenied')
            : String(cause?.message ?? cause));
        }
      }
      async function finishRecording(ref) {
        const capture = ref.current;
        if (capture === undefined) return;
        ref.current = undefined;
        clearInterval(capture.timer);
        clearTimeout(capture.stopTimer);
        setRecording(false);
        const blob = await new Promise((resolve) => {
          capture.recorder.onstop = () => resolve(new Blob(capture.chunks, { type: capture.recorder.mimeType }));
          try {
            capture.recorder.stop();
          } catch {
            resolve(new Blob(capture.chunks, { type: capture.recorder.mimeType }));
          }
        });
        for (const track of capture.stream.getTracks()) track.stop();
        if (blob.size === 0) {
          setError(t('common.error'));
          return;
        }
        try {
          const wav = await toWav16k(blob);
          await transcribeBytes(wav);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }
      async function onUpload(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file === undefined || busy) return;
        setError(undefined);
        try {
          const wav = await toWav16k(file);
          await transcribeBytes(wav);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }
      async function copyTranscript() {
        if (transcript === '') return;
        try {
          await navigator.clipboard.writeText(transcript);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setError(t('common.error'));
        }
      }
      return h('section', { className: 'mstudio-card' }, [
        h('div', { key: 'row', className: 'mstudio-row' }, [
          h('button', {
            key: 'record',
            type: 'button',
            className: recording ? 'mstudio-button primary' : 'mstudio-button',
            disabled: busy,
            onClick: () => {
              if (recording) void finishRecording(captureRef);
              else void startRecording();
            },
          }, h(Icon, { name: 'mic', size: 15 }),
            recording ? t('transcribe.recording', { seconds: elapsed }) : t('transcribe.record')),
          h('label', { key: 'upload', className: 'mstudio-button' }, [
            h(Icon, { key: 'i', name: 'download', size: 15 }),
            t('transcribe.upload'),
            h('input', {
              key: 'input',
              type: 'file',
              accept: 'audio/*',
              style: { display: 'none' },
              onChange: onUpload,
            }),
          ]),
          busy ? h('span', { key: 'busy', className: 'mstudio-meter' }, h('span', { className: 'mstudio-dot' }), t('transcribe.transcribing')) : null,
        ]),
        h('p', { key: 'provider', className: 'mstudio-note' }, t('transcribe.provider', { provider })),
        ready ? null : h('p', { key: 'prep', className: 'mstudio-note' }, t('transcribe.preparing')),
        error === undefined ? null : h('p', { key: 'error', className: 'mstudio-error' }, error),
        h('textarea', {
          key: 'output',
          className: 'mstudio-textarea short',
          placeholder: t('transcribe.empty'),
          value: transcript,
          onChange: (event) => setTranscript(event.target.value),
        }),
        transcript === ''
          ? null
          : h('div', { key: 'actions', className: 'mstudio-row' }, [
            h('button', { key: 'copy', type: 'button', className: 'mstudio-button', onClick: copyTranscript },
              h(Icon, { name: 'copy', size: 15 }), copied ? t('transcribe.copied') : t('transcribe.copy')),
          ]),
      ]);
    }
    /** Chat view for one `generate_speech` call: an inline audio player. */
    function SpeechToolView(props) {
      try {
        const t = translatorFor(props);
        const phase = props?.phase;
        const content = Array.isArray(props?.block?.content) ? props.block.content : [];
        const textBlock = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string');
        if (phase !== 'result') {
          return h('div', { className: 'mstudio-tool mstudio-tool-pending' }, h(Styles, {}), h(Icon, { name: 'waveform', size: 15 }), h('span', null, t('speech.generating')));
        }
        const file = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'file'
          && entry.attachment !== null && typeof entry.attachment === 'object'
          && typeof entry.attachment.attachmentId === 'string');
        if (file === undefined) {
          return h('div', { className: 'mstudio-tool' }, h(Styles, {}), h('div', { className: 'mstudio-tool-title' },
            h(Icon, { name: 'waveform', size: 15 }), h('span', null, textBlock?.text ?? t('tab.speech'))));
        }
        const src = `${ROUTE}/audio?id=${encodeURIComponent(file.attachment.attachmentId)}`;
        return h('div', { className: 'mstudio-tool' }, [
          h(Styles, { key: 'styles' }),
          h('div', { key: 'title', className: 'mstudio-tool-title' },
            h(Icon, { name: 'waveform', size: 15 }),
            h('span', null, textBlock?.text ?? t('tab.speech'))),
          h('audio', { key: 'audio', className: 'mstudio-audio', controls: true, preload: 'none', src }),
          h('div', { key: 'hint', className: 'mstudio-tool-hint' },
            typeof file.attachment.name === 'string' ? file.attachment.name : ''),
        ]);
      } catch {
        return null;
      }
    }
    /** Chat view for one `attach_material` call: the material that was added. */
    function MaterialToolView(props) {
      try {
        const t = translatorFor(props);
        const phase = props?.phase;
        const content = Array.isArray(props?.block?.content) ? props.block.content : [];
        const textBlock = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string');
        if (phase !== 'result') {
          return h('div', { className: 'mstudio-tool mstudio-tool-pending' }, h(Styles, {}), h(Icon, { name: 'image', size: 15 }), h('span', null, t('production.materials')));
        }
        return h('div', { className: 'mstudio-tool' }, [
          h(Styles, { key: 'styles' }),
          h('div', { key: 'title', className: 'mstudio-tool-title' }, h(Icon, { name: 'image', size: 15 }), h('span', null, textBlock?.text ?? t('production.materials'))),
        ]);
      } catch {
        return null;
      }
    }
    /** Chat view for one `generate_video` call: an inline video player. */
    function VideoToolView(props) {
      try {
        const t = translatorFor(props);
        const phase = props?.phase;
        const content = Array.isArray(props?.block?.content) ? props.block.content : [];
        const textBlock = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string');
        if (phase !== 'result') {
          return h('div', { className: 'mstudio-tool mstudio-tool-pending' }, h(Styles, {}), h(Icon, { name: 'video', size: 15 }), h('span', null, t('video.generating')));
        }
        const file = content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'file'
          && entry.attachment !== null && typeof entry.attachment === 'object'
          && typeof entry.attachment.attachmentId === 'string');
        if (file === undefined) {
          return h('div', { className: 'mstudio-tool' }, h(Styles, {}), h('div', { className: 'mstudio-tool-title' },
            h(Icon, { name: 'video', size: 15 }), h('span', null, textBlock?.text ?? t('tab.video'))));
        }
        const src = `${ROUTE}/video-file?id=${encodeURIComponent(file.attachment.attachmentId)}`;
        const name = typeof file.attachment.name === 'string' ? file.attachment.name : '';
        // A GIF is a picture, not a video: the player cannot show it.
        if (name.toLowerCase().endsWith('.gif')) {
          return h('div', { className: 'mstudio-tool' }, [
            h(Styles, { key: 'styles' }),
            h('div', { key: 'title', className: 'mstudio-tool-title' },
              h(Icon, { name: 'video', size: 15 }),
              h('span', null, textBlock?.text ?? t('tab.video'))),
            h('img', { key: 'image', className: 'mstudio-image', src, alt: name }),
            h('div', { key: 'hint', className: 'mstudio-tool-hint' }, name),
          ]);
        }
        return h('div', { className: 'mstudio-tool' }, [
          h(Styles, { key: 'styles' }),
          h('div', { key: 'title', className: 'mstudio-tool-title' },
            h(Icon, { name: 'video', size: 15 }),
            h('span', null, textBlock?.text ?? t('tab.video'))),
          h('video', { key: 'video', className: 'mstudio-video', controls: true, preload: 'metadata', src }),
          h('div', { key: 'hint', className: 'mstudio-tool-hint' }, name),
        ]);
      } catch {
        return null;
      }
    }
    // #endregion
    // #region Utilities
    /** Stop one in-flight recording capture and release the microphone. */
    function stopCapture(ref) {
      const capture = ref.current;
      if (capture === undefined) return;
      ref.current = undefined;
      clearInterval(capture.timer);
      clearTimeout(capture.stopTimer);
      try {
        capture.recorder.stop();
      } catch {
        // Already stopped.
      }
      for (const track of capture.stream.getTracks()) track.stop();
    }
    /** Revoke a held object URL, if any. */
    function revokeUrl(ref) {
      if (ref.current === undefined) return;
      try {
        URL.revokeObjectURL(ref.current);
      } catch {
        // Already revoked.
      }
      ref.current = undefined;
    }
    /** A short size for a byte count, such as "1.2 MB". */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '';
      if (value < 1024) return `${Math.round(value)} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
      return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
    }
    // #endregion
    return {
      inject: ['slots', 'locale', 'layout'],
      // Pure step-grid helpers, exposed so `node --test` can exercise the
      // grid-to-score conversion without rendering the panel.
      musicGrid: {
        ranges: MUSIC_RANGES,
        resolutions: MUSIC_RESOLUTIONS,
        rows: musicRows,
        score: gridToScore,
        pitchToHz,
        pitchToMidi,
        cellsToNotes,
        notesToCells,
        chooseResolution,
        chooseRange,
      },
      // The graphics form, exposed so `node --test` can render it without a
      // browser.
      graphicsTab: GraphicsTab,
      // The production form, for the same reason.
      productionTab: VideoTab,
      studioTab: StudioTab,
      studioTools,
      studioRunnable,
      studioSample,
      studioRequest,
      apply(ctx) {
        localeFace = ctx.get('locale');
        if (localeFace !== undefined) {
          ctx.effect(() => localeFace.register(NS, {
            en: DICTIONARIES.en,
            ja: DICTIONARIES.ja,
          }), 'media-studio: dictionaries');
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ close: () => ctx.layout.selectPanel(null) }),
        }, MediaStudioPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          label: () => translate('panel.title'),
          locale: NS,
        }, MediaStudioIcon));
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'generate_speech',
            locale: NS,
          }, SpeechToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'generate_music',
            locale: NS,
          }, SpeechToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'compose_music',
            locale: NS,
          }, SpeechToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'generate_sfx',
            locale: NS,
          }, SpeechToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'generate_video',
            locale: NS,
          }, VideoToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'make_motion_graphic',
            locale: NS,
          }, VideoToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'produce_video',
            locale: NS,
          }, VideoToolView);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'attach_material',
            locale: NS,
          }, MaterialToolView);
        });
      },
    };
  },});
