const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { JSDOM } = require("jsdom");
const { createRoot } = require("react-dom/client");
const app = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(app, "src", file), "utf8");
const compile = (code) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(file, dependencies = {}) {
  const module = { exports: {} };
  Function("require", "module", "exports", compile(source(file).replaceAll("import.meta.env.DEV", "false")))((id) => dependencies[id] ?? require(id), module, module.exports);
  return module.exports;
}
function deferred(queue) {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  queue.push({ resolve, reject }); return promise;
}
const workspace = ts.createSourceFile("workspace.ts", source("components/chat/useChatWorkspace.ts"), ts.ScriptTarget.Latest, true);
const names = new Set(["activeProviderModel", "providerDeclared", "reasoningOptions", "reasoningSelectionValid", "serviceTierSelectionValid", "canQueueOnActiveRun", "activeRunSubmitAllowed", "hasSubmissionPayload", "submitBlockReason", "editingQueuedTurn", "canSubmit", "canQueue"]);
const declarations = [], observerBranches = [];
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.has(item.name.getText(workspace)))) declarations.push(node.getText(workspace));
  if (ts.isIfStatement(node) && node.expression.getText(workspace).includes('artifact.event_kind === "rate_limits"')) observerBranches.push(Function("artifacts", "refreshProviderUsage", "refreshProviderInterfaces", compile(node.getText(workspace))));
  ts.forEachChild(node, visit);
}
visit(workspace); assert.equal(declarations.length, names.size); assert.equal(observerBranches.length, 2);
const gate = Function("input", `with(input){${compile(declarations.join("\n"))}return {canSubmit,canQueue,submitBlockReason};}`);
const capabilities = load("components/chat/chatWorkspaceCapabilities.ts", { "./taskAccess": load("components/chat/taskAccess.ts") });
const { chatDraftKey } = (() => {
  const module = { exports: {} };
  const bundled = require("esbuild").buildSync({ entryPoints: [path.join(app, "src/components/chat/useChatDraftState.ts")], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent", external: ["react", "react-dom"] });
  Function("require", "module", "exports", bundled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
})();
const model = { model: "model", showInPicker: true, supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", serviceTiers: [{ id: "priority", name: "Fast" }] };
const provider = { id: "provider", model: "model", models: [model] };
const catalogReads = [], usageReads = [], contextReads = [], traces = [];
let projectionChanged, accountChanged, current, latestGate, gateInput, home = "fixture-a", replyOpen = false;
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
window.octopusTransport = {
  onProjectionChanged: (listener) => { projectionChanged = listener; return () => { projectionChanged = null; }; },
  onChatgptAccountChanged: (listener) => { accountChanged = listener; return () => { accountChanged = null; }; },
};
const live = load("projectionLive.ts");
const { useChatCapabilityCatalog } = load("components/chat/useChatCapabilityCatalog.ts", {
  "../../shell/latestProjectionRead": load("shell/latestProjectionRead.ts"),
  "../../chatRuns": { formatProjectionError: String, loadChatExecutionContexts: () => deferred(contextReads), loadChatWorkerEnvironmentRooms: async () => [] },
  "../../projectionClient": { hasProjectionBridge: () => true, readProjection: async () => ({}), readRuntimeProviderInterfaces: () => deferred(catalogReads), readProviderInterfaceRateLimits: () => deferred(usageReads) },
  "../../projectionLive": live, "../../runtimeClient": { formatRuntimeError: (error) => error.message },
  "../../shell/clientWorkspaces": { readClientChatProjects: () => [], subscribeClientChatProjects: () => () => {} },
  "./chatActivityProjection": { toolPresentationsFromProjection: () => ({}) },
});
function Host() {
  current = useChatCapabilityCatalog("live", true, true, home);
  gateInput = { ...capabilities, ...current, chatDraftKey, enabled: true, runtimeReady: true, queueReady: true, queueError: "", loadingMessages: false,
    artifactWriterAvailable: true, activeRun: { writable: true }, activeRunId: "run", activeRunKey: "run", replyOpen, replyRunKey: replyOpen ? "run" : "",
    activeRunSteeringPending: false, queuedTurns: [], applicationMutationPending: "", clientAgentSelectionReady: true,
    providerSelectionReady: current.providerInterfacesLoaded, activeProvider: current.providerInterfaces.find((item) => item.id === provider.id),
    providerModel: "model", resolvedProviderInterfaceId: provider.id, reasoningEffort: "low", serviceTier: "priority", executionContextReady: true,
    selectedClientAgentCapabilityFailure: "", newTaskAuthoringError: "", workspaceSelectionError: "", text: "next", attachments: [], draftMessageId: "", queueOwner: { id: "test" } };
  latestGate = gate(gateInput);
  traces.push(latestGate); return null;
}
const root = createRoot(document.getElementById("root"));
const render = () => React.act(async () => root.render(React.createElement(Host)));
const settle = (read, value, failure = false) => React.act(async () => read[failure ? "reject" : "resolve"](value));
const notify = (kind, generation) => React.act(async () => projectionChanged({ kind, generation }));
const telemetry = (index) => React.act(async () => observerBranches[index]([{ event_kind: "rate_limits" }], current.refreshProviderUsage, () => { throw new Error("usage requested model discovery"); }));
const newTaskGate = () => gate({ ...gateInput, activeRunId: "", activeRun: null, replyOpen: false, executionContextReady: current.executionContextsLoaded });
async function main() {
  await render(); assert.equal(latestGate.canSubmit, false); assert.equal(catalogReads.length, 1);
  let first, second; await React.act(async () => { first = current.refreshProviderInterfaces(); second = current.refreshProviderInterfaces(); });
  assert.equal(first, second); assert.equal(catalogReads.length, 1);
  await settle(catalogReads[0], { providers: [provider] }); await settle(usageReads[0], new Map()); assert.equal(latestGate.canSubmit, true);
  assert.equal(newTaskGate().canSubmit, false); await settle(contextReads[0], []); assert.equal(newTaskGate().canSubmit, true);
  replyOpen = true; await render(); const beforeUsage = traces.length;
  await telemetry(0); await telemetry(1); assert.equal(usageReads.length, 2); assert.equal(catalogReads.length, 1);
  assert.equal(latestGate.canQueue, true); await settle(usageReads[1], new Map([[provider.id, { movementSeq: 20 }]]));
  await telemetry(1); await settle(usageReads[2], new Map([[provider.id, { movementSeq: 21 }]]));
  await notify("runs", 10); assert.equal(contextReads.length, 2); assert.equal(newTaskGate().canSubmit, true);
  await notify("files", 11); await settle(contextReads[1], [{ eeId: "obsolete" }]); assert.deepEqual(current.executionContexts, []);
  await settle(contextReads[2], []); await notify("ledger", 12); assert.equal(contextReads.length, 3);
  assert.equal(live.currentProjectionStructureGeneration(), 11); assert.equal(live.currentProjectionRegistryGeneration(), 0);
  await notify("runs", 13); assert.equal(newTaskGate().canSubmit, true);
  await settle(contextReads.at(-1), new Error("Contexts unavailable"), true); assert.equal(newTaskGate().canSubmit, false); assert.match(newTaskGate().submitBlockReason, /Contexts unavailable/);
  await notify("runs", 14); await settle(contextReads.at(-1), []); assert.equal(newTaskGate().canSubmit, true);
  assert.equal(catalogReads.length, 1); assert.ok(traces.slice(beforeUsage).every((row) => row.canSubmit && row.canQueue));
  assert.equal(current.providerInterfaces[0].models, provider.models); assert.equal(current.providerInterfaces[0].rateLimits.movementSeq, 21);
  replyOpen = false; await render(); await telemetry(0); home = "fixture-b"; await render();
  assert.equal(current.executionContextsLoaded, false); await settle(contextReads.at(-1), []);
  await settle(usageReads[3], new Map([[provider.id, { movementSeq: 999 }]])); assert.equal(current.providerInterfaces.length, 0);
  await settle(catalogReads[1], { providers: [provider] }); await settle(usageReads[4], new Map()); assert.equal(latestGate.canSubmit, true);
  await React.act(async () => { first = current.refreshProviderInterfaces(); second = current.refreshProviderInterfaces(); });
  assert.equal(first, second); assert.equal(catalogReads.length, 3); assert.equal(latestGate.canSubmit, false);
  await notify("structure", 15); assert.equal(catalogReads.length, 4); assert.equal(live.currentProjectionRegistryGeneration(), 15);
  assert.equal(current.executionContextsLoaded, false); await settle(contextReads.at(-1), []);
  await settle(catalogReads[2], { providers: [{ ...provider, models: [] }] }); assert.equal(current.providerInterfacesRefreshing, true);
  assert.equal(current.providerInterfaces[0].models, provider.models);
  await settle(catalogReads[3], { providers: [provider], error: "Registry unavailable" });
  assert.equal(latestGate.canSubmit, false); assert.equal(latestGate.submitBlockReason, "Registry unavailable");
  await React.act(async () => { first = current.refreshProviderInterfaces(); second = current.refreshProviderInterfaces(); });
  assert.equal(first, second); await telemetry(0); const oldAccountUsage = usageReads.at(-1);
  await React.act(async () => accountChanged()); assert.equal(catalogReads.length, 6);
  await settle(oldAccountUsage, new Map([[provider.id, { movementSeq: 999 }]])); assert.equal(current.providerInterfaces[0].rateLimits, undefined);
  await settle(catalogReads[4], { providers: [provider] }); assert.equal(current.providerInterfacesRefreshing, true);
  await settle(catalogReads[5], new Error("Account catalogue failed"), true);
  assert.equal(current.providerInterfaces.length, 0); assert.match(latestGate.submitBlockReason, /Account catalogue failed/);
  await React.act(async () => { void current.refreshProviderInterfaces(); }); await settle(catalogReads[6], { providers: [provider] });
  await settle(usageReads.at(-1), new Error("Usage offline"), true);
  assert.equal(latestGate.canSubmit, true); assert.equal(current.providerInterfaces[0].models, provider.models);
  assert.match(current.providerUsageError, /Usage offline/); assert.equal(current.providerInterfaces[0].rateLimits, undefined);
  await telemetry(1); await settle(usageReads.at(-1), new Map()); assert.equal(current.providerUsageError, "");
  await React.act(async () => { void current.refreshProviderInterfaces(); }); await settle(catalogReads[7], { providers: [{ ...provider, models: [] }] });
  assert.equal(latestGate.canSubmit, false); assert.match(current.providerInterfaceError, /No models are available/);
  for (const [nextModel, reason] of [[{ ...model, model: "other" }, /does not admit model/],
    [{ ...model, supportedReasoningEfforts: ["high"] }, /reasoning level/], [{ ...model, serviceTiers: [] }, /service tier 'priority'/]]) {
    await React.act(async () => { void current.refreshProviderInterfaces(); }); await settle(catalogReads.at(-1), { providers: [{ ...provider, models: [nextModel] }] });
    assert.equal(latestGate.canSubmit, false); assert.match(latestGate.submitBlockReason, reason); await settle(usageReads.at(-1), new Map());
  }
  await React.act(async () => { void current.refreshProviderInterfaces(); }); await settle(catalogReads.at(-1), { providers: [provider] });
  await React.act(async () => root.unmount()); await settle(usageReads.at(-1), new Map()); assert.equal(projectionChanged, null); assert.equal(accountChanged, null);
  dom.window.close(); console.log("PASS mounted catalogue/observer cycle: usage never blocks; runs/files/ledger preserve discovery; background context reads retain readiness, failure closes it; scope, registry and account invalidation reject stale reads");
}
main().catch((error) => { console.error(error); process.exitCode = 1; dom.window.close(); });
