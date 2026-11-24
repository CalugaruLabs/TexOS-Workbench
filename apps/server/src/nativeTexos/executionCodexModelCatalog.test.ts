// @effect-diagnostics nodeBuiltinImport:off -- Checks a disposable folder's modes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";

import {
  MANAGED_CODEX_MODEL_CATALOG,
  managedCodexCatalogLists,
  stageManagedCodexModelCatalog,
} from "./executionCodexModelCatalog.ts";

describe("managed Codex model catalog", () => {
  it("lists only the Run model, with direct tools and the file-edit tool", () => {
    // A change to the catalog has to change this pin, so it gets a review.
    assert.equal(
      NodeCrypto.createHash("sha256").update(MANAGED_CODEX_MODEL_CATALOG).digest("hex"),
      "87de69a705c3c645e7bf1228d8128467d3826141a37337009d4758c58c034ed4",
    );
    const { models } = JSON.parse(MANAGED_CODEX_MODEL_CATALOG);
    assert.lengthOf(models, 1);
    assert.equal(models[0].slug, "gpt-5.6-sol");
    // Codex 0.169 says "code_mode_only" here; null is what its direct-tool entries say.
    assert.isNull(models[0].tool_mode);
    assert.equal(models[0].apply_patch_tool_type, "freeform");
    assert.deepEqual(models[0].experimental_supported_tools, []);
    assert.isTrue(managedCodexCatalogLists("gpt-5.6-sol"));
    assert.isFalse(managedCodexCatalogLists("gpt-5.6-sol-extra"));
  });

  it.effect("stages a read-only copy in a private folder that goes when the scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "managed-catalog-" });
      const scope = yield* Scope.make();
      const file = yield* stageManagedCodexModelCatalog(directory, "gpt-5.6-sol").pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      assert.equal(NodePath.dirname(NodePath.dirname(file)), NodeFS.realpathSync(directory));
      assert.equal(yield* fs.readFileString(file), MANAGED_CODEX_MODEL_CATALOG);
      assert.equal(NodeFS.statSync(file).mode & 0o777, 0o400);
      assert.equal(NodeFS.statSync(NodePath.dirname(file)).mode & 0o777, 0o700);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(file)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a model the catalog doesn't list, writing nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "managed-catalog-" });
      const exit = yield* stageManagedCodexModelCatalog(directory, "gpt-5.4").pipe(
        Effect.scoped,
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
