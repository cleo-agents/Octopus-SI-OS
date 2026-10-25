import documentSchema from "../../schemas/client_surface_document.schema.json";
import manifestSchema from "../../schemas/client_extension_manifest.schema.json";
import type { InspectClientAction } from "../../electron/clientActionSemantics.mjs";
import { CLIENT_SURFACE_DOCUMENT_LIMITS } from "../../electron/clientSurfaceDocumentSemantics.mjs";
import { clientCommands } from "../clientActions";
import { CLIENT_SURFACE_READ_METHODS, isClientSurfaceReadMethod, type ClientSurfaceReadMethod } from "../client-surfaces/sourceContract";
import { formatProjectionError, readProjection } from "../projectionClient";
import { readPath } from "../runtimeFormat";
import type { ClientSurfaceDescriptor } from "../shell/surfaceTypes";
import { clientSurfaceRuntimeIssues, type ClientSurfaceRuntimeIssue } from "./runtimeIssues";
import { readClientExtensions } from "./transport";
import { materializeClientExtensions } from "./useClientExtensions";
import { admitClientExtensionSource } from "./validation";
import type { ClientExtensionRecord, ClientExtensionStoreSnapshot } from "./types";

type JsonSchema = {
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  maxItems?: number;
  maxProperties?: number;
  $ref?: string;
  oneOf?: readonly JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};

type SourcePreview = {
  method: string;
  params: Record<string, unknown>;
  path?: string;
  ok: boolean;
  value?: unknown;
  truncated?: boolean;
  error?: string;
};

const PROJECTION_SOURCES: Record<ClientSurfaceReadMethod, { params: string; returns: string }> = {
  "projection.interface_artifacts.list": {
    params: "run_id, interface_id, labels (array of exact labels), after_seq, limit, order (\"newest\" returns the newest rows first)",
    returns: "{artifacts:[{artifact_id,label,seq,run_id,interface_id,movement_kind,created_at,payload}]}; payload is the admitted artifact body",
  },
  "projection.runs.list": {
    params: "limit, include_ledger",
    returns: "{runs:[run rows], invalid_run_records}",
  },
  "projection.marks.list": {
    params: "limit",
    returns: "{marks:[admitted mark rows]}",
  },
  "projection.movements.list": {
    params: "limit and the ledger index cursor/search parameters",
    returns: "{movements, total, next_seq}",
  },
  "projection.scheduled_interfaces.list": {
    params: "none",
    returns: "{scheduled_interfaces:[trigger rows with schedule, next_run_at_ms, last_run_at_ms]}",
  },
  "projection.worker_environments.list": {
    params: "limit",
    returns: "{worker_environments:[room rows]}",
  },
  "projection.interfaces.list": {
    params: "interface_type, limit",
    returns: "{interfaces:[descriptor rows]}",
  },
  "projection.artifacts.list": {
    params: "source (\"ledger\" or \"registry\"), label, previewable_only, limit",
    returns: "{artifacts, total, returned, truncated}",
  },
  "projection.envelopes.list": {
    params: "kind, limit",
    returns: "{envelopes:[envelope rows]}",
  },
};

const PREVIEW_ITEMS = 3;
const PREVIEW_TEXT = 400;
const PREVIEW_DEPTH = 6;
const PREVIEW_BYTES = 16 * 1024;

export async function inspectClient(
  action: InspectClientAction,
  surfaces: readonly ClientSurfaceDescriptor[],
): Promise<Record<string, unknown>> {
  const snapshot = await readClientExtensions();
  const sourcePreview = action.source ? await previewClientSurfaceSource(action.source) : undefined;
  return buildClientInventory({
    snapshot,
    surfaces,
    runtimeIssues: clientSurfaceRuntimeIssues(),
    extensionId: action.extension_id,
    sourcePreview,
  });
}

