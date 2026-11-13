import { describe, expect, it } from "@effect/vitest";
import { decodePersonalAgentCommand } from "@t3tools/shared/personalAgents";
import { nativeCommandProblem, nativeHttpAllowed, nativeRpcAllowed } from "./profile.ts";
import {
  ANSWER_PAGE_BYTES,
  answerPage,
  decodeExecutionHostRequest,
  executionEnvelope,
  EXECUTION_CAPABILITY,
  MANAGED_EXECUTION_CAPABILITY,
} from "./executionProtocol.ts";
import { syntheticIntent, syntheticRequest, unicodeCanonicalFixture } from "./execution.testkit.ts";

describe("private execution envelope", () => {
  it("adds managed capability without changing controlled capability or granting renderer access", () => {
    expect(EXECUTION_CAPABILITY).toBe("texos.execution.controlled-codex.v2");
    expect(MANAGED_EXECUTION_CAPABILITY).toBe("texos.execution.managed-cli.v2");
    expect(MANAGED_EXECUTION_CAPABILITY).not.toBe(EXECUTION_CAPABILITY);
    expect(nativeRpcAllowed("execution.admit")).toBe(false);
    expect(() =>
      executionEnvelope({
        ...syntheticIntent(),
        qualified: true,
        profileDirectory: "/caller/profile",
      }),
    ).toThrow();
  });
  it("retains literal Unicode, combining marks and slashes in the Native mirror fixture", () => {
    const envelope = executionEnvelope({
      ...syntheticIntent(),
      input: unicodeCanonicalFixture.input,
    });
    expect(envelope.json).toBe(unicodeCanonicalFixture.json);
    expect(Buffer.byteLength(envelope.json, "utf8")).toBe(unicodeCanonicalFixture.utf8Bytes);
    expect(envelope.digest).toBe(unicodeCanonicalFixture.digest);
  });

  it("requires a task identity and keeps the mission pair inside 128 bytes", () => {
    const intent = syntheticIntent();
    const { canonicalTaskID: _task, ...withoutTask } = intent;
    expect(() => executionEnvelope(withoutTask)).toThrow();
    expect(() => executionEnvelope({ ...intent, canonicalTaskID: "t".repeat(129) })).toThrow();
    expect(() => executionEnvelope({ ...intent, canonicalAttemptID: "a".repeat(129) })).toThrow();
    expect(
      executionEnvelope({ ...intent, canonicalTaskID: "t".repeat(128) }).intent,
    ).toHaveProperty("canonicalTaskID", "t".repeat(128));
  });

  it("hashes canonical UTF-8 bytes, rejects unowned fields, and retains an immutable copy", () => {
    const intent = syntheticIntent();
    const envelope = executionEnvelope(intent);
    expect(envelope.digest).toBe(
      "ddcdf5ab020289a4174bf8d7bae9854677667e8f2f5488778b0742419240e6ec",
    );
    expect(executionEnvelope(JSON.parse(JSON.stringify(intent))).digest).toBe(envelope.digest);
    expect(executionEnvelope({ ...intent, input: "changed" }).digest).not.toBe(envelope.digest);
    expect(() => executionEnvelope({ ...intent, envelopeDigest: envelope.digest })).toThrow();
    expect(() =>
      executionEnvelope({
        ...intent,
        providerThreadID: "caller-thread",
        nativeThreadID: "caller-native-thread",
      }),
    ).toThrow();
    expect(() =>
      executionEnvelope({ ...intent, configuration: { ...intent.configuration, environment: {} } }),
    ).toThrow();
    expect(() =>
      executionEnvelope({
        ...intent,
        configuration: { ...intent.configuration, apiKey: "synthetic-rejected" },
      }),
    ).toThrow();
    expect(() =>
      executionEnvelope({
        ...intent,
        configuration: { ...intent.configuration, modelID: "native-settings" },
      }),
    ).toThrow();
    expect(() =>
      executionEnvelope({
        ...intent,
        worktree: { ...intent.worktree, root: "/synthetic/../other" },
      }),
    ).toThrow();
    expect(Object.isFrozen(envelope.intent.configuration)).toBe(true);
    expect(envelope.intent).not.toBe(intent);
  });

  it("cannot be reached through an agent method, HTTP route, RPC or ordinary coding command", () => {
    for (const method of ["execution.admit", "execution.authorizeStart", "execution.stop"]) {
      expect(nativeRpcAllowed(method)).toBe(false);
      expect(() =>
        decodePersonalAgentCommand({ id: syntheticIntent().commandID, method, params: {} }),
      ).toThrow();
    }
    expect(nativeHttpAllowed("POST", "/api/texos/execution")).toBe(false);
    expect(nativeCommandProblem({ type: "runtime-request.respond" })).toBeDefined();
    for (const method of [
      "terminal.create",
      "projects.writeFile",
      "provider.auth.start",
      "provider.consumeResetCredit",
    ]) {
      expect(nativeRpcAllowed(method)).toBe(false);
    }
  });

  it("rejects wrong directions and fields instead of falling into agent decoding", () => {
    const request = {
      version: 2,
      namespace: "texos.execution",
      kind: "request",
      id: syntheticIntent().commandID,
      authorityID: "synthetic-authority",
      hostID: "synthetic-host",
      hostGeneration: "generation-1",
      method: "execution.admit",
      params: syntheticIntent(),
    };
    expect(decodeExecutionHostRequest(request).method).toBe("execution.admit");
    expect(() => decodeExecutionHostRequest({ ...request, kind: "response" })).toThrow();
    expect(() =>
      decodeExecutionHostRequest({ ...request, method: "execution.authorizeStart" }),
    ).toThrow();
    expect(() => decodeExecutionHostRequest({ ...request, permissionGranted: true })).toThrow();
  });
});

