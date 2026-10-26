import { useSyncExternalStore } from "react";
import type { OctopusClientAccessProfile } from "../electron";
import type { ClientSurfaceDescriptor } from "./surfaceTypes";

export type ClientWorkspaceKey = "dashboard" | "octopus-os";

export type ClientChatProject = {
  sourceFolders?: string[];
  id: string;
  name: string;
  icon: string;
  color: string;
  parentId: string;
  chatRunIds: string[];
  templateName?: string;
  runtimeStatus?: string;
  recordDigest?: string;
  allowedChildTemplateIds?: string[];
  readOnlyRunIds?: string[];
};

export type ClientTaskSortMode = "manual" | "recent" | "attention";

export type ClientRecentDestination = {
  key: string;
  workspaceKey: ClientWorkspaceKey;
  surfaceId: string;
  runId: string;
  openedAtMs: number;
};

export type ClientTaskOrganization = {
  aliases: Readonly<Record<string, string>>;
  collapsedSectionIds: readonly string[];
  readBaselineAtMs: number;
  readMarks: Readonly<Record<string, number>>;
  recentRunIds: readonly string[];
  recentDestinations: readonly ClientRecentDestination[];
  sortMode: ClientTaskSortMode;
};

export type ClientTaskAttentionState = "waiting" | "unread" | "active" | "idle";

export type ClientTaskAttentionRun = {
  runId: string;
  turnOpen: boolean;
  turnState: string;
  updatedAtMs: number;
};

const CLIENT_TASK_ATTENTION_ORDER: Readonly<Record<ClientTaskAttentionState, number>> = Object.freeze({
  waiting: 0,
  unread: 1,
  active: 2,
  idle: 3,
});

export const PINNED_TASKS_STORAGE_KEY = "octopus.shell.pinnedTasks.v2";
export const TASK_ORDER_STORAGE_KEY = "octopus.shell.taskOrder.v2";
export const PROJECT_FILTER_STORAGE_KEY = "octopus.shell.selectedProject.v2";
export const TASK_ORGANIZATION_STORAGE_KEY = "octopus.shell.taskOrganization.v2";
export const DASHBOARD_PINNED_SURFACES_STORAGE_KEY = "octopus.dashboard.pinnedSurfaces.v1";
const PROJECTS_STORAGE_KEY = "octopus.shell.projects.v4";

const TASK_ORGANIZATION_CHANGED_EVENT = "octopus:task-organization-changed";
const CHAT_PROJECTS_CHANGED_EVENT = "octopus:chat-projects-changed";
const EMPTY_TASK_ORGANIZATION: ClientTaskOrganization = Object.freeze({
  aliases: Object.freeze({}),
  collapsedSectionIds: Object.freeze([]),
  readBaselineAtMs: 0,
  readMarks: Object.freeze({}),
  recentRunIds: Object.freeze([]),
  recentDestinations: Object.freeze([]),
  sortMode: "attention",
});

type TaskOrganizationStore = {
  profile: OctopusClientAccessProfile;
  current: ClientTaskOrganization;
  subscribers: Set<() => void>;
};

const taskOrganizationStores = new Map<OctopusClientAccessProfile, TaskOrganizationStore>();
let taskOrganizationStorageListenerReady = false;

export const fixedDashboardSurfaceIds = [
  "dashboard",
  "registry",
  "event-log",
  "worker-environments",
] as const;

const FIXED_DASHBOARD_SURFACE_IDS = new Set<string>(fixedDashboardSurfaceIds);

export function isFixedDashboardSurfaceId(surfaceId: string): boolean {
  return FIXED_DASHBOARD_SURFACE_IDS.has(surfaceId);
}

export function profileStorageKey(
  storageKey: string,
  profile: OctopusClientAccessProfile,
): string {
  return profile === "live" ? storageKey : `${storageKey}.test`;
}

export function parseClientWorkspaceKey(value: string | null | undefined): ClientWorkspaceKey | null {
  return value === "dashboard" || value === "octopus-os" ? value : null;
}

export function surfaceBelongsToWorkspace(
  surface: Pick<ClientSurfaceDescriptor, "placements">,
  workspaceKey: ClientWorkspaceKey,
): boolean {
  return surface.placements.includes(workspaceKey === "dashboard" ? "shell" : "home");
}

export function workspaceForSurface(
  surface: Pick<ClientSurfaceDescriptor, "placements">,
  fallback: ClientWorkspaceKey = "octopus-os",
): ClientWorkspaceKey {
  if (surface.placements.includes("home")) return "octopus-os";
  if (surface.placements.includes("shell")) return "dashboard";
  return fallback;
}

