import { db } from "@devsync/db";

export async function readProjectRealtimeVersion(userId: string, projectId: string) {
  const [member] = await db.$queryRaw<{ version: bigint }[]>`
    SELECT COALESCE(realtime."version", 0) AS "version"
    FROM "ProjectMember" member
    LEFT JOIN "ProjectRealtime" realtime ON realtime."projectId" = member."projectId"
    WHERE member."projectId" = ${projectId} AND member."userId" = ${userId}
  `;
  return member?.version.toString() ?? null;
}
