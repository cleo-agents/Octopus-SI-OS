export type WidgetAction = { schema: "octopus.client_action"; schema_version: 1; request_id: string } & (
  { action: "list_widgets" }
  | { action: "set_widget"; changes: Array<{ widget_id: string; source_digest: string; state: "visible" | "hidden" | "removed" }> }
);
export function parseClientActionRequest(value: unknown): { action: ReturnType<typeof parseClientAction>; toolCall: { id: string; content: number[] } | null };
export type InspectClientAction = {
  schema: "octopus.client_action"; schema_version: 1; request_id: string; action: "inspect_client"; extension_id?: string;
  source?: { method: string; params?: Record<string, unknown>; path?: string };
};
export type RelaunchClientAction = { schema: "octopus.client_action"; schema_version: 1; request_id: string; action: "relaunch_client" };
export type OpenFileAction = { schema: "octopus.client_action"; schema_version: 1; request_id: string; action: "open_file"; path: string };
export type ClientResultAction = WidgetAction | InspectClientAction | RelaunchClientAction | OpenFileAction;
export type ClientAction = ClientResultAction | {
  schema: "octopus.client_action"; schema_version: 1; action: "open_surface"; surface_id: string;
};
export function parseClientAction(value: unknown): ClientAction;
