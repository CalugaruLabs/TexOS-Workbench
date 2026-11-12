import { describe, expect, it } from "@effect/vitest";
import { PrivateExecutionChannel, type PrivateExecutionEndpoint } from "./executionChannel.ts";
import {
  AUTHORIZATION_CAPABILITY,
  EXECUTION_CAPABILITY,
  executionEnvelope,
  type ExecutionWireResponse,
  type ExecutionNativeRequest,
} from "./executionProtocol.ts";
import {
  syntheticBinding,
  syntheticIntent,
  syntheticRequest,
  syntheticAuthorization,
} from "./execution.testkit.ts";

describe("private execution direction and correlation", () => {
  it("processes a native authorization reply while the original request handler awaits it", async () => {
    const sent: Array<ExecutionWireResponse | ExecutionNativeRequest> = [];
    const intent = syntheticIntent();
    const envelopeDigest = executionEnvelope(intent).digest;
    let settle: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const endpoint: PrivateExecutionEndpoint = {
      handle: async (request, authorize) => {
        if (request.method === "execution.admit") {
          expect(authorize).toBeDefined();
          const result = await authorize!(
            {
              commandID: intent.commandID,
              canonicalRunID: intent.canonicalRunID,
              envelopeDigest,
              runtimeID: "synthetic-runtime",
              childID: "synthetic-child",
              t3ThreadID: "synthetic-thread",
              t3ProviderSessionID: "synthetic-session",
            },
            new AbortController().signal,
          );
          expect(result).toEqual(syntheticAuthorization(intent, 0));
        }
        return { capabilities: authorize ? [EXECUTION_CAPABILITY] : [] };
      },
      disconnect: async () => {},
    };
    const channel = new PrivateExecutionChannel(
      syntheticBinding,
      endpoint,
      (frame) => {
        sent.push(frame);
        if (frame.kind === "request")
          channel.receive({
            version: 2,
            namespace: "texos.execution",
            kind: "response",
            id: frame.id,
            ...syntheticBinding,
            ok: true,
            result: syntheticAuthorization(intent, 0),
          });
        else if (frame.id.endsWith("000000000011")) settle!();
      },
      () => {
        throw new Error("unexpectedPrivateChannelFailure");
      },
    );
    channel.receive(
      syntheticRequest("execution.hello", { capabilities: [AUTHORIZATION_CAPABILITY] }),
    );
    channel.receive(syntheticRequest("execution.admit", intent, 11));
    await done;
    expect(sent.filter((frame) => frame.kind === "request")).toHaveLength(1);
    expect(sent.filter((frame) => frame.kind === "response")).toHaveLength(2);
    channel.close();
  });

  it("offers no authorization callback without negotiation and rejects a stale generation", async () => {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let callbacks = 0;
    const channel = new PrivateExecutionChannel(
      syntheticBinding,
      {
        handle: async (_request, authorize) => {
          if (authorize) callbacks++;
          return { capabilities: [] };
        },
        disconnect: async () => {},
      },
      () => resolveDone!(),
      () => {},
    );
    channel.receive(syntheticRequest("execution.hello", { capabilities: [] }));
    await done;
    expect(callbacks).toBe(0);
    expect(() =>
      channel.receive({
        ...syntheticRequest("execution.admit", syntheticIntent()),
        hostGeneration: "stale",
      }),
    ).toThrow();
    expect(() =>
      channel.receive({
        ...syntheticRequest("execution.admit", syntheticIntent()),
        method: "execution.authorizeStart",
      }),
    ).toThrow();
    channel.close();
  });

  it("unsolicited authorization replies and repeated transport IDs cannot authorize work", () => {
    const channel = new PrivateExecutionChannel(
      syntheticBinding,
      {
        handle: async () => ({ capabilities: [] }),
        disconnect: async () => {},
      },
      () => {},
      () => {},
    );
    const hello = syntheticRequest("execution.hello", { capabilities: [] });
    channel.receive(hello);
    expect(() => channel.receive(hello)).toThrow();
    expect(() =>
      channel.receive({
        version: 2,
        namespace: "texos.execution",
        kind: "response",
        id: hello.id,
        ...syntheticBinding,
        ok: true,
        result: syntheticAuthorization(syntheticIntent(), 0),
      }),
    ).toThrow();
    channel.close();
  });

  it("keeps answering a launch's requests past 256, and still refuses a recent repeat", async () => {
    let answered = 0;
    let failed = false;
    let next: (() => void) | undefined;
    const channel = new PrivateExecutionChannel(
      syntheticBinding,
      {
        handle: async () => ({ capabilities: [] }),
        disconnect: async () => {},
      },
      (frame) => {
        if (frame.kind === "response") {
          answered++;
          next?.();
        }
      },
      () => {
        failed = true;
      },
    );
    for (let ordinal = 1; ordinal <= 300; ordinal++) {
      const replied = new Promise<void>((resolve) => {
        next = resolve;
      });
      channel.receive(syntheticRequest("execution.hello", { capabilities: [] }, ordinal));
      await replied;
    }
    expect(answered).toBe(300);
    expect(failed).toBe(false);
    expect(() =>
      channel.receive(syntheticRequest("execution.hello", { capabilities: [] }, 300)),
    ).toThrow();
    channel.close();
  });
});
