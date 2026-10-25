import { OcLoadingRows, OcLoadingText } from "../../design-system/LoadingSkeleton";
import { motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  OctopusClientAccessProfile,
  OctopusOsFile,
  OctopusOsFileEntry,
  OctopusOsFileRoot,
  OctopusOsFileSystemAction,
} from "../../electron";
import { OcButton, OcIconButton, OcMenuItem } from "../../design-system/components";
import { OcDropdown } from "../../design-system/OcDropdown";
import { copyText } from "../../runtimeFormat";
import { appToast } from "../../toasts";
import { clientDialogOwnsCommands } from "../../keyboardShortcuts";
import { ArtifactPreview } from "../artifacts/ArtifactPreview";
import {
  openArtifactFile,
  resolveArtifactFilePreview,
  safeArtifactFilename,
  type ResolvedArtifactFilePreview,
} from "../artifacts/artifactFileOperations";
import { Glyph } from "../IconGlyphs";
import { OctopusSpinner } from "../navigation/OctopusSpinner";
import { OctopusFileTree, OctopusFilterField, OctopusPanelNote, octopusTreeAncestors } from "../OctopusSurface";
import { SetupDialogShell } from "../SetupDialogShell";
import { PanelResizeHandle, useAnimatedPanelSize } from "../shell/PanelResizeHandle";
import { FilesCodeEditor } from "./FilesCodeEditor";
import { FilesBreadcrumb } from "./FilesBreadcrumb";
import type { FilesOpenTarget } from "./types";
import { resolveFileTarget } from "./fileTarget";
import { ensureFilesPane, hasFilesPane, readFilesPane, registerFilesPaneFlush, saveFilesPane, subscribeFilesPane, updateFilesPane } from "./filesPaneLifecycle";
import { filesRootMatches, type FilesEditorViewState, type FilesPaneSnapshot } from "./filesPaneSnapshot";
import "../artifacts/artifact-workbench.css";
import "./files.css";

type DirectoryCache = Record<string, OctopusOsFileEntry[]>;
type ArtifactResolutionState = {
  error: string;
  loading: boolean;
  preview: ResolvedArtifactFilePreview | null;
  targetKey: string;
};
type ArtifactTextState =
  | { status: "ready"; text: string }
  | { status: "too-large" }
  | { status: "unreadable" };

