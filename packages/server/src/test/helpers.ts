/**
 * What the server's own tests share beyond `@devsync/server/testing`: the clock, refusals and a
 * security finding.
 */
import { expect } from "vitest";
import { DevSyncError, type ErrorCode, type Finding } from "../host";
import type { FakeHost } from "../testing";

/** A security finding as the host gives it: a secret exposed at `src/app.ts:12`. */
export function sampleFinding(fields: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "config/client-exposed-secret:src/app.ts:12",
    ruleId: "config/client-exposed-secret",
    title: "A secret is exposed to the browser",
    severity: "high",
    file: "src/app.ts",
    line: 12,
    description: "The value is bundled into the client's code.",
    remediation: "Read it on the server only.",
    firstSeenAt: "2026-02-01T00:00:00.000Z",
    lastSeenAt: "2026-02-20T00:00:00.000Z",
    dismissal: null,
    ...fields,
  };
}

/** Moves the fake host's clock to `at`, in milliseconds since the epoch. */
export function setClock(host: FakeHost, at: number): void {
  host.clock = { now: () => new Date(at) };
}

/** The `DevSyncError` that `promise` is refused with, and with `code` when one is given. */
export async function refusal(promise: Promise<unknown>, code?: ErrorCode): Promise<DevSyncError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DevSyncError);
  if (code) expect((error as DevSyncError).code).toBe(code);
  return error as DevSyncError;
}