export function buildClientInventory(input: {
  snapshot: ClientExtensionStoreSnapshot;
  surfaces: readonly ClientSurfaceDescriptor[];
  runtimeIssues: readonly ClientSurfaceRuntimeIssue[];
  extensionId?: string;
  sourcePreview?: SourcePreview;
}): Record<string, unknown> {
  const { snapshot } = input;
  const materialized = materializeClientExtensions(snapshot, "live", "");
  const packagesRoot = snapshot.root ? `${snapshot.root}/packages` : "";
  const scoped = (id: string) => !input.extensionId || id === input.extensionId;
  const refused = snapshot.manifests.flatMap((source) => {
    const result = admitClientExtensionSource(source);
    const packageId = source.path.split(/[\\/]/g).at(-2) ?? "";
    if (result.admitted || !scoped(packageId)) return [];
    return [{
      extension_id: packageId,
      manifest_path: snapshot.root ? `${snapshot.root}/${source.path}` : source.path,
      source_digest: source.digest,
      modified_at: source.modifiedAt,
      issues: result.verdict.issues,
    }];
  });
  return {
    schema: "octopus.client_inventory",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    extensions_root: snapshot.root,
    packages_root: packagesRoot,
    package_layout: "<packages_root>/<extension id>/extension.json; the directory name equals the manifest id",
    contract: snapshot.contract
      ? { manifest: "octopus.client_extension@1", document: "octopus.client_surface@1", files: snapshot.contract.files }
      : null,
    review: "A new or changed package becomes pending; the owner reviews and installs its exact revision in the client. Every manifest edit is a new revision.",
    host: hostVocabulary(),
    surfaces: input.surfaces.map((surface) => ({ id: surface.id, label: surface.label, source: surface.source })),
    extensions: materialized.extensions.filter((record) => scoped(record.manifest.id))
      .map((record) => extensionRow(record, snapshot, input.runtimeIssues)),
    refused,
    runtime_issues: input.runtimeIssues.filter((issue) => !issue.extension_id && !input.extensionId),
    client_errors: input.extensionId ? [] : materialized.errors,
    ...(input.sourcePreview ? { source_preview: input.sourcePreview } : {}),
  };
}

export async function previewClientSurfaceSource(source: NonNullable<InspectClientAction["source"]>): Promise<SourcePreview> {
  const params = source.params ?? {};
  const base = { method: source.method, params, ...(source.path ? { path: source.path } : {}) };
  if (!isClientSurfaceReadMethod(source.method)) {
    return { ...base, ok: false, error: `projection method "${source.method}" is not available to client surfaces` };
  }
  try {
    const payload = await readProjection(source.method, params);
    const selected = source.path ? readPath(payload, source.path) : payload;
    const state = { truncated: false };
    const value = boundedPreview(selected, 0, state);
    if (JSON.stringify(value ?? null).length > PREVIEW_BYTES) {
      return { ...base, ok: true, truncated: true, value: "Preview exceeds 16 KiB; narrow params, limit or path." };
    }
    return { ...base, ok: true, value, truncated: state.truncated };
  } catch (error) {
    return { ...base, ok: false, error: formatProjectionError(error) };
  }
}

function extensionRow(
  record: ClientExtensionRecord,
  snapshot: ClientExtensionStoreSnapshot,
  runtimeIssues: readonly ClientSurfaceRuntimeIssue[],
): Record<string, unknown> {
  const contribution = record.manifest.contribution;
  const custom = contribution.kind === "surface";
  const surfaceDigest = record.surface?.sourceDigest ?? "";
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    category: record.manifest.category,
    origin: custom ? "custom" : "builtin",
    version: record.manifest.version,
    source_digest: record.sourceDigest,
    ...(custom && snapshot.root ? { manifest_path: `${snapshot.root}/${record.sourcePath}` } : {}),
    contribution: contribution.kind === "surface"
      ? { kind: "surface", document_id: contribution.document.id, target: contribution.document.target.kind }
      : contribution.kind === "builtin"
        ? { kind: "builtin", surface_id: contribution.surface_id }
        : contribution.kind === "builtin_input"
          ? { kind: "builtin_input", input_id: contribution.input_id, provider: { endpoint: contribution.provider.endpoint, model: contribution.provider.model } }
          : { kind: "builtin_action", action_id: contribution.action_id },
    admission: record.admission,
    installed: record.installed,
    configured: record.configured,
    unconfigured_sources: (record.manifest.sources ?? [])
      .filter((source) => source.required && !record.sourceConfiguration[source.id] && !record.credentials[source.id])
      .map((source) => source.id),
    lifecycle: { receipt: record.lifecycle.receiptState, desired: record.lifecycle.desiredState || null },
    runtime_issues: runtimeIssues.filter((issue) => issue.extension_id === record.manifest.id
      && (!surfaceDigest || issue.source_digest === surfaceDigest)),
  };
}

