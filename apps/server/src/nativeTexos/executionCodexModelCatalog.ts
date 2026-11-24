import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import catalog from "./executionCodexModelCatalog.json" with { type: "json" };

/**
 * Codex 0.169's own entry for the Run model with `tool_mode` null, as its direct-tool entries
 * have it. Codex lists the model as `code_mode_only`, and with Code Mode off it offers no tool at
 * all; with direct tools it offers `apply_patch`, and the shell stays off.
 */
export const MANAGED_CODEX_MODEL_CATALOG = JSON.stringify(catalog);

export const managedCodexCatalogLists = (model: string) =>
  catalog.models.some((entry) => entry.slug === model);

class ManagedCodexModelUnlisted extends Error {
  readonly _tag = "ManagedCodexModelUnlisted";
}

/**
 * Writes the catalog into a new private folder under `directory`, removed when the scope closes,
 * and returns the file's real path for `model_catalog_json`.
 */
export const stageManagedCodexModelCatalog = Effect.fn("ManagedCodexModelCatalog.stage")(function* (
  directory: string,
  model: string,
) {
  if (!managedCodexCatalogLists(model)) return yield* Effect.fail(new ManagedCodexModelUnlisted());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ directory, prefix: "codex-model-catalog-" });
  const file = path.join(yield* fs.realPath(folder), "models.json");
  yield* fs.writeFile(file, new TextEncoder().encode(MANAGED_CODEX_MODEL_CATALOG), {
    flag: "wx",
    mode: 0o400,
  });
  return file;
});
