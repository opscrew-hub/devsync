/**
 * DevSync's queues (docs/host.md, Queues), run by the host's worker: `jobs` from
 * `@devsync/server`. The host registers each under its name and calls its handler with the job's
 * payload and the `DevSyncHost` it builds over its own deps. Each handler validates its payload
 * first; payloads hold ids and the GitHub fact only.
 */
import { z } from "zod";
import { deliverDue } from "./domain/delivery";
import { applyGithubFact, GithubJob } from "./domain/pull-requests";
import type { DevSyncHost, QueueName } from "./host";

/** A queue, as the host's worker runs it: the shape of the host's own jobs. */
export interface DevSyncJob {
  handler(payload: unknown, host: DevSyncHost): Promise<void>;
  /** A cron entry, in UTC. */
  cron?: string;
  /** How often the host retries a job that failed. */
  retryLimit: number;
  retryBackoff?: boolean;
}

/** How many events one `deliverDue` call takes. */
const OUTBOX_BATCH = 100;
/**
 * The most `deliverDue` calls one job makes, so it can't run forever: what is left is delivered by
 * the next job, at the latest the next minute's.
 */
const OUTBOX_MAX_BATCHES = 50;

/** `devsync.outbox`'s payload: a project's wake-up (`wakeOutbox`), or the cron's empty one. */
const OutboxJob = z.object({ projectId: z.uuid().optional() }).nullish();

/** Parses a job's payload, refusing it with the invalid fields' names (never their values). */
function parsePayload<T extends z.ZodType>(queue: QueueName, schema: T, payload: unknown) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data as z.output<T>;
  const fields = [
    ...new Set(result.error.issues.map((issue) => issue.path.join(".") || "payload")),
  ];
  throw new Error(`DevSync's ${queue} job has an invalid payload: ${fields.join(", ")}.`);
}

export const jobs = {
  /** Delivers the due outbox events, every project's, until none is due. */
  "devsync.outbox": {
    async handler(payload, host) {
      parsePayload("devsync.outbox", OutboxJob, payload);
      for (let batch = 0; batch < OUTBOX_MAX_BATCHES; batch++) {
        if ((await deliverDue(host, OUTBOX_BATCH)) === 0) return;
      }
    },
    cron: "* * * * *",
    retryLimit: 3,
  },
  /** Applies one GitHub fact to its project, once per delivery. */
  "devsync.github": {
    async handler(payload, host) {
      await applyGithubFact(host, parsePayload("devsync.github", GithubJob, payload));
    },
    retryLimit: 5,
    retryBackoff: true,
  },
} satisfies Record<QueueName, DevSyncJob>;
