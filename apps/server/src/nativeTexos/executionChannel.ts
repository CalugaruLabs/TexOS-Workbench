// @effect-diagnostics nodeBuiltinImport:off -- Private inherited-pipe correlation, bounded timers and opaque request IDs.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";
import * as Effect from "effect/Effect";

import {
  AUTHORIZATION_CAPABILITY,
  EXECUTION_FRAME_BYTES,
  EXECUTION_NAMESPACE,
  ExecutionProtocolError,
  decodeExecutionHostRequest,
  exact,
  identifier,
  object,
  type ExecutionNativeRequest,
  type ExecutionObservationKey,
  type ExecutionChannelBinding,
  type ExecutionHostRequest,
  type ExecutionWireResponse,
} from "./executionProtocol.ts";
import type {
  ExecutionControl,
  ExecutionControlResult,
  NativeStartAuthorizer,
} from "./executionControl.ts";

export interface PrivateExecutionEndpoint {
  readonly handle: (
    request: ExecutionHostRequest,
    authorize?: NativeStartAuthorizer,
  ) => Promise<ExecutionControlResult>;
  readonly disconnect: () => Promise<void>;
}

// The only Effect runner is this transport adapter; the service and SQL repository remain effects.
export function executionEndpoint(control: ExecutionControl["Service"]): PrivateExecutionEndpoint {
  return {
    handle: (request, authorize) => Effect.runPromise(control.handle(request, authorize)),
    disconnect: () => Effect.runPromise(control.disconnect),
  };
}

