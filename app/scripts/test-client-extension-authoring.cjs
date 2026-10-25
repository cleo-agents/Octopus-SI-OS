const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");
const { blake3 } = require("@noble/hashes/blake3");
const { createClientExtensionStore } = require("../electron/clientExtensions.cjs");
const { createProjectionStore } = require("../electron/projection.cjs");

const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const authoring = require("../../registry/artifact/artifact-home-widget-authoring/artifact.json");
const catalogue = require("../../registry/tool/client.mcp/tool.json");
test("sandbox widgets inherit the client scrollbar and resize handles exclude background ripples", async () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html></html>", { url: "https://fixture.invalid" });
  const previous = new Map(["document", "window", "localStorage", "getComputedStyle"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, { document: { configurable: true, value: dom.window.document }, window: { configurable: true, value: dom.window }, localStorage: { configurable: true, value: dom.window.localStorage }, getComputedStyle: { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) } });
  try {
    const built = require("esbuild").buildSync({ stdin: { contents: 'export { ClientSurfaceRenderer } from "./src/client-surfaces/ClientSurfaceRenderer"; export { SCENE_RIPPLE_IGNORED_TARGETS } from "./src/components/voice/sceneRipple";', resolveDir: appRoot },
      bundle: true, platform: "node", format: "cjs", write: false, logOverride: { "ignored-bare-import": "silent" }, external: ["react", "react-dom", "motion/react"], define: { "import.meta.env.DEV": "false" }, loader: { ".css": "text" } });
    const owner = { exports: {} };
    Function("module", "exports", "require", built.outputFiles[0].text)(owner, owner.exports, require);
    const document = structuredClone(require("../src/client-surfaces/home-widget-authoring.json").example);
    document.render = { kind: "sandbox", html: "<div style='overflow:auto;height:40px'>Widget content</div>" };
    for (const theme of ["light", "dark"]) {
      dom.window.document.documentElement.dataset.theme = theme;
      for (const state of ["background", "hover-background", "active-background"]) dom.window.document.documentElement.style.setProperty(`--color-token-scrollbar-slider-${state}`, theme === "dark" ? "rgb(255 255 255 / 20%)" : "rgb(0 0 0 / 20%)");
      const html = require("react-dom/server").renderToStaticMarkup(require("react").createElement(owner.exports.ClientSurfaceRenderer, { accessProfile: "live", admitted: { document, sourceDigest: "test" } }));
      const rendered = new JSDOM(html);
      const frame = rendered.window.document.querySelector("iframe");
      assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
      assert.ok(frame.srcdoc.includes(await fs.readFile(path.join(appRoot, "src/design-system/scrollbars.css"), "utf8")));
      assert.ok(frame.srcdoc.includes(`--color-token-scrollbar-slider-background:${theme === "dark" ? "rgb(255 255 255 / 20%)" : "rgb(0 0 0 / 20%)"}`));
      const handles = rendered.window.document.querySelectorAll(".voice-widget-resize-handle");
      assert.equal(handles.length, 4);
      for (const handle of handles) assert.equal(handle.closest(owner.exports.SCENE_RIPPLE_IGNORED_TARGETS), handle);
      assert.equal(rendered.window.document.body.closest(owner.exports.SCENE_RIPPLE_IGNORED_TARGETS), null);
      rendered.window.close();
    }
  } finally {
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    dom.window.close();
  }
});
const documentSchema = require("../schemas/client_surface_document.schema.json");
const bundled = require("esbuild").buildSync({
  stdin: {
    contents: [
      'export { buildClientInventory, inspectClient } from "./src/extensions/clientInventory";',
      'export { admitClientExtensionSource } from "./src/extensions/validation";',
      'export { reportClientSurfaceRuntimeIssue, clientSurfaceRuntimeIssues } from "./src/extensions/runtimeIssues";',
      'export { parseClientAction } from "./electron/clientActionSemantics.mjs";',
      'export { CLIENT_SURFACE_READ_METHODS } from "./src/client-surfaces/sourceContract";',
    ].join("\n"),
    resolveDir: appRoot,
  },
  bundle: true, platform: "node", format: "cjs", write: false, external: ["react"],
  loader: { ".css": "empty" }, define: { "import.meta.env.DEV": "false" },
});
const client = { exports: {} };
Function("module", "exports", "require", bundled.outputFiles[0].text)(client, client.exports, require);
const { buildClientInventory, inspectClient, admitClientExtensionSource, reportClientSurfaceRuntimeIssue,
  clientSurfaceRuntimeIssues, parseClientAction, CLIENT_SURFACE_READ_METHODS } = client.exports;

