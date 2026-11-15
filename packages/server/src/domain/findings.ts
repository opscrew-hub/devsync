/**
 * A task from one of the host's security findings (docs/findings.md): `GET /findings` answers the
 * finding as the host gives it (`host.finding`: redacted, never the match itself) and the task
 * already linked to it, so the same finding never gets a second task. Creating the task is
 * `createTask` with `finding`, which reads the finding again. Every query filters by the project.
 */
import { type Finding, type FindingAnswer, FindingQuery, type Task } from "@devsync/schemas";
import { and, eq, isNull, ne } from "drizzle-orm";
import { task } from "../db";
import type { DevSyncDb, DevSyncHost, ProjectContext, ProjectRef } from "../host";
import { hostFinding, parse } from "./common";
import { selectTasks, toTask } from "./tasks";

/**
 * `GET /findings?fingerprint=`: any member. A fingerprint outside its character set is refused
 * before the host is asked; a finding the host doesn't give is refused `not-found`.
 */
export async function findingTask(
  host: DevSyncHost,
  ctx: ProjectContext,
  query: FindingQuery,
): Promise<FindingAnswer> {
  const { fingerprint } = parse(FindingQuery, query);
  const finding = await hostFinding(host, ctx.project, fingerprint);
  return { finding, task: await linkedTask(host.db, ctx.project, finding) };
}

/**
 * The task linked to `finding`: the latest made from the same fingerprint, whatever its status;
 * else, since the fingerprint includes the line and changes when code above it moves, the latest
 * open one (not Done) made from a finding with the same rule and file.
 */
async function linkedTask(
  db: DevSyncDb,
  project: ProjectRef,
  finding: Finding,
): Promise<Task | null> {
  const ofProject = and(
    eq(task.projectId, project.projectId),
    eq(task.workspaceId, project.workspaceId),
  );
  const [same] = await selectTasks(
    db,
    and(ofProject, eq(task.findingFingerprint, finding.fingerprint)),
  ).limit(1);
  if (same) return toTask(same.task, same.claimAgentName);
  const [open] = await selectTasks(
    db,
    and(
      ofProject,
      eq(task.findingRule, finding.ruleId),
      finding.file === null ? isNull(task.findingFile) : eq(task.findingFile, finding.file),
      ne(task.status, "DONE"),
    ),
  ).limit(1);
  return open ? toTask(open.task, open.claimAgentName) : null;
}
