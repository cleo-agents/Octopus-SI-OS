export function parseClientActionRequest(value) {
  if (value?.schema !== "octopus.client_action_request") {
    const action = parseClientAction(value);
    if (action.action !== "open_surface") throw new Error("Client controls require a correlated tool request.");
    return { action, toolCall: null };
  }
  const ref = value.tool_call;
  if (Object.keys(value).length !== 4 || value.schema_version !== 1 || !ref || Object.keys(ref).length !== 2
    || typeof ref.id !== "string" || !/^tool\.call:[a-f0-9]{64}$/.test(ref.id)
    || !Array.isArray(ref.content) || ref.content.length !== 32
    || ref.content.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Client control request has an invalid tool call identity.");
  }
  const action = parseClientAction(value.action);
  if (action.action === "open_surface") throw new Error("Navigation does not declare a result wait.");
  return { action, toolCall: ref };
}

export function parseClientAction(value) {
  const object = value && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
  if (!object || value.schema !== "octopus.client_action" || value.schema_version !== 1) {
    throw new Error("Client action requires exact octopus.client_action v1 data.");
  }
  if (value.action === "open_surface" && Object.keys(value).length === 4 && text(value.surface_id)) return value;
  if (value.action === "open_file" && Object.keys(value).length === 5 && text(value.request_id)
    && typeof value.path === "string" && value.path.length <= 4096 && value.path.trim() === value.path
    && /^(?:\/|[A-Za-z]:[\\/])/.test(value.path) && !/[\u0000-\u001f\u007f]/.test(value.path)
    && !value.path.split(/[\\/]/).some(part => part === "." || part === "..")) return value;
  if (value.action === "list_widgets" && Object.keys(value).length === 4 && text(value.request_id)) return value;
  if (value.action === "set_widget" && Object.keys(value).length === 5 && text(value.request_id) && widgetChanges(value.changes, text)) return value;
  if (value.action === "inspect_client" && text(value.request_id) && inspectionScope(value)) return value;
  if (value.action === "relaunch_client" && Object.keys(value).length === 4 && text(value.request_id)) return value;
  throw new Error("Client action must be an exact open_surface, open_file, list_widgets, set_widget, inspect_client or relaunch_client request.");
}

function inspectionScope(value) {
  const record = candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate);
  if (Object.keys(value).some(key => !["schema", "schema_version", "action", "request_id", "extension_id", "source"].includes(key))) return false;
  if (Object.hasOwn(value, "extension_id") && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(String(value.extension_id))) return false;
  if (!Object.hasOwn(value, "source")) return true;
  const source = value.source;
  if (!record(source) || Object.keys(source).some(key => !["method", "params", "path"].includes(key))) return false;
  if (typeof source.method !== "string" || !/^projection\.[a-z0-9_.]{1,96}$/.test(source.method)) return false;
  if (Object.hasOwn(source, "params") && (!record(source.params) || JSON.stringify(source.params).length > 16_384)) return false;
  return !Object.hasOwn(source, "path") || typeof source.path === "string" && source.path.length > 0 && source.path.length <= 256;
}

function widgetChanges(changes, text) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 32) return false;
  const widgets = new Set();
  for (const change of changes) {
    if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).length !== 3) return false;
    if (!text(change.widget_id) || !text(change.source_digest) || !["visible", "hidden", "removed"].includes(change.state)) return false;
    if (widgets.has(change.widget_id)) return false;
    widgets.add(change.widget_id);
  }
  return true;
}
