import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkspaceArea,
  WorkspaceAreaId,
  WorkspaceCreateItemInput,
  WorkspaceFileInput,
  WorkspaceItemId,
  WorkspaceSaveAreaInput,
  WorkspaceSnapshot,
  WorkspaceUpdateItemInput,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "./useSettings";

const NO_AREAS: ReadonlyArray<WorkspaceArea> = [];

// The workspace lives on the machine this app runs on; a hosted web client uses its first server.
function useWorkspaceEnvironmentId(): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const environmentIds = useEnvironmentIds();
  return primary ?? environmentIds[0] ?? null;
}

export function useWorkspace(): {
  readonly environmentId: EnvironmentId | null;
  readonly workspace: WorkspaceSnapshot | null;
  readonly areas: ReadonlyArray<WorkspaceArea>;
} {
  const environmentId = useWorkspaceEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workspaceLive({ environmentId, input: {} }),
  );
  return { environmentId, workspace: query.data, areas: query.data?.areas ?? NO_AREAS };
}

export function useWorkspaceAreaCommands(environmentId: EnvironmentId) {
  const canWrite = useAtomValue(serverEnvironment.saveWorkspaceArea.permissionAtom(environmentId));
  const save = useAtomCommand(serverEnvironment.saveWorkspaceArea, { label: "save area" });
  const remove = useAtomCommand(serverEnvironment.deleteWorkspaceArea, { label: "remove area" });
  return {
    canWrite,
    saveArea: (input: WorkspaceSaveAreaInput) => save({ environmentId, input }),
    deleteArea: (areaId: WorkspaceAreaId) => remove({ environmentId, input: { areaId } }),
  };
}

export function useWorkspaceItemCommands(environmentId: EnvironmentId) {
  const canWrite = useAtomValue(
    serverEnvironment.createWorkspaceItem.permissionAtom(environmentId),
  );
  const create = useAtomCommand(serverEnvironment.createWorkspaceItem, { label: "add item" });
  const update = useAtomCommand(serverEnvironment.updateWorkspaceItem, { label: "update item" });
  const remove = useAtomCommand(serverEnvironment.deleteWorkspaceItem, { label: "delete item" });
  const file = useAtomCommand(serverEnvironment.fileWorkspaceTarget, { label: "move item" });
  return {
    canWrite,
    createItem: (input: WorkspaceCreateItemInput) => create({ environmentId, input }),
    updateItem: (input: WorkspaceUpdateItemInput) => update({ environmentId, input }),
    deleteItem: (itemId: WorkspaceItemId) => remove({ environmentId, input: { itemId } }),
    file: (input: WorkspaceFileInput) => file({ environmentId, input }),
  };
}

/** Moves areas saved on this device by older builds into the shared workspace, once. */
export function useMigrateDeviceAreas() {
  const { environmentId, workspace } = useWorkspace();
  const hydrated = useClientSettingsHydrated();
  const deviceAreas = useClientSettings((settings) => settings.sidebarWorkspaceAreas);
  const saveArea = useAtomCommand(serverEnvironment.saveWorkspaceArea, {
    label: "move areas to workspace",
  });
  const started = useRef(false);

  // oxlint-disable-next-line t3code/react-effect-budget -- one-time copy from device settings to the server
  useEffect(() => {
    if (!hydrated || environmentId === null || workspace === null || started.current) return;
    if (deviceAreas.length === 0) return;
    started.current = true;
    void (async () => {
      const existing = new Set(workspace.areas.map((area) => area.name.toLowerCase()));
      let moved = true;
      for (const area of deviceAreas) {
        if (existing.has(area.name.toLowerCase())) continue;
        const result = await saveArea({
          environmentId,
          input: { name: area.name, projectRefs: area.projectRefs },
        });
        moved &&= result._tag === "Success";
      }
      // Keep the device copy until every area made it, so a dropped connection loses nothing.
      if (moved) {
        await persistClientSettingsUpdate((current) => ({ ...current, sidebarWorkspaceAreas: [] }));
      } else {
        started.current = false;
      }
    })();
  }, [hydrated, environmentId, workspace, deviceAreas, saveArea]);
}
