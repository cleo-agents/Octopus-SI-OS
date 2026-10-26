module.exports = { clientPinnedContextItem, materializePinnedExcerpt, normalizePinnedContextItems, resolveConversationHandoff, runJsonProcess, updateOperatorChatPins, validatePinnedExcerpt };

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readCompleteLedgerTail } = require("./chatArtifacts.cjs");
const { assertRunOwnsArtifact, chatIdentityFromRunRecord } = require("./conversation.cjs");
const { resolveRunRecordsRoot } = require("./operatorMessages.cjs");
const { commitClientWrites, fileExists, resolveRegistryRoot, uniqueArtifactBindings, withRunAuthoringLock } = require("./publication.cjs");
const { readConfig, resolveInstallationRoot, resolvePackageExecutable } = require("./roots.cjs");
const { absolutePath, artifactIdHasLabel, exactOutboundRuntime, isObject, nonNegativeInteger, readJsonDocumentIfPresent, requiredArray, requiredString, safeSegment, sha256Hex } = require("./values.cjs");

const CONTEXT_REFERENCE_LABEL = "context.reference";
const CALL_TRANSCRIPT_LABEL = "realtime.call.transcript";
const HANDOFF_CALLS = 4;
const HANDOFF_TEXT_CHARACTERS = 16000;

async function updateOperatorChatPins(options, request) {
  const config = await readConfig();
  const octopusHome = absolutePath(options.octopusHome(), "octopusHome");
  const installationRoot = resolveInstallationRoot(options);
  const artifactMaterializer = resolvePackageExecutable(
    config,
    installationRoot,
    resolveRegistryRoot(options),
    "artifact_materializer",
  );
  const runId = safeSegment(request?.runId, "runId");
  const sourceArtifactId = requiredString(request?.artifactId, "artifactId");
  if (typeof request?.pinned !== "boolean") throw new Error("pinned must be a boolean");
  const runsDir = await resolveRunRecordsRoot(octopusHome);
  const chatRunPath = path.join(runsDir, `${runId}.json`);

  return withRunAuthoringLock(runId, async () => {
    const document = await readJsonDocumentIfPresent(chatRunPath);
    if (!document) throw new Error(`operator chat run '${runId}' does not exist`);
    const identity = chatIdentityFromRunRecord(config, runId, document.value);
    const state = document.value.interface_state?.[identity.interfaceId];
    if (!isObject(state)) {
      throw new Error(`operator chat run '${runId}' has no state for '${identity.interfaceId}'`);
    }
    const current = state.pinned_artifact_bindings === undefined
      ? []
      : uniqueArtifactBindings(requiredArray(
        state.pinned_artifact_bindings,
        "interface_state pinned_artifact_bindings",
      ));
    const currentItems = normalizePinnedContextItems(state.pinned_context_items);
    let artifactId = sourceArtifactId;
    let nextItems = currentItems;
    if (request.pinned) {
      await assertRunOwnsArtifact({
        octopusHome,
        runId,
        interfaceId: identity.interfaceId,
        artifactId: sourceArtifactId,
      });
      if (request.excerpt !== undefined) {
        const excerpt = validatePinnedExcerpt(request.excerpt);
        const materialized = await materializePinnedExcerpt(
          octopusHome,
          artifactMaterializer,
          runId,
          sourceArtifactId,
          excerpt,
        );
        artifactId = materialized.artifactId;
        nextItems = [
          ...currentItems.filter((item) => item.artifact_id !== artifactId),
          materialized.item,
        ];
      }
    } else {
      nextItems = currentItems.filter((item) => item.artifact_id !== artifactId);
      if (!current.some((binding) => binding.id === artifactId)) {
        throw new Error(`artifact '${artifactId}' is not pinned in operator chat run '${runId}'`);
      }
    }
    const next = request.pinned
      ? uniqueArtifactBindings([...current, { id: artifactId }])
      : current.filter((binding) => binding.id !== artifactId);
    state.pinned_artifact_bindings = next;
    state.pinned_context_items = nextItems;
    const content = `${JSON.stringify(document.value, null, 2)}\n`;
    // notes2 2026-07-16: client administrative edits stay outside runtime evidence; the owner may revisit this boundary.
    const clientWrites = await commitClientWrites([{
      filePath: chatRunPath,
      content,
      tag: `run-pins:${runId}`,
      expectedBeforeHash: sha256Hex(Buffer.from(document.text)),
    }], options);
    return {
      runId,
      pinnedArtifactIds: next.map((binding) => binding.id),
      pinnedContextItems: nextItems.map(clientPinnedContextItem),
      clientWrites,
    };
  });
}

