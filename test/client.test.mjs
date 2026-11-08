import assert from 'node:assert/strict';
import test from 'node:test';

/** Capture the module the browser loader receives. */
let loaded;

/** Minimal React surface used by the plugin's render functions. */
const React = {
  createElement(...args) {
    return { type: args[0], props: args[1], children: args.slice(2) };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

await import('../client.js');

/** Build the Client context the plugin's `apply` expects. */
function fakeCtx() {
  const slots = [];
  const effects = [];
  const localeRegistrations = [];
  const panels = [];
  const ctx = {
    effect(factory) {
      effects.push(factory());
      return () => {};
    },
    get(name) {
      if (name === 'locale') {
        return {
          register(ns, dictionaries) {
            localeRegistrations.push({ ns, dictionaries });
            return () => {};
          },
          bind() {
            return (key) => key;
          },
        };
      }
      return undefined;
    },
    slots: {
      inject(slot, callback) {
        const produced = callback();
        if (produced !== undefined && typeof produced.next === 'function') {
          for (const _ of produced) {
            // Iterate generators so their registrations run.
          }
        }
        return () => {};
      },
      register(options, component) {
        slots.push({ slot: options.name, options, component });
        return () => {};
      },
    },
    layout: {
      selectPanel(id) {
        panels.push(id);
      },
    },
  };
  return { ctx, slots, localeRegistrations, panels };
}

test('the loader receives the package id and a factory', () => {
  assert.equal(loaded.id, '@local/dsh-media-studio');
  assert.equal(typeof loaded.factory, 'function');
});

test('apply registers the panel, its sidebar entry, the tool view and locales', () => {
  const { ctx, slots, localeRegistrations } = fakeCtx();
  const plugin = loaded.factory((id) => {
    assert.equal(id, 'react');
    return React;
  });
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout']);
  plugin.apply(ctx);

  assert.equal(localeRegistrations.length, 1);
  assert.equal(localeRegistrations[0].ns, 'media-studio');
  assert.ok(localeRegistrations[0].dictionaries.en['panel.title']);
  assert.ok(localeRegistrations[0].dictionaries.ja['panel.title']);

  const bySlot = new Map(slots.map((entry) => [entry.slot, entry]));
  assert.equal(slots.length, 10);
  assert.ok(
    slots.some((entry) => entry.slot === 'tool.call.toolview' && entry.options.key === 'generate_sfx'),
    'the sound-effect tool has its own chat view',
  );
  assert.equal(bySlot.get('main').options.key, 'media-studio');

  assert.equal(bySlot.get('sidebar.panellist').options.id, 'media-studio');
  assert.equal(typeof bySlot.get('sidebar.panellist').options.label, 'function');
  const toolViews = slots.filter((entry) => entry.slot === 'tool.call.toolview').map((entry) => entry.options.key);
  assert.deepEqual(toolViews.sort(), ['attach_material', 'compose_music', 'generate_music', 'generate_sfx', 'generate_speech', 'generate_video', 'make_motion_graphic', 'produce_video']);
  for (const entry of slots) {
    assert.equal(typeof entry.component, 'function', `${entry.slot} must render a component`);
  }
});

test('the step grid builds top-down pitch rows and a merged score', () => {
  const plugin = loaded.factory(() => React);
  const grid = plugin.musicGrid;
  assert.ok(grid !== undefined);
  const rows = grid.rows(3);
  assert.equal(rows.length, 24);
  assert.equal(rows[0].name, 'B4');
  assert.equal(rows[rows.length - 1].name, 'C3');
  assert.equal(rows.find((row) => row.name === 'C#4').black, true);
  assert.equal(rows.find((row) => row.name === 'C4').black, false);

  const cells = { 'C4:0': true, 'E4:0': true, 'C4:1': true };
  assert.equal(grid.score(cells, rows, 4, 0.5), 'E4,C4:0.5 C4:0.5 rest:1');
  assert.equal(grid.score({}, rows, 2, 1), 'rest:2');
});

test('the preview maps grid pitches to audible frequencies', () => {
  const grid = loaded.factory(() => React).musicGrid;
  assert.ok(Math.abs(grid.pitchToHz('A4') - 440) < 0.001);
  assert.ok(Math.abs(grid.pitchToHz('C4') - 261.6256) < 0.01);
  assert.equal(grid.pitchToHz('rest'), null);
  assert.equal(grid.pitchToHz('nope'), null);
  assert.equal(grid.pitchToMidi('C4'), 60);
  assert.equal(grid.pitchToMidi('A4'), 69);
  assert.equal(grid.pitchToMidi('nope'), null);
});

test('grid cells and absolute notes convert both ways', () => {
  const grid = loaded.factory(() => React).musicGrid;
  const rows = grid.rows(3);
  const cells = { 'C4:0': true, 'C4:1': true, 'E4:3': true };
  const notes = grid.cellsToNotes(cells, rows, 4, 0.5);
  assert.deepEqual(notes, [
    { pitch: 'C4', start: 0, duration: 1 },
    { pitch: 'E4', start: 1.5, duration: 0.5 },
  ]);
  const allowed = new Set(rows.map((row) => row.name));
  assert.deepEqual(grid.notesToCells(notes, 0.5, 4, allowed), { 'C4:0': true, 'C4:1': true, 'E4:3': true });
});

test('a parsed piece picks a resolution and range that fit it', () => {
  const grid = loaded.factory(() => React).musicGrid;
  assert.equal(grid.chooseResolution([{ start: 0, duration: 1 }, { start: 1, duration: 2 }]), '1/4');
  assert.equal(grid.chooseResolution([{ start: 0, duration: 0.5 }]), '1/8');
  assert.equal(grid.chooseResolution([{ start: 0, duration: 0.25 }]), '1/16');
  assert.equal(grid.chooseResolution([{ start: 0.1, duration: 0.3 }]), '1/16');
  assert.equal(grid.chooseRange([{ pitches: ['C4', 'G4'] }]), 'mid');
  assert.equal(grid.chooseRange([{ pitches: ['C2', 'B3'] }]), 'low');
  assert.equal(grid.chooseRange([]), null);
});

test('the close callback returns to the conversation panel', () => {
  const { ctx, slots, panels } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const main = slots.find((entry) => entry.slot === 'main');
  const injected = main.options.inject();
  injected.close();
  assert.deepEqual(panels, [null]);
});

test('the sidebar glyph renders at the requested size', () => {
  const { ctx, slots } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const glyph = slots.find((entry) => entry.slot === 'sidebar.panellist').component;
  const element = glyph({ size: 16, active: true });
  assert.equal(element.type, 'svg');
  assert.equal(element.props.width, 16);
  assert.equal(element.props.height, 16);
});

test('the panel offers a graphics tab with a chart and an edit mode', () => {
  const { ctx, slots } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const main = slots.find((entry) => entry.slot === 'main');
  const page = main.component({ t: (key) => key });
  const flat = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object') return;
    flat.push(node);
    walk(node.children);
  };
  walk(page);
  const labels = flat
    .filter((node) => node.type === 'button')
    .flatMap((node) => (Array.isArray(node.children) ? node.children : [node.children]))
    .filter((child) => typeof child === 'string');
// Tabs are no longer rendered in the panel; tools are selected from text.
  void labels;

  // The chart mode is the default, and both forms are wired to the routes.
  const plugin = loaded.factory(() => React);
  const form = plugin.graphicsTab({ t: (key) => key, capabilities: undefined });
  const fields = [];
  const collect = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (typeof node !== 'object') {
      fields.push(node);
      return;
    }
    fields.push(node);
    collect(node.children);
  };
  collect(form);
  const text = fields.map((node) => (typeof node === 'string' ? node : '')).join('|');
  assert.ok(text.includes('graphics.data'), 'the chart form must be rendered');
  const inputs = fields.filter((node) => node.type === 'textarea' || node.type === 'input' || node.type === 'select');
  assert.ok(inputs.length >= 4, 'the chart form needs the data, title, type and theme fields');
  assert.ok(fields.some((node) => node.type === 'textarea' && node.props.id === 'mstudio-chart-data'));
  assert.ok(fields.some((node) => node.type === 'select' && node.props.id === 'mstudio-chart-type'));
});

