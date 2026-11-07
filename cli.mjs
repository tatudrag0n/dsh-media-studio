#!/usr/bin/env node
/**
 * メディアスタジオをテキストだけで使う CLI。
 *
 * パネル（コンポーザー下のメディアパネル）を廃止する前提の入口。DSH の外から、
 * ターミナルの 1 行で同じツールを叩ける。中ではプラグインの `apply()` を
 * 最小のコンテキストに載せて、登録されたツールをそのまま実行している
 * （ツールの実装を CLI 用に書き直さない）。
 *
 *   node cli.mjs help
 *   node cli.mjs status
 *   node cli.mjs tools
 *   node cli.mjs run probe_video --args '{"path":"media-studio/a.mp4"}'
 *   node cli.mjs run cad_model --args @parts.json --dir C:\work
 *   node cli.mjs render night-drive.yaml
 *   node cli.mjs render night-drive.yaml --dry-run
 *   node cli.mjs list --kind image
 *
 * 終了コード: 0 = 成功、1 = 失敗。
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The defaults this package ships, next to this file. */
const SHIPPED_PATCH = fileURLToPath(new URL('./cordis.patch.yml', import.meta.url));

/**
 * The row config the plugin runs with.
 *
 * DSH passes the row config to `apply()`; a CLI has to find it. In order:
 * `--config <file.json>`, then `MEDIA_STUDIO_CONFIG`, then the defaults this
 * package ships (`cordis.patch.yml`) layered with every DSH profile patch
 * (`~/.dsh/profiles/<profile>/cordis.patch.yml`), which win. The paths are read
 * with a small line scanner — no YAML dependency, and the same values DSH uses.
 *
 * @param {object} flags - parsed CLI flags.
 * @returns {Promise<object>} the config object for `apply()`.
 */
async function loadConfig(flags) {
  if (typeof flags.config === 'string' && flags.config !== '') {
    const text = await readFile(isAbsolute(flags.config) ? flags.config : resolve(flags.config), 'utf8');
    return JSON.parse(text);
  }
  const carried = process.env.MEDIA_STUDIO_CONFIG;
  if (typeof carried === 'string' && carried.trim() !== '') return JSON.parse(carried);
  return await detectConfig();
}

/** Layer the shipped defaults and the profile patches into one config. */
async function detectConfig() {
  const config = {};
  if (existsSync(SHIPPED_PATCH)) mergePaths(config, await readFile(SHIPPED_PATCH, 'utf8'));
  const root = join(homedir(), '.dsh', 'profiles');
  let profiles;
  try {
    profiles = await readdir(root);
  } catch {
    return config;
  }
  for (const profile of profiles) {
    const file = join(root, profile, 'cordis.patch.yml');
    if (!existsSync(file)) continue;
    mergePaths(config, await readFile(file, 'utf8'));
  }
  return config;
}

/** Copy the paths a patch sets into `config`, overwriting what is there. */
function mergePaths(config, text) {
  const soundfont = blockValue(text, 'soundfont', 'path');
  if (soundfont !== undefined) config.soundfont = { ...(config.soundfont ?? {}), path: soundfont };
  const ffmpeg = blockValue(text, 'video', 'ffmpegPath');
  if (ffmpeg !== undefined) config.video = { ...(config.video ?? {}), ffmpegPath: ffmpeg };
  const blender = blockValue(text, 'cad', 'blenderPath');
  if (blender !== undefined) config.cad = { ...(config.cad ?? {}), blenderPath: blender };
}

/** The value of `key:` inside the indented block that starts with `section:`. */
function blockValue(text, section, key) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(\s*)([A-Za-z][\w.-]*):\s*$/u.exec(lines[index]);
    if (heading === null || heading[2] !== section) continue;
    const indent = heading[1].length;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner];
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const innerIndent = line.length - line.trimStart().length;
      if (innerIndent <= indent) break;
      const pair = /^\s*([A-Za-z][\w.-]*):\s*(.+?)\s*$/u.exec(line);
      if (pair !== null && pair[1] === key) return pair[2];
    }
  }
  return undefined;
}

/** Tools the CLI may run: everything the plugin registers. */
function mountPlugin() {
  const registered = [];
  const context = {
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
      get(name) {
        return registered.find((tool) => tool.name === name);
      },
    },
    connection: { fetch: { register() { return () => {}; } } },
    get(name) {
      if (name === 'tools') return context.tools;
      if (name === 'attachments') {
        return {
          saveFile: async () => ({ id: 'cli' }),
          saveImage: async () => ({ id: 'cli' }),
        };
      }
      if (name === 'systemPrompt') return { section() { return () => {}; } };
      return undefined;
    },
    on() {},
  };
  return { context, registered };
}

/** Split `--flag value` and `--flag=value` out of the arguments. */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[token.slice(2)] = true;
      continue;
    }
    flags[token.slice(2)] = next;
    index += 1;
  }
  return { positional, flags };
}

/** `@file` reads JSON from disk; anything else is inline JSON. */
async function readJsonArgument(value) {
  if (typeof value !== 'string') return {};
  const text = value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value;
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--args は JSON のオブジェクトで渡してください。');
  }
  return parsed;
}

