import { describe, expect, it } from "vite-plus/test";

import { isTexosMissionId, texosMissionThreadId } from "./texosMission.ts";

describe("texosMissionThreadId", () => {
  it("derives the published vectors", async () => {
    expect(await texosMissionThreadId("task-1", "attempt-1")).toBe(
      "81a2eb5d-dfd0-856e-866e-3b28fb0a40e9",
    );
    expect(await texosMissionThreadId("task-1", "attempt-2")).toBe(
      "e2365918-4eb9-8588-bda8-244c5222bb08",
    );
    expect(await texosMissionThreadId("Tâche/路径", "a b")).toBe(
      "c52374e8-3afd-8437-8e32-0d1e036c19ae",
    );
  });

  it("keeps the separator out of reach of the identities", async () => {
    expect(await texosMissionThreadId("ab", "c")).not.toBe(await texosMissionThreadId("a", "bc"));
  });

  it("rejects identities TexOS cannot send", async () => {
    expect(isTexosMissionId("x".repeat(128))).toBe(true);
    expect(isTexosMissionId("é".repeat(65))).toBe(false);
    expect(isTexosMissionId(" padded")).toBe(false);
    expect(isTexosMissionId("line\nbreak")).toBe(false);
    await expect(texosMissionThreadId("", "attempt")).rejects.toThrow();
  });
});