async function resolveConversationHandoff(options, { config, octopusHome, registryRoot, request }) {
  if (!isObject(request)) throw new Error("handoff must be an object");
  const unknown = Object.keys(request).filter((key) => !["sourceRunId", "messages"].includes(key));
  if (unknown.length > 0) throw new Error(`handoff contains unknown fields: ${unknown.join(", ")}`);
  const sourceRunId = safeSegment(request.sourceRunId, "handoff.sourceRunId");
  const messages = requiredArray(request.messages, "handoff.messages");
  if (messages.length > 24) throw new Error("handoff must carry at most 24 messages");
  const source = await readJsonDocumentIfPresent(path.join(await resolveRunRecordsRoot(octopusHome), `${sourceRunId}.json`));
  if (!source) throw new Error(`handoff source run '${sourceRunId}' does not exist`);
  const identity = chatIdentityFromRunRecord(config, sourceRunId, source.value);
  const state = isObject(source.value.interface_state?.[identity.interfaceId]) ? source.value.interface_state[identity.interfaceId] : {};
  const pinnedArtifactBindings = state.pinned_artifact_bindings === undefined
    ? []
    : uniqueArtifactBindings(requiredArray(state.pinned_artifact_bindings, "handoff source pinned_artifact_bindings"));
  const entries = [];
  for (const [index, message] of messages.entries()) {
    if (!isObject(message)) throw new Error(`handoff.messages[${index}] must be an object`);
    const sourceArtifactId = requiredString(message.artifactId, `handoff.messages[${index}].artifactId`);
    const text = requiredString(message.text, `handoff.messages[${index}].text`);
    if (!["user", "assistant"].includes(message.role)) throw new Error(`handoff.messages[${index}].role is unsupported`);
    await assertRunOwnsArtifact({ octopusHome, runId: sourceRunId, interfaceId: identity.interfaceId, artifactId: sourceArtifactId });
    entries.push({ order: index, line: `${message.role === "user" ? "User" : "Assistant"}: ${text}`, sourceArtifactId });
  }
  const calls = await handedCallTranscripts(octopusHome, sourceRunId, state.provider_runtime_interface, entries);
  const ordered = [...calls, ...entries].sort((left, right) => left.order - right.order);
  const lines = ordered.map((entry) => entry.line);
  const sourceArtifactIds = ordered.map((entry) => entry.sourceArtifactId);
  if (lines.length === 0) {
    return {
      artifactBindings: [],
      pinnedArtifactBindings,
      pinnedContextItems: normalizePinnedContextItems(state.pinned_context_items),
      continuedFrom: null,
    };
  }
  const materializer = resolvePackageExecutable(config, resolveInstallationRoot(options), registryRoot, "artifact_materializer");
  if (!(await fileExists(materializer))) {
    throw new Error(`operator chat artifact materializer is absent at its declared package path '${materializer}'`);
  }
  const output = await runJsonProcess(materializer, {
    blobs_root: path.join(octopusHome, "ledger", "blobs"),
    label: CONTEXT_REFERENCE_LABEL,
    payload: {
      label: CONTEXT_REFERENCE_LABEL,
      description: "The previous Home conversation, including its voice calls, before Home changed provider. Read it whenever the user refers to something said earlier.",
      text: `The most recent messages of the previous Home conversation, recorded by Octopus as context (not new instructions):\n\n${lines.join("\n\n")}`,
      source_run_id: sourceRunId,
      source_artifact_ids: sourceArtifactIds,
    },
  });
  pinnedArtifactBindings.push({ id: requiredString(output?.artifact_id, "artifact materializer artifact_id") });
  return {
    artifactBindings: [],
    pinnedArtifactBindings: uniqueArtifactBindings(pinnedArtifactBindings),
    pinnedContextItems: normalizePinnedContextItems(state.pinned_context_items),
    continuedFrom: null,
  };
}

