import { useEffect, useRef } from "react";
import { readProjection, submitInterfaceArtifact } from "../projectionClient";
import { parseClientAction, type InspectClientAction, type WidgetAction } from "../../electron/clientActionSemantics.mjs";
import { useProjectionGeneration } from "../projectionLive";
import type { ClientSurfaceDescriptor } from "./surfaceTypes";
import { prepareClientFile } from "../components/files/fileTarget";
import type { FilesOpenTarget } from "../components/files/types";

type ActionScope = { home: string; runId: string; interfaceId: string };
type DeliveryIdentity = {
  artifact_id: string;
  run_id: string;
  seq: number;
  from: { Interface: string };
  to: { Interface: string };
};
type ClientActionOptions = ActionScope & {
  enabled: boolean;
  surfaces: readonly ClientSurfaceDescriptor[];
  openSurface: (surface: ClientSurfaceDescriptor) => void;
  openFile?: (target: FilesOpenTarget) => void;
  widgets?: (action: WidgetAction, operationId: string) => Promise<unknown>;
  inspect?: (action: InspectClientAction) => Promise<Record<string, unknown>>;
  relaunch?: () => Promise<unknown>;
  onRefusal: (reason: string) => void;
};

const PAGE_SIZE = 128;
const CURSOR_PREFIX = "octopus.client-actions.cursor.v1:";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed client action evidence.");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function interfaceEndpoint(value: unknown): { Interface: string } {
  const endpoint = object(value);
  if (Object.keys(endpoint).length !== 1 || typeof endpoint.Interface !== "string" || !endpoint.Interface) {
    throw new Error("Client action has an invalid interface endpoint.");
  }
  return { Interface: endpoint.Interface };
}

function deliveryIdentity(value: unknown, scope: ActionScope): DeliveryIdentity {
  const row = object(value);
  const from = interfaceEndpoint(row.from);
  const to = interfaceEndpoint(row.to);
  if (typeof row.artifact_id !== "string" || !/^client\.action:[0-9a-f]{64}$/.test(row.artifact_id)
    || row.run_id !== scope.runId || to.Interface !== scope.interfaceId
    || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0) {
    throw new Error("Client action does not match the current Home run and interface.");
  }
  return { artifact_id: row.artifact_id, run_id: scope.runId, seq: row.seq, from, to };
}

function readCursor(storage: Storage, key: string, scope: ActionScope): number {
  const stored = storage.getItem(key);
  if (stored === null) return -1;
  const cursor = object(JSON.parse(stored));
  if (cursor.schema_version !== 1 || cursor.home !== scope.home
    || cursor.run_id !== scope.runId || cursor.interface_id !== scope.interfaceId) {
    throw new Error("Client action cursor does not match the selected Home.");
  }
  return deliveryIdentity(cursor.last_consumed, scope).seq;
}

function turnClosure(row: Record<string, unknown>): "completed" | "stopped" | null {
  if (row.turn_closure === null || row.turn_closure === undefined) return null;
  if (row.turn_closure === "completed" || row.turn_closure === "stopped") return row.turn_closure;
  throw new Error("Client action has an invalid turn closure.");
}

function clientAction(row: Record<string, unknown>) {
  if (Object.hasOwn(row, "error")) {
    throw new Error(typeof row.error === "string" && row.error ? row.error : "Client action payload could not be verified.");
  }
  const action = parseClientAction(row.action);
  if (action.action !== "open_surface" && !isRecord(row.tool_call)) throw new Error("Client controls require a correlated tool request.");
  return action;
}

