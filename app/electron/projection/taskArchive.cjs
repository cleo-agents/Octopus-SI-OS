module.exports = { readClientTaskArchive, setOctopusOsTaskArchived };

const crypto = require("node:crypto");
const path = require("node:path");
const { readRegularJsonDocument } = require("./jsonFiles.cjs");
const { assertRunPrivateStateIsOwned, scopedRecordPath, taskOwnedInterfaceIds } = require("./taskDeletion.cjs");
const { exactObjectKeys, interfaceBindingId, isPlainRecord, numberValue, requiredBoolean, requiredDigest, requiredSafeRegistryId } = require("./values.cjs");

function readClientTaskArchive(run, clientInterfaceId) {
  const state = run.interface_state?.[clientInterfaceId];
  if (state?.client_archive === undefined) return null;
  const label = `task '${run.id}' archive`;
  if (!["task", "home"].includes(state.client_surface_role)) throw new Error(`${label} belongs to a client that cannot be archived`);
  const archive = state.client_archive;
  exactObjectKeys(archive,
    ["schema_version", "active_checkpoints", "checkpoints_digest", "archived_at_ms"],
    ["schema_version", "active_checkpoints", "checkpoints_digest", "archived_at_ms"], label);
  if (archive.schema_version !== 1 || !Number.isSafeInteger(archive.archived_at_ms) || archive.archived_at_ms <= 0) {
    throw new Error(`${label} has invalid metadata`);
  }
  if (!Array.isArray(run.active_checkpoints) || run.active_checkpoints.length !== 0) {
    throw new Error(`${label} still admits artifacts through active checkpoints`);
  }
  if (!Array.isArray(archive.active_checkpoints) || !Array.isArray(run.checkpoints)) {
    throw new Error(`${label} has no saved checkpoint frontier`);
  }
  const savedIds = archive.active_checkpoints.map((id) => requiredSafeRegistryId(id, `${label} checkpoint`));
  const checkpointIds = new Set(run.checkpoints.map((checkpoint) => checkpoint.id));
  if (new Set(savedIds).size !== savedIds.length || savedIds.some((id) => !checkpointIds.has(id))) {
    throw new Error(`${label} has duplicate or missing checkpoints`);
  }
  if (requiredDigest(archive.checkpoints_digest, `${label} topology digest`)
    !== crypto.createHash("sha256").update(JSON.stringify(run.checkpoints)).digest("hex")) {
    throw new Error(`${label} checkpoint topology changed; restore is refused`);
  }
  if (!run.checkpoints.some((checkpoint) => interfaceBindingId(checkpoint.interface_binding) === clientInterfaceId)) {
    throw new Error(`${label} has no exact client checkpoint`);
  }
  return archive;
}

