const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test, after } = require('node:test');
const { blake3 } = require('@noble/hashes/blake3');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createProjectionStore } = require('../electron/projection.cjs');
const { createFixtureProjectionStore } = require('../electron/fixtureProjection.cjs');
const contract = require('../electron/projectionReadContract.cjs');
const dom = new JSDOM('<body></body>', { url: 'https://client.test' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'StorageEvent']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require('react-dom/client');
after(() => dom.window.close());
const action = surface_id => ({ schema: 'octopus.client_action', schema_version: 1, action: 'open_surface', surface_id });
const identity = (seq, overrides = {}) => ({ artifact_id: `client.action:${seq.toString(16).padStart(64, '0')}`, run_id: 'home-run', seq, movement_kind: 'InterfaceOutbound', from: { Interface: 'room' }, to: { Interface: 'home-client' }, action: action('dashboard'), ...overrides });
const response = (params, actions) => ({ home: params.home, run_id: params.run_id, interface_id: params.interface_id, actions });
const scope = { home: '/selected-home', runId: 'home-run', interfaceId: 'home-client' };

test('text submission validates its message route independently of client control results', () => {
  const { existingRunSubmission, activeOperatorMessageCheckpoint } = require('../../registry/interface/world_operator_chat/client/conversation.cjs');
  const config = require('../../registry/interface/world_operator_chat/client.json');
  const client = `${config.run.interface_prefix}home`, provider = 'provider';
  const binding = (interfaceId, label) => ({ interface: interfaceId, config: { artifact_policy: { mode: 'allow', names: [label], namespaces: [] } } });
  const checkpoint = (id, label, target) => ({ id, run: 'run', epoch: 0, interface_binding: binding(client, label), outbound_interface_bindings: [binding(target, label)] });
  const record = { id: 'run', ee: 'ee', worker: 'worker', active_checkpoints: ['message', 'result'],
    interface_state: { [client]: { client_surface_role: 'home', provider_runtime_interface: provider, provider_choice_interface: provider, worker_choice_interface: 'worker' }, [provider]: {} },
    checkpoints: [checkpoint('message', config.artifact_labels.message, provider), checkpoint('result', 'client.action.result', 'room')] };
  const requested = { providerChoiceInterfaceId: provider, clientSurfaceRole: 'home' };
  assert.equal(existingRunSubmission(config, 'run', record, client, requested).modelInterfaceId, provider);
  assert.equal(activeOperatorMessageCheckpoint(record, 'run', client, provider, config.artifact_labels.message).id, 'message');
  record.checkpoints[0].outbound_interface_bindings[0].interface = 'room';
  assert.throws(() => existingRunSubmission(config, 'run', record, client, requested), /differs from its provider route/);
});

test('client action contract and fixture stay read-only and typed', async () => {
  assert.ok(contract.PROJECTION_READ_METHODS.includes('projection.client_actions.list'));
  assert.ok(!contract.CLIENT_SURFACE_PROJECTION_READ_METHODS.includes('projection.client_actions.list'));
  const params = { home: scope.home, run_id: scope.runId, interface_id: scope.interfaceId };
  const request = values => ({ contract_version: 1, method: 'projection.client_actions.list', params: values });
  for (const invalid of [{}, { ...params, after_seq: '0' }, { ...params, after_seq: -2 }, { ...params, limit: 0 }, { ...params, url: 'https://external.test' }]) assert.throws(() => contract.parseProjectionReadRequest(request(invalid)), /violates contract/);
  assert.deepEqual(await createFixtureProjectionStore().read(request(params)), response(params, []));
});

test('actions require exact admitted outbound evidence and immutable manifest/payload bytes', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-client-actions-')), blobs = path.join(home, 'ledger/blobs'), rows = [];
  await fs.mkdir(blobs, { recursive: true });
  const store = createProjectionStore({ resolveRepoRoot: () => path.resolve(__dirname, '../..'), octopusHome: () => home, sourceRegistry: () => path.join(home, 'registry'), projectEePolicies: () => new Promise(() => {}) });
  t.after(async () => { store.close(); await fs.rm(home, { recursive: true, force: true }); });
  const blob = async value => { const bytes = Buffer.from(JSON.stringify(value)), hash = Buffer.from(blake3(bytes)).toString('hex'); await fs.writeFile(path.join(blobs, hash), bytes); return hash; };
  const original = path.join(home, 'original.json'); await fs.writeFile(original, JSON.stringify(action('foreign')));
  const admit = async (payload, overrides = {}, manifestOverrides = {}) => {
    const payloadHash = await blob(payload), hash = await blob({ label: 'client.action', payload_path: original, payload_content_hash: payloadHash, ...manifestOverrides });
    const seq = rows.length;
    rows.push({ seq, lamport: seq, trace: 'test', recorded_at_unix_ms: seq, kind: 'InterfaceOutbound', from: { Interface: 'room' }, to: { Interface: scope.interfaceId }, artifact: { id: `client.action:${hash}`, content: [...Buffer.from(hash, 'hex')] }, invocation_metadata: { runtime: { run: scope.runId, ee: 'ee', worker: 'worker', checkpoint: 'checkpoint', interface: scope.interfaceId, epoch: 0 } }, ...overrides });
    await fs.writeFile(path.join(home, 'ledger/movements.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
    return { hash, payloadHash };
  };
  const read = (params = {}) => store.read({ contract_version: 1, method: 'projection.client_actions.list', params: { home, run_id: scope.runId, interface_id: scope.interfaceId, ...params } });
  const first = await admit(action('dashboard'));
  await admit(action('dashboard'), { kind: 'InterfaceArrival' }); await admit(action('dashboard'), { kind: 'DeliveryRefused' });
  await admit(action('dashboard'), { to: { Interface: 'other-client' } });
  await admit(action('dashboard'), { invocation_metadata: { runtime: { run: 'other-run', ee: 'ee', worker: 'worker', checkpoint: 'checkpoint', interface: scope.interfaceId, epoch: 0 } } });
  await admit({ ...action('dashboard'), schema_version: 2 });
  await admit(action('dashboard'), {}, { label: 'client.action.extra' });
  await admit(action('scheduled'));
  const projected = await read();
  assert.deepEqual(projected.actions.map(row => row.seq), [0, 5, 6, 7]);
  assert.deepEqual(projected.actions[0].action, action('dashboard'));
  assert.deepEqual(projected.actions[0].from, { Interface: 'room' }); assert.equal(projected.actions[0].run_id, scope.runId);
  assert.match(projected.actions[1].error, /exact/); assert.match(projected.actions[2].error, /identity/);
  assert.deepEqual((await read({ after_seq: 6, limit: 1 })).actions.map(row => row.seq), [7]);
  const tool = { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) };
  const request = { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: 'recorded' };
  const requestSeq = rows.length;
  const admitted = await admit({ schema: 'octopus.client_action_request', schema_version: 1, action: request, tool_call: tool });
  const resultPayload = { schema: 'octopus.client_action_result', schema_version: 1, phase: 'completed', ok: true, widgets: [],
    tool_call: tool, request_artifact: `client.action:${admitted.hash}`, request_seq: requestSeq, request_id: 'recorded', action: 'list_widgets' };
  const resultHash = await blob({ label: 'client.action.result', payload_path: original, payload_content_hash: await blob(resultPayload) });
  const resultSeq = rows.length;
  rows.push({ ...rows[requestSeq], seq: resultSeq, lamport: resultSeq, kind: 'InterfaceArrival',
    from: { Interface: scope.interfaceId }, to: { Interface: 'worker' },
    artifact: { id: `client.action.result:${resultHash}`, content: [...Buffer.from(resultHash, 'hex')] } });
  await fs.writeFile(path.join(home, 'ledger/movements.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual((await read({ after_seq: 7 })).actions[0].completed_result, { artifact_id: `client.action.result:${resultHash}`, seq: resultSeq });
  await assert.rejects(read({ home: '/other-home' }), /selected Home/);
  await fs.writeFile(path.join(blobs, first.payloadHash), '{}'); assert.match((await read({ limit: 1 })).actions[0].error, /digest/);
  await fs.unlink(path.join(blobs, first.payloadHash)); assert.match((await read({ limit: 1 })).actions[0].error, /ENOENT/);
  await fs.appendFile(path.join(home, 'ledger/movements.jsonl'), '{"from":{"Run":"retired"}}\n'); await assert.rejects(read(), /malformed ledger/);
});

async function harness(read, props = {}) {
  const source = await fs.readFile(path.join(__dirname, '../src/shell/useAdmittedClientActions.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }, opens = [], refusals = [], reads = [], results = [];
  const semantics = await import('../electron/clientActionSemantics.mjs');
  const fileTargetSource = await fs.readFile(path.join(__dirname, '../src/components/files/fileTarget.ts'), 'utf8');
  const fileTarget = { exports: {} };
  Function('exports', ts.transpileModule(fileTargetSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(fileTarget.exports);
  let generation = 0;
  Function('module', 'exports', 'require', compiled)(module, module.exports, id => id === 'react' ? React : id.includes('clientActionSemantics') ? semantics : id.endsWith('/fileTarget') ? fileTarget.exports : id === '../projectionClient' ? {
    readProjection: (method, params) => { assert.equal(method, 'projection.client_actions.list'); reads.push(params); return read(params); },
    submitInterfaceArtifact: async request => { results.push(request); if (props.deliver) await props.deliver(request); },
  } : { useProjectionGeneration: () => generation });
  function Consumer(options) { module.exports.useAdmittedClientActions(options); return null; }
  const options = { ...scope, enabled: true, surfaces: [{ id: 'dashboard' }, { id: 'scheduled' }], openSurface: surface => { const cursor = JSON.parse(window.localStorage.getItem(`octopus.client-actions.cursor.v1:${JSON.stringify([options.home, options.runId, options.interfaceId])}`)); assert.ok(cursor.last_consumed.seq >= 0); opens.push(surface.id); }, onRefusal: reason => refusals.push(reason), ...props };
  let root, container;
  const render = async (changes = {}, bump = false) => { Object.assign(options, changes); if (bump) generation++; if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); } await React.act(async () => root.render(React.createElement(Consumer, { ...options }))); };
  const close = async () => { if (!root) return; await React.act(async () => root.unmount()); container.remove(); root = null; };
  await render();
  return { render, close, opens, refusals, reads, results, options };
}

test('widget results resume after lost admission without repeating the saved action', async () => {
  window.localStorage.clear(); let calls = 0, fail = true;
  const request = { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: 'inventory' };
  const view = await harness(params => response(params, params.after_seq < 3 ? [identity(3, { action: request, tool_call: { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) }, expires_at_ms: Date.now() + 10000, turn_closure: 'completed' })] : []), {
    widgets: async () => { calls++; return [{ widget_id: 'clock', state: 'hidden' }]; },
    deliver: async () => { if (fail) throw new Error('receipt admission unavailable'); },
  });
  try {
    assert.equal(calls, 1); assert.equal(view.results.length, 1); assert.match(view.refusals[0], /admission unavailable/);
    fail = false; await view.render({}, true);
    assert.equal(calls, 1); assert.equal(view.results.length, 2); assert.deepEqual(view.results[0], view.results[1]);
    assert.equal(view.results[1].interfaceId, scope.interfaceId); assert.equal(view.results[1].label, 'client.action.result');
    assert.equal(view.results[1].payload.request_seq, 3); assert.equal(view.results[1].payload.ok, true);
    await view.close(); await view.render(); assert.equal(calls, 1); assert.equal(view.results.length, 2);
    await view.close(); window.localStorage.clear();
    const pendingKey = `octopus.client-widget-result.v1:${JSON.stringify([scope.home, scope.runId, scope.interfaceId])}`;
    const { ok, widgets, ...prepared } = view.results[0].payload;
    window.localStorage.setItem(pendingKey, JSON.stringify({ ...prepared, phase: 'prepared' }));
    await view.render(); assert.equal(calls, 1); assert.equal(view.results.at(-1).payload.ok, false);
    assert.match(view.results.at(-1).payload.error, /effect is unconfirmed/);
  } finally { await view.close(); }
});

test('file controls use admitted roots and retain their result without reopening', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-open-file-'));
  const root = await fs.realpath(directory), previous = window.octopusTransport;
  const files = require('../electron/osFiles.cjs').createOsFileStore({ resolveRoots: async () => [{ id: 'documents', label: 'Documents', root }] });
  window.octopusTransport = { osFileRoots: files.roots, readOsFile: files.read };
  t.after(async () => { window.octopusTransport = previous; await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'Trip plan.md'), '# Trip plan\n\nDetails for the trip.');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 255]));
  await fs.symlink('/etc/hosts', path.join(root, 'escape'));
  const semantics = await import('../electron/clientActionSemantics.mjs');
  const makeAction = file => ({ schema: 'octopus.client_action', schema_version: 1, action: 'open_file', request_id: 'document', path: file });
  for (const invalid of ['relative.md', `${root}/../other.md`, 'https://example.org/page', `${root}/a\0b`]) {
    assert.throws(() => semantics.parseClientAction(makeAction(invalid)), /exact/);
  }
  for (const [file, allowed] of [[path.join(root, 'Trip plan.md'), true], ['/etc/hosts', false], [path.join(root, 'missing.md'), false], [path.join(root, 'binary'), false], [path.join(root, 'escape'), false]]) {
    window.localStorage.clear(); let finish, opens = 0, fail = allowed;
    const delivered = new Promise(resolve => { finish = resolve; });
    const row = identity(2, { action: makeAction(file), tool_call: { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) }, expires_at_ms: Date.now() + 5000 });
    const view = await harness(params => response(params, params.after_seq < 2 ? [row] : []), {
      openFile: target => { opens++; assert.deepEqual(target, { kind: 'file', rootId: 'documents', path: 'Trip plan.md' }); },
      deliver: async () => { finish(); if (fail) throw Error('delivery unavailable'); },
    });
    try {
      await React.act(async () => { await delivered; });
      assert.equal(view.results[0].payload.ok, allowed);
      assert.equal(opens, allowed ? 1 : 0);
      if (allowed) {
        assert.equal(view.results[0].payload.opened.path, file);
        fail = false; await view.render({}, true);
        assert.equal(opens, 1); assert.deepEqual(view.results[0], view.results[1]);
      }
    } finally { await view.close(); }
  }
});

