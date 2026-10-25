import { useCallback, useEffect, useState } from "react";
import type { OctopusClientAccessProfile } from "../electron";
import { useProjectionStructureGeneration } from "../projectionLive";
import { mutateOctopusOsWorkspace, readProjection } from "../projectionClient";

export type HomeProviderSelection = {
  providerInterfaceId: string;
  providerModel: string;
  reasoningEffort: string;
};

type HomeScope = {
  rootEeId: string;
  homeRunId: string;
  homeInterfaceId: string;
  homeSidecarDigest: string;
  homeRunDigest: string;
  providerInterfaceId: string;
};

export function useHomeProviderSwitch(profile: OctopusClientAccessProfile) {
  const generation = useProjectionStructureGeneration();
  const [scope, setScope] = useState<HomeScope | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (profile !== "live") {
      setScope(null);
      return;
    }
    let current = true;
    readProjection<unknown>("projection.operator.os.scope")
      .then((raw) => { if (current) setScope(homeScope(raw)); })
      .catch(() => { if (current) setScope(null); });
    return () => { current = false; };
  }, [generation, profile]);

  const switchProvider = useCallback(async (selection: HomeProviderSelection) => {
    if (!scope) throw new Error("Home is not ready to change its provider.");
    setPending(true);
    setError("");
    try {
      await mutateOctopusOsWorkspace({
        action: "switch_home_provider",
        operationId: crypto.randomUUID(),
        workspace: {
          rootEeId: scope.rootEeId,
          homeRunId: scope.homeRunId,
          homeInterfaceId: scope.homeInterfaceId,
          expectedHomeSidecarDigest: scope.homeSidecarDigest,
        },
        providerInterfaceId: selection.providerInterfaceId,
        providerModel: selection.providerModel,
        reasoningEffort: selection.reasoningEffort,
        expectedHomeRunDigest: scope.homeRunDigest,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      setPending(false);
    }
  }, [scope]);

  return {
    ready: scope !== null,
    providerInterfaceId: scope?.providerInterfaceId ?? "",
    pending,
    error,
    switchProvider,
  };
}

function homeScope(value: unknown): HomeScope | null {
  if (!isRecord(value) || text(value.status) !== "ready") return null;
  const homeRunId = text(value.home_run_id);
  const home = (Array.isArray(value.client_runs) ? value.client_runs : [])
    .find((row) => isRecord(row) && text(row.run_id) === homeRunId);
  if (!isRecord(home)) return null;
  const scope = {
    rootEeId: text(value.root_ee_id),
    homeRunId,
    homeInterfaceId: text(value.home_interface_id),
    homeSidecarDigest: text(value.home_sidecar_digest),
    homeRunDigest: text(home.record_digest),
    providerInterfaceId: text(home.provider_choice_interface),
  };
  return Object.values(scope).every(Boolean) ? scope : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