const FILE_TREE_DEFAULT_WIDTH = 250;
const FILE_TREE_MINIMUM_WIDTH = 200;
const FILE_TREE_WIDTH_KEY = "octopus.files.treeWidth";
const FILES_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function FilesView({ accessProfile, active, paneKey, snapshot: initialSnapshot, target }: {
  accessProfile: OctopusClientAccessProfile;
  active: boolean;
  paneKey: string;
  snapshot?: FilesPaneSnapshot;
  target?: FilesOpenTarget;
}) {
  ensureFilesPane(paneKey, target, initialSnapshot);
  const subscribe = useCallback((listener: () => void) => subscribeFilesPane(paneKey, listener), [paneKey]);
  const getState = useCallback(() => readFilesPane(paneKey), [paneKey]);
  const paneState = useSyncExternalStore(subscribe, getState);
  const { snapshot: paneSnapshot, saving } = paneState;
  const locked = paneState.transferPending || paneState.nativeClosePending;
  const { target: activeTarget, rootId, file, draft } = paneSnapshot;
  const hydratedTargetRef = useRef(filesOpenTargetKey(activeTarget));
  const setActiveTarget = (target: FilesOpenTarget | undefined) => updateFilesPane(paneKey, (current) => ({ ...current, target }));
  const pendingExternalTargetRef = useRef<{ key: string; target: FilesOpenTarget | undefined } | null>(null);
  const externalTargetPromptRef = useRef(false);
  const incomingTargetKey = filesOpenTargetKey(target);
  const activeTargetKey = filesOpenTargetKey(activeTarget);
  const artifactTarget = activeTarget?.kind === "artifact" ? activeTarget : null;
  const artifactTargetKey = artifactTarget
    ? JSON.stringify([artifactTarget.artifactId, artifactTarget.runId, artifactTarget.interfaceId])
    : "";
  const [roots, setRoots] = useState<OctopusOsFileRoot[]>([]);
  const [directories, setDirectories] = useState<DirectoryCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState("");
  const [query, setQuery] = useState("");
  const setFile = useCallback((file: OctopusOsFile | null) => updateFilesPane(paneKey, (current) => ({ ...current, file, draft: file?.text ?? "", view: { scrollTop: 0, scrollLeft: 0 } })), [paneKey]);
  const setDraft = useCallback((draft: string) => updateFilesPane(paneKey, (current) => current.draft === draft ? current : { ...current, draft }), [paneKey]);
  const [fileLoading, setFileLoadingState] = useState(false);
  const fileLoadingRef = useRef(false);
  const setFileLoading = (loading: boolean) => { fileLoadingRef.current = loading; setFileLoadingState(loading); };
  const [fileError, setFileError] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [treeWidth, setTreeWidth] = useState(readFileTreeWidth);
  const [treeMaximum, setTreeMaximum] = useState(Number.MAX_SAFE_INTEGER);
  const [treeResizing, setTreeResizing] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [rootMenuOpen, setRootMenuOpen] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState("");
  const [artifactResolution, setArtifactResolution] = useState<ArtifactResolutionState>({ error: "", loading: false, preview: null, targetKey: "" });
  const [artifactRefreshGeneration, setArtifactRefreshGeneration] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const rootMenuRef = useRef<HTMLButtonElement>(null);
  const discardContinuationRef = useRef<(() => void) | null>(null);
  const fileRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const activeRootRef = useRef(rootId);
  activeRootRef.current = rootId;
  const artifactResolutionCurrent = artifactResolution.targetKey === artifactTargetKey;
  const activeArtifactPreview = artifactResolutionCurrent ? artifactResolution.preview : null;
  const artifactLoading = Boolean(artifactTarget && (!artifactResolutionCurrent || artifactResolution.loading));
  const artifactError = artifactResolutionCurrent ? artifactResolution.error : "";
  const artifactTextState = useMemo(
    () => activeArtifactPreview ? readableArtifactText(activeArtifactPreview.file) : null,
    [activeArtifactPreview],
  );
  const artifactText = artifactTextState?.status === "ready" ? artifactTextState.text : null;
  const constrainedTreeWidth = Math.min(Math.max(treeWidth, FILE_TREE_MINIMUM_WIDTH), treeMaximum);
  const treeMotion = useAnimatedPanelSize(treeOpen, constrainedTreeWidth);

  const dirty = Boolean(file && file.kind === "text" && draft !== file.text);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchActive = normalizedQuery.length > 0;
  const selectedRoot = roots.find((root) => root.id === rootId) ?? null;
  const currentCopyPath = artifactTarget
    ? ""
    : file ? absoluteDisplayPath(paneSnapshot.rootPath, file.path) : "";
  const currentCopyContents = artifactTarget ? artifactText : file?.kind === "text" && !file.truncated ? draft : null;
  const canWordWrap = artifactTarget ? artifactText !== null : file?.kind === "text" && !file.truncated;

  useLayoutEffect(() => {
    fileRequestRef.current += 1;
    setFileLoading(false);
  }, [activeTargetKey, rootId]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; fileRequestRef.current += 1; };
  }, []);

  useLayoutEffect(() => registerFilesPaneFlush(paneKey, () => {
    if (fileLoadingRef.current) throw new Error("Wait for the selected file to finish opening before closing or moving it.");
    if (discardContinuationRef.current) throw new Error("Finish or cancel the current Files action before closing or moving it.");
  }), [paneKey]);

  function setRootId(nextRootId: string) {
    const root = roots.find((candidate) => candidate.id === nextRootId);
    if (!root) throw new Error("The selected Files root is unavailable.");
    updateFilesPane(paneKey, (current) => current.rootId === root.id && current.rootPath === root.path ? current : {
      ...current, rootId: root.id, rootPath: root.path, file: null, draft: "", view: { scrollTop: 0, scrollLeft: 0 },
    });
  }

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateMaximum = () => {
      const width = workspace.getBoundingClientRect().width;
      setTreeMaximum(Math.max(FILE_TREE_MINIMUM_WIDTH, Math.floor(width * 0.6)));
    };
    updateMaximum();
    const observer = new ResizeObserver(updateMaximum);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [accessProfile]);

  useEffect(() => {
    if (locked || saving || !active) return;
    if (incomingTargetKey === activeTargetKey) {
      if (externalTargetPromptRef.current) clearExternalTargetPrompt();
      return;
    }
    if (!dirty) {
      acceptExternalTarget(target, false);
      return;
    }
    if (pendingExternalTargetRef.current?.key === incomingTargetKey) return;
    pendingExternalTargetRef.current = { key: incomingTargetKey, target };
    externalTargetPromptRef.current = true;
    requestDiscard("Discard unsaved changes and open another file?", () => {
      const pending = pendingExternalTargetRef.current;
      if (pending) acceptExternalTarget(pending.target, true);
    });
  }, [active, activeTargetKey, dirty, incomingTargetKey, saving, target, locked]);

  useEffect(() => {
    if (artifactTarget) {
      setRoots([]);
      setTreeError("");
      return;
    }
    const transport = window.octopusTransport;
    if (!transport?.osFileRoots) {
      setTreeError("The desktop Files bridge is unavailable.");
      return;
    }
    let cancelled = false;
    void transport.osFileRoots().then((response) => {
      if (cancelled || !mountedRef.current || !hasFilesPane(paneKey)) return;
      setRoots(response.roots);
      const current = readFilesPane(paneKey).snapshot;
      if (current.rootId && !filesRootMatches(current, response.roots)) {
        setTreeError("The admitted Files root changed. The current document and unsaved draft were retained.");
        return;
      }
      if (!current.rootId && response.roots[0] && !paneLocked()) {
        const root = response.roots[0];
        updateFilesPane(paneKey, (state) => ({ ...state, rootId: root.id, rootPath: root.path }));
      }
      setTreeError("");
    }).catch((error) => {
      if (!cancelled) setTreeError(failureMessage(error));
    });
    return () => { cancelled = true; };
  }, [accessProfile, activeTarget?.kind, paneKey, locked]);

  useEffect(() => {
    if (!artifactTarget) {
      setArtifactResolution({ error: "", loading: false, preview: null, targetKey: "" });
      return;
    }
    if (locked) return;
    let cancelled = false;
    if (file) setFile(null);
    setDraft("");
    setFileError("");
    setQuery("");
    setArtifactResolution({ error: "", loading: true, preview: null, targetKey: artifactTargetKey });
    void resolveArtifactFilePreview({
      artifactId: artifactTarget.artifactId,
      createdAtMs: artifactTarget.createdAtMs,
      interfaceId: artifactTarget.interfaceId,
      label: artifactTarget.label,
      runId: artifactTarget.runId,
      source: "ledger",
    }).then((resolved) => {
      if (!cancelled) setArtifactResolution({ error: "", loading: false, preview: resolved, targetKey: artifactTargetKey });
    }).catch((error) => {
      if (!cancelled) setArtifactResolution({ error: failureMessage(error), loading: false, preview: null, targetKey: artifactTargetKey });
    });
    return () => { cancelled = true; };
  }, [
    artifactRefreshGeneration,
    artifactTargetKey,
    artifactTarget?.artifactId,
    artifactTarget?.createdAtMs,
    artifactTarget?.interfaceId,
    artifactTarget?.label,
    artifactTarget?.runId,
    locked,
  ]);

  const loadDirectory = useCallback(async (requestedRootId: string, path: string) => {
    const transport = window.octopusTransport;
    if (!requestedRootId || !transport?.listOsFiles) return false;
    setLoadingPaths((current) => new Set(current).add(path));
    try {
      const result = await transport.listOsFiles({ rootId: requestedRootId, path });
      if (result.rootId !== requestedRootId || result.path !== path) {
        throw new Error("OS Files returned a directory for a different root or path");
      }
      if (activeRootRef.current !== requestedRootId) return false;
      setDirectories((current) => ({ ...current, [result.path]: result.entries }));
      setTreeError("");
      return true;
    } catch (error) {
      if (activeRootRef.current === requestedRootId) setTreeError(failureMessage(error));
      return false;
    } finally {
      if (activeRootRef.current === requestedRootId) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  }, []);

  useEffect(() => {
    if (artifactTarget || locked) return;
    setDirectories({});
    setExpanded(new Set());
    setFileError("");
    setQuery("");
    if (rootId) void loadDirectory(rootId, "");
  }, [artifactTarget, loadDirectory, rootId, locked]);

  useEffect(() => {
    if (!activeTarget || activeTarget.kind !== "file" || roots.length === 0) return;
    if (locked) return;
    if (paneSnapshot.rootId && !filesRootMatches(paneSnapshot, roots)) return;
    if (file && hydratedTargetRef.current === activeTargetKey) return;
    hydratedTargetRef.current = activeTargetKey;
    const location = resolveFileTarget(activeTarget, roots);
    if (!location) {
      setFileError("The selected file is outside the admitted Files roots.");
      return;
    }
    if (location.rootId !== rootId) {
      setRootId(location.rootId);
      return;
    }
    let cancelled = false;
    const ancestors = octopusTreeAncestors([location.path]);
    const directoryLoad = Promise.all(["", ...ancestors].map((path) => loadDirectory(location.rootId, path)));
    const fileLoad = openFile(location.path);
    void Promise.all([directoryLoad, fileLoad]).then(() => {
      if (cancelled || activeRootRef.current !== location.rootId) return;
      setExpanded((current) => new Set([...current, ...ancestors]));
    });
    return () => { cancelled = true; };
  }, [activeTarget, activeTargetKey, loadDirectory, rootId, roots, locked]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !active || locked || paneState.closeRequested || clientDialogOwnsCommands()) return;
      const owner = viewRef.current;
      const target = event.target;
      if (!owner || !(target instanceof Element) || target.closest('[inert], [hidden], [aria-hidden="true"]')) return;
      const pane = owner.closest('.workspace-surface-pane');
      if (!owner.contains(target) && (!pane || target.closest('.workspace-surface-pane') !== pane)) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || !dirty) return;
      event.preventDefault();
      void saveFile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const loadedEntries = useMemo(() => {
    const byPath = new Map<string, OctopusOsFileEntry>();
    for (const entries of Object.values(directories)) {
      for (const entry of entries) byPath.set(entry.path, entry);
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }));
  }, [directories]);

  const searchEntries = useMemo(() => {
    if (!normalizedQuery) return [];
    return loadedEntries
      .filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }));
  }, [loadedEntries, normalizedQuery]);
  const visibleTreeEntries = searchActive ? searchEntries : loadedEntries;
  const fileTreePaths = useMemo(() => {
    const paths = visibleTreeEntries.flatMap((entry) => {
      if (entry.kind === "directory") return [`${entry.path}/`];
      return entry.kind === "file" ? [entry.path] : [];
    });
    if (!searchActive && file?.rootId === rootId && file.path && !paths.includes(file.path)) paths.push(file.path);
    return paths;
  }, [file, rootId, searchActive, visibleTreeEntries]);
  const searchExpandedPaths = useMemo(() => octopusTreeAncestors(fileTreePaths), [fileTreePaths]);
  const artifactTreePaths = useMemo(() => {
    const filename = activeArtifactPreview?.file.filename ?? "";
    if (!filename || normalizedQuery && !filename.toLocaleLowerCase().includes(normalizedQuery)) return [];
    return [safeArtifactFilename(filename)];
  }, [activeArtifactPreview, normalizedQuery]);
  const treePaths = artifactTarget ? artifactTreePaths : fileTreePaths;
  const knownDirectories = useMemo(() => loadedEntries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path), [loadedEntries]);

  const syncExpandedDirectories = useCallback((model: { getItem(path: string): { isDirectory(): boolean; isExpanded?: () => boolean } | null }) => {
    const next = new Set<string>();
    for (const path of knownDirectories) {
      const item = model.getItem(path);
      if (!item?.isDirectory() || !item.isExpanded?.()) continue;
      next.add(path);
      if (!Object.prototype.hasOwnProperty.call(directories, path)) void loadDirectory(rootId, path);
    }
    setExpanded((current) => setsEqual(current, next) ? current : next);
  }, [directories, knownDirectories, loadDirectory, rootId]);

  async function openFile(path: string, force = false) {
    if (saving || locked) return;
    if (!force && file?.rootId === rootId && file.path === path) {
      fileRequestRef.current += 1;
      setFileLoading(false);
      return;
    }
    if (dirty && !force) {
      requestDiscard("Discard unsaved changes and open another file?", () => void openFile(path, true));
      return;
    }
    const transport = window.octopusTransport;
    if (!transport?.readOsFile) return;
    const requestedRootId = rootId;
    const requestId = fileRequestRef.current + 1;
    fileRequestRef.current = requestId;
    setFileLoading(true);
    setFileError("");
    try {
      const next = await transport.readOsFile({ rootId: requestedRootId, path });
      if (!mountedRef.current || !hasFilesPane(paneKey) || paneLocked()) return;
      if (requestId !== fileRequestRef.current || activeRootRef.current !== requestedRootId) return;
      if (next.rootId !== requestedRootId || next.path !== path) {
        throw new Error("OS Files returned a file for a different root or path");
      }
      setFile(next);
      setDraft(next.text);
    } catch (error) {
      if (requestId === fileRequestRef.current && activeRootRef.current === requestedRootId) {
        setFileError(failureMessage(error));
      }
    } finally {
      if (requestId === fileRequestRef.current && activeRootRef.current === requestedRootId) {
        setFileLoading(false);
      }
    }
  }

  async function saveFile(): Promise<boolean> {
    if (fileLoading) return false;
    const saved = await saveFilesPane(paneKey, window.octopusTransport);
    if (!hasFilesPane(paneKey)) return saved;
    if (saved) appToast.success(`Saved ${readFilesPane(paneKey).snapshot.file?.name ?? "file"}`);
    else if (readFilesPane(paneKey).error) appToast.danger(readFilesPane(paneKey).error);
    return saved;
  }

  async function refreshFile() {
    if (saving || locked) return;
    if (artifactTarget) {
      setArtifactRefreshGeneration((generation) => generation + 1);
      return;
    }
    if (!file) return;
    if (dirty) {
      requestDiscard("Discard unsaved changes and reload this file?", () => void refreshFileForced());
      return;
    }
    await refreshFileForced();
  }

  async function refreshFileForced() {
    if (!file) return;
    const path = file.path;
    setFile(null);
    setDraft("");
    await openFile(path, true);
  }

  async function fileSystemAction(action: OctopusOsFileSystemAction) {
    const transport = window.octopusTransport;
    if (!file || !transport?.performOsFileSystemAction) return;
    try {
      const outcome = await transport.performOsFileSystemAction({ rootId: file.rootId, path: file.path, action });
      if (outcome.rootId !== file.rootId || outcome.path !== file.path || outcome.action !== action) {
        throw new Error("OS Files returned an action receipt for a different root or path");
      }
    } catch (error) {
      appToast.danger(failureMessage(error));
    }
  }

  async function currentFileSystemAction(action: "open" | "reveal") {
    if (artifactTarget) {
      if (!activeArtifactPreview) return;
      try {
        await openArtifactFile(activeArtifactPreview.file, action);
      } catch (error) {
        appToast.danger(failureMessage(error));
      }
      return;
    }
    await fileSystemAction(action);
  }

  async function copyCurrentFileValue(value: string, successMessage: string) {
    setOptionsOpen(false);
    try {
      if (!await copyText(value)) throw new Error("Clipboard access is unavailable.");
      appToast.success(successMessage);
    } catch (error) {
      appToast.danger(failureMessage(error));
    }
  }

  function changeRoot(nextRootId: string) {
    if (saving || locked) return;
    if (nextRootId === rootId) return;
    if (dirty) {
      requestDiscard("Discard unsaved changes and switch file roots?", () => setRootId(nextRootId));
      return;
    }
    setRootId(nextRootId);
  }

  function requestDiscard(message: string, continuation: () => void) {
    discardContinuationRef.current = continuation;
    setDiscardPrompt(message);
  }

  function acceptExternalTarget(nextTarget: FilesOpenTarget | undefined, discardCurrent: boolean) {
    pendingExternalTargetRef.current = null;
    externalTargetPromptRef.current = false;
    discardContinuationRef.current = null;
    setDiscardPrompt("");
    if (discardCurrent) {
      setFile(null);
      setDraft("");
    }
    setActiveTarget(nextTarget);
  }

  function clearExternalTargetPrompt() {
    pendingExternalTargetRef.current = null;
    externalTargetPromptRef.current = false;
    discardContinuationRef.current = null;
    setDiscardPrompt("");
  }

  function paneLocked(): boolean {
    const state = readFilesPane(paneKey);
    return state.transferPending || state.nativeClosePending;
  }

  function changeDraft(next: string) {
    if (hasFilesPane(paneKey) && !paneLocked()) setDraft(next);
  }

  function rememberView(view: FilesEditorViewState) {
    if (!hasFilesPane(paneKey) || paneLocked()) return;
    updateFilesPane(paneKey, (current) => current.view.scrollTop === view.scrollTop && current.view.scrollLeft === view.scrollLeft ? current : { ...current, view });
  }

  return (
    <section className="os-files-view" inert={locked || undefined} ref={viewRef}>
      <nav aria-label="File path" className="os-files-header">
        <FilesBreadcrumb
          label={artifactTarget ? activeArtifactPreview?.file.filename || artifactTarget.label : undefined}
          onSelectFile={(requestedRootId, path) => { if (activeRootRef.current === requestedRootId) void openFile(path); }}
          path={artifactTarget ? undefined : file?.path}
          root={selectedRoot}
        />
        <div className="os-files-path-actions">
          <OcIconButton disabled={artifactTarget ? !activeArtifactPreview : !file} glyph="openExternal" label="Open in default application" onClick={() => void currentFileSystemAction("open")} size="xs" variant="ghost" />
          <OcIconButton disabled={artifactTarget ? !activeArtifactPreview : !file} glyph="folderOpen" label="Reveal in Finder" onClick={() => void currentFileSystemAction("reveal")} size="xs" variant="ghost" />
        </div>
        <div className="os-files-header-actions">
          {dirty ? <em className="os-files-edited">Edited</em> : null}
          <OcButton disabled={!dirty || saving || file?.truncated} onClick={() => void saveFile()} size="xs" variant={dirty ? "primary" : "ghost"}>
            {saving ? "Saving…" : "Save"}
          </OcButton>
          <OcIconButton disabled={artifactTarget ? artifactLoading : !file} glyph="refresh" label="Reload file" onClick={() => void refreshFile()} size="xs" variant="ghost" />
          <div className="os-files-options">
            <OcIconButton
              buttonRef={optionsRef}
              aria-expanded={optionsOpen}
              aria-haspopup="menu"
              disabled={!currentCopyPath && currentCopyContents === null}
              glyph="more"
              label="File viewer options"
              onClick={() => setOptionsOpen((current) => !current)}
              selected={optionsOpen}
              size="xs"
              variant="ghost"
            />
              <OcDropdown align="end" anchorRef={optionsRef} aria-label="File viewer options" onOpenChange={setOptionsOpen} open={optionsOpen}>
                <OcMenuItem disabled={!currentCopyPath} label="Copy path" leadingIcon="copy" onClick={() => void copyCurrentFileValue(currentCopyPath, "Copied file path")} role="menuitem" />
                <OcMenuItem disabled={currentCopyContents === null} label="Copy file contents" leadingIcon="copy" onClick={() => void copyCurrentFileValue(currentCopyContents ?? "", "Copied file contents")} role="menuitem" />
                {canWordWrap ? (
                  <OcMenuItem
                    label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
                    leadingIcon="viewAll"
                    onClick={() => {
                      setWordWrap((current) => !current);
                      setOptionsOpen(false);
                    }}
                    role="menuitem"
                  />
                ) : null}
              </OcDropdown>
          </div>
          <OcIconButton glyph={treeOpen ? "sidebarClosed" : "sidebarOpen"} label="Toggle file tree" onClick={() => setTreeOpen((current) => !current)} selected={treeOpen} size="xs" variant="ghost" />
        </div>
      </nav>

      <div className={`os-files-workspace${treeResizing ? " is-resizing" : ""}`} ref={workspaceRef}>
        <main className="os-files-editor">
          {paneState.error ? <div className="px-4 py-2 text-sm text-token-text-danger" role="alert">{paneState.error}</div> : null}
          {artifactTarget ? artifactLoading ? (
            <FilesUnavailable title="Opening artifact payload" detail="Resolving admitted bytes from the exact artifact movement." glyph="refresh" />
          ) : artifactError ? (
            <FilesUnavailable title="Artifact payload unavailable" detail={artifactError} glyph="warning" />
          ) : activeArtifactPreview && artifactTextState?.status === "ready" ? (
            <FilesCodeEditor
              documentId={`artifact:${artifactTargetKey}`}
              filename={activeArtifactPreview.file.filename}
              key={`artifact:${artifactTargetKey}`}
              label={`View ${activeArtifactPreview.file.filename}`}
              value={artifactTextState.text}
              wordWrap={wordWrap}
            />
          ) : activeArtifactPreview && artifactTextState?.status === "too-large" ? (
            <FilesUnavailable title="File is too large" detail="The artifact exceeds the 2 MB Files text preview limit." glyph="warning" />
          ) : activeArtifactPreview && nativeArtifactPreview(activeArtifactPreview.model.kind) ? (
            <div className="os-files-artifact-preview">
              <ArtifactPreview model={activeArtifactPreview.model} zoomPercent={100} />
            </div>
          ) : activeArtifactPreview ? (
            <FilesUnavailable title="Preview unavailable" detail={`${activeArtifactPreview.file.mediaType || "Binary file"} · ${activeArtifactPreview.file.filename}`} />
          ) : (
            <FilesUnavailable title="Artifact payload unavailable" detail="No admitted payload bytes were resolved for this artifact." glyph="warning" />
          ) : fileLoading ? (
            <FilesUnavailable title="Opening file" detail="Reading the selected file from its admitted OS root." glyph="refresh" />
          ) : fileError ? (
            <FilesUnavailable title="File unavailable" detail={fileError} glyph="warning" />
          ) : !file ? (
            <FilesUnavailable title="Open file" detail="Select a file from the workspace tree" initial />
          ) : file.kind === "binary" ? (
            <FilesUnavailable title="Preview unavailable" detail="This file is binary and cannot be edited as text." />
          ) : file.truncated ? (
            <FilesUnavailable title="File is too large" detail="The bounded preview is read-only because the complete file was not loaded." glyph="warning" />
          ) : (
            <FilesCodeEditor
              documentId={JSON.stringify([file.rootId, file.path])}
              filename={file.name}
              key={JSON.stringify([file.rootId, file.path])}
              label={`Edit ${file.name}`}
              onChange={changeDraft}
              initialViewState={paneSnapshot.view}
              onViewStateChange={rememberView}
              value={draft}
              wordWrap={wordWrap}
            />
          )}
        </main>

        {treeMotion.mounted ? (
          <motion.aside
            aria-label="Workspace files"
            className="os-files-tree"
            inert={!treeOpen}
            style={{ opacity: treeMotion.opacity, width: treeMotion.animatedSize }}
          >
            <PanelResizeHandle
              ariaLabel="Resize workspace files"
              className="os-files-tree-resizer"
              defaultSize={FILE_TREE_DEFAULT_WIDTH}
              edge="left"
              maximum={treeMaximum}
              minimum={FILE_TREE_MINIMUM_WIDTH}
              onChange={setTreeWidth}
              onCommit={persistFileTreeWidth}
              onOpenChange={setTreeOpen}
              onResizingChange={setTreeResizing}
              title="Drag to resize. Double-click to reset."
              value={constrainedTreeWidth}
            />
            <div className="os-files-tree-content">
              {!artifactTarget && roots.length > 1 ? (
                <div className="os-files-root-control">
                  <button aria-label="Choose file tree root" className="os-files-root-picker" onClick={() => setRootMenuOpen((open) => !open)} ref={rootMenuRef} type="button">
                    <Glyph aria-hidden="true" name="folderOpen" size={16} />
                    <span>{selectedRoot?.label}</span>
                  </button>
                  <OcDropdown anchorRef={rootMenuRef} aria-label="File tree roots" contentWidth="menuBounded" onOpenChange={setRootMenuOpen} open={rootMenuOpen}>
                    {roots.map((root) => <OcMenuItem key={root.id} label={root.label} leadingIcon="folderOpen" onClick={() => changeRoot(root.id)} role="menuitem" title={root.path} trailing={root.id === rootId ? <Glyph className="icon-xs" name="check" size={16} /> : undefined} />)}
                  </OcDropdown>
                </div>
              ) : null}
              <div className="os-files-filter-shell">
                <OctopusFilterField inputId="os-files-tree-search" label="Filter files" onQueryChange={setQuery} placeholder="Filter files…" searchQuery={query} />
              </div>
              <div className="os-files-octopus-tree">
                {artifactTarget ? artifactLoading ? <OctopusPanelNote><OcLoadingText label="Resolving artifact payload…" /></OctopusPanelNote>
                  : artifactError ? <p className="os-files-tree-message is-error">Payload unavailable</p>
                    : searchActive && !treePaths.length ? <OctopusPanelNote>No matching files</OctopusPanelNote>
                      : !treePaths.length ? <OctopusPanelNote>Payload unavailable</OctopusPanelNote>
                        : <OctopusFileTree
                            directScrolling
                            initialSelectedPaths={treePaths}
                            onOpenPath={() => undefined}
                            onSelectPath={() => undefined}
                            paths={treePaths}
                            resetKey={`artifact:${artifactTarget.artifactId}:${query}`}
                            revealSelectedPath
                            selectedPath={treePaths[0]}
                          />
                  : searchActive ? !treePaths.length ? <OctopusPanelNote>No matching files</OctopusPanelNote>
                    : <OctopusFileTree
                        directScrolling
                        flattenEmptyDirectories
                        initialExpandedPaths={searchExpandedPaths}
                        onOpenPath={(path) => void openFile(path)}
                        onSelectPath={(path) => void openFile(path)}
                        paths={treePaths}
                        resetKey={`${rootId}:${query}`}
                        revealSelectedPath
                        selectedPath={file?.path}
                      />
                    : treeError ? <p className="os-files-tree-message is-error">{treeError}</p>
                      : loadingPaths.has("") && !treePaths.length ? <OcLoadingRows label="Loading directory entries…" />
                        : !treePaths.length ? <OctopusPanelNote>No files in this folder</OctopusPanelNote>
                          : <OctopusFileTree
                              directScrolling
                              initialExpandedPaths={[...expanded]}
                              initialSelectedPaths={file ? [file.path] : []}
                              onModelEvent={syncExpandedDirectories}
                              onOpenPath={(path) => void openFile(path)}
                              onSelectPath={(path) => void openFile(path)}
                              paths={treePaths}
                              resetKey={rootId}
                              revealSelectedPath
                              selectedPath={file?.path}
                            />}
              </div>
            </div>
          </motion.aside>
        ) : null}
      </div>
      <SetupDialogShell
        ariaLabel="Discard unsaved changes"
        busy={false}
        onClose={() => {
          if (externalTargetPromptRef.current) clearExternalTargetPrompt();
          else {
            discardContinuationRef.current = null;
            setDiscardPrompt("");
          }
        }}
        open={Boolean(discardPrompt)}
        panelClassName="max-w-md"
      >
        <div className="px-6 pt-8 pb-6">
          <h2 className="heading-lg text-token-foreground">Discard unsaved changes?</h2>
          <p className="mt-2 text-sm leading-5 text-token-text-secondary">{discardPrompt}</p>
        </div>
        <div className="flex min-h-[76px] items-center justify-end gap-2 border-t border-token-border/40 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <OcButton onClick={() => {
            if (externalTargetPromptRef.current) clearExternalTargetPrompt();
            else {
              discardContinuationRef.current = null;
              setDiscardPrompt("");
            }
          }} variant="ghost">Keep editing</OcButton>
          <OcButton onClick={() => {
            const continuation = discardContinuationRef.current;
            discardContinuationRef.current = null;
            setDiscardPrompt("");
            continuation?.();
          }} tone="danger" variant="secondary">Discard</OcButton>
        </div>
      </SetupDialogShell>
    </section>
  );
}