test('a tool-correlated client control returns during the open turn, once, and expired or stopped requests have no effect', async () => {
  for (const state of ['open', 'expired', 'stopped']) {
    window.localStorage.clear(); let calls = 0;
    const tool = { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) };
    const request = { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: state };
    const view = await harness(params => response(params, params.after_seq < 8 ? [identity(8, {
      action: request, tool_call: tool, expires_at_ms: Date.now() + (state === 'expired' ? -1000 : 10000),
      turn_closure: state === 'stopped' ? 'stopped' : null,
    })] : []), { widgets: async () => { calls++; return [{ widget_id: 'clock', state: 'visible' }]; } });
    try {
      assert.equal(view.results.length, 1); assert.equal(calls, state === 'open' ? 1 : 0);
      assert.equal(view.results[0].payload.ok, state === 'open');
      assert.deepEqual(view.results[0].payload.tool_call, tool);
      await view.render({}, true); assert.equal(view.results.length, 1);
      await view.close(); await view.render(); assert.equal(view.results.length, 1);
    } finally { await view.close(); }
  }
});

test('projection activity cannot cancel an admitted client control or its result', async () => {
  window.localStorage.clear(); let resolveRead, resolveEffect, calls = 0;
  const request = { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: 'during-activity' };
  const view = await harness(params => params.after_seq < 8 ? new Promise(done => { resolveRead = () => done(response(params, [identity(8, {
    action: request, tool_call: { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) },
    expires_at_ms: Date.now() + 10000, turn_closure: null,
  })])); }) : response(params, []), { widgets: () => { calls++; return new Promise(done => { resolveEffect = () => done([]); }); } });
  try {
    const firstRead = resolveRead;
    for (let index = 0; index < 3; index++) await view.render({}, true);
    await React.act(async () => firstRead());
    assert.equal(calls, 1);
    for (let index = 0; index < 3; index++) await view.render({}, true);
    await React.act(async () => resolveEffect());
    assert.equal(view.results.length, 1); assert.equal(view.results[0].payload.ok, true);
    assert.equal(calls, 1); assert.deepEqual(view.refusals, []);
    assert.equal(view.reads.at(-1).after_seq, 8);
  } finally { await view.close(); }
});

