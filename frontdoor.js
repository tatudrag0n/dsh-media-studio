/**
 * 入口 (the front door).
 *
 * 1 行のプロンプトを、登録済みのツール 1 つに橋渡しする。どのツールも
 * `ctx.tools.get(name)` から取り出すので、ここは生成処理を持たない。
 * ツールの検証・保存・キャッシュ・表示はそのまま効く。
 *
 * 引数は各ツールの宣言済みプロパティへ**絞り込んでから**渡す。知らない
 * キーを送って `additionalProperties: false` に弾かれる事故を防ぐため。
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

import { CAPABILITIES, describeIntent, parseIntent, planIntent, shortTitle } from './intent.js';
import { isStudioTool } from './tools-list.js';
import { mediaKindOf } from './extra.js';

/**
 * Standing guidance for the agent.
 *
 * Without this the tools are a drawer of verbs nobody opens; with it the
 * studio is something the agent reaches for, and reuses what it already made.
 */
export const MEDIA_STUDIO_HINT = [
  '## Media Studio',
  '`media_create` turns one sentence into any studio artifact (image, sound effect, music, speech, lyrics, novel chapter, article, motion graphic, chart, video) and chooses the capability itself — use it when the request is a sentence rather than a known tool call.',
  '`list_media` lists what this session already produced. Call it before generating anything again: it returns the `path` of earlier output, which you can pass to `attach_material`, `produce_video` or `generate_video`, or read directly with the file tools when it is a `.md` or `.json` artifact.',
  'In an on-demand session these tools may be held back: load one with `tool_load` before calling it.',
  'Prefer reusing an existing asset over producing a near-duplicate, and keep the paths you were given so later steps can chain (a generated track as the bed of a generated video, a lyric file as the brief of a new take).',
  'For editing, CAD and DTM the studio has `edit_video` (a `timeline` → one file; `probe_video`, `export_timeline` to MLT/OTIO/FCPXML/EDL, `make_subtitles` for SRT/VTT), `cad_model`/`cad_drawing`/`cad_export` (parametric solids → STL/OBJ/GLB/PLY/DXF/SVG in mm) and `daw_arrange`/`export_daw_project`/`import_midi` (multitrack → WAV, MIDI, MusicXML, LMMS, Hydrogen). They take structured arguments, so call them directly rather than through `media_create`.',
].join('\n');

/**
 * Binary results larger than this are reported by path instead of inlined.
 * The panel previews media through a data URL, and a very large payload would
 * stall the browser for no benefit.
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** Media type by extension, for the panel's preview. */
const MEDIA_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * The session a panel request belongs to.
 *
 * A route has no calling Agent, but the model adapter routes nested calls by
 * session (the opencode adapter sends it as a header) and the working
 * directory is per session, so the request has to carry one. The live root
 * agent is the session the panel is showing.
 */
