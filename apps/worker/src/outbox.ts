import { setTimeout } from "node:timers/promises";
import { db } from "@devsync/db";
import { processTaskOutboxEvent } from "@devsync/core/task-outbox";
import { processGithubEvent } from "@devsync/core/github-events";
import { expireRunningRuns } from "@devsync/core/runs";
import pino from "pino";

const log = pino({ name: "devsync-outbox" });
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

try {
  let nextRecoveryAt = 0;
  while (!shutdown.signal.aborted) {
    if (Date.now() >= nextRecoveryAt) {
      nextRecoveryAt = Date.now() + 30000;
      try {
        const expired = await expireRunningRuns();
        if (expired) log.warn({ expired }, "Expired managed runs marked failed");
      } catch (error) {
        if (process.argv.includes("--recover-once")) throw error;
        log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Managed run recovery failed");
      }
    }
    if (process.argv.includes("--recover-once")) break;
    let wait = true;
    try {
      const result = await processTaskOutboxEvent();
      wait = result.status === "idle";
      if (result.status === "retry") {
        log.warn({ eventId: result.eventId, attempts: result.attempts }, "Signal delivery scheduled for retry");
      }
    } catch (error) {
      log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Outbox poll failed");
      wait = true;
    }
    try {
      if (await processGithubEvent()) wait = false;
    } catch (error) {
      log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "GitHub delivery processing failed");
    }
    if (wait && !shutdown.signal.aborted) {
      await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(error => {
        if (!shutdown.signal.aborted) throw error;
      });
    }
  }
} finally {
  await db.$disconnect();
}
