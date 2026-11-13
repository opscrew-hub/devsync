import { listCheckoutChanges, withCheckout } from "./checkout.ts";
import { setTimeout } from "node:timers/promises";
import { finishReservedRun, getRunExecutionContext, releaseRunReservation, renewRunningRun, reserveQueuedRun, startReservedRun } from "@devsync/core/runs";

type ExecutionContext = NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>;
type Reservation = NonNullable<Awaited<ReturnType<typeof reserveQueuedRun>>>;
export type ManagedExecutor = (
  run: Pick<Reservation, "id" | "projectId" | "taskId" | "revision"> & ExecutionContext,
  signal: AbortSignal,
) => Promise<void | { changes: Awaited<ReturnType<typeof listCheckoutChanges>>; baseCommit: string }>;

export async function executeNextRun(
  agentType: "CODEX" | "CLAUDE",
  execute: ManagedExecutor,
  shutdown: AbortSignal,
) {
  if (shutdown.aborted) return false;
  const run = await reserveQueuedRun(agentType);
  if (!run) return false;
  const { id, dispatchToken, projectId, taskId, revision } = run;
  if (shutdown.aborted || !await startReservedRun(id, dispatchToken)) {
    await releaseRunReservation(id, dispatchToken);
    return false;
  }

  const stopped = new AbortController();
  const signal = AbortSignal.any([shutdown, stopped.signal, AbortSignal.timeout(15 * 60 * 1000)]);
  const heartbeat = (async () => {
    while (!signal.aborted) {
      await setTimeout(15000, undefined, { signal });
      if (!signal.aborted && !await renewRunningRun(id, dispatchToken)) stopped.abort();
    }
  })().catch(() => stopped.abort());
  let result: Awaited<ReturnType<ManagedExecutor>> = undefined;
  try {
    if (!signal.aborted) {
      const context = await getRunExecutionContext(id, dispatchToken);
      if (!context) throw new Error("Run requires a current task revision, a valid lease, and a linked repository.");
      signal.throwIfAborted();
      result = await execute({ id, projectId, taskId, revision, ...context }, signal);
    }
    if (signal.aborted || !await finishReservedRun(id, dispatchToken, "SUCCEEDED", result?.changes, result?.baseCommit)) {
      await finishReservedRun(id, dispatchToken, "FAILED");
    }
  } catch (error) {
    await finishReservedRun(id, dispatchToken, "FAILED");
    throw error;
  } finally {
    stopped.abort();
    await heartbeat;
  }
  return true;
}

export function withManagedCheckout(
  resolveSource: (run: Parameters<ManagedExecutor>[0], signal: AbortSignal) => Promise<{ repository: string; commit: string; cloneToken?: string }>,
  execute: (run: Parameters<ManagedExecutor>[0], checkout: { directory: string; commit: string }, signal: AbortSignal) => Promise<void>,
  reportChanges?: (runId: string, changes: Awaited<ReturnType<typeof listCheckoutChanges>>) => Promise<void>,
): ManagedExecutor {
  return async (run, signal) => {
    signal.throwIfAborted();
    const { repository, commit, cloneToken } = await resolveSource(run, signal);
    return withCheckout(repository, commit, signal, async directory => {
      await execute(run, { directory, commit }, signal);
      signal.throwIfAborted();
      {
        const changes = await listCheckoutChanges(directory, signal);
        signal.throwIfAborted();
        if (reportChanges) await reportChanges(run.id, changes);
        return { changes, baseCommit: commit };
      }
    }, cloneToken);
  };
}