export function useAdmittedClientActions(options: ClientActionOptions): void {
  const enabled = options.enabled && Boolean(options.home && options.runId && options.interfaceId);
  const generation = useProjectionGeneration(true, enabled);
  const scopeKey = enabled ? JSON.stringify([options.home, options.runId, options.interfaceId]) : "";
  const latest = useRef(options);
  latest.current = options;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const lastFailure = useRef("");
  const serial = useRef(new Map<string, Promise<void>>());
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!scopeKey) return;
    const scope = { home: options.home, runId: options.runId, interfaceId: options.interfaceId };
    const token = active.current;
    const key = CURSOR_PREFIX + scopeKey;
    let cancelled = false;
    const current = () => !cancelled && active.current === token && latest.current.enabled;
    const refuse = (reason: string) => latest.current.onRefusal(`Client action refused: ${reason}`);

    async function consume(): Promise<void> {
      try {
        const storage = window.localStorage;
        let afterSeq = readCursor(storage, key, scope);
        while (current()) {
          const response = object(await readProjection("projection.client_actions.list", {
            home: scope.home, run_id: scope.runId, interface_id: scope.interfaceId,
            after_seq: afterSeq, limit: PAGE_SIZE,
          }));
          if (!current()) return;
          if (response.home !== scope.home || response.run_id !== scope.runId
            || response.interface_id !== scope.interfaceId || !Array.isArray(response.actions)
            || response.actions.length > PAGE_SIZE) {
            throw new Error("Client action projection does not match the selected Home.");
          }
          let previousSeq = -1;
          const deliveries = response.actions.map((value: unknown) => {
            const row = object(value);
            const identity = deliveryIdentity(row, scope);
            if (row.movement_kind !== "InterfaceOutbound" || identity.seq <= previousSeq) {
              throw new Error("Client actions must be admitted outbound movements in ledger order.");
            }
            previousSeq = identity.seq;
            return { row, identity };
          });
          for (const { row, identity } of deliveries) {
            if (!current()) return;
            if (identity.seq <= readCursor(storage, key, scope)) continue;
            let action;
            try { action = clientAction(row); } catch (error) { refuse(error instanceof Error ? error.message : String(error)); }
            const closure = turnClosure(row);
            const recorded = row.completed_result === undefined ? null : object(row.completed_result);
            if (recorded && (typeof recorded.artifact_id !== "string" || !/^client\.action\.result:[0-9a-f]{64}$/.test(recorded.artifact_id)
              || typeof recorded.seq !== "number" || !Number.isSafeInteger(recorded.seq) || recorded.seq <= identity.seq)) {
              throw new Error("Client action completion has invalid ledger evidence.");
            }
            let relaunchReady = false;
            if (action && action.action !== "open_surface" && !recorded) {
              const pendingKey = `octopus.client-widget-result.v1:${scopeKey}`;
              const retained = storage.getItem(pendingKey);
              let receipt: Record<string, unknown>;
              if (retained !== null) {
                receipt = object(JSON.parse(retained));
                if (receipt.schema !== "octopus.client_action_result" || receipt.schema_version !== 1
                  || typeof receipt.observed_at !== "string" || !Number.isFinite(Date.parse(receipt.observed_at))
                  || !["prepared", "completed"].includes(String(receipt.phase))
                  || receipt.phase === "completed" && (typeof receipt.ok !== "boolean"
                    || (receipt.ok ? !Array.isArray(receipt.widgets) && !isRecord(receipt.client) && !isRecord(receipt.relaunch) && !isRecord(receipt.opened) : typeof receipt.error !== "string"))) {
                  throw new Error("Saved widget action result is malformed.");
                }
                if (receipt.request_artifact !== identity.artifact_id || receipt.request_seq !== identity.seq
                  || receipt.request_id !== action.request_id || receipt.action !== action.action) {
                  if (typeof receipt.request_seq !== "number" || receipt.request_seq > readCursor(storage, key, scope)) {
                    throw new Error("A different Home widget action still awaits its result delivery.");
                  }
                  storage.removeItem(pendingKey);
                  receipt = {};
                }
              } else receipt = {};
              if (!receipt.request_artifact && closure === "stopped") {
                receipt = { schema: "octopus.client_action_result", schema_version: 1,
                  observed_at: new Date().toISOString(), phase: "completed", ok: false,
                  request_artifact: identity.artifact_id, request_seq: identity.seq,
                  request_id: action.request_id, action: action.action, tool_call: row.tool_call,
                  error: "The request was stopped before this client action executed." };
              } else if (!receipt.request_artifact) {
                const base = { schema: "octopus.client_action_result", schema_version: 1,
                  observed_at: new Date().toISOString(),
                  request_artifact: identity.artifact_id, request_seq: identity.seq, request_id: action.request_id, action: action.action,
                  tool_call: row.tool_call };
                const prepared = JSON.stringify({ ...base, phase: "prepared" });
                storage.setItem(pendingKey, prepared);
                if (storage.getItem(pendingKey) !== prepared) throw new Error("Widget action preparation could not be saved.");
                try {
                  if (typeof row.expires_at_ms !== "number" || Date.now() >= row.expires_at_ms) {
                    throw new Error("This client control expired before execution. No action was performed.");
                  }
                  if (action.action === "open_file") {
                    if (!latest.current.openFile) throw new Error("File viewing is unavailable.");
                    const preparedFile = await prepareClientFile(action.path);
                    if (!current()) return;
                    if (Date.now() >= row.expires_at_ms) throw new Error("This file request expired before opening.");
                    latest.current.openFile(preparedFile.target);
                    receipt = { ...base, phase: "completed", ok: true, opened: preparedFile.opened };
                  } else if (action.action === "inspect_client") {
                    if (!latest.current.inspect) throw new Error("Client inspection is unavailable.");
                    receipt = { ...base, phase: "completed", ok: true, client: await latest.current.inspect(action) };
                  } else if (action.action === "relaunch_client") {
                    if (!latest.current.relaunch) throw new Error("Client relaunch is unavailable.");
                    receipt = { ...base, phase: "completed", ok: true, relaunch: {
                      status: "requested",
                      runtime: "The system keeps running while the client restarts; the operator signs in again.",
                    } };
                  } else {
                    if (!latest.current.widgets) throw new Error("Home widget controls are unavailable.");
                    const widgets = await latest.current.widgets(action, `widget_${identity.artifact_id.split(":")[1]}`);
                    receipt = { ...base, phase: "completed", ok: true, widgets };
                  }
                } catch (error) {
                  receipt = { ...base, phase: "completed", ok: false, error: error instanceof Error ? error.message : String(error) };
                }
                storage.setItem(pendingKey, JSON.stringify(receipt));
              } else if (receipt.phase === "prepared") {
                receipt = { ...receipt, phase: "completed", ok: false,
                  error: "The client stopped before this widget action saved its result. Its effect is unconfirmed; use a new list_widgets request to inspect current state before another change." };
                storage.setItem(pendingKey, JSON.stringify(receipt));
              }
              if (!current()) return;
              await submitInterfaceArtifact({ interfaceId: scope.interfaceId, runId: scope.runId,
                label: "client.action.result", payload: receipt, timeoutMs: 15_000 });
              relaunchReady = action.action === "relaunch_client" && receipt.ok === true && closure !== "stopped";
            }
            storage.setItem(key, JSON.stringify({
              schema_version: 1, home: scope.home, run_id: scope.runId, interface_id: scope.interfaceId,
              last_consumed: identity,
            }));
            if (readCursor(storage, key, scope) !== identity.seq) throw new Error("Client action cursor could not be saved.");
            if (relaunchReady && latest.current.relaunch) {
              await latest.current.relaunch();
              return;
            }
            try {
              if (!action || action.action !== "open_surface") continue;
              const surfaceId = action.surface_id;
              const surface = latest.current.surfaces.find((candidate) => candidate.id === surfaceId);
              if (!surface) throw new Error(`Surface ${surfaceId} is unavailable.`);
              latest.current.openSurface(surface);
            } catch (error) {
              refuse(error instanceof Error ? error.message : String(error));
            }
          }
          const nextSeq = readCursor(storage, key, scope);
          if (deliveries.length < PAGE_SIZE || nextSeq <= afterSeq) break;
          afterSeq = nextSeq;
        }
        lastFailure.current = "";
      } catch (error) {
        if (!current()) return;
        const reason = error instanceof Error ? error.message : String(error);
        const failure = JSON.stringify([scopeKey, reason]);
        if (lastFailure.current !== failure) refuse(reason);
        lastFailure.current = failure;
      }
    }
    let requested = false;
    let running = false;
    const request = () => {
      if (!current()) return;
      requested = true;
      if (running) return;
      running = true;
      const queued = (serial.current.get(scopeKey) ?? Promise.resolve()).then(async () => {
        while (current() && requested) {
          requested = false;
          await consume();
        }
      });
      serial.current.set(scopeKey, queued);
      void queued.finally(() => {
        running = false;
        if (serial.current.get(scopeKey) === queued) serial.current.delete(scopeKey);
        if (requested && current()) request();
      });
    };
    wake.current = request;
    request();
    return () => {
      cancelled = true;
      if (wake.current === request) wake.current = null;
    };
  }, [scopeKey]);

  useEffect(() => {
    wake.current?.();
  }, [generation, scopeKey]);
}