function octopusOsSurface(surfaceId: string): string {
  return ["voice", "chat", "scheduled", "inbox", "applications", "drivers"].includes(surfaceId) ? surfaceId : "";
}

export function readStoredStringList(
  storageKey: string,
  profile: OctopusClientAccessProfile,
  fallback: readonly string[] = [],
): string[] {
  const raw = window.localStorage.getItem(profileStorageKey(storageKey, profile));
  if (!raw) return [...fallback];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [...fallback];
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  } catch {
    return [...fallback];
  }
}

export function saveStoredStringList(
  storageKey: string,
  values: readonly string[],
  profile: OctopusClientAccessProfile,
): void {
  window.localStorage.setItem(profileStorageKey(storageKey, profile), JSON.stringify([...new Set(values)]));
}

const LAB_SEED_PROJECTS: readonly ClientChatProject[] = Object.freeze([
  {
    id: "lab_project_lumen",
    name: "Lumen",
    icon: "code",
    color: "violet",
    parentId: "",
    chatRunIds: ["lab_run_2", "lab_run_3", "lab_run_6", "lab_run_7", "lab_run_8"],
  },
  {
    id: "lab_project_research",
    name: "Research",
    icon: "globe",
    color: "teal",
    parentId: "",
    chatRunIds: ["lab_run_5"],
  },
  {
    id: "lab_project_operations",
    name: "Operations",
    icon: "briefcase",
    color: "orange",
    parentId: "",
    chatRunIds: ["lab_run_4"],
  },
]);

const LAB_SEED_PINNED_CHAT_IDS: readonly string[] = Object.freeze(["lab_run_2", "lab_run_5"]);

const LAB_SEED_MARKER_STORAGE_KEY = "octopus.shell.labSeeds.v3";

export function defaultClientChatProjects(profile: OctopusClientAccessProfile): ClientChatProject[] {
  return profile === "lab" ? LAB_SEED_PROJECTS.map((project) => ({ ...project, chatRunIds: [...project.chatRunIds] })) : [];
}

export function defaultPinnedTaskIds(profile: OctopusClientAccessProfile): string[] {
  return profile === "lab" ? [...LAB_SEED_PINNED_CHAT_IDS] : [];
}

export function ensureLabSidebarSeeds(profile: OctopusClientAccessProfile): void {
  if (profile !== "lab" || typeof window === "undefined") return;
  const markerKey = profileStorageKey(LAB_SEED_MARKER_STORAGE_KEY, profile);
  if (window.localStorage.getItem(markerKey)) return;
  window.localStorage.removeItem(profileStorageKey(TASK_ORDER_STORAGE_KEY, profile));
  window.localStorage.removeItem(profileStorageKey(TASK_ORGANIZATION_STORAGE_KEY, profile));
  saveClientChatProjects(defaultClientChatProjects(profile), profile);
  saveStoredStringList(PINNED_TASKS_STORAGE_KEY, defaultPinnedTaskIds(profile), profile);
  saveClientProjectFilterEeId(profile, LAB_SEED_PROJECTS[0].id);
  window.localStorage.setItem(markerKey, new Date().toISOString());
}

export function readClientChatProjects(profile: OctopusClientAccessProfile): ClientChatProject[] {
  const raw = window.localStorage.getItem(profileStorageKey(PROJECTS_STORAGE_KEY, profile));
  if (raw == null) return defaultClientChatProjects(profile);
  try {
    const value: unknown = JSON.parse(raw);
    return normalizeClientChatProjects(value, []);
  } catch {
    return [];
  }
}

export function hasStoredClientChatProjects(profile: OctopusClientAccessProfile): boolean {
  return window.localStorage.getItem(profileStorageKey(PROJECTS_STORAGE_KEY, profile)) != null;
}

export function readClientProjectFilterEeId(profile: OctopusClientAccessProfile): string {
  const raw = window.localStorage.getItem(profileStorageKey(PROJECT_FILTER_STORAGE_KEY, profile));
  if (raw == null) return profile === "lab" ? LAB_SEED_PROJECTS[0].id : "";
  return raw.trim();
}

export function saveClientProjectFilterEeId(profile: OctopusClientAccessProfile, projectId: string): void {
  window.localStorage.setItem(profileStorageKey(PROJECT_FILTER_STORAGE_KEY, profile), projectId.trim());
}

