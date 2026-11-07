/**
 * 素材ライブラリをテキストで操作する (the material library, driven by text).
 *
 * コンポーザー下のメディアパネルは廃止予定。パネルがやっていた
 * 「素材の一覧・プレビュー・削除」を、チャットのツール呼び出しだけで
 * 届くようにするのがこの module の役目。
 *
 * - `list_assets`  ライブラリの素材を一覧する（パネルの一覧の代わり）
 * - `asset_info`   素材 1 件の情報を返す（パネルのプレビューの代わり。中身は返さない）
 * - `remove_asset` 素材を消す（パネルの削除の代わり。`dryRun` で事故を防ぐ）
 *
 * 保存先の決定・拡張子からの種類判定・ファイルの読み書きは、すべて
 * `assets.js` の API（`assetDirectory` / `listAssets` / `readAsset` /
 * `removeAsset`）に任せる。ここで二重実装しない。ツール側に拡張子の表は
 * 持たない（`kind` は `assets.js` が付けた値をそのまま返す）。
 *
 * `index.js` から必要な小さな道具は引数で受け取り、この module は
 * index.js を import しない（循環参照を作らないため）。
 */

import {
  ASSET_KINDS,
  assetDirectory,
  listAssets,
  readAsset,
  removeAsset,
} from './assets.js';

/** The kinds a caller may filter by: the three `assets.js` knows, plus `other`. */
export const ASSET_KIND_NAMES = [...Object.keys(ASSET_KINDS), 'other'];

/** Page size for `list_assets` when the row configures nothing. */
const DEFAULT_LIMIT = 20;

/** Hard cap on one `list_assets` page, so a big library cannot flood the chat. */
const MAX_LIMIT = 200;

/**
 * Register the material library tools on the plugin context.
 *
 * Registration is synchronous: the tools are handed to `ctx.tools.register`
 * from `ctx.effect`, and every file-system call happens later, inside
 * `execute`. Nothing here awaits.
 *
 * @param {object} ctx - the plugin context (`ctx.effect`, `ctx.tools.register`).
 * @param {object} options - resolved plugin options (`options.assets.directory`).
 * @param {object} config - the raw row config (`config.library`).
 * @param {{ resolveSessionCwd: Function, formatBytes: Function, safeRelativeDir: Function }} helpers - small utilities owned by `index.js`.
 * @returns {void}
 */
export function registerLibraryTools(ctx, options, config, helpers) {
  const settings = resolveLibraryOptions(config);
  const tools = [
    listAssetsTool(options, settings, helpers),
    assetInfoTool(options, helpers),
    removeAssetTool(options, helpers),
  ];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `media-studio: ${tool.name} tool`);
  }
}

/** Normalise the `library` section of the row config. */
function resolveLibraryOptions(config) {
  const source = config?.library ?? {};
  return { limit: clampLimit(source.limit, DEFAULT_LIMIT) };
}

/** A page size between 1 and `MAX_LIMIT`; anything else falls back. */
function clampLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const whole = Math.floor(number);
  if (whole < 1) return fallback;
  return Math.min(whole, MAX_LIMIT);
}