/** The text a tool wants shown, from its own renderer. */
function renderToolResult(tool, args, value) {
  const blocks = tool.output?.render?.(args, value) ?? [];
  const lines = blocks.filter((block) => block.type === 'text').map((block) => block.text);
  if (lines.length === 0) lines.push(JSON.stringify(value, null, 2));
  return lines.join('\n');
}

/** Print the JSON a machine can pipe, when `--json` is set. */
function printValue(value, flags) {
  if (flags.json === true) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `メディアスタジオ CLI — テキストだけで制作する

  node cli.mjs help
      この説明。

  node cli.mjs status [--json]
      何ができるか・バックエンド（ffmpeg / Blender / SoundFont）が生きているか。

  node cli.mjs tools [--json]
      実行できるツールの一覧。

  node cli.mjs run <tool> [--args <json|@file>] [--dir <dir>] [--json]
      ツールを 1 つ実行する。--dir は作業ディレクトリ（既定はカレント）。

  node cli.mjs render <project.yaml|md|json> [--dry-run] [--dir <dir>] [--json]
      テキストのプロジェクトファイルを上から順に実行する。

  node cli.mjs list [--kind image|audio|video|other] [--limit N] [--json]
      素材ライブラリを一覧する。

  node cli.mjs remove <asset-id> [--dry-run]
      素材をライブラリから消す（--dry-run で確認だけ）。

共通オプション:
  --config <file.json>   行設定を明示する（既定は同梱の cordis.patch.yml と
                         ~/.dsh/profiles/*/cordis.patch.yml から SoundFont /
                         ffmpeg / Blender のパスを拾う）
  --json                 機械可読な JSON も一緒に出す

例:
  node cli.mjs render docs/examples/video-cut.yaml
  node cli.mjs run edit_video --args @timeline.json --dir C:\\work
`;

/** Run one command. */
async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? 'help';

  if (command === 'help' || flags.help === true) {
    process.stdout.write(HELP);
    return 0;
  }

  if (typeof flags.dir === 'string' && flags.dir !== '') {
    process.chdir(isAbsolute(flags.dir) ? flags.dir : resolve(flags.dir));
  }

  const { context, registered } = mountPlugin();
  const plugin = await import('./index.js');
  plugin.apply(context, await loadConfig(flags));
  const tool = (name) => registered.find((entry) => entry.name === name);
  const exec = { sessionId: 'cli', agent: undefined };

  if (command === 'tools') {
    const names = registered
      .filter((entry) => entry.name !== 'media_create')
      .map((entry) => ({ name: entry.name, required: entry.parameters?.required ?? [] }));
    printValue(names, flags);
    for (const entry of names) {
      process.stdout.write(`${entry.name}${entry.required.length === 0 ? '' : `  (必須: ${entry.required.join(', ')})`}\n`);
    }
    return 0;
  }

  if (command === 'status') {
    const target = tool('studio_status');
    if (target === undefined) throw new Error('studio_status が登録されていません。');
    const value = await target.execute({ checkBackends: true }, exec);
    printValue(value, flags);
    process.stdout.write(`${renderToolResult(target, { checkBackends: true }, value)}\n`);
    return 0;
  }

  if (command === 'run') {
    const name = positional[1];
    if (name === undefined) throw new Error('run にはツール名が必要です。node cli.mjs tools で一覧できます。');
    const target = tool(name);
    if (target === undefined) throw new Error(`${name} は登録されていません。node cli.mjs tools で一覧できます。`);
    const args = await readJsonArgument(flags.args);
    const value = await target.execute(args, exec);
    printValue(value, flags);
    process.stdout.write(`${renderToolResult(target, args, value)}\n`);
    return 0;
  }

  if (command === 'render') {
    const path = positional[1];
    if (path === undefined) throw new Error('render にはプロジェクトファイルのパスが必要です。');
    const target = tool('render_project');
    if (target === undefined) throw new Error('render_project が登録されていません。');
    const args = { path, ...(flags['dry-run'] === true ? { dryRun: true } : {}) };
    const value = await target.execute(args, exec);
    printValue(value, flags);
    process.stdout.write(`${renderToolResult(target, args, value)}\n`);
    return value.failures !== undefined && value.failures > 0 ? 1 : 0;
  }

  if (command === 'list') {
    const target = tool('list_assets');
    if (target === undefined) throw new Error('list_assets が登録されていません。');
    const args = {
      ...(typeof flags.kind === 'string' ? { kind: flags.kind } : {}),
      ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
    };
    const value = await target.execute(args, exec);
    printValue(value, flags);
    process.stdout.write(`${renderToolResult(target, args, value)}\n`);
    return 0;
  }

  if (command === 'remove') {
    const id = positional[1];
    if (id === undefined) throw new Error('remove には素材の id が必要です。node cli.mjs list で確認できます。');
    const target = tool('remove_asset');
    if (target === undefined) throw new Error('remove_asset が登録されていません。');
    const args = { id, ...(flags['dry-run'] === true ? { dryRun: true } : {}) };
    const value = await target.execute(args, exec);
    printValue(value, flags);
    process.stdout.write(`${renderToolResult(target, args, value)}\n`);
    return 0;
  }

  process.stderr.write(`不明なコマンド: ${command}\n\n${HELP}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  },
);