test('the production tab offers materials, a scene list and an export', () => {
  const plugin = loaded.factory(() => React);
  const form = plugin.productionTab({ t: (key) => key, capabilities: undefined });
  const fields = [];
  const collect = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (typeof node !== 'object') {
      fields.push(node);
      return;
    }
    fields.push(node);
    collect(node.children);
  };
  collect(form);
  const text = fields.map((node) => (typeof node === 'string' ? node : '')).join('|');
  assert.ok(text.includes('production.materials'), 'the material library must be rendered');
  assert.ok(text.includes('production.scenes'), 'the scene list must be rendered');
  assert.ok(text.includes('production.export'), 'the export section must be rendered');
  assert.ok(fields.some((node) => node.type === 'input' && node.props.type === 'file'), 'the panel must accept material files');
  assert.ok(fields.some((node) => node.type === 'button' && node.props.onClick !== undefined), 'the panel must have buttons');
});

test('every translation key the client asks for exists in both dictionaries', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/gu)) {
    keys.add(match[1]);
  }
  assert.ok(keys.size > 20, 'the scan must find the static keys');

  const { ctx, localeRegistrations } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const { en, ja } = localeRegistrations[0].dictionaries;
  const missingEn = [...keys].filter((key) => en[key] === undefined);
  const missingJa = [...keys].filter((key) => ja[key] === undefined);
  assert.deepEqual(missingEn, [], 'the English dictionary misses keys');
  assert.deepEqual(missingJa, [], 'the Japanese dictionary misses keys');

  // The keys built from a template need their variants too.
  for (const type of ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked']) {
    assert.ok(en[`graphics.type.${type}`] !== undefined, `graphics.type.${type}`);
    assert.ok(ja[`graphics.type.${type}`] !== undefined, `graphics.type.${type}`);
  }
  for (const theme of ['light', 'dark']) {
    assert.ok(en[`graphics.theme.${theme}`] !== undefined);
    assert.ok(ja[`graphics.theme.${theme}`] !== undefined);
  }
  for (const format of ['png', 'jpeg', 'webp']) {
    assert.ok(en[`graphics.format.${format}`] !== undefined);
    assert.ok(ja[`graphics.format.${format}`] !== undefined);
  }
});