function activeSessionId(ctx) {
  const agents = ctx?.get?.('agents');
  const roots = typeof agents?.roots === 'function' ? agents.roots() : [];
  const agent = roots[roots.length - 1];
  const id = agent?.session?.id ?? agent?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Resolve one prompt into a finished result.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {{ resolveSessionCwd: Function }} helpers - session utilities from `index.js`.
 * @param {{ prompt: string, hint?: string, args?: object, agent?: object, sessionId?: string, signal?: AbortSignal }} request - the ask.
 * @returns {Promise<object>} capability, plan, summary, text, blocks, media and value.
 */
/**
 * Which tool a request runs, honouring an explicit tool name.
 *
 * The panel is going away, so a text request may name the tool outright:
 * `media_create tool="cad_model" args={...}` reaches every studio tool, not
 * just the ones a sentence can imply. An unknown name is an error rather than a
 * silent fallback — being told "that is not a studio tool" beats getting an
 * image when you asked for a bracket.
 *
 * @param {object} intent - the parsed intent.
 * @param {unknown} named - the request's `tool` field.
 * @returns {{ tool: string, args: object }} the plan to run.
 */
function resolvePlan(intent, named) {
  const text = typeof named === 'string' ? named.trim() : '';
  if (text === '') return planIntent(intent);
  if (!isStudioTool(text)) {
    throw new Error(`このツールはスタジオのものではありません: ${text}。studio_status で使える名前を確認してください。`);
  }
  return { tool: text, args: {} };
}

export async function runPrompt(ctx, options, helpers, request) {
  const prompt = typeof request?.prompt === 'string' ? request.prompt : '';
  const namedTool = typeof request?.tool === 'string' ? request.tool.trim() : '';
  // ツール名を指定する使い方では 1 文は要らない。空のまま解釈させると
  // 「プロンプトが空です」で止まるので、ツール名を文の代わりに渡しておく
  // （どのみち `resolvePlan` がツール名を優先する）。
  const intent = parseIntent(prompt !== '' ? prompt : namedTool, { hint: request?.hint });
  const plan = resolvePlan(intent, namedTool);
  const definition = ctx?.tools?.get?.(plan.tool) ?? ctx?.get?.('tools')?.get?.(plan.tool);
  if (definition === undefined) {
    throw new Error(
      `${plan.tool} が登録されていません。メディアスタジオのプラグインが有効か確認してください。Tool ${plan.tool} is not registered.`,
    );
  }
  // Explicit arguments win over the plan: the panel's editors re-run the same
  // prompt with the knobs a person moved.
  const planned = { ...plan.args, ...(request?.args ?? {}) };
  const args = filterArgs(definition, planned);
  const missing = missingRequired(definition, args);
  if (missing.length > 0) {
    throw new Error(describeMissing(intent, missing));
  }
  const sessionId = request?.sessionId ?? activeSessionId(ctx);
  const exec = { agent: request?.agent, signal: request?.signal, sessionId };
  let value;
  let note;
  // A fallback runs a different tool, so its renderer and arguments follow.
  let usedTool = plan.tool;
  let usedArgs = args;
  try {
    value = await definition.execute(args, exec);
  } catch (cause) {
    // The local video model is optional (it needs torch and diffusers). When
    // it is missing, a motion graphic is still a real MP4 the user can use,
    // so degrade to that instead of failing the whole request.
    const fallback = await tryFallback(ctx, plan.tool, intent, args, exec);
    if (fallback === undefined) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${intent.label}に失敗しました (${plan.tool}): ${message}`);
    }
    value = fallback.value;
    note = fallback.note;
    usedTool = fallback.tool;
    usedArgs = fallback.args;
  }
  const blocks = definition.output?.render?.(args, value) ?? [];
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
  const media = await readMedia(ctx, helpers, exec, value);
  // A normalized handle, so the caller always has a reusable path whatever
  // capability ran.
  const asset =
    typeof value?.path === 'string'
      ? {
          path: value.path,
          name: typeof value.name === 'string' ? value.name : value.path,
          kind: mediaKindOf(value.path),
          bytes: typeof value.bytes === 'number' ? value.bytes : media?.bytes,
        }
      : undefined;
  return {
    capability: intent.capability,
    label: intent.label,
    tool: usedTool,
    args: usedArgs,
    summary: describeIntent(intent),
    confidence: intent.confidence,
    subject: intent.subject,
    params: intent.params,
    text,
    blocks,
    media,
    asset,
    ...(note === undefined ? {} : { note }),
    value,
  };
}

/**
 * A working substitute when the preferred tool cannot run.
 *
 * Only video has one: the local model needs torch and diffusers, while the
 * motion renderer needs Pillow and ffmpeg, which this machine has. The result
 * is a real MP4 and the caller is told what happened.
 */
async function tryFallback(ctx, tool, intent, args, exec) {
  if (tool !== 'generate_video') return undefined;
  const motion = ctx?.tools?.get?.('make_motion_graphic') ?? ctx?.get?.('tools')?.get?.('make_motion_graphic');
  if (motion === undefined) return undefined;
  const fallbackArgs = filterArgs(motion, {
    text: shortTitle(intent.subject, 40),
    template: 'title',
    ...(typeof args.seconds === 'number' ? { seconds: Math.min(10, Math.max(1, args.seconds)) } : {}),
  });
  try {
    const value = await motion.execute(fallbackArgs, exec);
    return {
      value,
      tool: 'make_motion_graphic',
      args: fallbackArgs,
      note: '動画モデルが使えないため、モーショングラフィックスとして制作しました。The video model is unavailable, so this was produced as a motion graphic.',
    };
  } catch {
    return undefined;
  }
}

/** Keep only the arguments the tool declares, and drop empty ones. */export function filterArgs(definition, args) {
  const properties = definition?.parameters?.properties ?? {};
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue;
    if (properties[key] === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Required arguments the plan did not supply. */
function missingRequired(definition, args) {
  const required = Array.isArray(definition?.parameters?.required) ? definition.parameters.required : [];
  return required.filter((key) => args[key] === undefined);
}

/** A message a person can act on when the prompt is under-specified. */
function describeMissing(intent, missing) {
  if (intent.capability === 'chart' && missing.includes('values')) {
    return 'グラフには数値が必要です。「売上: A 10、B 20、C 30」のように、ラベルと数値を並べて書いてください。A chart needs numbers; name each label with its value.';
  }
  return `プロンプトに ${missing.join(', ')} が足りません。もう少し具体的に書いてください。The prompt is missing ${missing.join(', ')}.`;
}

/** Read the produced file back as base64, when the result is a file. */
export async function readMedia(ctx, helpers, exec, value) {
  const path = typeof value?.path === 'string' ? value.path : '';
  if (path === '') return undefined;
  try {
    const cwd = await helpers.resolveSessionCwd(ctx, exec);
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_INLINE_BYTES) {
      return { path, bytes: info.size, tooLarge: true };
    }
    const bytes = await readFile(absolute);
    const mime = MEDIA_TYPES[extname(absolute).toLowerCase()] ?? 'application/octet-stream';
    return { path, mime, bytes: bytes.length, base64: bytes.toString('base64') };
  } catch {
    return { path };
  }
}

/**
 * `media_create`: one prompt, any capability.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options.
 * @param {{ resolveSessionCwd: Function }} helpers - session utilities from `index.js`.
 * @returns {object} a tool definition.
 */
export function mediaCreateTool(ctx, options, helpers) {
  return {
    name: 'media_create',
    description: [
      'Do anything the studio can do from one plain-language prompt: an image, a sound effect, music, a spoken line, lyrics, a novel chapter, an article, a motion graphic, a chart, a video edit, a CAD part or a multitrack arrangement.',
      'Write the prompt the way a person would say it, in Japanese or English. Numbers in the prompt set the duration, tempo, key and aspect.',
      'Examples: "雨の効果音を30秒、ループで" / "夜のドライブ向けのシティポップ、92 BPM" / "灯台守の小説の第1章" / "1200字の記事" / "夜明けの海辺の灯台、横長".',
      `Capabilities: ${Object.values(CAPABILITIES).map((entry) => entry.label).join(', ')}.`,
      'Prefer the specific tool when you already know exactly what you want; use this when the request is a sentence.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      // `prompt` か `tool` のどちらかがあればよい。ツール名を指定する使い方では
      // 1 文は要らない（テキストから全ツールに届かせるための入口なので）。
      properties: {
        prompt: { type: 'string', description: 'What to make, in one sentence, in Japanese or English. Optional when `tool` names the tool outright.' },
        hint: {
          type: 'string',
          enum: Object.keys(CAPABILITIES),
          description: 'Force a capability when the sentence is ambiguous.',
        },
        args: {
          type: 'object',
          description: 'Structured arguments for the capability: the `timeline` of edit_video, the `parts` of cad_model, or the `arrangement` of daw_arrange. The prompt alone cannot describe these, so pass them here and they win over anything the sentence implied.',
        },
        tool: {
          type: 'string',
          description: 'Name the studio tool to run directly, e.g. "cad_model" or "probe_video". Use it when you already know which tool you want; `studio_status` lists every name. An unknown name is an error rather than a fallback.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          capability: { type: 'string' },
          label: { type: 'string' },
          tool: { type: 'string' },
          summary: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        const definition = ctx?.tools?.get?.(value.tool) ?? ctx?.get?.('tools')?.get?.(value.tool);
        const blocks = definition?.output?.render?.(value.args ?? {}, value.value) ?? [];
        // One text block reads better than two adjacent ones the harness would
        // concatenate without a separator.
        const texts = (blocks.length === 0 && typeof value?.text === 'string' && value.text !== '')
          ? [value.text]
          : blocks.filter((block) => block.type === 'text').map((block) => block.text);
        const rest = blocks.filter((block) => block.type !== 'text');
        const text = [`解釈: ${value.summary}`, ...(value.note === undefined ? [] : [value.note]), ...texts].filter((line) => typeof line === 'string' && line !== '').join('\n');
        const tail = value.asset === undefined ? '' : `\n再利用するときはこのパスを渡してください: ${value.asset.path}`;
        return text === '' && rest.length === 0 ? [] : [{ type: 'text', text: `${text}${tail}` }, ...rest];
      },
      presentationMeta(_args, value) {
        const path = value?.value?.path;
        return typeof path === 'string' ? { path } : { name: value?.label ?? 'media' };
      },
    },
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // `prompt` か `tool` のどちらかがあればよい。両方空のときだけ止める。
      const named = typeof args?.tool === 'string' ? args.tool.trim() : '';
      const sentence = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
      if (named === '' && sentence === '') {
        throw new Error('何を作るか書いてください（`prompt`）。ツールが決まっているなら `tool` に名前を渡してください（studio_status で一覧）。');
      }
      const result = await runPrompt(ctx, options, helpers, {
        prompt: args?.prompt,
        hint: args?.hint,
        // 構造化引数はそのまま流す。`edit_video` のタイムラインのように、
        // 1 文からは作れない入力はここで渡す。
        args: args?.args,
        tool: args?.tool,
        agent: exec?.agent,
        signal: exec?.signal,
      });
      return {
        capability: result.capability,
        label: result.label,
        tool: result.tool,
        args: result.args,
        summary: result.summary,
        confidence: result.confidence,
        subject: result.subject,
        text: result.text,
        ...(result.note === undefined ? {} : { note: result.note }),
        asset: result.asset,
        value: result.value,
      };
    },
  };
}
