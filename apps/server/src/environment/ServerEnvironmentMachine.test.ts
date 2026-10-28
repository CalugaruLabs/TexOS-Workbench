import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { detectServerEnvironmentMachineKind } from "./ServerEnvironmentMachine.ts";

it.effect(
  "native presentation skips ioreg and sysctl while ordinary machine detection remains available",
  () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          commands.push(input.command);
          return Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stdout: '"product-name" = <"MacBookPro">',
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      });
      const detect = detectServerEnvironmentMachineKind().pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      expect(
        yield* detect.pipe(
          Effect.provideService(HostProcess.Environment, { T3CODE_TEXOS_NATIVE_BRIDGE: "1" }),
        ),
      ).toBeNull();
      expect(commands).toEqual([]);
      expect(yield* detect.pipe(Effect.provideService(HostProcess.Environment, {}))).toBe("laptop");
      expect(commands).toEqual(["ioreg"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