async function setOctopusOsTaskArchived(registryRoot, octopusHomeRoot, scope, request, hooks) {
  exactObjectKeys(request, ["action", "home", "workspace", "runId", "expectedDigest", "archived"],
    ["action", "home", "workspace", "runId", "expectedDigest", "archived"], "Task archive request");
  exactObjectKeys(request.workspace, ["rootEeId", "homeRunId", "homeInterfaceId"],
    ["rootEeId", "homeRunId", "homeInterfaceId"], "Task archive workspace");
  if (request.home !== octopusHomeRoot || request.workspace.rootEeId !== scope.rootEeId
    || request.workspace.homeRunId !== scope.homeRunId || request.workspace.homeInterfaceId !== scope.homeInterfaceId) {
    throw new Error("Task archive request does not match the current Home and workspace");
  }
  const runId = requiredSafeRegistryId(request.runId, "runId");
  const archived = requiredBoolean(request.archived, "archived");
  const expectedDigest = requiredDigest(request.expectedDigest, "expectedDigest");
  const projected = scope.clientRuns.find((row) => row.run_id === runId && row.surface_role === "task");
  if (!projected || runId === scope.homeRunId) throw new Error(`task '${runId}' is not an archivable Octopus OS task`);
  if (!scope.byId.has(projected.ee_id)) throw new Error(`task '${runId}' is outside the Octopus OS scope`);
  if (typeof hooks.withTaskAuthoringLock !== "function" || typeof hooks.readTaskStatus !== "function"
    || typeof hooks.commitClientAuthoring !== "function") {
    throw new Error("task archive authoring is unavailable");
  }
  return hooks.withTaskAuthoringLock(runId, async () => {
    const runPath = await scopedRecordPath(octopusHomeRoot, projected.record_path, path.join("state", "runs"), `${runId}.json`);
    const current = await readRegularJsonDocument(runPath, `task run ${runId}`);
    if (current.digest !== expectedDigest || projected.record_digest !== expectedDigest) {
      throw new Error(`task '${runId}' changed before its archive state could be edited`);
    }
    const next = current.document;
    const clientInterfaceId = requiredSafeRegistryId(projected.interface_id, "task client interface");
    const clientState = next.interface_state?.[clientInterfaceId];
    if (next.id !== runId || next.ee !== projected.ee_id || !isPlainRecord(clientState)
      || clientState.client_surface_role !== "task" || !Array.isArray(next.checkpoints) || !Array.isArray(next.active_checkpoints)) {
      throw new Error(`task '${runId}' has malformed authored topology`);
    }
    const archive = readClientTaskArchive(next, clientInterfaceId);
    const exactInterfaces = await taskOwnedInterfaceIds(registryRoot, next, clientInterfaceId, runId);
    assertRunPrivateStateIsOwned(next, exactInterfaces, runId);
    const ids = next.checkpoints.map((checkpoint) => requiredSafeRegistryId(checkpoint.id, "task checkpoint"));
    const activeIds = next.active_checkpoints.map((id) => requiredSafeRegistryId(id, "active task checkpoint"));
    if (new Set(ids).size !== ids.length || new Set(activeIds).size !== activeIds.length || activeIds.some((id) => !ids.includes(id))) {
      throw new Error(`task '${runId}' has duplicated or missing checkpoints`);
    }
    const providerId = requiredSafeRegistryId(clientState.provider_runtime_interface, "task provider interface");
    const providerState = next.interface_state[providerId];
    if (!isPlainRecord(providerState)) throw new Error(`task '${runId}' has no exact provider state`);
    if (providerState.pending_handoff !== undefined) {
      if (!isPlainRecord(providerState.pending_handoff) || providerState.pending_handoff.terminal !== true) {
        throw new Error(`task '${runId}' is working; stop the task before archiving`);
      }
    } else if (numberValue(providerState.authoring_generation, 0) > 0) {
      throw new Error(`task '${runId}' lost its provider handoff evidence`);
    }
    if (archived === Boolean(archive)) return { action: "set_task_archived", runId, archived, changed: false };
    if (archived) {
      const status = await hooks.readTaskStatus(runId);
      if (!status || status.run_id !== runId || status.turn_open !== false || !["idle", "failed"].includes(status.turn_state)) {
        throw new Error(`task '${runId}' has an open turn; stop the task before archiving`);
      }
      clientState.client_archive = {
        schema_version: 1,
        active_checkpoints: [...activeIds],
        checkpoints_digest: crypto.createHash("sha256").update(JSON.stringify(next.checkpoints)).digest("hex"),
        archived_at_ms: Date.now(),
      };
      next.active_checkpoints = [];
      readClientTaskArchive(next, clientInterfaceId);
    } else {
      next.active_checkpoints = [...archive.active_checkpoints];
      delete clientState.client_archive;
    }
    await hooks.commitClientAuthoring({
      label: archived ? "archive Octopus OS task" : "restore Octopus OS task",
      writes: [{ file: runPath, beforeDigest: expectedDigest, next }], removals: [], publishBarrierPath: runPath,
    });
    return { action: "set_task_archived", runId, archived, changed: true };
  });
}
