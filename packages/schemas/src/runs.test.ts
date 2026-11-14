import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkRunResult,
  pullRequestNumberOf,
  Run,
  RunFailure,
  RunResult,
  RunSetup,
  WorkflowFailure,
} from "./runs";

const runId = randomUUID();
const fullName = "Acme/Shop";

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId,
    status: "succeeded",
    failure: null,
    changedFiles: ["src/app.ts"],
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      costUsd: 0.42,
    },
    models: ["claude-sonnet-5-5"],
    pullRequestUrl: "https://github.com/acme/shop/pull/12",
    branch: `devsync/${runId}`,
    ...overrides,
  };
}

describe("checkRunResult", () => {
  it("takes a succeeded run's result, with its pull request's number", () => {
    const checked = checkRunResult(result(), { runId, fullName });
    expect(checked).toEqual({ ok: true, result: RunResult.parse(result()), pullRequestNumber: 12 });
  });

  it("takes a failed run's result without a pull request", () => {
    const failed = result({ status: "failed", failure: "no-changes", pullRequestUrl: null });
    expect(checkRunResult(failed, { runId, fullName })).toMatchObject({
      ok: true,
      result: { status: "failed", failure: "no-changes" },
      pullRequestNumber: null,
    });
  });

  it("drops fields it doesn't know", () => {
    const checked = checkRunResult(result({ numTurns: 4 }), { runId, fullName });
    expect(checked.ok && "numTurns" in checked.result).toBe(false);
  });

  it("refuses another run's result", () => {
    expect(checkRunResult(result({ runId: randomUUID() }), { runId, fullName })).toEqual({
      ok: false,
    });
    expect(checkRunResult(result(), { runId: runId.toUpperCase(), fullName })).toEqual({
      ok: false,
    });
  });

  it("refuses a pull request of another repository, or a URL that isn't a pull request's", () => {
    for (const url of [
      "https://github.com/acme/other/pull/12",
      "https://github.com/evil/shop/pull/12",
      "https://github.com/acme/shop/issues/12",
      "https://github.com/acme/shop/pull/12/files",
      "https://github.com/acme/shop/pull/0",
      "http://github.com/acme/shop/pull/12",
      "https://github.com.evil.example/acme/shop/pull/12",
      "https://github.com/acme/shop/pull/99999999999",
    ]) {
      expect(checkRunResult(result({ pullRequestUrl: url }), { runId, fullName }), url).toEqual({
        ok: false,
      });
    }
  });

  it("refuses more than 1,000 changed files, or a path longer than 400 characters", () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => `src/${i}.ts`);
    expect(checkRunResult(result({ changedFiles: files(1000) }), { runId, fullName }).ok).toBe(
      true,
    );
    expect(checkRunResult(result({ changedFiles: files(1001) }), { runId, fullName }).ok).toBe(
      false,
    );
    expect(
      checkRunResult(result({ changedFiles: ["a".repeat(400)] }), { runId, fullName }).ok,
    ).toBe(true);
    expect(
      checkRunResult(result({ changedFiles: ["a".repeat(401)] }), { runId, fullName }).ok,
    ).toBe(false);
    expect(checkRunResult(result({ changedFiles: [""] }), { runId, fullName }).ok).toBe(false);
  });

  it("refuses a negative, fractional or missing figure", () => {
    const usage = result().usage;
    for (const changed of [
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { cacheReadInputTokens: "5" },
      { costUsd: -0.01 },
      { costUsd: null },
    ]) {
      expect(
        checkRunResult(result({ usage: { ...usage, ...changed } }), { runId, fullName }).ok,
        JSON.stringify(changed),
      ).toBe(false);
    }
    const { costUsd: _, ...withoutCost } = usage;
    expect(checkRunResult(result({ usage: withoutCost }), { runId, fullName }).ok).toBe(false);
  });

  it("refuses another schema version, an unknown failure, and a status its fields contradict", () => {
    for (const changed of [
      { schemaVersion: 2 },
      { status: "failed", failure: "out-of-coffee", pullRequestUrl: null },
      { status: "succeeded", failure: "budget" },
      { status: "succeeded", pullRequestUrl: null },
      { status: "failed", failure: null },
      { status: "running" },
    ]) {
      expect(checkRunResult(result(changed), { runId, fullName }).ok, JSON.stringify(changed)).toBe(
        false,
      );
    }
    expect(checkRunResult(null, { runId, fullName })).toEqual({ ok: false });
    expect(checkRunResult("{}", { runId, fullName })).toEqual({ ok: false });
  });
});

describe("pullRequestNumberOf", () => {
  it("reads a pull request of the repository, in any case", () => {
    expect(pullRequestNumberOf("https://github.com/ACME/shop/pull/7", "acme/Shop")).toBe(7);
    expect(pullRequestNumberOf("https://github.com/acme/shop.js/pull/7", "acme/shop.js")).toBe(7);
    expect(pullRequestNumberOf("https://github.com/acme/shop/pull/7", "acme/shop.js")).toBeNull();
  });
});

describe("RunFailure", () => {
  it("holds the workflow's failures and DevSync's own", () => {
    for (const failure of WorkflowFailure.options) expect(RunFailure.options).toContain(failure);
    expect(RunFailure.options).toEqual(
      expect.arrayContaining(["bad-result", "no-result", "cancelled", "workflow-missing"]),
    );
  });
});

describe("Run and RunSetup", () => {
  it("parse the answers the task panel reads", () => {
    const at = new Date().toISOString();
    const member = { kind: "member", userId: randomUUID(), name: "Ana" } as const;
    const run: Run = {
      id: runId,
      taskId: randomUUID(),
      revision: 2,
      status: "SUCCEEDED",
      requestedBy: member,
      decidedBy: member,
      createdAt: at,
      decidedAt: at,
      startedAt: at,
      finishedAt: at,
      failure: null,
      changedFiles: ["src/app.ts"],
      usage: { ...result().usage, models: ["claude-sonnet-5-5"] },
      draftPullRequestUrl: "https://github.com/acme/shop/pull/12",
      githubRunUrl: "https://github.com/acme/shop/actions/runs/1",
    };
    expect(Run.parse(run)).toEqual(run);
    expect(Run.safeParse({ ...run, status: "DONE" }).success).toBe(false);
    expect(RunSetup.parse({ workflow: true, secret: false, missing: ["Add it."] })).toEqual({
      workflow: true,
      secret: false,
      missing: ["Add it."],
    });
  });
});
