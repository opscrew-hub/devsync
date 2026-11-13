import { setTimeout } from "node:timers/promises";
import { db } from "@devsync/db";
import { createGithubDraftClient } from "@devsync/core/github-app";
import { claimRunDraftPublication, recordRunDraftPullRequest } from "@devsync/core/runs";
import pino from "pino";
import { createCodexExecutor } from "./codex-executor.ts";
import { createClaudeExecutor } from "./claude-executor.ts";
import { executeNextRun } from "./managed-run.ts";
import { ensureDraftBranch } from "./draft-pr-branch.ts";
import { planDraftPullRequest, publishDraftPullRequest } from "./draft-pr-plan.ts";

const agentType = process.argv.includes("--claude") ? "CLAUDE" : "CODEX";
const prefix = `DEVSYNC_${agentType}`;
const apiKey = process.env[`${prefix}_API_KEY`]?.trim();
if (!apiKey || !process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY || !process.env.GITHUB_PROJECT_REPOSITORIES) {
  throw new Error(`Managed ${agentType} requires a dedicated API key and GitHub App repository configuration.`);
}
const configuredBudget = process.env[`${prefix}_TOKEN_BUDGET`];
const tokenBudget = configuredBudget === undefined ? undefined : Number(configuredBudget);
if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
  throw new Error(`${prefix}_TOKEN_BUDGET must be a positive integer.`);
}
const log = pino({ name: `devsync-managed-${agentType.toLowerCase()}` });
const draftEnabled = process.env[`${prefix}_DRAFT_PRS`] === "true";
async function publishNextDraft(shutdown: AbortSignal) {
    if (shutdown.aborted) return false;
    const run = await claimRunDraftPublication(agentType);
    if (!run) return false;
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(60000)]);
    try {
      const plan = planDraftPullRequest(run, run);
      if (!plan) throw new Error("Managed draft has no patch.");
      const github = await createGithubDraftClient(run, signal);
      const pull = await publishDraftPullRequest(plan, github.base, {
        ...github,
        ensureBranch: input => ensureDraftBranch(github.repository, input, signal, github.token),
      }, signal);
      if (!await recordRunDraftPullRequest(run, plan.baseCommit, pull.url)) {
        log.warn({ runId: run.id, pullRequestUrl: pull.url }, "Managed draft pull request link could not be saved");
        return true;
      }
      log.info({ runId: run.id, pullRequestUrl: pull.url }, "Managed draft pull request published");
    } catch (error) {
      log.error({ runId: run.id, errorType: error instanceof Error ? error.name : "unknown" }, "Managed draft pull request publication failed");
    }
    return true;
}
const execute = agentType === "CLAUDE"
  ? createClaudeExecutor(process.env.DEVSYNC_CLAUDE_BINARY ?? "", apiKey)
  : createCodexExecutor(apiKey);
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

try {
  while (!shutdown.signal.aborted) {
    try {
      const published = draftEnabled && await publishNextDraft(shutdown.signal);
      if (await executeNextRun(agentType, execute, shutdown.signal, undefined, log, tokenBudget, undefined, draftEnabled) || published) continue;
    } catch (error) {
      log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Managed run failed");
    }
    await setTimeout(2000, undefined, { signal: shutdown.signal }).catch(error => {
      if (!shutdown.signal.aborted) throw error;
    });
  }
} finally {
  await db.$disconnect();
}