function hostVocabulary(): Record<string, unknown> {
  const defs = (documentSchema as { $defs: Record<string, JsonSchema> }).$defs;
  const manifestDefs = (manifestSchema as { $defs: Record<string, JsonSchema> }).$defs;
  const voiceWidget = defs.voiceTarget.properties ?? {};
  const layout = defs.voiceWidgetLayout.properties ?? {};
  const voiceWindow = defs.voiceWindowTarget.properties ?? {};
  const workspace = defs.workspaceTarget.properties ?? {};
  const chrome = workspace.chrome?.properties ?? {};
  const sandbox = defs.sandboxRender.properties ?? {};
  const filesystem = manifestDefs.filesystemSource;
  const filesystemFields = (filesystem as { allOf?: JsonSchema[] }).allOf?.[1]?.properties ?? {};
  const deviceFields = (manifestDefs.deviceSource as { allOf?: JsonSchema[] }).allOf?.[1]?.properties ?? {};
  const credentialFields = (manifestDefs.credentialSource as { allOf?: JsonSchema[] }).allOf?.[1]?.properties ?? {};
  return {
    file_viewer: { operation: "open_file", placement: "right", formats: "text files, including Markdown", path: "absolute path inside the client's admitted Files roots" },
    categories: {
      widget: { targets: ["voice.widget", "voice.window"], placement: "Home" },
      tab: { targets: ["workspace.surface"], placement: "workspace navigation and split panes" },
      repair: { custom: false, note: "Repairs are built-in client actions; custom packages contribute widgets or tabs." },
      input: { custom: false, note: "Inputs are built-in client controls that call a declared decision provider with the owner's credential." },
    },
    targets: {
      "voice.widget": {
        slot: voiceWidget.slot?.enum,
        order: range(voiceWidget.order),
        layout: Object.fromEntries(Object.entries(layout).map(([key, schema]) => [key, schema.enum ?? range(schema)])),
      },
      "voice.window": { slot: voiceWindow.slot?.enum, order: range(voiceWindow.order), size: voiceWindow.size?.enum },
      "workspace.surface": {
        placements: workspace.placements?.items?.enum,
        order: range(workspace.order),
        chrome: { topbar: chrome.topbar?.enum, workspace: chrome.workspace?.enum, titlebar_glyph: "optional glyph", search_placeholder: "optional text" },
      },
    },
    render: {
      native: {
        density: defs.nativeRender.properties?.density?.enum,
        nodes: (defs.node.oneOf ?? []).flatMap((entry) => {
          const name = entry.$ref?.split("/").at(-1) ?? "";
          const type = defs[name]?.properties?.type?.const;
          return typeof type === "string" ? [type] : [];
        }),
        bindings: "{path:\"data.x\" | \"sources.<source id>.<field>\", format?, fallback?}; collections take {path, limit}",
      },
      sandbox: {
        html_chars: sandbox.html?.maxLength,
        css_chars: sandbox.css?.maxLength,
        javascript_chars: sandbox.javascript?.maxLength,
        initial_height: range(sandbox.initial_height),
        actions: sandbox.actions?.maxProperties,
        runtime: "window.octopusSurface = {data, sources}; octopusSurface.invoke(actionId) requests a declared render.actions entry. No network, forms, frames, host DOM or bridges. Uncaught errors are reported as runtime issues.",
      },
    },
    glyphs: defs.glyph.enum,
    sources: {
      max: documentSchemaSourcesMax(),
      projection: CLIENT_SURFACE_READ_METHODS.map((method) => ({ method, ...PROJECTION_SOURCES[method] })),
      projection_refresh: "Projection sources re-read whenever the Home ledger or run records change.",
      host: {
        filesystem: {
          selection: filesystemFields.selection?.enum,
          read: filesystemFields.read?.enum,
          refresh_interval_ms: range(filesystemFields.refresh_interval_ms),
          configured_by: "the owner during Extension setup",
        },
        device: { device: deviceFields.device?.enum, configured_by: "the owner during Extension setup" },
        credential: {
          origin: credentialFields.origin?.pattern,
          check_path: credentialFields.check_path?.pattern,
          configured_by: "the owner during Extension setup; the value is sent only to the declared origin and is never readable by the client page or Home",
        },
      },
    },
    actions: {
      "client.command": { payload: "{command}", commands: clientCommands.map((command) => ({ id: command.id, label: command.label })) },
      "client.open-surface": { payload: "{surface_id}", surface_ids: "see surfaces" },
      boundary: "Actions are client presentation only. Anything that must reach a model or a run is an artifact through an interface, produced by the system side.",
    },
    limits: CLIENT_SURFACE_DOCUMENT_LIMITS,
  };
}

function documentSchemaSourcesMax(): number | undefined {
  return ((documentSchema as { properties: Record<string, JsonSchema> }).properties.sources as JsonSchema).maxItems;
}

function range(schema: JsonSchema | undefined): [number, number] | undefined {
  return schema && typeof schema.minimum === "number" && typeof schema.maximum === "number"
    ? [schema.minimum, schema.maximum]
    : undefined;
}

function boundedPreview(value: unknown, depth: number, state: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= PREVIEW_TEXT) return value;
    state.truncated = true;
    return `${value.slice(0, PREVIEW_TEXT)}…`;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= PREVIEW_DEPTH) {
    state.truncated = true;
    return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  }
  if (Array.isArray(value)) {
    if (value.length > PREVIEW_ITEMS) state.truncated = true;
    return value.slice(0, PREVIEW_ITEMS).map((item) => boundedPreview(item, depth + 1, state));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedPreview(item, depth + 1, state)]));
}
