import { db } from "@devsync/db";

export async function processTaskOutboxEvent(projectId: string | null = null) {
  return db.$transaction(async tx => {
    const [event] = await tx.$queryRaw<{
      id: string; projectId: string; actorId: string; kind: string;
      payload: { taskId: string; revision: number; version: number; message: string };
      createdAt: Date; attempts: number;
    }[]>`
      SELECT "id", "projectId", "actorId", "kind", "payload", "createdAt", "attempts"
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL AND "availableAt" <= timezone('UTC', clock_timestamp())
        AND (${projectId}::text IS NULL OR "projectId" = ${projectId}::text)
      ORDER BY "availableAt", "createdAt", "id"
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!event) return { status: "idle" as const };
    await tx.$executeRaw`SAVEPOINT signal_delivery`;
    try {
      const recipients = await tx.agent.findMany({
        where: { projectId: event.projectId, revokedAt: null, createdAt: { lte: event.createdAt } },
        select: { id: true },
      });
      const deliveries = await tx.signal.createMany({
        data: recipients.map(({ id }) => ({
          projectId: event.projectId,
          senderId: event.actorId,
          recipientId: id,
          kind: event.kind,
          payload: event.payload,
          idempotencyKey: `outbox:${event.id}:${id}`,
        })),
        skipDuplicates: true,
      });
      await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
      return { status: "delivered" as const, count: deliveries.count };
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT signal_delivery`;
      const attempts = event.attempts + 1;
      const delay = Math.min(300, 2 ** Math.min(attempts, 9));
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { attempts, availableAt: new Date(Date.now() + delay * 1000) },
      });
      return { status: "retry" as const, eventId: event.id, attempts, error };
    }
  }, { timeout: 15000 });
}