const temporary = [];
after(async () => { for (const directory of temporary) await fs.rm(directory, { recursive: true, force: true }); });
async function scratch(prefix) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}
async function writePackage(root, manifest) {
  const file = path.join(root, "packages", manifest.id, "extension.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(file, text);
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}
const examples = authoring.contract.extensions.use_cases.map((useCase) => useCase.client);
const inspect = (extra = {}) => ({ schema: "octopus.client_action", schema_version: 1, action: "inspect_client", request_id: "inspect-1", ...extra });

test("every authored Extension example passes the running client's admission and reaches owner review", async () => {
  const root = path.join(await scratch("octopus-extension-authoring-"), "extensions");
  const store = createClientExtensionStore({ root });
  try {
    const digests = new Map();
    for (const manifest of examples) digests.set(manifest.id, await writePackage(root, manifest));
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.errors, []);
    for (const [key, file] of Object.entries(snapshot.contract.files)) {
      const name = { manifest: "client_extension_manifest", document: "client_surface_document", projection: "projection_read_contract" }[key];
      assert.deepEqual(await fs.readFile(file), await fs.readFile(path.join(appRoot, "schemas", `${name}.schema.json`)));
    }
    for (const source of snapshot.manifests) assert.equal(admitClientExtensionSource(source).verdict.passed, true, source.path);
    const inventory = buildClientInventory({ snapshot, surfaces: [{ id: "voice", label: "Home", source: "builtin" }], runtimeIssues: [] });
    assert.equal(inventory.packages_root, path.join(root, "packages"));
    assert.deepEqual(inventory.refused, []);
    for (const manifest of examples) {
      const row = inventory.extensions.find((entry) => entry.id === manifest.id);
      assert.equal(row.admission, "pending");
      assert.equal(row.installed, false);
      assert.equal(row.source_digest, digests.get(manifest.id));
      assert.equal(row.manifest_path, path.join(root, "packages", manifest.id, "extension.json"));
    }
    assert.deepEqual(inventory.extensions.filter((row) => row.category === "tab" && row.origin === "custom").map((row) => row.id), ["tab.task-returns"]);
  } finally {
    store.close();
  }
});

test("a refused revision reports exact issues and runtime issues follow the current surface revision", async () => {
  const root = path.join(await scratch("octopus-extension-refusal-"), "extensions");
  const store = createClientExtensionStore({ root });
  try {
    const broken = structuredClone(examples[0]);
    broken.contribution.document.target.slot = "middle";
    broken.default_installed = true;
    await writePackage(root, broken);
    const good = await writePackage(root, examples[2]);
    const snapshot = await store.snapshot();
    assert.match(snapshot.errors.join("\n"), /packages\/home\.attention\/extension\.json: Client extension manifest does not satisfy the client extension contract: \/contribution\/document\/target\/slot must be equal to one of the allowed values/);
    reportClientSurfaceRuntimeIssue({ extensionId: "tab.task-returns", documentId: "tab.task-returns", sourceDigest: `${good}:surface` }, "script", "boom");
    reportClientSurfaceRuntimeIssue({ extensionId: "tab.task-returns", documentId: "tab.task-returns", sourceDigest: "sha256:old:surface" }, "script", "stale");
    const inventory = buildClientInventory({ snapshot, surfaces: [], runtimeIssues: clientSurfaceRuntimeIssues() });
    const refused = inventory.refused.find((entry) => entry.extension_id === "home.attention");
    assert.ok(refused.issues.some((issue) => issue.path === "/contribution/document/target/slot"));
    assert.equal(inventory.extensions.some((entry) => entry.id === "home.attention"), false);
    const scoped = buildClientInventory({ snapshot, surfaces: [], runtimeIssues: clientSurfaceRuntimeIssues(), extensionId: "tab.task-returns" });
    assert.deepEqual(scoped.extensions.map((entry) => entry.id), ["tab.task-returns"]);
    assert.deepEqual(scoped.extensions[0].runtime_issues.map((issue) => issue.message), ["boom"]);
    assert.deepEqual(scoped.refused, []);
  } finally {
    store.close();
  }
});