export function flattenClientChatProjects(
  projects: readonly ClientChatProject[],
): Array<{ project: ClientChatProject; depth: number }> {
  const knownIds = new Set(projects.map((project) => project.id));
  const childrenByParent = new Map<string, ClientChatProject[]>();
  for (const project of projects) {
    const parentId = knownIds.has(project.parentId) ? project.parentId : "";
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(project);
    childrenByParent.set(parentId, siblings);
  }
  const rows: Array<{ project: ClientChatProject; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (parentId: string, depth: number) => {
    for (const project of childrenByParent.get(parentId) ?? []) {
      if (visited.has(project.id)) continue;
      visited.add(project.id);
      rows.push({ project, depth });
      visit(project.id, depth + 1);
    }
  };
  visit("", 0);
  for (const project of projects) {
    if (visited.has(project.id)) continue;
    visited.add(project.id);
    rows.push({ project, depth: 0 });
  }
  return rows;
}

export function clientProjectScopeIds(
  projects: readonly ClientChatProject[],
  projectId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentId) continue;
    const siblings = childrenByParent.get(project.parentId) ?? [];
    siblings.push(project.id);
    childrenByParent.set(project.parentId, siblings);
  }
  const scope = new Set<string>();
  const visit = (id: string) => {
    if (scope.has(id)) return;
    scope.add(id);
    for (const childId of childrenByParent.get(id) ?? []) visit(childId);
  };
  if (projectId) visit(projectId);
  return scope;
}

export function saveClientChatProjects(
  projects: readonly ClientChatProject[],
  profile: OctopusClientAccessProfile,
): void {
  const stored = projects.map((project) => ({
    id: project.id,
    name: project.name,
    icon: project.icon,
    color: project.color,
    parentId: profile === "lab" ? project.parentId : "",
    chatRunIds: profile === "lab" ? project.chatRunIds : [],
  }));
  const key = profileStorageKey(PROJECTS_STORAGE_KEY, profile);
  const serialized = JSON.stringify(stored);
  if (window.localStorage.getItem(key) === serialized) return;
  window.localStorage.setItem(key, serialized);
  window.dispatchEvent(new CustomEvent(CHAT_PROJECTS_CHANGED_EVENT, { detail: { profile } }));
}

export function subscribeClientChatProjects(
  profile: OctopusClientAccessProfile,
  onChange: () => void,
): () => void {
  const storageKey = profileStorageKey(PROJECTS_STORAGE_KEY, profile);
  const onProjectChange = (event: Event) => {
    if ((event as CustomEvent<{ profile?: unknown }>).detail?.profile === profile) onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && event.key === storageKey) onChange();
  };
  window.addEventListener(CHAT_PROJECTS_CHANGED_EVENT, onProjectChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHAT_PROJECTS_CHANGED_EVENT, onProjectChange);
    window.removeEventListener("storage", onStorage);
  };
}

function normalizeClientChatProjects(value: unknown, fallback: ClientChatProject[]): ClientChatProject[] {
  if (!Array.isArray(value)) return fallback;
  const projectIds = new Set<string>();
  const assignedChatIds = new Set<string>();
  const projects: ClientChatProject[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!id || !name || projectIds.has(id)) continue;
    projectIds.add(id);
    const chatRunIds = Array.isArray(row.chatRunIds)
      ? row.chatRunIds.filter((chatRunId): chatRunId is string => {
          if (typeof chatRunId !== "string" || !chatRunId.trim() || assignedChatIds.has(chatRunId)) return false;
          assignedChatIds.add(chatRunId);
          return true;
        })
      : [];
    projects.push({
      id,
      name,
      icon: typeof row.icon === "string" ? row.icon.trim() : "",
      color: typeof row.color === "string" ? row.color.trim() : "",
      parentId: typeof row.parentId === "string" && row.parentId.trim() !== id ? row.parentId.trim() : "",
      chatRunIds,
    });
  }
  const knownIds = new Set(projects.map((project) => project.id));
  return projects.map((project) => (
    knownIds.has(project.parentId) ? project : { ...project, parentId: "" }
  ));
}

export function useClientTaskOrganization(
  profile: OctopusClientAccessProfile,
): ClientTaskOrganization {
  const store = taskOrganizationStore(profile);
  return useSyncExternalStore(
    (subscriber) => subscribeTaskOrganization(store, subscriber),
    () => store.current,
    () => EMPTY_TASK_ORGANIZATION,
  );
}