describe("answer pages and reconcile on the wire", () => {
  const command = {
    commandID: "00000000-0000-4000-8000-000000000001",
    envelopeDigest: "a".repeat(64),
  };

  it("accepts a status text offset and reconcile, and refuses a bad offset", () => {
    expect(syntheticRequest("execution.status", { ...command, textOffset: 12 }).params).toEqual({
      ...command,
      textOffset: 12,
    });
    expect(syntheticRequest("execution.status", command).params).toEqual(command);
    expect(syntheticRequest("execution.reconcile", command).method).toBe("execution.reconcile");
    for (const textOffset of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1])
      expect(() => syntheticRequest("execution.status", { ...command, textOffset })).toThrow();
    expect(() => syntheticRequest("execution.stop", { ...command, textOffset: 0 })).toThrow();
    expect(() => syntheticRequest("execution.reconcile", { ...command, textOffset: 0 })).toThrow();
  });

  it("pages by code point, keeps escaped pages inside the frame budget, and rebuilds the text", () => {
    const text = `${"\u0000".repeat(20_000)}😀${"é".repeat(30_000)}"\\`;
    const pages = [];
    let offset = 0;
    for (;;) {
      const page = answerPage(text, offset, true, false);
      expect(page.offset).toBe(offset);
      expect(new TextEncoder().encode(JSON.stringify(page.text)).length - 2).toBeLessThanOrEqual(
        ANSWER_PAGE_BYTES,
      );
      pages.push(page.text);
      if (page.nextOffset === page.total) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("")).toBe(text);
    expect(answerPage(text, 20_000, false, true)).toMatchObject({
      offset: 20_000,
      final: false,
      truncated: true,
    });
    expect(answerPage(text, 20_000, false, true).text.startsWith("😀é")).toBe(true);
    expect(answerPage("abc", 99, true, false)).toEqual({
      offset: 3,
      text: "",
      nextOffset: 3,
      total: 3,
      final: true,
      truncated: false,
    });
  });
});
