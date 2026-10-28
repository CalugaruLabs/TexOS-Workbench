import {
  OrchestratorMcpFailure,
  type ProjectDocAuthor,
  type ProjectDocError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectDocs from "../../../project/ProjectDocs.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { DocsToolkit } from "./tools.ts";

const toFailure = (error: ProjectDocError) =>
  error.reason === "storage"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const callerProject = (projectId: Parameters<typeof resolveProjectId>[1]) =>
  loadCaller().pipe(Effect.flatMap((caller) => resolveProjectId(caller, projectId)));

export const layer = McpToolAccess.toLayer(DocsToolkit, {
  t3_doc_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const docs = yield* ProjectDocs.ProjectDocs;
      const projectId = yield* callerProject(input.projectId);
      return yield* docs.list(projectId).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_doc_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const docs = yield* ProjectDocs.ProjectDocs;
      const projectId = yield* callerProject(input.projectId);
      return yield* docs.read({ projectId, docId: input.docId }).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_doc_write: McpToolAccess.writesWithCapability(({ projectId: requested, ...input }) =>
    Effect.gen(function* () {
      const docs = yield* ProjectDocs.ProjectDocs;
      const caller = yield* loadCaller();
      const projectId = yield* resolveProjectId(caller, requested);
      const author: ProjectDocAuthor =
        caller.scope.thread !== undefined
          ? { _tag: "Agent", threadId: caller.scope.thread.threadId }
          : { _tag: "Client", label: caller.scope.client?.label ?? "MCP client" };
      return yield* docs.save({ projectId, ...input }, author).pipe(Effect.mapError(toFailure));
    }),
  ),
});
