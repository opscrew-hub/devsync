import { captureCheckoutPatch, listCheckoutChanges, withCheckout } from "./checkout.ts";
import { setTimeout } from "node:timers/promises";
import { type RunTokenUsage, finishReservedRun, getRunExecutionContext, releaseRunReservation, renewRunningRun, reserveQueuedRun, startReservedRun } from "@devsync/core/runs";

type ExecutionContext = NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>;
type Reservation = NonNullable<Awaited<ReturnType<typeof reserveQueuedRun>>>;
export type ManagedExecutor = (
  run: Pick<Reservation, "id" | "projectId" | "taskId" | "revision"> & ExecutionContext,
  signal: AbortSignal,
) => Promise<void | { changes: Awaited<ReturnType<typeof listCheckoutChanges>>; baseCommit: string; patch?: string; tokenUsage?: RunTokenUsage }>;

export async function executeNextRun(
  agentType: "CODEX" | "CLAUDE",
  execute: ManagedExecutor,
  shutdown: AbortSignal,
  timeoutMs = 15 * 60 * 1000,
  log?: Pick<import("pino").Logger, "info">,
) {
  if (shutdown.aborted) return false;
  const run = await reserveQueuedRun(agentType);
  if (!run) return false;
  const { id, dispatchToken, projectId, taskId, revision } = run;
  if (shutdown.aborted || !await startReservedRun(id, dispatchToken)) {
    await releaseRunReservation(id, dispatchToken);
    return false;
  }

  const started = performance.now();
  const fields = { runId: id, projectId, taskId, revision, agentType };
  log?.info(fields, "Managed run started");
  let outcome = "not_recorded";
  const stopped = new AbortController();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([shutdown, stopped.signal, deadline]);
  const heartbeat = (async () => {
    while (!signal.aborted) {
      await setTimeout(15000, undefined, { signal });
      if (!signal.aborted && !await renewRunningRun(id, dispatchToken)) stopped.abort();
    }
  })().catch(() => stopped.abort());
  function recordFailure() {
    const reason = deadline.aborted && signal.reason === deadline.reason ? "TIME_LIMIT" : "EXECUTION_FAILED";
    return finishReservedRun(id, dispatchToken, "FAILED", undefined, undefined, undefined, reason);
  }
  let result: Awaited<ReturnType<ManagedExecutor>> = undefined;
  try {
    if (!signal.aborted) {
      const context = await getRunExecutionContext(id, dispatchToken);
      if (!context) throw new Error("Run requires a current task revision, a valid lease, and a linked repository.");
      signal.throwIfAborted();
      result = await execute({ id, projectId, taskId, revision, ...context }, signal);
    }
    if (!signal.aborted && await finishReservedRun(id, dispatchToken, "SUCCEEDED", result?.changes, result?.baseCommit, result?.patch, undefined, result?.tokenUsage)) {
      outcome = "succeeded";
    } else if (await recordFailure()) {
      outcome = "failed";
    }
  } catch (error) {
    if (await recordFailure()) outcome = "failed";
    throw error;
  } finally {
    stopped.abort();
    await heartbeat;
    log?.info({ ...fields, outcome, elapsedMs: Math.round(performance.now() - started) }, "Managed run finished");
  }
  return true;
}

export function withManagedCheckout(
  resolveSource: (run: Parameters<ManagedExecutor>[0], signal: AbortSignal) => Promise<{ repository: string; commit: string; cloneToken?: string }>,
  execute: (run: Parameters<ManagedExecutor>[0], checkout: { directory: string; commit: string }, signal: AbortSignal) => Promise<void | RunTokenUsage>,
  reportChanges?: (runId: string, changes: Awaited<ReturnType<typeof listCheckoutChanges>>) => Promise<void>,
): ManagedExecutor {
  return async (run, signal) => {
    signal.throwIfAborted();
    const { repository, commit, cloneToken } = await resolveSource(run, signal);
    return withCheckout(repository, commit, signal, async directory => {
      const tokenUsage = await execute(run, { directory, commit }, signal);
      signal.throwIfAborted();
      {
        const changes = await listCheckoutChanges(directory, signal);
        signal.throwIfAborted();
        if (reportChanges) await reportChanges(run.id, changes);
        return { changes, baseCommit: commit, tokenUsage: tokenUsage || undefined, patch: await captureCheckoutPatch(directory, commit, signal) };
      }
    }, cloneToken);
  };
}
