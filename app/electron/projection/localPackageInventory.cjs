module.exports = { mutateLocalPackageInventory, reportLocalPackageProgress, requireOctopusOsScope, workspaceProjectMutationScope };

const fs = require("node:fs/promises");
const path = require("node:path");
const { applyLocalApplicationPack, installLocalPackages, repairLocalPackages, removeLocalPackages } = require("../localPackages.cjs");
const { assertApplicationPackageUnreferenced } = require("./applicationPackages.cjs");
const { arrayValue, isPlainRecord, objectOrEmpty, requiredAbsolutePath, requiredApplicationOperationId, requiredDigest, requiredLocalPackageId, requiredSafeRegistryId, stringValue } = require("./values.cjs");

async function mutateLocalPackageInventory(
  registryRoot,
  octopusHomeRoot,
  _scope,
  request,
  hooks,
) {
  const action = stringValue(request?.action);
  const roots = {
    sourceRegistryRoot: requiredAbsolutePath(
      hooks.localPackageRegistryRoot,
      "local package registry",
    ),
    activeRegistryRoot: requiredAbsolutePath(registryRoot, "active registry"),
    libraryRoot: requiredAbsolutePath(
      hooks.localPackageLibraryRoot,
      "local package library",
    ),
    stateRoot: path.join(octopusHomeRoot, "client", "package-state"),
    publication: hooks.localPackagePublication,
  };
  const operationId = requiredApplicationOperationId(request?.operationId);
  const onProgress = (progress) => reportLocalPackageProgress(
    hooks.onApplicationProgress,
    progress,
  );
  if (action === "apply_application_pack") {
    return applyLocalApplicationPack({
      ...roots,
      operationId,
      packId: requiredSafeRegistryId(request?.packId, "packId"),
      selectedRecommended: arrayValue(request?.selectedRecommended),
      expectedSourceDigests: objectOrEmpty(request?.expectedSourceDigests),
      assertMutable: hooks.assertLocalPackageMutation,
      onProgress,
    });
  }
  if (action === "repair_package") {
    const packageIds = arrayValue(request?.packageIds).map((packageId, index) => (
      requiredLocalPackageId(packageId, `packageIds[${index}]`)
    ));
    if (packageIds.length === 0 || new Set(packageIds).size !== packageIds.length) {
      throw new Error("packageIds must contain unique local package ids");
    }
    return repairLocalPackages({
      ...roots,
      operationId,
      packageIds,
      expectedRepairs: objectOrEmpty(request?.expectedRepairs),
      assertMutable: hooks.assertLocalPackageMutation,
      onProgress,
    });
  }
  let packageIds;
  let expectedSourceDigests = {};
  let expectedInstalledDigests = {};
  let capabilityId = "";
  if (action === "install_application" || action === "remove_application") {
    capabilityId = requiredSafeRegistryId(request?.applicationId, "applicationId");
    packageIds = [capabilityId];
    if (action === "install_application") {
      expectedSourceDigests[capabilityId] = requiredDigest(request?.expectedSourceDigest, "expectedSourceDigest");
    } else {
      expectedInstalledDigests[capabilityId] = requiredDigest(request?.expectedInstalledDigest, "expectedInstalledDigest");
    }
  } else if (action === "install_driver" || action === "remove_driver") {
    capabilityId = requiredSafeRegistryId(request?.driverName, "driverName");
    packageIds = [`driver.${capabilityId}`];
    if (action === "install_driver") {
      expectedSourceDigests[packageIds[0]] = requiredDigest(request?.expectedSourceDigest, "expectedSourceDigest");
    } else {
      expectedInstalledDigests[packageIds[0]] = requiredDigest(request?.expectedInstalledDigest, "expectedInstalledDigest");
    }
  } else {
    packageIds = arrayValue(request?.packageIds).map((packageId, index) => (
      requiredLocalPackageId(packageId, `packageIds[${index}]`)
    ));
    if (packageIds.length === 0 || new Set(packageIds).size !== packageIds.length) {
      throw new Error("packageIds must contain unique local package ids");
    }
    if (action === "install_package") expectedSourceDigests = objectOrEmpty(request?.expectedSourceDigests);
    else expectedInstalledDigests = objectOrEmpty(request?.expectedInstalledDigests);
  }
  const install = action === "install_application" || action === "install_driver" || action === "install_package";
  const outcome = install
    ? await installLocalPackages({
        ...roots,
        operationId,
        packageIds,
        expectedSourceDigests,
        assertMutable: hooks.assertLocalPackageMutation,
        onProgress,
      })
    : await removeLocalPackages({
        ...roots,
        operationId,
        packageIds,
        expectedInstalledDigests,
        assertMutable: hooks.assertLocalPackageMutation,
        onProgress,
        assertRemovable: async (manifest) => {
          const excludedDirectories = new Set(manifest.members.map((member) => (
            path.join(registryRoot, member.registry_kind, member.owner)
          )));
          await assertApplicationPackageUnreferenced(
            await fs.realpath(registryRoot),
            octopusHomeRoot,
            excludedDirectories,
            new Set(manifest.members.map((member) => member.owner)),
            manifest.id,
          );
        },
      });
  return {
    ...outcome,
    action,
    ...(capabilityId ? { capabilityId } : {}),
  };
}

