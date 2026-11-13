import { describe, expect, it } from "vite-plus/test";

import { isTexosMissionId, texosMissionEmbedPath, texosMissionThreadId } from "./texosMission.ts";

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

describe("texosMissionEmbedPath", () => {
  it("accepts only a Mission panel path on this server", () => {
    const encoded = `/embed/missions/${encodeURIComponent("Tâche 路径")}/${encodeURIComponent("a b")}`;
    expect(texosMissionEmbedPath("/embed/missions/task-1/attempt-1")).toBe(
      "/embed/missions/task-1/attempt-1",
    );
    expect(texosMissionEmbedPath(encoded)).toBe(encoded);
    // The query TexOS's WorkbenchServer.missionPanelURL builds for "task-1" and "attempt 2 é",
    // read the way the router reads it.
    const fromTexos = new URLSearchParams(
      "next=/embed/missions/task-1/attempt%25202%2520%25C3%25A9",
    ).get("next");
    expect(fromTexos).toBe("/embed/missions/task-1/attempt%202%20%C3%A9");
    expect(texosMissionEmbedPath(fromTexos)).toBe(fromTexos);
    for (const next of [
      undefined,
      "/",
      "https://example.com/embed/missions/a/b",
      "//example.com/embed/missions/a/b",
      "/embed/missions/a/b/c",
      "/embed/missions/a/b?x=1",
      "/embed/missions/a/b#token=x",
      "/embed/missions/../b",
      "/embed/missions/%2e%2e/b",
      "/embed/missions/a%2Fb/c",
      "/embed/missions/a%5Cb/c",
      "/embed/missions/a..b/c",
      "/embed/missions/a%2E%2Eb/c",
      "/embed/missions/a\\b/c",
      "/embed/missions/%E0%A4%A/b",
      "/embed/missions/%20padded/b",
      "/settings/general",
    ])
      expect(texosMissionEmbedPath(next)).toBeNull();
  });
});