export function updateClientTaskOrganization(
  profile: OctopusClientAccessProfile,
  update: (current: ClientTaskOrganization) => ClientTaskOrganization,
): ClientTaskOrganization {
  const store = taskOrganizationStore(profile);
  const next = normalizeTaskOrganization(update(store.current));
  window.localStorage.setItem(
    profileStorageKey(TASK_ORGANIZATION_STORAGE_KEY, profile),
    JSON.stringify(next),
  );
  store.current = next;
  emitTaskOrganization(store);
  window.dispatchEvent(new CustomEvent(TASK_ORGANIZATION_CHANGED_EVENT, { detail: { profile } }));
  return next;
}

export function clientTaskTitle(
  runId: string,
  projectedTitle: string,
  organization: ClientTaskOrganization,
): string {
  return organization.aliases[runId] || (projectedTitle && projectedTitle !== runId ? projectedTitle : "Untitled task");
}

export function renameClientTask(
  profile: OctopusClientAccessProfile,
  runId: string,
  title: string,
): ClientTaskOrganization {
  const normalizedTitle = title.trim().slice(0, 180);
  if (!runId || !normalizedTitle) throw new Error("A projected run and a non-empty task title are required.");
  return updateClientTaskOrganization(profile, (current) => ({
    ...current,
    aliases: { ...current.aliases, [runId]: normalizedTitle },
  }));
}

export function clearClientTaskAlias(
  profile: OctopusClientAccessProfile,
  runId: string,
): ClientTaskOrganization {
  return updateClientTaskOrganization(profile, (current) => {
    const aliases = { ...current.aliases };
    delete aliases[runId];
    return { ...current, aliases };
  });
}

export function restoreClientTaskAliasIfAbsent(
  profile: OctopusClientAccessProfile,
  runId: string,
  title: string,
): ClientTaskOrganization {
  const normalizedTitle = title.trim().slice(0, 180);
  if (!runId || !normalizedTitle) throw new Error("A projected run and a non-empty task title are required.");
  return updateClientTaskOrganization(profile, (current) => current.aliases[runId]
    ? current
    : { ...current, aliases: { ...current.aliases, [runId]: normalizedTitle } });
}

export function removeClientTaskPresentation(
  profile: OctopusClientAccessProfile,
  runId: string,
): ClientTaskOrganization {
  if (!runId) throw new Error("A projected run is required.");
  return updateClientTaskOrganization(profile, (current) => {
    const aliases = { ...current.aliases };
    delete aliases[runId];
    const readMarks = { ...current.readMarks };
    delete readMarks[runId];
    return {
      ...current,
      aliases,
      readMarks,
      recentRunIds: current.recentRunIds.filter((id) => id !== runId),
      recentDestinations: current.recentDestinations.filter((destination) => destination.runId !== runId),
    };
  });
}

export function recordClientTaskOpened(
  profile: OctopusClientAccessProfile,
  runId: string,
): ClientTaskOrganization {
  if (!runId) return taskOrganizationStore(profile).current;
  return updateClientTaskOrganization(profile, (current) => ({
    ...current,
    recentRunIds: [runId, ...current.recentRunIds.filter((id) => id !== runId)].slice(0, 40),
  }));
}

export function ensureClientTaskReadBaseline(
  profile: OctopusClientAccessProfile,
): ClientTaskOrganization {
  const store = taskOrganizationStore(profile);
  if (store.current.readBaselineAtMs) return store.current;
  return updateClientTaskOrganization(profile, (current) => (
    current.readBaselineAtMs ? current : { ...current, readBaselineAtMs: Date.now() }
  ));
}

export function recordClientTaskRead(
  profile: OctopusClientAccessProfile,
  runId: string,
  updatedAtMs: number,
): ClientTaskOrganization {
  const store = taskOrganizationStore(profile);
  const seen = Number.isFinite(updatedAtMs) ? Math.max(0, Math.round(updatedAtMs)) : 0;
  if (!runId || !seen || (store.current.readMarks[runId] ?? 0) >= seen) return store.current;
  return updateClientTaskOrganization(profile, (current) => ({
    ...current,
    readMarks: { ...current.readMarks, [runId]: seen },
  }));
}

export function clientTaskUnread(
  run: ClientTaskAttentionRun,
  organization: ClientTaskOrganization,
): boolean {
  if (!organization.readBaselineAtMs) return false;
  return run.updatedAtMs > (organization.readMarks[run.runId] ?? organization.readBaselineAtMs);
}

