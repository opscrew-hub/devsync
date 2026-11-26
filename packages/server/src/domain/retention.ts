/**
 * What DevSync deletes as it ages (docs/host.md, Queues): the daily `devsync.retention` job deletes
 * the signals acknowledged over 30 days ago, every project's. Delivered outbox events stay, as they
 * are the tasks' timelines, and so do a task's revisions, comments and questions, which a task holds
 * a bounded number of.
 */
import { and, eq, lt, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { signal } from "../db";
import type { DevSyncHost } from "../host";
import { MAX_HOPS } from "./signals";

/** How long DevSync keeps a signal once its agent acknowledged it. */
export const SIGNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes the signals acknowledged over 30 days ago. A signal's replies go with it (its
 * `reply_to_id` cascades), so each pass deletes only those that no reply answers: a conversation goes
 * from its last reply, a pass a reply, once all of it is old enough, and one still holding a newer
 * or unacknowledged reply stays whole. A conversation holds at most four replies, so five passes
 * delete the longest.
 */
export async function purgeSignals(host: DevSyncHost): Promise<void> {
  const cutoff = new Date(host.clock.now().getTime() - SIGNAL_RETENTION_MS);
  const reply = alias(signal, "reply");
  for (let pass = 0; pass <= MAX_HOPS; pass++) {
    await host.db
      .delete(signal)
      .where(
        and(
          lt(signal.acknowledgedAt, cutoff),
          notExists(
            host.db.select({ id: reply.id }).from(reply).where(eq(reply.replyToId, signal.id)),
          ),
        ),
      );
  }
}
