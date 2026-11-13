import { setTimeout } from "node:timers/promises";
import { finishReservedRun, getRunExecutionContext, releaseRunReservation, renewRunningRun, reserveQueuedRun, startReservedRun } from "@devsync/core/runs";

type ExecutionContext = NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>;
type Reservation = NonNullable<Awaited<ReturnType<typeof reserveQueuedRun>>>;
export type ManagedExecutor = (
  run: Pick<Reservation, "id" | "projectId" | "taskId" | "revision"> & ExecutionContext,
  signal: AbortSignal,
) => Promise<void>;

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
  try {
    if (!signal.aborted) {
      const context = await getRunExecutionContext(id, dispatchToken);
      if (!context) throw new Error("Run requires a current task revision, a valid lease, and a linked repository.");
      signal.throwIfAborted();
      await execute({ id, projectId, taskId, revision, ...context }, signal);
    }
    if (signal.aborted || !await finishReservedRun(id, dispatchToken, "SUCCEEDED")) {
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
