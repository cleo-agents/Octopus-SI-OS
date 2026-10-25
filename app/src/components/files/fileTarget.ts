import type { OctopusOsFileRoot } from "../../electron";
import type { FilesOpenTarget } from "./types";

export function resolveFileTarget(
  target: Extract<FilesOpenTarget, { kind: "file" }>,
  roots: OctopusOsFileRoot[],
): { path: string; rootId: string } | null {
  if (target.rootId && target.path !== undefined) {
    return roots.some((root) => root.id === target.rootId)
      ? { path: target.path, rootId: target.rootId }
      : null;
  }
  const absolutePath = target.absolutePath?.replaceAll("\\", "/");
  if (!absolutePath) return null;
  const root = roots
    .map((candidate) => ({ candidate, path: candidate.path.replaceAll("\\", "/").replace(/\/+$/, "") }))
    .filter(({ path }) => absolutePath === path || absolutePath.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!root) return null;
  return {
    path: absolutePath === root.path ? "" : absolutePath.slice(root.path.length + 1),
    rootId: root.candidate.id,
  };
}

export async function prepareClientFile(path: string) {
  const transport = window.octopusTransport;
  if (!transport) throw new Error("File viewing is unavailable.");
  const { roots } = await transport.osFileRoots();
  const location = resolveFileTarget({ kind: "file", absolutePath: path }, roots);
  if (!location) throw new Error("The selected file is outside the admitted Files roots.");
  const file = await transport.readOsFile(location);
  if (file.rootId !== location.rootId || file.path !== location.path) throw new Error("The file read does not match the requested target.");
  if (file.kind !== "text") throw new Error("Files currently previews text documents. Use a widget for images or other supported media.");
  if (file.truncated) throw new Error("The document exceeds the Files preview limit.");
  return {
    target: { kind: "file" as const, ...location },
    opened: { path, name: file.name, placement: "right", status: "opening" },
  };
}
