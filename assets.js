/**
 * The material library of the Media Studio plugin.
 *
 * A production is assembled from materials: a logo, a photograph, a music
 * bed, a recorded clip. The user drops them into the panel, or the agent
 * copies files into the library; both end up in the same place, so a scene
 * can name one by id.
 *
 * Materials live under `media-studio/assets/` in the harness home, next to
 * the sessions that produced from them. They stay there across harness
 * restarts, which is what makes a production editable the next day.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

/** The kinds of material the library recognises, by file extension. */
export const ASSET_KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'],
  video: ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'],
  audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'],
};

/** Media type per extension, for the ones the browser can show. */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** Largest material the library accepts, in bytes. */
export const MAX_ASSET_BYTES = 256 * 1024 * 1024;

/**
 * The directory that holds the materials.
 *
 * The library is shared: the panel and the agent put materials in the same
 * place, so a production can be edited the next day. It lives under the
 * harness home, which is the one folder both the panel request and a tool
 * call can name without knowing the session.
 */
export function assetDirectory(options) {
  const configured = typeof options?.assets?.directory === 'string' && options.assets.directory !== ''
    ? options.assets.directory
    : undefined;
  if (configured !== undefined) return resolve(configured);
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'media-studio', 'assets');
}

/** The kind of a material, from its name. */
export function assetKind(name) {
  const extension = extname(String(name ?? '')).toLowerCase();
  for (const [kind, extensions] of Object.entries(ASSET_KINDS)) {
    if (extensions.includes(extension)) return kind;
  }
  return 'other';
}

/** The media type of a material, from its name. */
export function assetMediaType(name) {
  return MEDIA_TYPES[extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Store one material and return its record.
 *
 * The file name carries the id, so the library can be read back without a
 * side-car index: `<id>_<safe name>`.
 */
export async function saveAsset(directory, { name, data }) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(0);
  if (bytes.byteLength === 0) throw new Error('空の素材は保存できません。');
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`素材が大きすぎます (${Math.round(bytes.byteLength / 1024 / 1024)} MB)。上限は ${MAX_ASSET_BYTES / 1024 / 1024} MB です。`);
  }
  const safeName = safeFileName(name);
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  await mkdir(directory, { recursive: true });
  const fileName = `${id}_${safeName}`;
  const path = join(directory, fileName);
  await writeFile(path, bytes);
  return {
    id,
    name: safeName,
    fileName,
    kind: assetKind(safeName),
    mediaType: assetMediaType(safeName),
    bytes: bytes.byteLength,
    path,
    createdAt: new Date().toISOString(),
  };
}

/** Every material in the library, newest first. */
export async function listAssets(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const index = entry.name.indexOf('_');
    if (index <= 0) continue;
    const id = entry.name.slice(0, index);
    const name = entry.name.slice(index + 1);
    try {
      const info = await stat(join(directory, entry.name));
      records.push({
        id,
        name,
        fileName: entry.name,
        kind: assetKind(name),
        mediaType: assetMediaType(name),
        bytes: info.size,
        path: join(directory, entry.name),
        createdAt: info.birthtimeMs > 0 ? new Date(info.birthtimeMs).toISOString() : new Date(info.mtimeMs).toISOString(),
      });
    } catch {
      // The file vanished while we were listing; skip it.
    }
  }
  records.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  return records;
}

/** The bytes of one material, or undefined when the id is unknown. */
export async function readAsset(directory, id) {
  const record = (await listAssets(directory)).find((entry) => entry.id === id);
  if (record === undefined) return undefined;
  try {
    const data = await readFile(record.path);
    return { record, data };
  } catch {
    return undefined;
  }
}

/** Remove one material from the library. */
export async function removeAsset(directory, id) {
  const record = (await listAssets(directory)).find((entry) => entry.id === id);
  if (record === undefined) return false;
  try {
    await unlink(record.path);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of one material, or undefined when the id is unknown. */
export async function assetPath(directory, id) {
  const record = (await listAssets(directory)).find((entry) => entry.id === id);
  return record?.path;
}

/** A file name that is safe on every file system. */
export function safeFileName(name) {
  const text = basename(String(name ?? '')).trim();
  const cleaned = text.replace(/[^\w.\- ]+/gu, '_').replace(/\s+/gu, ' ').trim();
  return cleaned === '' ? 'material' : cleaned.slice(0, 120);
}