export function clientTaskNeedsOperator(
  run: ClientTaskAttentionRun,
  organization: ClientTaskOrganization,
): boolean {
  if (run.turnState !== "waiting" && run.turnState !== "failed") return false;
  return clientTaskUnread(run, organization);
}

export function clientTaskAttentionState(
  run: ClientTaskAttentionRun,
  organization: ClientTaskOrganization,
): ClientTaskAttentionState {
  if (clientTaskNeedsOperator(run, organization)) return "waiting";
  if (clientTaskUnread(run, organization)) return "unread";
  if (run.turnState === "working" || run.turnOpen) return "active";
  return "idle";
}

export function clientTaskAttentionRank(state: ClientTaskAttentionState): number {
  return CLIENT_TASK_ATTENTION_ORDER[state];
}

export function recordClientDestination(
  profile: OctopusClientAccessProfile,
  destination: Omit<ClientRecentDestination, "key" | "openedAtMs">,
): ClientTaskOrganization {
  const surfaceId = destination.surfaceId.trim();
  const runId = destination.runId.trim();
  if (!surfaceId) throw new Error("A client destination requires a surface id.");
  const key = `${destination.workspaceKey}:${surfaceId}:${runId}`;
  const row: ClientRecentDestination = {
    key,
    workspaceKey: destination.workspaceKey,
    surfaceId,
    runId,
    openedAtMs: Date.now(),
  };
  return updateClientTaskOrganization(profile, (current) => ({
    ...current,
    recentDestinations: [
      row,
      ...current.recentDestinations.filter((candidate) => candidate.key !== key),
    ].slice(0, 24),
    recentRunIds: runId
      ? [runId, ...current.recentRunIds.filter((id) => id !== runId)].slice(0, 40)
      : current.recentRunIds,
  }));
}

export function setClientTaskSortMode(
  profile: OctopusClientAccessProfile,
  sortMode: ClientTaskSortMode,
): ClientTaskOrganization {
  return updateClientTaskOrganization(profile, (current) => ({ ...current, sortMode }));
}

export function setClientSidebarSectionCollapsed(
  profile: OctopusClientAccessProfile,
  sectionId: string,
  collapsed: boolean,
): ClientTaskOrganization {
  const id = sectionId.trim();
  if (!id) throw new Error("A sidebar section id is required.");
  return updateClientTaskOrganization(profile, (current) => ({
    ...current,
    collapsedSectionIds: collapsed
      ? [...current.collapsedSectionIds.filter((candidate) => candidate !== id), id]
      : current.collapsedSectionIds.filter((candidate) => candidate !== id),
  }));
}

export function clientHomeRunId(
  runs: ReadonlyArray<{ runId: string; eeId: string; clientSurfaceRole: "home" | "task"; osRootEeId: string; archived: boolean }>,
): string {
  const candidates = runs.filter((run) => (
    run.clientSurfaceRole === "home"
    && !run.archived
    && Boolean(run.osRootEeId)
    && run.eeId === run.osRootEeId
  ));
  return candidates.length === 1 ? candidates[0].runId : "";
}

export function clientOsRootEeId(
  runs: ReadonlyArray<{ osRootEeId: string }>,
): string {
  const roots = [...new Set(runs.map((run) => run.osRootEeId.trim()).filter(Boolean))];
  return roots.length === 1 ? roots[0] : "";
}

function taskOrganizationStore(profile: OctopusClientAccessProfile): TaskOrganizationStore {
  ensureTaskOrganizationStorageListener();
  const existing = taskOrganizationStores.get(profile);
  if (existing) return existing;
  const created: TaskOrganizationStore = {
    profile,
    current: readClientTaskOrganization(profile),
    subscribers: new Set(),
  };
  taskOrganizationStores.set(profile, created);
  return created;
}

function subscribeTaskOrganization(
  store: TaskOrganizationStore,
  subscriber: () => void,
): () => void {
  store.subscribers.add(subscriber);
  return () => {
    store.subscribers.delete(subscriber);
  };
}

function emitTaskOrganization(store: TaskOrganizationStore): void {
  for (const subscriber of [...store.subscribers]) subscriber();
}

