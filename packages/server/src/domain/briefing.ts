/**
 * `get_briefing` (docs/host.md, MCP for coding agents): what an agent reads before it starts on a
 * task. The task (title, description, acceptance criteria, status, revision), its open questions
 * and its answered ones, its paths, the tasks it waits for with their statuses, the open tasks
 * sharing its paths, and the context the host gives for its title (`host.context`, as the caller
 * may see it; a managed run gets none, as the host takes no run there), within 8,000 characters of
 * JSON. Past them the context is cut first, from its last entry (its facts before its
 * instructions), then the answered questions, the oldest first; the task, its open questions, paths,
 * waits and overlaps are kept whole, even past 8,000. `omitted` counts what was cut.
 */
import type { Question, TaskDetail, TaskSummary } from "@devsync/schemas";
import { z } from "zod";
import type { ContextBlock, DevSyncHost } from "../host";
import { getTask, type TaskReader } from "./tasks";

/** The most characters of JSON a briefing takes, unless its task alone takes more. */
export const BRIEFING_LIMIT = 8_000;

/** The host's `ContextEntry`, checked before DevSync passes it on: only the contract's fields. */
const ContextEntry = z.object({
  source: z.string(),
  kind: z.enum(["instruction", "fact", "event"]),
  author: z.string(),
  trust: z.enum(["trusted", "untrusted"]),
  text: z.string(),
});
const HostContext = z.object({
  instructions: z.array(ContextEntry),
  facts: z.array(ContextEntry),
});

/** `get_briefing`'s answer. */
export interface Briefing {
  task: Pick<
    TaskDetail,
    "id" | "title" | "description" | "acceptanceCriteria" | "status" | "revision"
  >;
  openQuestions: Question[];
  /** The answered questions, each oldest first; cut from the oldest. */
  answeredQuestions: Question[];
  owns: string[];
  waitsFor: TaskSummary[];
  overlaps: TaskDetail["overlaps"];
  context: ContextBlock;
  /** How many context entries and answered questions were cut to keep within 8,000 characters. */
  omitted: { contextEntries: number; answeredQuestions: number };
}

const NO_CONTEXT: ContextBlock = { instructions: [], facts: [] };

/**
 * The host's context for `subject`, as the reader may see it: a member's or an agent's, none for a
 * managed run. An answer that doesn't parse is logged (where, never its text) and gives none.
 */
async function contextFor(
  host: DevSyncHost,
  reader: TaskReader,
  subject: string,
): Promise<ContextBlock> {
  const { projectId } = reader.project;
  const caller =
    "member" in reader
      ? { projectId, userId: reader.member.userId }
      : "agentId" in reader
        ? { projectId, agentId: reader.agentId }
        : null;
  if (!caller) return NO_CONTEXT;
  const parsed = HostContext.safeParse(await host.context(caller, { subject }));
  if (parsed.success) return parsed.data;
  const paths = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
  host.log.error(
    `The host's context doesn't match DevSync's schema at ${paths.join(", ")}; the briefing has none.`,
  );
  return NO_CONTEXT;
}

/** The largest count up to `total` that `fits`, or 0: `fits` holds for every count below one that does. */
function most(total: number, fits: (count: number) => boolean): number {
  if (fits(total)) return total;
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * `get_briefing`: the task's briefing for `reader`, a member, an agent or a managed run, within
 * 8,000 characters of JSON (the context cut first, then the oldest answered questions).
 */
export async function getBriefing(
  host: DevSyncHost,
  reader: TaskReader,
  taskId: string,
): Promise<Briefing> {
  const detail = await getTask(host, reader, taskId);
  const context = await contextFor(host, reader, detail.title);
  const answered = detail.questions.filter((q) => q.status === "ANSWERED");
  const entries = [...context.instructions, ...context.facts];

  /** The briefing with the first `kept` context entries and the latest `latest` answers. */
  const briefing = (kept: number, latest: number): Briefing => ({
    task: {
      id: detail.id,
      title: detail.title,
      description: detail.description,
      acceptanceCriteria: detail.acceptanceCriteria,
      status: detail.status,
      revision: detail.revision,
    },
    openQuestions: detail.questions.filter((q) => q.status === "OPEN"),
    answeredQuestions: answered.slice(answered.length - latest),
    owns: detail.owns,
    waitsFor: detail.dependencies,
    overlaps: detail.overlaps,
    context: {
      instructions: context.instructions.slice(0, kept),
      facts: context.facts.slice(0, Math.max(0, kept - context.instructions.length)),
    },
    omitted: { contextEntries: entries.length - kept, answeredQuestions: answered.length - latest },
  });
  const fits = (b: Briefing) => JSON.stringify(b).length <= BRIEFING_LIMIT;

  const kept = most(entries.length, (count) => fits(briefing(count, answered.length)));
  const latest =
    kept > 0 || fits(briefing(0, answered.length))
      ? answered.length
      : most(answered.length, (count) => fits(briefing(0, count)));
  return briefing(kept, latest);
}