function reportLocalPackageProgress(onProgress, progress) {
  if (typeof onProgress !== "function") return;
  onProgress({
    ...progress,
    applicationId: stringValue(progress?.packageId),
  });
}

function requireOctopusOsScope(scope) {
  if (!isPlainRecord(scope) || !["ready", "awaiting_home"].includes(stringValue(scope.status))) {
    throw new Error("Octopus OS scope is not writable");
  }
  const rootEeId = requiredSafeRegistryId(scope.root_ee_id, "Octopus OS root EE");
  const environments = arrayValue(scope.environments);
  const byId = new Map();
  for (const environment of environments) {
    const eeId = requiredSafeRegistryId(environment?.ee_id, "scope EE id");
    if (byId.has(eeId)) throw new Error(`Octopus OS scope repeats EE '${eeId}'`);
    byId.set(eeId, environment);
  }
  if (!byId.has(rootEeId)) throw new Error("Octopus OS root EE is absent from its scope");
  return {
    status: stringValue(scope.status),
    rootEeId,
    homeRunId: stringValue(scope.home_run_id),
    homeInterfaceId: stringValue(scope.home_interface_id),
    homeSidecarDigest: stringValue(scope.home_sidecar_digest),
    agentCatalogPath: stringValue(scope.agent_catalog_path),
    agentCatalogDigest: stringValue(scope.agent_catalog_digest),
    agentProjectSources: arrayValue(scope.agent_project_sources),
    agentPresentations: arrayValue(scope.agent_presentations),
    environments,
    byId,
    clientRuns: arrayValue(scope.client_runs),
    taskAuthoringProfiles: arrayValue(scope.task_authoring_profiles),
    readOnlyRuns: arrayValue(scope.read_only_runs),
  };
}

function workspaceProjectMutationScope(scope) {
  if (scope.status !== "ready") {
    throw new Error(`Workspace Project authoring requires ready scope, found '${scope.status}'`);
  }
  return {
    status: "ready",
    rootEeId: requiredSafeRegistryId(scope.rootEeId, "Workspace Project root EE"),
    homeRunId: requiredSafeRegistryId(scope.homeRunId, "Workspace Project Home run"),
    homeInterfaceId: requiredSafeRegistryId(scope.homeInterfaceId, "Workspace Project Home interface"),
    homeSidecarDigest: requiredDigest(scope.homeSidecarDigest, "Workspace Project Home sidecar digest"),
    environments: scope.environments.map((environment) => ({
      eeId: requiredSafeRegistryId(environment?.ee_id, "Workspace Project EE"),
      parentEeId: stringValue(environment?.parent_ee_id),
      templateName: requiredSafeRegistryId(environment?.template_name, "Workspace Project EE template"),
      recordDigest: requiredDigest(environment?.record_digest, "Workspace Project EE digest"),
      allowedChildTemplateIds: arrayValue(environment?.allowed_child_ee_templates)
        .map((value) => requiredSafeRegistryId(value, "Workspace Project child template"))
        .sort(),
    })),
    clientRuns: scope.clientRuns.map((run) => ({
      runId: requiredSafeRegistryId(run?.run_id, "Workspace Project client run"),
      eeId: requiredSafeRegistryId(run?.ee_id, "Workspace Project client run EE"),
    })),
    readOnlyRuns: scope.readOnlyRuns.map((run) => ({
      runId: requiredSafeRegistryId(run?.run_id, "Workspace Project read-only run"),
      eeId: requiredSafeRegistryId(run?.ee_id, "Workspace Project read-only run EE"),
    })),
  };
}