function filesOpenTargetKey(target: FilesOpenTarget | undefined): string {
  if (!target) return "none";
  return target.kind === "artifact"
    ? JSON.stringify(["artifact", target.artifactId, target.runId, target.interfaceId, target.label, target.createdAtMs ?? null])
    : JSON.stringify(["file", target.rootId ?? null, target.path ?? null, target.absolutePath ?? null]);
}

function FilesUnavailable({ detail, glyph = "file", initial = false, title }: { detail: string; glyph?: "file" | "refresh" | "warning"; initial?: boolean; title: string }) {
  if (glyph === "refresh") {
    return <div aria-busy="true" className="os-files-loading" role="status"><OctopusSpinner /><span className="sr-only">{title}. {detail}</span></div>;
  }
  return (
    <div className={`os-files-empty${initial ? " is-initial" : ""}`}>
      <div className="os-files-empty-content">
        <div className="os-files-empty-icon"><Glyph name={glyph} size={32} /></div>
        <div className="os-files-empty-message">
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
      </div>
    </div>
  );
}

function absoluteDisplayPath(root: string, path: string): string {
  if (!root) return path;
  if (!path) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "").replaceAll("/", separator)}`;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function readFileTreeWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(FILE_TREE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(FILE_TREE_MINIMUM_WIDTH, stored)
      : FILE_TREE_DEFAULT_WIDTH;
  } catch {
    return FILE_TREE_DEFAULT_WIDTH;
  }
}

function persistFileTreeWidth(value: number): void {
  try {
    window.localStorage.setItem(FILE_TREE_WIDTH_KEY, String(Math.round(value)));
  } catch {
    return;
  }
}

function readableArtifactText(file: ResolvedArtifactFilePreview["file"]): ArtifactTextState {
  const mediaType = file.mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  const extension = file.filename.split(/[?#]/, 1)[0]?.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const textual = mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/javascript"
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || ["c", "cc", "cpp", "cs", "css", "csv", "go", "h", "hpp", "html", "ini", "ipynb", "java", "js", "jsx", "json", "kt", "log", "lua", "md", "mdx", "php", "pl", "py", "rb", "rs", "rst", "scala", "sh", "sql", "swift", "text", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml"].includes(extension);
  if (!textual) return { status: "unreadable" };
  if (file.bytes.byteLength > FILES_TEXT_PREVIEW_MAX_BYTES) return { status: "too-large" };
  try {
    return { status: "ready", text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) };
  } catch {
    return { status: "unreadable" };
  }
}

function nativeArtifactPreview(kind: ResolvedArtifactFilePreview["model"]["kind"]): boolean {
  return kind === "image" || kind === "media" || kind === "pdf";
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
