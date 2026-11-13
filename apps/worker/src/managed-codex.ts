import { setTimeout } from "node:timers/promises";
import { db } from "@devsync/db";
import pino from "pino";
import { createCodexExecutor } from "./codex-executor.ts";
import { executeNextRun } from "./managed-run.ts";

const apiKey = process.env.DEVSYNC_CODEX_API_KEY?.trim();
if (!apiKey || !process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY || !process.env.GITHUB_PROJECT_REPOSITORIES) {
  throw new Error("Managed Codex requires a dedicated API key and GitHub App repository configuration.");
}
const configuredBudget = process.env.DEVSYNC_CODEX_TOKEN_BUDGET;
const tokenBudget = configuredBudget === undefined ? undefined : Number(configuredBudget);
if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
  throw new Error("DEVSYNC_CODEX_TOKEN_BUDGET must be a positive integer.");
}
const log = pino({ name: "devsync-managed-codex" });
const execute = createCodexExecutor(apiKey);
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

try {
  while (!shutdown.signal.aborted) {
    try {
      if (await executeNextRun("CODEX", execute, shutdown.signal, undefined, log, tokenBudget)) continue;
    } catch (error) {
      log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Managed Codex run failed");
    }
    await setTimeout(2000, undefined, { signal: shutdown.signal }).catch(error => {
      if (!shutdown.signal.aborted) throw error;
    });
  }
} finally {
  await db.$disconnect();
}
