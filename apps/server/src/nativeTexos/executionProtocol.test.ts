import { describe, expect, it } from "@effect/vitest";
import { decodePersonalAgentCommand } from "@t3tools/shared/personalAgents";
import { nativeCommandProblem, nativeHttpAllowed, nativeRpcAllowed } from "./profile.ts";
import { decodeExecutionHostRequest, executionEnvelope } from "./executionProtocol.ts";
import { syntheticIntent, unicodeCanonicalFixture } from "./execution.testkit.ts";

describe("private execution envelope", () => {
  it("retains literal Unicode, combining marks and slashes in the Native mirror fixture", () => {
    const envelope = executionEnvelope({
      ...syntheticIntent(),
      input: unicodeCanonicalFixture.input,
    });
    expect(envelope.json).toBe(unicodeCanonicalFixture.json);
    expect(Buffer.byteLength(envelope.json, "utf8")).toBe(unicodeCanonicalFixture.utf8Bytes);
    expect(envelope.digest).toBe(unicodeCanonicalFixture.digest);
  });

  it("hashes canonical UTF-8 bytes, rejects unowned fields, and retains an immutable copy", () => {
    const intent = syntheticIntent();
    const envelope = executionEnvelope(intent);
    expect(envelope.digest).toBe(
      "37faebb6baac0ba79cbce075327fb1a80ed4e54409130664be70a669ece81778",
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
