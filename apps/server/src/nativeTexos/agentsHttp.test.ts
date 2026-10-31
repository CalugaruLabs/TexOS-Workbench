import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AgentsHttp from "./agentsHttp.ts";

afterEach(() => vi.unstubAllEnvs());
const id = "00000000-0000-4000-8000-000000000001";
async function request(input: {
  native: boolean;
  scopes?: ReadonlyArray<AuthEnvironmentScope>;
  method?: string;
  path?: string;
  body?: object;
}) {
  vi.stubEnv("T3CODE_TEXOS_NATIVE_BRIDGE", input.native ? "1" : "0");
  const checked: string[] = [];
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: (incoming) => {
      checked.push(incoming.url);
      return input.scopes
        ? Effect.succeed({
            sessionId: AuthSessionId.make("synthetic"),
            subject: "synthetic",
            method: "browser-session-cookie",
            scopes: input.scopes,
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
    },
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    AgentsHttp.layer.pipe(Layer.provideMerge(auth), Layer.provideMerge(NodeServices.layer)),
    {
      disableLogger: true,
    },
  );
  try {
    const response = await handler(
      new Request(`http://localhost${input.path ?? "/api/texos/agents"}`, {
        method: input.method ?? "POST",
        ...(input.body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }
          : {}),
      }),
    );
    return { status: response.status, checked };
  } finally {
    await dispose();
  }
}
describe("native personal agents HTTP admission", () => {
  it("standard builds do not probe or authenticate a personal engine", async () => {
    expect(
      await request({ native: false, body: { id, method: "agents.hello", params: {} } }),
    ).toEqual({ status: 404, checked: [] });
  });
  it("requires an authenticated session before commands or event reads", async () => {
    expect(
      (await request({ native: true, body: { id, method: "agents.hello", params: {} } })).status,
    ).toBe(401);
    expect(
      (await request({ native: true, method: "GET", path: "/api/texos/agents/events" })).status,
    ).toBe(401);
  });
  it("read scope cannot mutate personal agents", async () => {
    expect(
      (
        await request({
          native: true,
          scopes: [AuthOrchestrationReadScope],
          body: { id, method: "agents.submit", params: { agentID: "a", text: "work" } },
        })
      ).status,
    ).toBe(403);
  });
  it("rejects authority overrides before reaching native dispatch", async () => {
    expect(
      (
        await request({
          native: true,
          scopes: [AuthOrchestrationOperateScope],
          body: {
            id,
            method: "agents.submit",
            authorityID: "other-space",
            params: { agentID: "a", text: "work" },
          },
        })
      ).status,
    ).toBe(400);
  });
});
