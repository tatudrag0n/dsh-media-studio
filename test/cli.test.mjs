/**
 * CLI のスモークテスト。
 *
 * パネルを廃止する前提なので、`cli.mjs` は「DSH の外から同じツールを叩ける」
 * ことが仕事になる。ここではプロセスとして起動し、終了コードと出力だけを見る
 * （中身の実装ではなく、利用者が見る振る舞いを確かめる）。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/** Run the CLI and capture what a user would see. */
function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: DIRECTORY,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('help explains every command', () => {
  const result = runCli(['help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /メディアスタジオ CLI/u);
  for (const command of ['status', 'tools', 'run', 'render', 'list', 'remove']) {
    assert.match(result.stdout, new RegExp(`node cli\\.mjs ${command}`, 'u'), `${command} is documented`);
  }
});

test('tools lists the studio tools a text command can name', () => {
  const result = runCli(['tools']);
  assert.equal(result.status, 0);
  for (const name of ['edit_video', 'cad_model', 'daw_arrange', 'render_project', 'studio_status', 'list_assets']) {
    assert.match(result.stdout, new RegExp(`^${name}`, 'mu'), `${name} is listed`);
  }
});

test('a missing tool name is refused with an actionable message', () => {
  const result = runCli(['run', 'no_such_tool']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no_such_tool/u);
  assert.match(result.stderr, /node cli\.mjs tools/u);
});

test('a missing required argument is refused, not silently ignored', () => {
  const result = runCli(['run', 'probe_video']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /path/u);
});

test('render without a project file is refused', () => {
  const result = runCli(['render']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /プロジェクトファイル/u);
});

test('an unknown command prints the help and fails', () => {
  const result = runCli(['frobnicate']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不明なコマンド/u);
  assert.match(result.stderr, /node cli\.mjs help/u);
});