test('the speech tool view degrades safely at every render phase', () => {
  const { ctx, slots } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const view = slots.find((entry) => entry.slot === 'tool.call.toolview' && entry.options.key === 'generate_speech').component;
  const pending = view({ phase: 'start', block: {} });
  assert.equal(typeof pending, 'object');
  const missing = view({ phase: 'result', block: { content: [] } });
  assert.equal(typeof missing, 'object');
  const withFile = view({
    phase: 'result',
    block: {
      content: [
        { type: 'text', text: '音声を生成しました' },
        { type: 'file', attachment: { attachmentId: 'att-1', name: 'speech.wav', bytes: 10 } },
      ],
    },
  });
  const audio = withFile.children.flat(3).find((child) => child !== null && child !== undefined && child.type === 'audio');
  assert.match(audio.props.src, /^api\/media-studio\/audio\?id=att-1$/);
  assert.doesNotThrow(() => view(undefined));
});

/** Flatten the element tree a render function returns. */
function flatten(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') {
    out.push(node);
    return out;
  }
  out.push(node);
  flatten(node.children, out);
  return out;
}

/** The string labels a tree carries, including button and option captions. */
function labelsOf(nodes) {
  return nodes
    .filter((node) => typeof node === 'object')
    .flatMap((node) => (Array.isArray(node.children) ? node.children : [node.children]))
    .filter((child) => typeof child === 'string');
}

test('the studio tab lists every v3 tool and the tool route reaches them all', () => {
  const plugin = loaded.factory(() => React);
  const tools = plugin.studioTools();
  assert.equal(tools.length, 10);
  assert.deepEqual(tools.map((entry) => entry.name), [
    'edit_video',
    'probe_video',
    'export_timeline',
    'make_subtitles',
    'cad_model',
    'cad_drawing',
    'cad_export',
    'daw_arrange',
    'export_daw_project',
    'import_midi',
  ]);
  assert.deepEqual(
    tools.filter((entry) => plugin.studioRunnable(entry.name)).map((entry) => entry.name),
    [
      'edit_video',
      'probe_video',
      'export_timeline',
      'make_subtitles',
      'cad_model',
      'cad_drawing',
      'cad_export',
      'daw_arrange',
      'export_daw_project',
      'import_midi',
    ],
    'the tool route runs every listed tool',
  );
  assert.equal(plugin.studioRunnable('edit_video'), true);
  assert.equal(plugin.studioRunnable('probe_video'), true);
  assert.equal(plugin.studioRunnable('import_midi'), true);
  assert.equal(plugin.studioRunnable('nope'), false);
  assert.equal('hint' in tools[0], false, 'the tool route needs no capability hint');
});