export class PrivateExecutionChannel {
  private readonly binding: ExecutionChannelBinding;
  private readonly endpoint: PrivateExecutionEndpoint;
  private readonly send: (frame: ExecutionWireResponse | ExecutionNativeRequest) => void;
  private readonly fail: () => void;
  private readonly timeoutMs: number;
  private negotiated = false;
  private closed = false;
  private active = 0;
  private requests = new Set<string>();
  private expired = new Set<string>();
  private pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof NodeTimers.setTimeout>;
      readonly abort: () => void;
    }
  >();

  constructor(
    binding: ExecutionChannelBinding,
    endpoint: PrivateExecutionEndpoint,
    send: (frame: ExecutionWireResponse | ExecutionNativeRequest) => void,
    fail: () => void,
    timeoutMs = 5000,
  ) {
    exact(binding, ["authorityID", "hostID", "hostGeneration"]);
    for (const value of Object.values(binding)) identifier(value);
    this.binding = Object.freeze({ ...binding });
    this.endpoint = endpoint;
    this.send = send;
    this.fail = fail;
    this.timeoutMs = timeoutMs;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.negotiated = false;
    for (const entry of this.pending.values()) {
      NodeTimers.clearTimeout(entry.timer);
      entry.abort();
      entry.reject(new ExecutionProtocolError("executionChannelDisconnected"));
    }
    this.pending.clear();
    void this.endpoint.disconnect().catch(() => {});
  }

  private authorize: NativeStartAuthorizer = (params, signal) =>
    this.nativeRequest("execution.authorizeStart", params, signal);

  /** The native admission's CLI binding for one admitted key; TexOS owns the answer. */
  readBinding(key: ExecutionObservationKey, signal: AbortSignal): Promise<unknown> {
    return this.nativeRequest("execution.readBinding", key, signal);
  }

  private nativeRequest(
    method: ExecutionNativeRequest["method"],
    params: ExecutionNativeRequest["params"],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (
      this.closed ||
      !this.negotiated ||
      signal.aborted ||
      this.pending.size >= 8 ||
      this.expired.size >= 256
    ) {
      return Promise.reject(new ExecutionProtocolError("nativeAuthorizationUnavailable"));
    }
    const id = NodeCrypto.randomUUID();
    if (this.requests.has(id) || this.pending.has(id) || this.expired.has(id))
      return Promise.reject(new ExecutionProtocolError("executionIdentityConflict"));
    return new Promise((resolve, reject) => {
      const expire = () => {
        const saved = this.pending.get(id);
        if (!saved) return;
        NodeTimers.clearTimeout(saved.timer);
        saved.abort();
        this.pending.delete(id);
        this.expired.add(id);
        reject(new ExecutionProtocolError("nativeAuthorizationUnavailable"));
      };
      // @effect-diagnostics-next-line globalTimers:off -- Promise transport deadlines must cancel their native callback entries.
      const timer = NodeTimers.setTimeout(expire, this.timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        abort: () => signal.removeEventListener("abort", expire),
      });
      signal.addEventListener("abort", expire, { once: true });
      try {
        this.send({
          version: 2,
          namespace: EXECUTION_NAMESPACE,
          kind: "request",
          id,
          ...this.binding,
          method,
          params,
        } as ExecutionNativeRequest);
      } catch {
        expire();
        this.fail();
      }
    });
  }

  receive(value: unknown) {
    if (this.closed) throw new ExecutionProtocolError("executionChannelDisconnected");
    const frame = object(value);
    if (
      frame.version !== 2 ||
      frame.namespace !== EXECUTION_NAMESPACE ||
      frame.authorityID !== this.binding.authorityID ||
      frame.hostID !== this.binding.hostID ||
      frame.hostGeneration !== this.binding.hostGeneration ||
      Buffer.byteLength(JSON.stringify(frame)) > EXECUTION_FRAME_BYTES
    ) {
      throw new ExecutionProtocolError("staleExecutionAuthority");
    }
    if (frame.kind === "response") {
      exact(frame, [
        "version",
        "namespace",
        "kind",
        "id",
        "authorityID",
        "hostID",
        "hostGeneration",
        "ok",
        frame.ok === true ? "result" : "error",
      ]);
      if (typeof frame.id !== "string" || typeof frame.ok !== "boolean")
        throw new ExecutionProtocolError("invalidExecutionReply");
      const entry = this.pending.get(frame.id);
      if (!entry && this.expired.delete(frame.id)) return;
      if (!entry) throw new ExecutionProtocolError("unmatchedExecutionReply");
      if (!frame.ok) {
        const error = exact(frame.error, ["code"]);
        identifier(error.code);
      }
      this.pending.delete(frame.id);
      NodeTimers.clearTimeout(entry.timer);
      entry.abort();
      if (frame.ok) entry.resolve(frame.result);
      else {
        entry.reject(new ExecutionProtocolError("nativeAuthorizationDenied"));
      }
      return;
    }
    const request = decodeExecutionHostRequest(frame);
    if (
      this.active >= 8 ||
      this.requests.size >= 256 ||
      this.requests.has(request.id) ||
      this.pending.has(request.id) ||
      this.expired.has(request.id)
    ) {
      throw new ExecutionProtocolError("executionRequestLimit");
    }
    this.requests.add(request.id);
    this.active++;
    if (request.method === "execution.hello") {
      this.negotiated = request.params.capabilities.includes(AUTHORIZATION_CAPABILITY);
    }
    const authorize = this.negotiated ? this.authorize : undefined;
    void this.endpoint
      .handle(request, authorize)
      .then(
        (result) => this.reply(request, { ok: true, result }),
        () => this.reply(request, { ok: false, error: { code: "executionRefused" } }),
      )
      .catch(() => this.fail())
      .finally(() => {
        this.active--;
      });
  }

  private reply(
    request: ExecutionHostRequest,
    result:
      | { readonly ok: true; readonly result: unknown }
      | { readonly ok: false; readonly error: { readonly code: string } },
  ) {
    if (this.closed) return;
    this.send({
      version: 2,
      namespace: EXECUTION_NAMESPACE,
      kind: "response",
      id: request.id,
      ...this.binding,
      ...result,
    });
  }
}