/** Human-readable size, using `index.js`'s formatter when it is wired up. */
function bytesLabel(formatBytes, bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (typeof formatBytes === 'function') return formatBytes(value);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** The `id` a tool was called with, or a clear error. */
function requireId(args) {
  const id = typeof args?.id === 'string' ? args.id.trim() : '';
  if (id === '') throw new Error('id が必要です。list_assets で素材の id を確認してください。');
  return id;
}

/** `YYYY-MM-DD HH:MM` from an ISO timestamp, for the Japanese renders. */
function shortDate(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text;
}

/** The error every tool raises for an id the library does not know. */
function unknownId(id) {
  return new Error(
    `id "${id}" の素材はライブラリにありません。list_assets で id を確認してください。`,
  );
}

// ---------------------------------------------------------------------------
// list_assets
// ---------------------------------------------------------------------------

/** `list_assets`: the whole library, newest first, filtered by kind. */
function listAssetsTool(options, settings, helpers) {
  const formatBytes = helpers?.formatBytes;
  return {
    name: 'list_assets',
    description: [
      'List the material library: imported images, audio and video, plus the files earlier tools were given as material.',
      'This is the text replacement for the media panel, and every entry carries the `id` that `asset_info` and `remove_asset` take.',
      'Newest first. Filter with `kind` to see only the images, only the audio or only the video.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ASSET_KIND_NAMES,
          description: 'Only materials of this kind.',
        },
        limit: {
          type: 'integer',
          description: `How many entries to return, newest first. Defaults to ${settings.limit}, at most ${MAX_LIMIT}.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          count: { type: 'integer' },
          total: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'integer' },
                modifiedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value.total === 0) {
          return [
            {
              type: 'text',
              text: `素材ライブラリ ${value.dir} は空です。素材を追加してからもう一度 list_assets を呼んでください。`,
            },
          ];
        }
        const lines = value.entries.map(
          (entry) =>
            `- ${entry.name} (${entry.kind}, ${bytesLabel(formatBytes, entry.bytes)}, id ${entry.id}, ${shortDate(entry.modifiedAt)})`,
        );
        return [
          {
            type: 'text',
            text: [`素材 ${value.total} 件のうち ${value.count} 件 (新しい順):`, ...lines].join('\n'),
          },
        ];
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const directory = assetDirectory(options);
      const requested = typeof args?.kind === 'string' ? args.kind.trim() : '';
      if (requested !== '' && !ASSET_KIND_NAMES.includes(requested)) {
        throw new Error(
          `kind は ${ASSET_KIND_NAMES.join(' / ')} のどれかです: "${requested}"`,
        );
      }
      const library = await listAssets(directory);
      const matched = requested === '' ? library : library.filter((entry) => entry.kind === requested);
      const limit = clampLimit(args?.limit, settings.limit);
      const entries = matched.slice(0, limit).map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        bytes: entry.bytes,
        modifiedAt: entry.createdAt,
      }));
      return { dir: directory, count: entries.length, total: matched.length, entries };
    },
  };
}

// ---------------------------------------------------------------------------
// asset_info
// ---------------------------------------------------------------------------

/**
 * `asset_info`: one material's metadata and path.
 *
 * The panel could show a material inline; text cannot, so this returns where
 * the bytes are and what they are, never the bytes themselves.
 */
function assetInfoTool(options, helpers) {
  const formatBytes = helpers?.formatBytes;
  return {
    name: 'asset_info',
    description: [
      'Describe one material in the library: name, kind, size, media type and absolute path.',
      'This replaces the media panel preview: the bytes are not returned, only where they are.',
      'Use the `path` with `edit_video`, `attach_material`, `produce_video` or the file tools.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'The material id shown by `list_assets`.',
        },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          bytes: { type: 'integer' },
          mediaType: { type: 'string' },
          fileName: { type: 'string' },
          path: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
      render(_args, value) {
        return [
          {
            type: 'text',
            text: [
              `${value.name} (${value.kind}) — id ${value.id}`,
              `サイズ: ${bytesLabel(formatBytes, value.bytes)} / 種類: ${value.mediaType}`,
              `パス: ${value.path}`,
              `追加: ${shortDate(value.createdAt)}`,
              '中身は返していません。プレビューが必要ならこのパスを開いてください。',
            ].join('\n'),
          },
        ];
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = requireId(args);
      const directory = assetDirectory(options);
      const found = await readAsset(directory, id);
      if (found === undefined) throw unknownId(id);
      const { record } = found;
      return {
        dir: directory,
        id: record.id,
        name: record.name,
        kind: record.kind,
        bytes: record.bytes,
        mediaType: record.mediaType,
        fileName: record.fileName,
        path: record.path,
        createdAt: record.createdAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// remove_asset
// ---------------------------------------------------------------------------

/**
 * `remove_asset`: delete one material.
 *
 * Deleting is the one irreversible thing the panel could do, so this tool says
 * what it deleted, and `dryRun` reports the plan without touching the file.
 */
function removeAssetTool(options, helpers) {
  const formatBytes = helpers?.formatBytes;
  return {
    name: 'remove_asset',
    description: [
      'Delete one material from the library. This cannot be undone, so the reply states plainly that it was deleted.',
      'Pass `dryRun: true` first to see exactly what would be deleted without touching the file.',
      'An unknown `id` is an error rather than a silent no-op, so a typo never looks like a successful delete.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'The material id shown by `list_assets`.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would be deleted without deleting it. Defaults to false.',
        },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
          removed: { type: 'boolean' },
          dryRun: { type: 'boolean' },
        },
      },
      render(_args, value) {
        const facts = [
          `id: ${value.id}`,
          `サイズ: ${bytesLabel(formatBytes, value.bytes)} (${value.kind})`,
          `元のパス: ${value.path}`,
        ];
        if (value.dryRun === true) {
          return [
            {
              type: 'text',
              text: [
                `まだ消していません (dryRun)。素材 ${value.name} を消す予定です。`,
                ...facts,
                '本当に消すときは dryRun を付けずに、もう一度 remove_asset を呼んでください。',
              ].join('\n'),
            },
          ];
        }
        return [
          {
            type: 'text',
            text: [
              `消しました。素材 ${value.name} をライブラリから削除しました。`,
              ...facts,
              'この操作は取り消せません。',
            ].join('\n'),
          },
        ];
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const id = requireId(args);
      const directory = assetDirectory(options);
      // Look the record up first: it tells "unknown id" apart from "could not
      // unlink", and it gives the reply the name and path it reports.
      const record = (await listAssets(directory)).find((entry) => entry.id === id);
      if (record === undefined) {
        throw new Error(
          `id "${id}" の素材はライブラリにありません。消す前に list_assets で id を確認してください。`,
        );
      }
      const facts = {
        dir: directory,
        id: record.id,
        name: record.name,
        kind: record.kind,
        bytes: record.bytes,
        path: record.path,
      };
      if (args?.dryRun === true) return { ...facts, removed: false, dryRun: true };
      const removed = await removeAsset(directory, id);
      if (!removed) {
        throw new Error(
          `id "${id}" の素材を消せませんでした。ファイルが使用中か、権限がない可能性があります: ${record.path}`,
        );
      }
      return { ...facts, removed: true, dryRun: false };
    },
  };
}