test('an admitted client result prevents effects after local cursor loss', async () => {
  window.localStorage.clear(); let calls = 0;
  const view = await harness(params => response(params, params.after_seq < 8 ? [identity(8, {
    action: { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: 'recorded' },
    tool_call: { id: 'tool.call:' + 'a'.repeat(64), content: Array(32).fill(10) },
    completed_result: { artifact_id: 'client.action.result:' + 'b'.repeat(64), seq: 10 },
    expires_at_ms: Date.now() + 10000,
  })] : []), { widgets: async () => { calls++; return []; } });
  try {
    assert.equal(calls, 0); assert.equal(view.results.length, 0);
    await view.close(); window.localStorage.clear(); await view.render();
    assert.equal(calls, 0); assert.equal(view.results.length, 0);
  } finally { await view.close(); }
});

test('widget controls use actual extension receipts, exact document revisions and saved visibility', async t => {
  window.localStorage.clear();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-widget-controls-'));
  const store = require('../electron/clientExtensions.cjs').createClientExtensionStore({ root });
  t.after(async () => { await store.close(); delete window.octopusTransport; await fs.rm(root, { recursive: true, force: true }); });
  const bundled = require('esbuild').buildSync({ stdin: { contents: 'export * from "./src/client-surfaces/homeWidgetControls"; export {materializeClientExtensions} from "./src/extensions/useClientExtensions";', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], loader: { '.css': 'empty' }, define: { 'import.meta.env.DEV': 'false' } });
  const module = { exports: {} }; Function('module', 'exports', 'require', bundled.outputFiles[0].text)(module, module.exports, require);
  const { applyHomeWidgetAction, materializeClientExtensions, homeWidgetHiddenKey } = module.exports;
  window.octopusTransport = { clientExtensions: () => store.snapshot() };
  const lifecycle = async (id, operationId, action) => store.applyLifecycle({ id, operationId, action, expectedGeneration: (await store.snapshot()).generation, expectedRevision: store.builtinRevision(id) });
  const extensionState = async () => ({ ...materializeClientExtensions(await store.snapshot(), 'live', ''), hydrated: true,
    install: (id, op) => lifecycle(id, op, 'install'), uninstall: (id, op) => lifecycle(id, op, 'remove') });
  const item = { sourceDigest: 'sha256:document', sourceRunId: scope.runId, sourceInterfaceId: scope.interfaceId, sourceArtifactId: 'client.surface.document:original', sourceSequence: 1,
    document: { id: 'hello', title: 'Hello', revision: 1, target: { kind: 'voice.widget', slot: 'right' } } };
  const options = { ...scope, accessProfile: 'live', surfaces: [item, { ...item, sourceRunId: 'foreign', document: { ...item.document, id: 'foreign' } }], extensions: await extensionState() };
  const query = { schema: 'octopus.client_action', schema_version: 1, action: 'list_widgets', request_id: 'list' };
  const list = () => applyHomeWidgetAction(options, query, 'widget_inventory');
  const change = (widget, state) => applyHomeWidgetAction(options, { ...query, action: 'set_widget', changes: [{ widget_id: widget.widget_id, source_digest: widget.source_digest, state }] }, `widget_${state}_fixture`);
  let rows = await list(); assert.ok(!rows.some(row => row.widget_id === 'foreign'));
  const hello = rows.find(row => row.widget_id === 'hello'), builtin = rows.find(row => row.widget_id === 'builtin.voice.live-context');
  for (const state of ['hidden', 'visible', 'removed', 'visible']) assert.equal((await change(hello, state)).find(row => row.widget_id === 'hello').state, state);
  await assert.rejects(change({ ...hello, source_digest: 'foreign' }, 'removed'), /revision changed/);
  await change(builtin, 'removed'); options.extensions = await extensionState();
  assert.equal((await list()).find(row => row.widget_id === builtin.widget_id).installed, false);
  await change(builtin, 'visible'); options.extensions = await extensionState();
  rows = await list(); assert.equal(rows.find(row => row.widget_id === builtin.widget_id).state, 'visible');
  assert.equal(rows.find(row => row.widget_id === builtin.widget_id).installed, true);
  rows = await applyHomeWidgetAction(options, { ...query, action: 'set_widget', changes: [hello, builtin].map(widget => ({ widget_id: widget.widget_id, source_digest: widget.source_digest, state: 'hidden' })) }, 'widget_batch_fixture');
  assert.deepEqual([hello, builtin].map(widget => rows.find(row => row.widget_id === widget.widget_id).state), ['hidden', 'hidden']);
  window.localStorage.setItem(homeWidgetHiddenKey('live'), '{}'); await assert.rejects(list(), /malformed/);
});