test('every studio tool ships a JSON example that parses to an object', () => {
  const plugin = loaded.factory(() => React);
  for (const entry of plugin.studioTools()) {
    const text = plugin.studioSample(entry.name);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${entry.name} needs an example`);
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed, 'object');
    assert.equal(Array.isArray(parsed), false);
    assert.ok(Object.keys(parsed).length > 0, `${entry.name} must show at least one argument`);
  }
  assert.equal(plugin.studioSample('nope'), '');
});

test('a studio request names the tool and carries the parsed arguments', () => {
  const plugin = loaded.factory(() => React);
  assert.deepEqual(plugin.studioRequest('edit_video', '{ "clips": ["a.mp4"] }'), {
    tool: 'edit_video',
    args: { clips: ['a.mp4'] },
  });
  assert.deepEqual(plugin.studioRequest('cad_model', '   '), { tool: 'cad_model', args: {} });
  for (const entry of plugin.studioTools()) {
    assert.deepEqual(plugin.studioRequest(entry.name, ''), { tool: entry.name, args: {} });
  }
  assert.throws(() => plugin.studioRequest('nope', '{}'), /studio\.unknownTool/u);
  assert.throws(() => plugin.studioRequest('edit_video', '{'), /studio\.badJson/u);
  assert.throws(() => plugin.studioRequest('edit_video', '[]'), /studio\.badJson/u);
  assert.throws(() => plugin.studioRequest('edit_video', 'null'), /studio\.badJson/u);
});

test('the studio tab renders a tool picker, a JSON box, an example button and a run button', () => {
  const plugin = loaded.factory(() => React);
  const fields = flatten(plugin.studioTab({ t: (key) => key }));
  assert.ok(fields.some((node) => node.type === 'select' && node.props.id === 'mstudio-studio-tool'));
  const options = fields.filter((node) => node.type === 'option');
  assert.deepEqual(options.map((node) => node.props.value), plugin.studioTools().map((entry) => entry.name));
  assert.ok(fields.some((node) => node.type === 'textarea' && node.props.id === 'mstudio-studio-json'));
  const labels = labelsOf(fields);
  assert.ok(labels.includes('studio.sample'), 'the example button must exist');
  assert.ok(labels.includes('studio.run'), 'the run button must exist');
  assert.ok(labels.includes('studio.clear'));
  const runButton = fields.find(
    (node) => node.type === 'button' && (Array.isArray(node.children) ? node.children : [node.children]).includes('studio.run'),
  );
  assert.equal(runButton.props.disabled, false, 'the run button starts enabled');
  const text = fields.map((node) => (typeof node === 'string' ? node : '')).join('|');
  assert.equal(text.includes('studio.notRunnable'), false, 'no tool is marked unrunnable');
  assert.equal(text.includes('studio.limitedTitle'), false, 'the limited-tools section is gone');
  assert.equal(fields.some((node) => node.type === 'details'), false, 'the tab has no limitation panel');
  assert.doesNotThrow(() => plugin.studioTab({}));
});

test('the panel no longer offers a studio tab, but studio locale keys and the tool route remain', () => {
  const { ctx, slots, localeRegistrations } = fakeCtx();
  loaded.factory(() => React).apply(ctx);
  const main = slots.find((entry) => entry.slot === 'main');
  const labels = labelsOf(flatten(main.component({ t: (key) => key })));
  assert.ok(!labels.includes('tab.studio'), 'the studio tab must be removed from the panel');

  const plugin = loaded.factory(() => React);
  const { en, ja } = localeRegistrations[0].dictionaries;
  assert.equal(en['tab.studio'], 'Studio');
  assert.equal(ja['tab.studio'], 'スタジオ');
  const dynamicKeys = [
    'studio.intro',
    'studio.tool',
    'studio.args',
    'studio.result',
    'studio.empty',
    'studio.path',
    'studio.badJson',
    'studio.unknownTool',
    'studio.error',
    ...plugin.studioTools().map((entry) => `studio.tool.${entry.name}`),
  ];
  const missing = [];
  for (const key of dynamicKeys) {
    if (en[key] === undefined) missing.push(`en:${key}`);
    if (ja[key] === undefined) missing.push(`ja:${key}`);
  }
  assert.deepEqual(missing, []);
});
