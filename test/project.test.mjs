/**
 * Tests for `project.js` (v3.1): the text project runner.
 *
 * The pure functions are tested directly — YAML subset, reference resolution,
 * normalisation, schema checking — and the tool is run for real: a three step
 * project (`generate_sfx` ×2 → `edit_video`) has to leave an MP4 on disk with
 * the bytes to prove it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { registerExtraTools } from '../extra.js';
import { registerNleTools } from '../nle.js';
import {
  ProjectError,
  collectReferences,
  extractFence,
  normalizeProject,
  parseProject,
  parseYamlSubset,
  projectFormat,
  registerProjectTools,
  resolveReferences,
  validateArgs,
} from '../project.js';

const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;

/** True when this machine can run an external binary. */
function hasBinary(name) {
  try {
    return spawnSync(name, ['-version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

const hasFfmpeg = hasBinary('ffmpeg') && hasBinary('ffprobe');

/** A session directory wired into every studio tool. */
function makeStudio(session, { config = {}, options = {} } = {}) {
  const tools = new Map();
  const ctx = {
    effect(effect) {
      effect();
    },
    get(name) {
      return name === 'tools' ? { get: (tool) => tools.get(tool) } : undefined;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
  };
  const helpers = {
    async resolveSessionCwd() {
      return session;
    },
    formatBytes(bytes) {
      return `${bytes} B`;
    },
    safeRelativeDir(dir) {
      return dir;
    },
  };
  const resolved = { outputDir: 'media-studio', video: {}, ...options };
  registerExtraTools(ctx, resolved, new Map(), config, helpers);
  registerNleTools(ctx, resolved, config, helpers);
  registerProjectTools(ctx, resolved, config, helpers);
  return { tools, ctx, helpers };
}

/** Every file under a directory, recursively. */
async function countFiles(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
  }
  return total;
}

/** A palette PNG drawn by ffmpeg, so a timeline has a picture to hold. */
function writeStill(path) {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'color=c=0x102030:s=320x180', '-frames:v', '1', path],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0 && existsSync(path);
}

// ---------------------------------------------------------------------------
// The YAML subset
// ---------------------------------------------------------------------------

describe('parseYamlSubset', () => {
  it('reads a nested mapping, a list and the scalar types', () => {
    const value = parseYamlSubset(
      [
        'version: 1',
        'title: 夜のドライブ PV',
        'steps:',
        '  - id: cover',
        '    tool: generate_image',
        '    args:',
        '      aspect: landscape',
        '      width: 1280',
        '      scale: 1.5',
        '      enabled: true',
        '      note: null',
      ].join('\n'),
    );
    assert.deepEqual(value, {
      version: 1,
      title: '夜のドライブ PV',
      steps: [{ id: 'cover', tool: 'generate_image', args: { aspect: 'landscape', width: 1280, scale: 1.5, enabled: true, note: null } }],
    });
  });

  it('reads a list of scalars, and a list nested under a key', () => {
    const value = parseYamlSubset(['labels:', '  - 一', '  - 二', 'nested:', '  groups:', '    - a', '    - b'].join('\n'));
    assert.deepEqual(value, { labels: ['一', '二'], nested: { groups: ['a', 'b'] } });
  });

  it('keeps a colon inside a quoted string', () => {
    const value = parseYamlSubset('prompt: "彼は言った: 行くよ"\nnested:\n  x: \'a: b\'\n');
    assert.equal(value.prompt, '彼は言った: 行くよ');
    assert.equal(value.nested.x, 'a: b');
  });

  it('reads flow lists and flow maps, one level nested', () => {
    const value = parseYamlSubset('a: [1, two, "three"]\nb: {x: 1, y: [z]}\n');
    assert.deepEqual(value, { a: [1, 'two', 'three'], b: { x: 1, y: ['z'] } });
  });

  it('reads a flow map or a flow list as a list item', () => {
    const value = parseYamlSubset(['notes:', '  - { start: 0, duration: 2, pitches: [A4] }', '  - [A4, C5]'].join('\n'));
    assert.deepEqual(value, { notes: [{ start: 0, duration: 2, pitches: ['A4'] }, ['A4', 'C5']] });
  });

  it('reads a flow value wrapped over several lines', () => {
    const value = parseYamlSubset(['notes:', '  - { start: 0, duration: 2,', '      pitches: [A4] }', '  - { start: 2, duration: 2 }'].join('\n'));
    assert.deepEqual(value, { notes: [{ start: 0, duration: 2, pitches: ['A4'] }, { start: 2, duration: 2 }] });
  });

  it('refuses a flow value that never closes', () => {
    assert.throws(() => parseYamlSubset('a:\n  - { x: 1\nb: 2'), /が足りません/u);
  });

  it('keeps newlines in a literal block scalar and folds a folded one', () => {
    const value = parseYamlSubset(['text: |', '  一行目', '  二行目', 'folded: >', '  これと', '  これを', '  つなぐ'].join('\n'));
    assert.equal(value.text, '一行目\n二行目\n');
    assert.equal(value.folded, 'これと これを つなぐ\n');
  });

  it('strips the trailing newline when the block scalar says so', () => {
    const value = parseYamlSubset('text: |-\n  a\n  b\nnext: 1\n');
    assert.equal(value.text, 'a\nb');
    assert.equal(value.next, 1);
  });

  it('ignores comments and blank lines, and allows a leading ---', () => {
    const value = parseYamlSubset(['---', '# プロジェクト', 'version: 1  # 固定', '', 'title: PV'].join('\n'));
    assert.deepEqual(value, { version: 1, title: 'PV' });
  });

  it('reads the project shape from the SPEC example', () => {
    const source = [
      'version: 1',
      'title: 夜のドライブ PV',
      'steps:',
      '  - id: cover',
      '    tool: generate_image',
      '    args:',
      '      prompt: 夜の海沿いの道路、ネオン、シネマティック',
      '      aspect: landscape',
      '  - id: bgm',
      '    tool: compose_music',
      '    args:',
      '      prompt: シティポップ、92 BPM',
      '      seconds: 20',
      '  - id: cut',
      '    tool: edit_video',
      '    args:',
      '      timeline:',
      '        tracks:',
      '          - type: video',
      '            clips:',
      '              - path: $cover',
      '                duration: 4',
      '          - type: audio',
      '            clips:',
      '              - path: $bgm',
      '                volume: 0.4',
      '      name: night-drive',
    ].join('\n');
    const project = normalizeProject(parseYamlSubset(source));
    assert.equal(project.title, '夜のドライブ PV');
    assert.deepEqual(project.steps.map((step) => [step.id, step.tool]), [
      ['cover', 'generate_image'],
      ['bgm', 'compose_music'],
      ['cut', 'edit_video'],
    ]);
    assert.deepEqual(project.steps[2].args.timeline.tracks[1].clips, [{ path: '$bgm', volume: 0.4 }]);
  });

  describe('refuses what it does not implement, with a line number', () => {
    const cases = [
      ['a tab used for indentation', 'version: 1\n\ttitle: x', 2, /タブ/u],
      ['an anchor', 'a: &x 1', 1, /アンカー/u],
      ['an alias', 'a: *x', 1, /アンカー/u],
      ['a tag', 'a: !tag x', 1, /アンカー/u],
      ['an unterminated quote', 'a: "x', 1, /引用符/u],
      ['a mapping without a space after the colon', 'a:1', 1, /「key: 値」/u],
      ['a duplicate key', 'a: 1\na: 2', 2, /重複/u],
      ['a colon inside a plain value', 'a: b: c', 1, /引用符/u],
      ['bad indentation', 'a: 1\n   b: 2', 2, /インデント|次の行/u],
      ['a list at the same indent as its key', 'a:\n- 1', 2, /深くインデント/u],
      ['two dashes on one line', 'a:\n  - - 1', 2, /2 つ以上/u],
      ['a document end marker', 'a: 1\n...', 2, /文書終端/u],
      ['a value continued on the next line', 'a: hello\n  world', 2, /複数行|次の行/u],
      ['a complex key', '? a\n: 1', 1, /対応外/u],
      ['a flow list that never closes', 'a: [1, 2', 1, /フロー/u],
      ['a mapping and a list mixed at one level', 'a: 1\n- 2', 2, /混ざって/u],
    ];
    for (const [name, source, line, pattern] of cases) {
      it(name, () => {
        assert.throws(
          () => parseYamlSubset(source),
          (error) => {
            assert.ok(error instanceof ProjectError, `${name}: ProjectError ではない: ${error}`);
            assert.equal(error.line, line, `${name}: 行番号が違う (${error.line})`);
            assert.match(error.message, new RegExp(`^${line} 行目: `, 'u'));
            assert.match(error.message, pattern);
            return true;
          },
        );
      });
    }
  });

  it('reports an empty document rather than returning null', () => {
    assert.throws(() => parseYamlSubset('   \n# only a comment\n'), /プロジェクトが空です/u);
  });
});

// ---------------------------------------------------------------------------
// Reading a project file
// ---------------------------------------------------------------------------

describe('parseProject', () => {
  it('picks the reader from the file name', () => {
    assert.equal(projectFormat('a/b/c.yaml'), 'yaml');
    assert.equal(projectFormat('c.yml'), 'yaml');
    assert.equal(projectFormat('C:\\work\\pv.json'), 'json');
    assert.equal(projectFormat('pv.md'), 'markdown');
    assert.equal(projectFormat('notes.markdown'), 'markdown');
    assert.equal(projectFormat(''), '');
  });

  it('prefers JSON, then falls back to YAML', () => {
    const json = parseProject('{"version": 1, "steps": [{"tool": "generate_sfx"}]}');
    assert.equal(json.format, 'json');
    assert.equal(json.project.steps[0].tool, 'generate_sfx');
    const yaml = parseProject('version: 1\nsteps:\n  - tool: generate_sfx\n');
    assert.equal(yaml.format, 'yaml');
    assert.equal(yaml.container, 'text');
  });

  it('reads only JSON from a .json file', () => {
    assert.throws(() => parseProject('version: 1\n', { path: 'pv.json' }), /JSON として読めません/u);
  });

  it('reads the first yaml fence of a Markdown file', () => {
    const markdown = [
      '# 夜のドライブ PV',
      '',
      '作り方はこのとおり。',
      '',
      '```yaml',
      'version: 1',
      'steps:',
      '  - tool: generate_sfx',
      '```',
      '',
      '```json',
      '{"version": 1, "steps": [{"tool": "generate_image"}]}',
      '```',
    ].join('\n');
    const parsed = parseProject(markdown, { path: 'pv.md' });
    assert.equal(parsed.container, 'markdown');
    assert.equal(parsed.format, 'yaml');
    assert.equal(parsed.project.steps[0].tool, 'generate_sfx');
  });

  it('reads a json fence and keeps the line numbers of the file', () => {
    const markdown = ['# title', '', '```json', '{"version": 1}', '```'].join('\n');
    const parsed = parseProject(markdown, { path: 'pv.md' });
    assert.equal(parsed.format, 'json');
    assert.equal(parsed.project.version, 1);
  });

  it('offsets YAML errors by the fence position', () => {
    const markdown = ['# title', '', '```yaml', 'a: "unterminated', '```'].join('\n');
    assert.throws(
      () => parseProject(markdown, { path: 'pv.md' }),
      (error) => {
        assert.equal(error.line, 4);
        assert.match(error.message, /^4 行目: /u);
        return true;
      },
    );
  });

  it('reads a Markdown project passed as source, fence and all', () => {
    const parsed = parseProject('# 手順\n\n```yaml\nversion: 1\nsteps:\n  - tool: generate_sfx\n```\n');
    assert.equal(parsed.container, 'markdown');
    assert.equal(parsed.project.steps[0].tool, 'generate_sfx');
  });

  it('says what a Markdown project is missing', () => {
    assert.throws(() => parseProject('# 手順だけ\n', { path: 'pv.md' }), /```yaml/u);
  });

  it('finds a fence only when the language is yaml or json', () => {
    assert.equal(extractFence('```js\nconst a = 1;\n```\n'), undefined);
    assert.deepEqual(extractFence('```yml\nversion: 1\n```\n').format, 'yaml');
  });
});

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

describe('normalizeProject', () => {
  it('fills in the ids and the empty arguments', () => {
    const project = normalizeProject({ version: 1, steps: [{ tool: 'generate_sfx' }, { tool: 'edit_video', args: { name: 'x' } }] });
    assert.deepEqual(project.steps.map((step) => step.id), ['step1', 'step2']);
    assert.deepEqual(project.steps[0].args, {});
    assert.equal(project.version, 1);
  });

  it('accepts a project without version and normalises outputDir', () => {
    const project = normalizeProject({ title: 12, outputDir: 'media-studio/pv/', steps: [{ tool: 'generate_sfx' }] });
    assert.equal(project.version, 1);
    assert.equal(project.title, '12');
    assert.equal(project.outputDir, 'media-studio/pv');
  });

  const failures = [
    ['a non-object document', [], /オブジェクト/u],
    ['an unknown top-level key', { steps: [{ tool: 'generate_sfx' }], extra: 1 }, /不明なキー「extra」/u],
    ['an unsupported version', { version: 2, steps: [{ tool: 'generate_sfx' }] }, /version は 1/u],
    ['no steps', { version: 1 }, /steps は/u],
    ['empty steps', { version: 1, steps: [] }, /steps が空/u],
    ['a step that is not an object', { steps: ['generate_sfx'] }, /手順 1 は/u],
    ['a step without a tool', { steps: [{ args: {} }] }, /tool がありません/u],
    ['an unknown tool name', { steps: [{ tool: 'make_something' }] }, /「make_something」は使えません/u],
    ['the project runner itself', { steps: [{ tool: 'render_project' }] }, /使えません/u],
    ['an unknown step key', { steps: [{ tool: 'generate_sfx', arg: {} }] }, /不明なキー「arg」/u],
    ['a bad id', { steps: [{ tool: 'generate_sfx', id: '1cover' }] }, /id「1cover」は使えません/u],
    ['a duplicate id', { steps: [{ tool: 'generate_sfx', id: 'a' }, { tool: 'generate_sfx', id: 'a' }] }, /重複/u],
    ['args that are a list', { steps: [{ tool: 'generate_sfx', args: [] }] }, /args は/u],
    ['an absolute outputDir', { outputDir: 'C:/work', steps: [{ tool: 'generate_sfx' }] }, /outputDir/u],
    ['an outputDir that climbs out', { outputDir: '../out', steps: [{ tool: 'generate_sfx' }] }, /outputDir/u],
  ];
  for (const [name, raw, pattern] of failures) {
    it(`refuses ${name}`, () => {
      assert.throws(() => normalizeProject(raw), pattern);
    });
  }

  it('refuses more steps than allowed', () => {
    const steps = Array.from({ length: 3 }, () => ({ tool: 'generate_sfx' }));
    assert.throws(() => normalizeProject({ steps }, { maxSteps: 2 }), /手順が多すぎます/u);
  });
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

describe('collectReferences', () => {
  it('finds whole and embedded references, and skips the escaped form', () => {
    const found = collectReferences({
      a: '$cover',
      b: '$bgm.bytes',
      c: 'prefix {{cover.path}} suffix',
      d: '$$literal',
      e: ['$one.name'],
      f: 3,
    });
    assert.deepEqual(
      found.map((reference) => [reference.id, reference.field, reference.embedded]),
      [
        ['cover', undefined, false],
        ['bgm', 'bytes', false],
        ['cover', 'path', true],
        ['one', 'name', false],
      ],
    );
  });
});

describe('resolveReferences', () => {
  const results = new Map([
    ['cover', { id: 'cover', tool: 'generate_image', path: 'media-studio/cover.png', absPath: '/s/media-studio/cover.png', bytes: 2048, name: 'cover.png', attachmentId: 'att_1' }],
    ['bgm', { id: 'bgm', tool: 'compose_music', path: 'media-studio/bgm.wav', bytes: 4096, name: 'bgm.wav' }],
  ]);

  it('replaces $id with the earlier path', () => {
    assert.equal(resolveReferences('$cover', results), 'media-studio/cover.png');
  });

  it('replaces $id.field with that field', () => {
    assert.equal(resolveReferences('$cover.bytes', results), 2048);
    assert.equal(resolveReferences('$cover.absPath', results), '/s/media-studio/cover.png');
    assert.equal(resolveReferences('$cover.attachmentId', results), 'att_1');
    assert.equal(resolveReferences('$cover.name', results), 'cover.png');
  });

  it('embeds a reference inside a longer string', () => {
    assert.equal(resolveReferences('dir/{{cover.name}}', results), 'dir/cover.png');
    assert.equal(resolveReferences('{{cover.bytes}} bytes', results), '2048 bytes');
  });

  it('walks nested lists and objects', () => {
    const args = {
      timeline: { tracks: [{ clips: [{ path: '$cover' }, { path: '$bgm', volume: 0.4 }] }] },
      name: 'night-drive',
      count: 2,
      flag: true,
    };
    assert.deepEqual(resolveReferences(args, results), {
      timeline: { tracks: [{ clips: [{ path: 'media-studio/cover.png' }, { path: 'media-studio/bgm.wav', volume: 0.4 }] }] },
      name: 'night-drive',
      count: 2,
      flag: true,
    });
  });

  it('treats $$ as an escaped dollar sign', () => {
    assert.equal(resolveReferences('$$5.00', results), '$5.00');
  });

  it('refuses a reference to a step that has not run', () => {
    assert.throws(
      () => resolveReferences('$later', results),
      (error) => {
        assert.ok(error instanceof ProjectError);
        assert.match(error.message, /「\$later」/u);
        assert.match(error.message, /まだ実行されていません/u);
        return true;
      },
    );
  });

  it('refuses a field the result does not have, and lists the ones it has', () => {
    assert.throws(() => resolveReferences('$bgm.attachmentId', results), /「bgm」に「attachmentId」がありません/u);
  });

  it('refuses $id when the result made no single file', () => {
    const noPath = new Map([['list', { id: 'list', tool: 'list_media', total: 3 }]]);
    assert.throws(() => resolveReferences('$list', noPath), /path がありません/u);
  });

  it('gives the first file when the step reported several', () => {
    const many = new Map([
      ['drawing', { id: 'drawing', path: 'media-studio/d-front.png', bytes: 10, files: [{ path: 'media-studio/d-front.png' }, { path: 'media-studio/d-top.png' }] }],
    ]);
    assert.equal(resolveReferences('$drawing', many), 'media-studio/d-front.png');
  });

  it('leaves the reference visible during a dry run', () => {
    assert.equal(resolveReferences('$later', results, { dryRun: true }), '$later');
    assert.equal(resolveReferences('$later.bytes', results, { dryRun: true }), '$later.bytes');
    assert.equal(resolveReferences('dir/{{later.path}}', results, { dryRun: true }), 'dir/{{later.path}}');
  });

  it('records what it replaced', () => {
    const trace = [];
    resolveReferences('$cover', results, { trace });
    assert.deepEqual(trace, [{ from: '$cover', step: 'cover', field: 'path', value: 'media-studio/cover.png' }]);
  });
});

// ---------------------------------------------------------------------------
// Argument checking
// ---------------------------------------------------------------------------

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['chime', 'rain'] },
      duration: { type: 'number' },
      timeline: {
        type: 'object',
        required: ['tracks'],
        properties: {
          tracks: { type: 'array', minItems: 1, items: { type: 'object', properties: { type: { type: 'string', enum: ['video', 'audio'] } } } },
        },
      },
    },
  };

  it('accepts arguments that fit', () => {
    assert.deepEqual(validateArgs(schema, { kind: 'chime', duration: 1, timeline: { tracks: [{ type: 'audio' }] } }), []);
  });

  it('reports a missing required argument with its path', () => {
    assert.deepEqual(validateArgs(schema, { duration: 1 }), ['args.kind: 必須の引数がありません。']);
  });

  it('reports a type mismatch', () => {
    const problems = validateArgs(schema, { kind: 'chime', duration: '1' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^args\.duration: number が必要/u);
  });

  it('reports a value outside the enum', () => {
    const problems = validateArgs(schema, { kind: 'boom' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /args\.kind: "boom" は選べません/u);
    assert.match(problems[0], /"chime", "rain"/u);
  });

  it('reports an argument the tool does not have', () => {
    assert.deepEqual(validateArgs(schema, { kind: 'chime', colour: 'red' }), ['args.colour: このツールには無い引数です。']);
  });

  it('descends into nested lists and objects', () => {
    const problems = validateArgs(schema, { kind: 'chime', timeline: { tracks: [] } });
    assert.deepEqual(problems, ['args.timeline.tracks: 1 個以上必要です（0 個）。']);
    const deeper = validateArgs(schema, { kind: 'chime', timeline: { tracks: [{ type: 'midi' }] } });
    assert.deepEqual(deeper, ['args.timeline.tracks[0].type: "midi" は選べません（"video", "audio" のどれか）。']);
  });

  it('does not type-check a placeholder a dry run left behind', () => {
    assert.deepEqual(validateArgs(schema, { kind: 'chime', duration: '$bgm.seconds' }), []);
  });

  it('ignores schema keywords it does not implement', () => {
    const exotic = { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } };
    assert.deepEqual(validateArgs(exotic, { a: 1 }), []);
  });
});

// ---------------------------------------------------------------------------
// Registering the tool
// ---------------------------------------------------------------------------

describe('registerProjectTools', () => {
  it('registers render_project once, synchronously, with its arguments', () => {
    const session = join(tmpdir(), 'dsh-project-register');
    const { tools } = makeStudio(session);
    assert.deepEqual([...tools.keys()].filter((name) => name === 'render_project'), ['render_project']);
    const tool = tools.get('render_project');
    assert.equal(tool.timeoutMs, 1800000);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['dryRun', 'path', 'source', 'stopOnError']);
    for (const property of Object.values(tool.parameters.properties)) {
      assert.match(property.description, /[A-Za-z]{4}/u);
      assert.doesNotMatch(property.description, JAPANESE);
    }
    assert.equal(tool.parameters.required, undefined);
    assert.match(tool.description, /render_project|project file/u);
    assert.doesNotMatch(tool.description, JAPANESE);
  });

  it('takes its timeout and step limit from the row config', () => {
    const { tools } = makeStudio(join(tmpdir(), 'dsh-project-config'), { config: { project: { timeoutMs: 5000, maxSteps: 3 } } });
    assert.equal(tools.get('render_project').timeoutMs, 5000);
  });

  it('renders the dry run in Japanese, listing the steps', () => {
    const { tools } = makeStudio(join(tmpdir(), 'dsh-project-render'));
    const rendered = tools.get('render_project').output.render({}, {
      title: '夜のドライブ',
      dryRun: true,
      steps: [{ id: 'a', tool: 'generate_sfx', ok: true, args: { kind: 'chime' } }],
      artifacts: [],
      failures: [],
      seconds: 0,
    });
    const text = rendered.map((part) => part.text).join('\n');
    assert.match(text, JAPANESE);
    assert.match(text, /ドライラン/u);
    assert.match(text, /- a: generate_sfx/u);
  });

  it('renders a finished run with the artifact paths and sizes', () => {
    const { tools } = makeStudio(join(tmpdir(), 'dsh-project-render2'));
    const rendered = tools.get('render_project').output.render({}, {
      title: 'PV',
      dryRun: false,
      steps: [{ id: 'a', tool: 'generate_sfx', ok: true, path: 'media-studio/a.wav', bytes: 10 }],
      artifacts: [{ id: 'a', tool: 'generate_sfx', path: 'media-studio/a.wav', bytes: 10, mediaType: 'audio/wav' }],
      failures: [],
      seconds: 1.5,
    });
    const text = rendered.map((part) => part.text).join('\n');
    assert.match(text, /1 ステップ中 1 成功/u);
    assert.match(text, /media-studio\/a\.wav \(10 B\)/u);
  });
});

// ---------------------------------------------------------------------------
// Running a project
// ---------------------------------------------------------------------------

describe('render_project', () => {
  let session;

  before(async () => {
    session = await mkdtemp(join(tmpdir(), 'dsh-project-'));
  });

  after(async () => {
    await rm(session, { recursive: true, force: true });
  });

  it('needs path or source', async () => {
    const { tools } = makeStudio(session);
    await assert.rejects(() => tools.get('render_project').execute({}, {}), /path か source/u);
  });

  it('says which file it could not read', async () => {
    const { tools } = makeStudio(session);
    await assert.rejects(() => tools.get('render_project').execute({ path: 'no-such-project.yaml' }, {}), /プロジェクトファイルを読めません/u);
  });

  it('creates nothing at all on a dry run', async () => {
    const { tools } = makeStudio(session);
    const project = [
      'version: 1',
      'title: 確認だけ',
      'steps:',
      '  - id: tone',
      '    tool: generate_sfx',
      '    args:',
      '      kind: chime',
      '      duration: 1',
      '  - id: cut',
      '    tool: edit_video',
      '    args:',
      '      timeline:',
      '        tracks:',
      '          - type: video',
      '            clips:',
      '              - path: $tone',
      '                duration: 1',
    ].join('\n');
    const before = await countFiles(session);
    const result = await tools.get('render_project').execute({ source: project, dryRun: true }, {});
    const after = await countFiles(session);
    assert.equal(after, before, `${before} 件あったファイルが ${after} 件になった`);
    assert.equal(result.dryRun, true);
    assert.equal(result.artifacts.length, 0);
    assert.deepEqual(result.steps.map((step) => step.id), ['tone', 'cut']);
    assert.equal(result.steps[1].ok, true);
    assert.equal(result.steps[1].args.timeline.tracks[0].clips[0].path, '$tone');
    assert.equal(JSON.stringify(result).includes('undefined'), false);
  });

  it('refuses a reference to a later step before running anything', async () => {
    const { tools } = makeStudio(session);
    const project = [
      'steps:',
      '  - id: cut',
      '    tool: edit_video',
      '    args:',
      '      timeline:',
      '        tracks:',
      '          - type: video',
      '            clips:',
      '              - path: $tone',
      '  - id: tone',
      '    tool: generate_sfx',
      '    args:',
      '      kind: chime',
    ].join('\n');
    const before = await countFiles(session);
    await assert.rejects(
      () => tools.get('render_project').execute({ source: project }, {}),
      /参照できるのは前の手順だけです/u,
    );
    assert.equal(await countFiles(session), before);
  });

  it('refuses an id that is not in the project', async () => {
    const { tools } = makeStudio(session);
    const project = ['steps:', '  - tool: generate_sfx', '    args:', '      path: $nope'].join('\n');
    await assert.rejects(() => tools.get('render_project').execute({ source: project }, {}), /id「nope」はこのプロジェクトにありません/u);
  });

  it('reports arguments the tool cannot accept, by path', async () => {
    const { tools } = makeStudio(session);
    const project = ['steps:', '  - id: tone', '    tool: generate_sfx', '    args:', '      kind: not-a-sound'].join('\n');
    const result = await tools.get('render_project').execute({ source: project }, {});
    assert.equal(result.steps[0].ok, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /args\.kind/u);
    assert.match(result.failures[0].error, /選べません/u);
    assert.equal(result.artifacts.length, 0);
  });

  it('stops at the first failing step, and keeps going when told to', async () => {
    const { tools } = makeStudio(session);
    const project = [
      'steps:',
      '  - id: broken',
      '    tool: generate_sfx',
      '    args:',
      '      kind: not-a-sound',
      '  - id: fine',
      '    tool: generate_sfx',
      '    args:',
      '      kind: click',
      '      duration: 0.3',
    ].join('\n');
    const stopped = await tools.get('render_project').execute({ source: project }, {});
    assert.equal(stopped.steps.length, 1);
    assert.equal(stopped.failures.length, 1);
    assert.equal(stopped.artifacts.length, 0);

    const continued = await tools.get('render_project').execute({ source: project, stopOnError: false }, {});
    assert.equal(continued.steps.length, 2);
    assert.equal(continued.steps[1].ok, true);
    assert.equal(continued.failures.length, 1);
    assert.equal(continued.artifacts.length, 1);
    assert.ok(continued.artifacts[0].bytes > 0);
  });

  it('runs a three step project for real and leaves the files on disk', { timeout: 300000 }, async (t) => {
    if (!hasFfmpeg) {
      t.skip('ffmpeg / ffprobe がないので実測できません');
      return;
    }
    const poster = join(session, 'poster.png');
    if (!writeStill(poster)) {
      t.skip('ffmpeg で下地の PNG を作れませんでした');
      return;
    }
    const { tools } = makeStudio(session);
    const project = [
      'version: 1',
      'title: 夜のドライブ PV',
      'outputDir: media-studio',
      'steps:',
      '  - id: chime',
      '    tool: generate_sfx',
      '    args:',
      '      kind: chime',
      '      duration: 1',
      '      name: chime',
      '  - id: bed',
      '    tool: generate_sfx',
      '    args:',
      '      kind: rain',
      '      duration: 2',
      '      name: rain',
      '  - id: cut',
      '    tool: edit_video',
      '    args:',
      '      name: pv',
      '      timeline:',
      '        width: 320',
      '        height: 180',
      '        fps: 12',
      '        tracks:',
      '          - type: video',
      '            clips:',
      '              - path: poster.png',
      '                duration: 1.5',
      '          - type: audio',
      '            clips:',
      '              - path: $chime',
      '                volume: 0.5',
      '              - path: $bed',
      '                volume: 0.2',
      '                duck: true',
    ].join('\n');
    const result = await tools.get('render_project').execute({ source: project }, {});

    assert.deepEqual(result.steps.map((step) => [step.id, step.ok]), [['chime', true], ['bed', true], ['cut', true]]);
    assert.equal(result.failures.length, 0);
    assert.equal(result.artifacts.length, 3);
    assert.equal(result.title, '夜のドライブ PV');

    const video = result.artifacts.find((artifact) => artifact.id === 'cut');
    assert.equal(video.path, join('media-studio', 'pv.mp4'));
    assert.equal(video.mediaType, 'video/mp4');
    assert.ok(video.bytes > 1000, `MP4 が小さすぎる: ${video.bytes}`);
    const written = await stat(join(session, 'media-studio', 'pv.mp4'));
    assert.equal(written.size, video.bytes);

    for (const artifact of result.artifacts) {
      const info = await stat(join(session, artifact.path));
      assert.equal(info.size, artifact.bytes, `${artifact.path} のサイズが記録と違う`);
      assert.ok(info.size > 0, `${artifact.path} が空`);
    }
    const chime = result.artifacts.find((artifact) => artifact.id === 'chime');
    assert.match(chime.path, /chime\.wav$/u);
    assert.equal(chime.mediaType, 'audio/wav');

    const rendered = tools.get('render_project').output.render({}, result);
    const text = rendered.map((part) => part.text).join('\n');
    assert.match(text, /3 ステップ中 3 成功/u);
    assert.match(text, /pv\.mp4/u);
  });

  it('reads a project from a YAML file in the session', async () => {
    const { tools } = makeStudio(session);
    await writeFile(join(session, 'recipe.yaml'), ['version: 1', 'title: ファイルから', 'steps:', '  - tool: generate_sfx', '    args:', '      kind: pop', '      duration: 0.3'].join('\n'), 'utf8');
    const result = await tools.get('render_project').execute({ path: 'recipe.yaml' }, {});
    assert.equal(result.title, 'ファイルから');
    assert.equal(result.artifacts.length, 1);
    assert.ok(result.artifacts[0].bytes > 0);
  });

  it('reports a project outputDir as the default for the tools that accept one', async () => {
    const { tools } = makeStudio(session);
    const project = [
      'version: 1',
      'outputDir: media-studio/pv',
      'steps:',
      '  - tool: edit_video',
      '    args:',
      '      timeline:',
      '        tracks:',
      '          - type: video',
      '            clips:',
      '              - path: poster.png',
    ].join('\n');
    const result = await tools.get('render_project').execute({ source: project, dryRun: true }, {});
    assert.equal(result.steps[0].ok, true);
    assert.equal(result.steps[0].args.outputDir, 'media-studio/pv');
    assert.equal(result.artifacts.length, 0);
  });

  it('reads a project out of a Markdown fence', async () => {
    const { tools } = makeStudio(session);
    const markdown = [
      '# 効果音の作り方',
      '',
      'この 2 行で 1 つ作れます。',
      '',
      '```yaml',
      'version: 1',
      'title: Markdown の手順書',
      'steps:',
      '  - tool: generate_sfx',
      '    args:',
      '      kind: beep',
      '      duration: 0.2',
      '      name: beep',
      '```',
    ].join('\n');
    await writeFile(join(session, 'how-to.md'), markdown, 'utf8');
    const result = await tools.get('render_project').execute({ path: 'how-to.md' }, {});
    assert.equal(result.title, 'Markdown の手順書');
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].path, join('media-studio', 'beep.wav'));
    const info = await stat(join(session, 'media-studio', 'beep.wav'));
    assert.ok(info.size > 0);
  });

  it('reports a tool that is not registered in this environment', async () => {
    const tools = new Map();
    const ctx = {
      effect(effect) {
        effect();
      },
      get() {
        return { get: (name) => tools.get(name) };
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
    };
    registerProjectTools(ctx, { outputDir: 'media-studio' }, {}, {
      async resolveSessionCwd() {
        return session;
      },
      formatBytes(bytes) {
        return `${bytes} B`;
      },
      safeRelativeDir(dir) {
        return dir;
      },
    });
    const project = ['steps:', '  - tool: generate_sfx', '    args:', '      kind: click'].join('\n');
    const result = await tools.get('render_project').execute({ source: project }, {});
    assert.equal(result.steps[0].ok, false);
    assert.match(result.failures[0].error, /登録されていません/u);
  });

  it('reports every file a step wrote, not just the first', async () => {
    const { tools } = makeStudio(session);
    const permissive = { type: 'object', properties: {} };
    tools.set('cad_model', {
      name: 'cad_model',
      parameters: permissive,
      async execute() {
        return { path: 'media-studio/part.stl', bytes: 100, mediaType: 'model/stl' };
      },
    });
    tools.set('cad_drawing', {
      name: 'cad_drawing',
      parameters: permissive,
      async execute() {
        return {
          name: 'part-drawing',
          path: 'media-studio/part-front.png',
          bytes: 200,
          mediaType: 'image/png',
          files: [
            { name: 'front', path: 'media-studio/part-front.png', bytes: 200, mediaType: 'image/png', view: 'front' },
            { name: 'top', path: 'media-studio/part-top.png', bytes: 300, mediaType: 'image/png', view: 'top' },
            { name: 'iso', path: 'media-studio/part-iso.png', bytes: 400, mediaType: 'image/png', view: 'iso' },
          ],
        };
      },
    });
    const project = [
      'steps:',
      '  - id: part',
      '    tool: cad_model',
      '  - id: drawing',
      '    tool: cad_drawing',
    ].join('\n');
    const result = await tools.get('render_project').execute({ source: project }, {});
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), [
      'media-studio/part.stl',
      'media-studio/part-front.png',
      'media-studio/part-top.png',
      'media-studio/part-iso.png',
    ]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.id), ['part', 'drawing', 'drawing', 'drawing']);
    assert.equal(result.artifacts[2].view, 'top');
    assert.equal(result.artifacts[1].view, 'front');
    assert.equal(result.artifacts[1].bytes, 200);

    const text = tools.get('render_project').output.render({}, result).map((part) => part.text).join('\n');
    assert.match(text, /- part: media-studio\/part\.stl \(100 B\)/u);
    assert.match(text, /- drawing: media-studio\/part-top\.png \(300 B\) \[top\]/u);
    assert.equal((text.match(/^- /gmu) ?? []).length, 4);
  });

  it('falls back to ctx.tools when ctx.get("tools") is not there', async () => {
    const tools = new Map();
    const ctx = {
      effect(effect) {
        effect();
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
        get(name) {
          return tools.get(name);
        },
      },
    };
    registerProjectTools(ctx, {}, {}, {
      async resolveSessionCwd() {
        return session;
      },
      formatBytes(bytes) {
        return `${bytes} B`;
      },
      safeRelativeDir(dir) {
        return dir;
      },
    });
    tools.set('generate_sfx', {
      name: 'generate_sfx',
      parameters: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
      async execute() {
        return { path: 'media-studio/stub.wav', bytes: 3 };
      },
    });
    const result = await tools.get('render_project').execute({ source: 'steps:\n  - tool: generate_sfx\n    args:\n      kind: click\n', dryRun: true }, {});
    assert.equal(result.steps[0].id, 'step1');
    assert.equal(result.steps[0].ok, true);
  });
});
