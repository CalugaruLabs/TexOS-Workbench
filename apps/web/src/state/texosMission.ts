import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

// Keyed by a revision the panel derives from the Mission's file edits, so a read follows an edit.
export const texosMissionFiles = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:texos-mission:files",
  tag: WS_METHODS.texosMissionListFiles,
  staleTimeMs: 60_000,
  idleTtlMs: 60_000,
});

// Keyed by the file's size and change time, so an unchanged file is read once.
export const texosMissionFile = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:texos-mission:file",
  tag: WS_METHODS.texosMissionReadFile,
  staleTimeMs: 300_000,
  idleTtlMs: 300_000,
});