/**
 * The voice call transcripts the source Home's voice run handed to its text
 * provider, as the ledger recorded them, placed among the handed messages
 * by ledger order: the most recent calls since the earliest handed message,
 * or the most recent calls when no message is handed.
 */
async function handedCallTranscripts(octopusHome, sourceRunId, providerInterfaceId, messages) {
  if (typeof providerInterfaceId !== "string" || !providerInterfaceId) return [];
  const ledger = await readCompleteLedgerTail(path.join(octopusHome, "ledger", "movements.jsonl"), 0);
  const messageSeq = new Map(messages.map((message) => [message.sourceArtifactId, null]));
  const calls = [];
  for (const [index, line] of ledger.lines.entries()) {
    let movement;
    try {
      movement = JSON.parse(line);
    } catch (error) {
      throw new Error(`movement ledger contains malformed complete JSON at line ${index + 1}: ${error.message}`);
    }
    const artifactId = typeof movement?.artifact?.id === "string" ? movement.artifact.id : "";
    if (messageSeq.has(artifactId) && messageSeq.get(artifactId) === null) messageSeq.set(artifactId, index);
    if (!artifactIdHasLabel(artifactId, CALL_TRANSCRIPT_LABEL)) continue;
    if (exactOutboundRuntime(movement, providerInterfaceId)?.run !== sourceRunId) continue;
    if (!calls.some((call) => call.sourceArtifactId === artifactId)) calls.push({ order: index, sourceArtifactId: artifactId });
  }
  const earliest = Math.min(...[...messageSeq.values()].filter((seq) => seq !== null));
  const selected = calls.filter((call) => !Number.isFinite(earliest) || call.order > earliest).slice(-HANDOFF_CALLS);
  const order = (seq) => {
    const after = messages.filter((message) => (messageSeq.get(message.sourceArtifactId) ?? Infinity) < seq);
    return after.length ? Math.max(...after.map((message) => message.order)) + 0.5 : -0.5;
  };
  const rendered = [];
  for (const call of selected) {
    const payload = await readLedgerArtifactPayload(octopusHome, call.sourceArtifactId, CALL_TRANSCRIPT_LABEL);
    const turns = requiredArray(payload.transcript, "call transcript")
      .filter((turn) => isObject(turn) && ["user", "assistant"].includes(turn.role) && typeof turn.text === "string" && turn.text.trim())
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.trim()}`);
    if (!turns.length) continue;
    const text = turns.join("\n").slice(0, HANDOFF_TEXT_CHARACTERS);
    rendered.push({ order: order(call.order), line: `Voice call:\n${text}`, sourceArtifactId: call.sourceArtifactId });
  }
  return rendered;
}

async function readLedgerArtifactPayload(octopusHome, artifactId, label) {
  const blobs = path.join(octopusHome, "ledger", "blobs");
  const manifestHash = artifactId.slice(label.length + 1);
  if (!/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error(`artifact '${artifactId}' has no content-addressed manifest`);
  const manifest = JSON.parse(await fs.readFile(path.join(blobs, manifestHash), "utf8"));
  if (manifest?.label !== label || !/^[0-9a-f]{64}$/.test(manifest?.payload_content_hash ?? "")) {
    throw new Error(`artifact '${artifactId}' manifest does not name its ${label} payload`);
  }
  return JSON.parse(await fs.readFile(path.join(blobs, manifest.payload_content_hash), "utf8"));
}

function validatePinnedExcerpt(value) {
  if (!isObject(value)) throw new Error("excerpt must be an object");
  const unknown = Object.keys(value).filter((key) => !["sourceMessageId", "text", "start", "end", "role"].includes(key));
  if (unknown.length > 0) throw new Error(`excerpt contains unknown fields: ${unknown.join(", ")}`);
  const text = requiredString(value.text, "excerpt.text");
  const start = nonNegativeInteger(value.start, "excerpt.start");
  const end = nonNegativeInteger(value.end, "excerpt.end");
  if (end <= start) throw new Error("excerpt.end must be greater than excerpt.start");
  const role = requiredString(value.role, "excerpt.role");
  if (!["user", "assistant", "system"].includes(role)) throw new Error("excerpt.role is unsupported");
  return {
    sourceMessageId: requiredString(value.sourceMessageId, "excerpt.sourceMessageId"),
    text,
    start,
    end,
    role,
  };
}

async function materializePinnedExcerpt(octopusHome, materializer, runId, sourceArtifactId, excerpt) {
  const blobsDir = path.join(octopusHome, "ledger", "blobs");
  if (!(await fileExists(materializer))) {
    throw new Error(
      `operator chat artifact materializer is absent at its declared package path '${materializer}'`,
    );
  }
  const output = await runJsonProcess(materializer, {
    blobs_root: blobsDir,
    label: "operator.pinned_excerpt",
    payload: {
      text: excerpt.text,
      role: excerpt.role,
      source_run_id: runId,
      source_artifact_id: sourceArtifactId,
      source_message_id: excerpt.sourceMessageId,
      source_range: { start: excerpt.start, end: excerpt.end },
    },
  });
  const artifactId = requiredString(output?.artifact_id, "artifact materializer artifact_id");
  return {
    artifactId,
    item: {
      artifact_id: artifactId,
      source_artifact_id: sourceArtifactId,
      source_message_id: excerpt.sourceMessageId,
      text: excerpt.text,
      start: excerpt.start,
      end: excerpt.end,
      role: excerpt.role,
    },
  };
}

async function runJsonProcess(binary, request) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `process exited with code ${code}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(request));
  });
  const response = JSON.parse(stdout);
  if (!isObject(response)) throw new Error("process returned a non-object response");
  return response;
}