test('durable consumption precedes navigation, never replays on generation/remount, and scopes each Home', async () => {
  window.localStorage.clear();
  const view = await harness(async params => response(params, [identity(0), identity(1, { action: action('scheduled') })].filter(row => row.seq > params.after_seq)));
  try {
    assert.deepEqual(view.opens, ['dashboard', 'scheduled']); await view.render({}, true); assert.equal(view.reads.at(-1).after_seq, 1);
    const reads = view.reads.length; await view.render({ surfaces: [...view.options.surfaces] }); assert.equal(view.reads.length, reads);
    await view.close(); await view.render(); assert.equal(view.opens.length, 2);
    await view.render({ home: '/second-home' }); assert.equal(view.opens.length, 4);
    await view.render({ home: scope.home }); assert.equal(view.opens.length, 4);
    await view.render({ interfaceId: 'foreign-client' }); assert.equal(view.opens.length, 4); assert.match(view.refusals.at(-1), /current Home/);
    await view.render({ interfaceId: scope.interfaceId, enabled: false }, true); assert.equal(view.opens.length, 4);
    assert.equal(window.localStorage.length, 2);
  } finally { await view.close(); }
});

test('malformed or unavailable actions are consumed with explicit refusals; broken storage cannot navigate', async () => {
  window.localStorage.clear();
  const rows = [identity(0, { action: { ...action('dashboard'), url: 'https://external.test' } }), identity(1, { action: action('missing') }), identity(2, { error: 'immutable payload digest mismatch' }), identity(3)];
  const view = await harness(async params => response(params, rows.filter(row => row.seq > params.after_seq)));
  try {
    assert.deepEqual(view.opens, ['dashboard']); assert.equal(view.refusals.length, 3);
    await view.render({}, true); assert.equal(view.refusals.length, 3);
    const originalSet = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = () => { throw new Error('storage write denied'); };
    try { await view.render({ home: '/cannot-save' }); assert.equal(view.opens.length, 1); assert.match(view.refusals.at(-1), /storage write denied/); }
    finally { dom.window.Storage.prototype.setItem = originalSet; }
  } finally { await view.close(); }
});

test('late reads from a previous Home or inactive client cannot execute', async () => {
  window.localStorage.clear(); let resolve;
  const view = await harness(params => params.home === scope.home ? new Promise(done => { resolve = () => done(response(params, [identity(0)])); }) : Promise.resolve(response(params, [identity(1, { action: action('scheduled') })])));
  try {
    await view.render({ home: '/next-home' }); assert.deepEqual(view.opens, ['scheduled']);
    await React.act(async () => resolve()); assert.deepEqual(view.opens, ['scheduled']);
    await view.render({ home: scope.home }); await view.render({ enabled: false }); await React.act(async () => resolve()); assert.deepEqual(view.opens, ['scheduled']);
    assert.equal(window.localStorage.length, 1);
  } finally { await view.close(); }
});
