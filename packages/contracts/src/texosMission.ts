import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Above this size a Mission file is listed but its text is not sent. */
export const TEXOS_MISSION_FILE_BYTES = 512 * 1024;

const MissionIdentity = {
  taskId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  /** Changes only the client's cache key; the server always reads the folder as it is now. */
  revision: Schema.optional(Schema.String),
};

export const TexosMissionListFilesInput = Schema.Struct(MissionIdentity);
export type TexosMissionListFilesInput = typeof TexosMissionListFilesInput.Type;

export const TexosMissionFile = Schema.Struct({
  /** Relative to the Mission's folder, with `/` separators. */
  path: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
  changedAtMs: NonNegativeInt,
});
export type TexosMissionFile = typeof TexosMissionFile.Type;

export const TexosMissionListFilesResult = Schema.Struct({
  files: Schema.Array(TexosMissionFile),
  /** Links, special files and anything past a limit, which are never listed. */
  omitted: NonNegativeInt,
});
export type TexosMissionListFilesResult = typeof TexosMissionListFilesResult.Type;

export const TexosMissionReadFileInput = Schema.Struct({
  ...MissionIdentity,
  path: TrimmedNonEmptyString,
});
export type TexosMissionReadFileInput = typeof TexosMissionReadFileInput.Type;

export const TexosMissionReadFileResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    contents: Schema.String,
    byteLength: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literals(["binary", "tooLarge"]),
    byteLength: NonNegativeInt,
  }),
]);
export type TexosMissionReadFileResult = typeof TexosMissionReadFileResult.Type;

export const TexosMissionFilesFailure = Schema.Literals([
  "unavailable",
  "notFound",
  "folderChanged",
  "invalidPath",
  "unreadable",
]);
export type TexosMissionFilesFailure = typeof TexosMissionFilesFailure.Type;

export class TexosMissionFilesError extends Schema.TaggedError<TexosMissionFilesError>()(
  "TexosMissionFilesError",
  {
    failure: TexosMissionFilesFailure,
    message: TrimmedNonEmptyString,
  },
) {}