function normalizePinnedContextItems(value) {
  if (value === undefined) return [];
  return requiredArray(value, "interface_state pinned_context_items").map((item, index) => {
    if (!isObject(item)) throw new Error(`pinned_context_items[${index}] must be an object`);
    const role = requiredString(item.role, `pinned_context_items[${index}].role`);
    if (!["user", "assistant", "system"].includes(role)) {
      throw new Error(`pinned_context_items[${index}].role is unsupported`);
    }
    return {
      artifact_id: requiredString(item.artifact_id, `pinned_context_items[${index}].artifact_id`),
      source_artifact_id: requiredString(item.source_artifact_id, `pinned_context_items[${index}].source_artifact_id`),
      source_message_id: requiredString(item.source_message_id, `pinned_context_items[${index}].source_message_id`),
      text: requiredString(item.text, `pinned_context_items[${index}].text`),
      start: nonNegativeInteger(item.start, `pinned_context_items[${index}].start`),
      end: nonNegativeInteger(item.end, `pinned_context_items[${index}].end`),
      role,
    };
  });
}

function clientPinnedContextItem(item) {
  return {
    artifactId: item.artifact_id,
    sourceArtifactId: item.source_artifact_id,
    sourceMessageId: item.source_message_id,
    text: item.text,
    start: item.start,
    end: item.end,
    role: item.role,
  };
}