function ensureTaskOrganizationStorageListener(): void {
  if (taskOrganizationStorageListenerReady || typeof window === "undefined") return;
  taskOrganizationStorageListenerReady = true;
  window.addEventListener("storage", (event) => {
    for (const store of taskOrganizationStores.values()) {
      if (event.key !== profileStorageKey(TASK_ORGANIZATION_STORAGE_KEY, store.profile)) continue;
      store.current = readClientTaskOrganization(store.profile);
      emitTaskOrganization(store);
    }
  });
  window.addEventListener(TASK_ORGANIZATION_CHANGED_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const profile = event.detail?.profile;
    if (profile !== "live" && profile !== "lab") return;
    const store = taskOrganizationStores.get(profile);
    if (!store) return;
    const fromDisk = readClientTaskOrganization(profile);
    if (JSON.stringify(fromDisk) === JSON.stringify(store.current)) return;
    store.current = fromDisk;
    emitTaskOrganization(store);
  });
}

function readClientTaskOrganization(
  profile: OctopusClientAccessProfile,
): ClientTaskOrganization {
  if (typeof window === "undefined") return EMPTY_TASK_ORGANIZATION;
  const raw = window.localStorage.getItem(profileStorageKey(TASK_ORGANIZATION_STORAGE_KEY, profile));
  if (!raw) return EMPTY_TASK_ORGANIZATION;
  try {
    return normalizeTaskOrganization(JSON.parse(raw));
  } catch {
    return EMPTY_TASK_ORGANIZATION;
  }
}

function normalizeTaskOrganization(value: unknown): ClientTaskOrganization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_TASK_ORGANIZATION;
  const row = value as Partial<ClientTaskOrganization>;
  const aliases = Object.fromEntries(Object.entries(
    row.aliases && typeof row.aliases === "object" && !Array.isArray(row.aliases)
      ? row.aliases
      : {},
  ).flatMap(([runId, title]) => {
    const normalizedRunId = runId.trim();
    const normalizedTitle = typeof title === "string" ? title.trim().slice(0, 180) : "";
    return normalizedRunId && normalizedTitle ? [[normalizedRunId, normalizedTitle]] : [];
  }).slice(0, 500));
  const sortMode: ClientTaskSortMode = row.sortMode === "recent" || row.sortMode === "manual"
    ? row.sortMode
    : "attention";
  const readMarks = Object.fromEntries(Object.entries(
    row.readMarks && typeof row.readMarks === "object" && !Array.isArray(row.readMarks)
      ? row.readMarks
      : {},
  ).flatMap(([runId, mark]) => {
    const normalizedRunId = runId.trim();
    const normalizedMark = typeof mark === "number" && Number.isFinite(mark) ? Math.max(0, Math.round(mark)) : 0;
    return normalizedRunId && normalizedMark ? [[normalizedRunId, normalizedMark]] : [];
  }).slice(0, 500));
  return Object.freeze({
    aliases: Object.freeze(aliases),
    collapsedSectionIds: Object.freeze(normalizeStringList(row.collapsedSectionIds).slice(0, 100)),
    readBaselineAtMs: typeof row.readBaselineAtMs === "number" && Number.isFinite(row.readBaselineAtMs)
      ? Math.max(0, Math.round(row.readBaselineAtMs))
      : 0,
    readMarks: Object.freeze(readMarks),
    recentRunIds: Object.freeze(normalizeStringList(row.recentRunIds).slice(0, 40)),
    recentDestinations: Object.freeze(normalizeRecentDestinations(row.recentDestinations)),
    sortMode,
  });
}

function normalizeRecentDestinations(value: unknown): ClientRecentDestination[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const row = candidate as Partial<ClientRecentDestination>;
    const rawWorkspaceKey = (candidate as Record<string, unknown>).workspaceKey;
    const workspaceKey = rawWorkspaceKey === "os" ? "dashboard"
      : rawWorkspaceKey === "agent-1" ? "octopus-os"
        : parseClientWorkspaceKey(typeof rawWorkspaceKey === "string" ? rawWorkspaceKey : undefined)
          ?? (octopusOsSurface(String(row.surfaceId ?? "")) ? "octopus-os" : "dashboard");
    const surfaceId = typeof row.surfaceId === "string" ? row.surfaceId.trim() : "";
    const runId = typeof row.runId === "string" ? row.runId.trim() : "";
    const openedAtMs = typeof row.openedAtMs === "number" && Number.isFinite(row.openedAtMs)
      ? Math.max(0, Math.round(row.openedAtMs))
      : 0;
    if (!surfaceId || !openedAtMs) return [];
    const key = `${workspaceKey}:${surfaceId}:${runId}`;
    if (keys.has(key)) return [];
    keys.add(key);
    return [{ key, workspaceKey, surfaceId, runId, openedAtMs }];
  }).slice(0, 24);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const normalized = item.trim();
    return normalized ? [normalized] : [];
  }))];
}
