/**
 * A task from one of the host's security findings (docs/findings.md): `GET /findings` answers the
 * finding as the host gives it (`host.finding`: redacted, never the match itself) and the open task
 * already linked to it (`linkedTask`). Creating the task is `createTask` with `finding`, which reads
 * the finding again and refuses a second open task for it. Every query filters by the project.
 */
import { type FindingAnswer, FindingQuery } from "@devsync/schemas";
import type { DevSyncHost, ProjectContext } from "../host";
import { hostFinding, parse } from "./common";
import { linkedTask } from "./tasks";

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