test("inspect_client is a declared client.mcp operation and describes the host from the running schemas", () => {
  const operation = catalogue.handler_config.mcp.tools.find((tool) => tool.name === "inspect_client");
  const publish = catalogue.handler_config.mcp.tools.find((tool) => tool.name === "publish_widget");
  assert.deepEqual(publish.input_schema.$defs.client_surface, documentSchema, "the model and renderer must receive the same widget schema");
  assert.deepEqual(operation.operation, { kind: "emit", label: "client.action", payload_argument: "action", await_client_result: true });
  assert.equal(operation.input_schema.properties.action.properties.action.const, "inspect_client");
  assert.ok(parseClientAction(inspect({ extension_id: "home.attention", source: { method: "projection.runs.list", params: { limit: 1 } } })));
  assert.throws(() => parseClientAction(inspect({ source: { method: "projection.runs.list", url: "x" } })), /inspect_client/);
  assert.ok(parseClientAction({ schema: "octopus.client_action", schema_version: 1, action: "relaunch_client", request_id: "relaunch-1" }));
  assert.throws(() => parseClientAction({ schema: "octopus.client_action", schema_version: 1, action: "relaunch_client", request_id: "relaunch-1", force: true }), /relaunch_client/);
  const inventory = buildClientInventory({ snapshot: { generation: 0, root: "/home/client/extensions", manifests: [], state: {}, stateStatus: "valid", lifecycle: {}, credentials: {}, actionStatuses: [], errors: [] }, surfaces: [], runtimeIssues: [] });
  assert.deepEqual(inventory.host.targets["voice.widget"].slot, documentSchema.$defs.voiceTarget.properties.slot.enum);
  assert.deepEqual(inventory.host.glyphs, documentSchema.$defs.glyph.enum);
  for (const node of ["list", "table", "metric", "progress", "button", "video"]) assert.ok(inventory.host.render.native.nodes.includes(node));
  assert.deepEqual(inventory.host.sources.projection.map((source) => source.method), [...CLIENT_SURFACE_READ_METHODS]);
  assert.ok(inventory.host.sources.projection.every((source) => source.params && source.returns));
});

test("a feed reader shows the newest emission and inspect previews it through the real projection", async () => {
  const home = await scratch("octopus-extension-feed-");
  const blobs = path.join(home, "ledger/blobs");
  await fs.mkdir(blobs, { recursive: true });
  const blob = async (value) => {
    const bytes = Buffer.from(JSON.stringify(value)), hash = Buffer.from(blake3(bytes)).toString("hex");
    await fs.writeFile(path.join(blobs, hash), bytes);
    return hash;
  };
  const source = examples[1].contribution.document.sources[0];
  const feed = source.params.interface_id, label = source.params.labels[0];
  const rows = [];
  for (const free of [120, 150, 182.4]) {
    const payloadPath = path.join(home, `payload-${free}.json`), payload = { mount: "/", free_gb: free, used_percent: 61 };
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    const hash = await blob({ label, payload_path: payloadPath, payload_content_hash: await blob(payload) });
    const seq = rows.length;
    rows.push({ seq, lamport: seq, trace: "feed", recorded_at_unix_ms: 1_000 + seq, kind: "InterfaceOutbound",
      from: { Interface: "system_room_producer" }, to: { Interface: feed }, artifact: { id: `${label}:${hash}`, content: [...Buffer.from(hash, "hex")] },
      invocation_metadata: { runtime: { run: "run_producer", ee: "ee", worker: "worker", checkpoint: "emit", interface: "system_room_producer", epoch: 0 } } });
  }
  await fs.writeFile(path.join(home, "ledger/movements.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const store = createProjectionStore({ resolveRepoRoot: () => repoRoot, octopusHome: () => home, sourceRegistry: () => path.join(home, "registry"), projectEePolicies: () => new Promise(() => {}) });
  try {
    const read = (params) => store.read({ contract_version: 1, method: source.method, params });
    assert.deepEqual((await read(source.params)).artifacts.map((row) => row.payload.free_gb), [182.4]);
    assert.deepEqual((await read({ ...source.params, order: undefined, limit: 3 })).artifacts.map((row) => row.payload.free_gb), [120, 150, 182.4]);
    await assert.rejects(read({ ...source.params, order: "latest" }), /oldest or newest/);
    globalThis.window = { octopusTransport: {
      projectionRead: (request) => store.read(request),
      clientExtensions: async () => ({ generation: 0, root: "", manifests: [], state: {}, stateStatus: "valid", lifecycle: {}, credentials: {}, actionStatuses: [], errors: [] }),
    } };
    const inventory = await inspectClient(inspect({ source: { method: source.method, params: source.params, path: "artifacts.0.payload" } }), []);
    assert.deepEqual(inventory.source_preview, { method: source.method, params: source.params, path: "artifacts.0.payload", ok: true, value: { mount: "/", free_gb: 182.4, used_percent: 61 }, truncated: false });
    const refused = await inspectClient(inspect({ source: { method: "projection.operator.chat.messages" } }), []);
    assert.match(refused.source_preview.error, /not available to client surfaces/);
  } finally {
    store.close();
    delete globalThis.window;
  }
});
