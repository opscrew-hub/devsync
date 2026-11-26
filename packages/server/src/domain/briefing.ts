/**
 * `get_briefing` (docs/host.md, MCP for coding agents): what an agent reads before it starts on a
 * task. The task (title, description, acceptance criteria, status, revision), its open questions
 * and its answered ones, its paths, the tasks it waits for with their statuses, the open tasks
 * sharing its paths, and the context the host gives for its title (`host.context`, as the caller
 * may see it; a managed run gets none, as the host takes no run there), within 8,000 characters of
 * JSON. Past them the context is cut first, from its last entry (its facts before its
 * instructions), then the answered questions, the oldest first, then the overlaps, the newest first,
 * then the open questions, the newest first; `omitted` counts what was cut, with the older answered
 * questions and the overlaps the task's detail leaves out. Only the task, with its paths and waits,
 * is never cut, so it alone may pass 8,000. Each entry, question and overlap is measured once and
 * the briefing once, so the cut is linear in them.
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
  /** The open questions, oldest first; cut from the newest. */
  openQuestions: Question[];
  /** The answered questions, oldest first; cut from the oldest. */
  answeredQuestions: Question[];
  owns: string[];
  waitsFor: TaskSummary[];
  overlaps: TaskDetail["overlaps"];
  context: ContextBlock;
  /** How many context entries, questions and overlaps were cut to keep within 8,000 characters. */
  omitted: {
    contextEntries: number;
    answeredQuestions: number;
    openQuestions: number;
    overlaps: number;
  };
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

/** How many characters `n` takes in JSON. */
const digits = (n: number) => String(n).length;

/**
 * `get_briefing`: the task's briefing for `reader`, a member, an agent or a managed run, within
 * 8,000 characters of JSON (the context cut first, then the oldest answered questions, then the
 * newest overlaps, then the newest open questions).
 */
export async function getBriefing(
  host: DevSyncHost,
  reader: TaskReader,
  taskId: string,
): Promise<Briefing> {
  const detail = await getTask(host, reader, taskId);
  const context = await contextFor(host, reader, detail.title);
  const open = detail.questions.filter((q) => q.status === "OPEN");
  const answered = detail.questions.filter((q) => q.status === "ANSWERED");
  const entries = context.instructions.length + context.facts.length;
  const notShown = detail.answeredNotShown;
  const { overlaps, overlapsNotShown } = detail;

  /**
   * The briefing with its first `kept` context entries, last `answers`, first `asked` and first
   * `shared` overlaps.
   */
  const briefing = (kept: number, answers: number, asked: number, shared: number): Briefing => ({
    task: {
      id: detail.id,
      title: detail.title,
      description: detail.description,
      acceptanceCriteria: detail.acceptanceCriteria,
      status: detail.status,
      revision: detail.revision,
    },
    openQuestions: open.slice(0, asked),
    answeredQuestions: answered.slice(answered.length - answers),
    owns: detail.owns,
    waitsFor: detail.dependencies,
    overlaps: overlaps.slice(0, shared),
    context: {
      instructions: context.instructions.slice(0, kept),
      facts: context.facts.slice(0, Math.max(0, kept - context.instructions.length)),
    },
    omitted: {
      contextEntries: entries - kept,
      answeredQuestions: notShown + answered.length - answers,
      openQuestions: open.length - asked,
      overlaps: overlapsNotShown + overlaps.length - shared,
    },
  });
  let kept = entries;
  let answers = answered.length;
  let asked = open.length;
  let shared = overlaps.length;
  // The whole briefing is measured once, and each item once: cutting one takes its JSON away, with
  // the comma beside it unless it was its list's last, and its `omitted` count grows by one.
  let length = JSON.stringify(briefing(kept, answers, asked, shared)).length;
  /** Cuts `item`, one of `inList` items in its list, whose `omitted` count is `omitted`. */
  const cut = (item: unknown, inList: number, omitted: number) => {
    length -= JSON.stringify(item).length + (inList > 1 ? 1 : 0);
    length += digits(omitted + 1) - digits(omitted);
  };
  const { instructions, facts } = context;
  for (; kept > 0 && length > BRIEFING_LIMIT; kept--) {
    const fact = kept > instructions.length;
    const item = fact ? facts[kept - 1 - instructions.length] : instructions[kept - 1];
    cut(item, fact ? kept - instructions.length : kept, entries - kept);
  }
  for (; answers > 0 && length > BRIEFING_LIMIT; answers--) {
    cut(answered[answered.length - answers], answers, notShown + answered.length - answers);
  }
  for (; shared > 0 && length > BRIEFING_LIMIT; shared--) {
    cut(overlaps[shared - 1], shared, overlapsNotShown + overlaps.length - shared);
  }
  for (; asked > 0 && length > BRIEFING_LIMIT; asked--) {
    cut(open[asked - 1], asked, open.length - asked);
  }
  return briefing(kept, answers, asked, shared);
}
