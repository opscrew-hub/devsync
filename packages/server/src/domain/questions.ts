/**
 * Questions on a task (docs/host.md, Questions). An agent asks with `ask_question`, idempotent by
 * its `requestId`, and a member on the task's panel; the task's creator, when it is another agent,
 * gets a `clarification.requested` signal. With `wait`, the agent holding the task's claim ends it
 * and the task moves to Blocked, as a blocker does. A member answers on the panel and an agent with
 * `answer_question`, once, never its own question; the asker, when it is an agent, gets
 * `clarification.answered`. A task a question's `wait` blocked (`blocked_by_question`) returns to
 * Ready once none of its open questions has `wait`; when it leaves Blocked another way, the flag and
 * its open questions' `wait` are cleared, so only the current block's question counts, and a task
 * blocked by a blocker report or a member's move stays Blocked. Each question and answer of an
 * agent counts against its 20 signals a minute, signal or not. Asking and answering are timeline
 * events of the task (`question.asked`, `question.answered`) with their host events; an agent's
 * text passes the host's redactor before it is stored. Every query filters by the project.
 */
import { randomUUID } from "node:crypto";
import {
  AnswerInput,
  AnswerQuestionInput,
  AskQuestionInput,
  Id,
  type Question,
  QuestionInput,
  STATUS_LABEL,
  type TaskStatus,
} from "@devsync/schemas";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { agent, type QuestionRow, question, signal, type TaskRow, task } from "../db";
import {
  type AgentActor,
  type DevSyncDb,
  DevSyncError,
  type DevSyncHost,
  type ProjectContext,
  type ProjectRef,
} from "../host";
import {
  authorOf,
  lockAgentRow,
  type Names,
  namesOf,
  parse,
  REFUSAL,
  requireRole,
  requireSignalRate,
  requireWritable,
  taskIdOf,
  taskIn,
} from "./common";
import { type OutboxActor, outbox } from "./outbox";

/** Who asks or answers: a member on the task's panel, or an agent through its actions. */
type QuestionActor = ProjectContext | AgentActor;

function isAgent(actor: QuestionActor): actor is AgentActor {
  return "kind" in actor && actor.kind === "agent";
}

function actorIds(actor: QuestionActor): NonNullable<OutboxActor> {
  return isAgent(actor) ? { agentId: actor.agentId } : { userId: actor.member.userId };
}

/** The statuses of a task that takes no more questions. */
const CLOSED: readonly TaskStatus[] = ["DONE", "CANCELLED"];

const REQUEST_REUSED =
  "This request ID was already used for another question. Send the question with a new request ID.";

// --- Reads --------------------------------------------------------------------------------------

/** The task's questions: the open ones first, each group oldest first. */
export function selectQuestions(db: DevSyncDb, project: ProjectRef, taskId: string) {
  return db
    .select()
    .from(question)
    .where(and(eq(question.taskId, taskId), eq(question.projectId, project.projectId)))
    .orderBy(sql`${question.answeredAt} is not null`, asc(question.createdAt), asc(question.id));
}

/** The agents a question names: its asker and its answerer, when they are agents. */
export function questionAgentIds(row: QuestionRow): string[] {
  return [row.askerAgentId, row.answererAgentId].filter((id): id is string => id !== null);
}

/** A question's row as `Question`, its asker and answerer named by `names`. */
export function toQuestion(row: QuestionRow, names: Names): Question {
  const askedBy = authorOf(names, row.askerUserId, row.askerAgentId);
  if (!askedBy) throw new Error("A question has no asker.");
  return {
    id: row.id,
    taskId: row.taskId,
    askedBy,
    text: row.text,
    wait: row.wait,
    status: row.answeredAt ? "ANSWERED" : "OPEN",
    answer: row.answer,
    answeredBy: row.answeredAt ? authorOf(names, row.answererUserId, row.answererAgentId) : null,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

/** One question as `Question`, its asker and answerer named as they are now. */
async function namedQuestion(host: DevSyncHost, project: ProjectRef, row: QuestionRow) {
  const agentIds = questionAgentIds(row);
  const [members, agents] = await Promise.all([
    host.members(project.workspaceId),
    agentIds.length === 0
      ? Promise.resolve([])
      : host.db
          .select({ id: agent.id, name: agent.name })
          .from(agent)
          .where(and(eq(agent.projectId, project.projectId), inArray(agent.id, agentIds))),
  ]);
  const names: Names = {
    members: namesOf(members),
    agents: new Map(agents.map((a) => [a.id, a.name])),
  };
  return toQuestion(row, names);
}

// --- Writes -------------------------------------------------------------------------------------

/**
 * Clears `wait` on the task's open questions in `tx`: the task left the Blocked their wait put it
 * in (`updateTask`), so they no longer hold it.
 */
export async function releaseWaitingQuestions(
  tx: DevSyncDb,
  project: ProjectRef,
  taskId: string,
): Promise<void> {
  await tx
    .update(question)
    .set({ wait: false })
    .where(
      and(
        eq(question.taskId, taskId),
        eq(question.projectId, project.projectId),
        eq(question.wait, true),
        isNull(question.answeredAt),
      ),
    );
}

/**
 * The task's row in the project, locked for the rest of `tx` (`no key update`, as an edit locks
 * it, so a dependency written on it meanwhile doesn't wait).
 */
async function lockTask(tx: DevSyncDb, actor: QuestionActor, taskId: string): Promise<TaskRow> {
  const [row] = await tx
    .select()
    .from(task)
    .where(taskIn(actor.project, taskId))
    .for("no key update");
  if (!row) {
    throw new DevSyncError(
      "not-found",
      isAgent(actor) ? REFUSAL.noSuchTaskForAgent : REFUSAL.noSuchTask,
    );
  }
  return row;
}

/**
 * Signals agent `recipientId` about the question in `tx`, from `sender`, with `message`: nothing
 * when its row is gone or revoked.
 */
async function signalAbout(
  tx: DevSyncDb,
  sender: QuestionActor,
  recipientId: string,
  kind: "clarification.requested" | "clarification.answered",
  row: QuestionRow,
  message: string,
  now: Date,
): Promise<void> {
  const { workspaceId, projectId } = sender.project;
  const [recipient] = await tx
    .select({ revokedAt: agent.revokedAt })
    .from(agent)
    .where(and(eq(agent.id, recipientId), eq(agent.projectId, projectId)));
  if (!recipient || recipient.revokedAt) return;
  await tx.insert(signal).values({
    workspaceId,
    projectId,
    recipientAgentId: recipientId,
    senderUserId: isAgent(sender) ? null : sender.member.userId,
    senderAgentId: isAgent(sender) ? sender.agentId : null,
    kind,
    payload: { taskId: row.taskId, questionId: row.id, message },
    // The question itself makes a retry send nothing more: each signal is new.
    idempotencyKey: randomUUID(),
    createdAt: now,
  });
}

/** Refuses a write to a read-only project, and a member whose role may not change tasks. */
function requireWrite(actor: QuestionActor): void {
  requireWritable(actor.project);
  if (!isAgent(actor)) requireRole(actor.member.role, "task.write");
}

/** A question to ask: its text (an agent's redacted), whether the task waits, an agent's request. */
interface Asked {
  taskId: string;
  text: string;
  wait: boolean;
  requestId: string | null;
}

async function ask(host: DevSyncHost, actor: QuestionActor, asked: Asked): Promise<Question> {
  const { project } = actor;
  const { taskId, text, wait, requestId } = asked;
  const asker = actorIds(actor);
  const askerAgentId = "agentId" in asker ? asker.agentId : null;
  const now = host.clock.now();
  const result = await host.db.transaction(async (tx) => {
    if (isAgent(actor)) {
      // One agent's questions one at a time, so a retry finds what the first attempt saved and its
      // signal limit holds.
      await lockAgentRow(tx, actor);
      const [existing] = requestId
        ? await tx
            .select()
            .from(question)
            .where(
              and(
                eq(question.projectId, project.projectId),
                eq(question.askerAgentId, actor.agentId),
                eq(question.requestId, requestId),
              ),
            )
        : [];
      // The same task and text: its `wait` may have been cleared since, as the task moved on.
      if (existing) {
        if (existing.taskId !== taskId || existing.text !== text) {
          throw new DevSyncError("conflict", REQUEST_REUSED, ["requestId"]);
        }
        return { row: existing, created: false };
      }
      await requireSignalRate(tx, actor, now);
    }

    const current = await lockTask(tx, actor, taskId);
    if (CLOSED.includes(current.status)) {
      throw new DevSyncError(
        "conflict",
        `This task is ${STATUS_LABEL[current.status]}, so it takes no more questions. Ask on an open task.`,
      );
    }
    const holdsClaim =
      askerAgentId !== null &&
      current.status === "CLAIMED" &&
      current.claimAgentId === askerAgentId &&
      current.claimExpiresAt !== null &&
      current.claimExpiresAt.getTime() > now.getTime();
    if (wait && !holdsClaim) {
      throw new DevSyncError(
        "conflict",
        "Only the agent holding the task's claim can make it wait for an answer. Claim the task first, or ask without wait.",
      );
    }

    const [row] = await tx
      .insert(question)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        taskId,
        askerUserId: "userId" in asker ? asker.userId : null,
        askerAgentId,
        requestId,
        text,
        wait,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("The question wasn't saved.");
    // With `wait`, as a blocker: the claim ends and the task moves to Blocked, by this question.
    if (wait) {
      await tx
        .update(task)
        .set({
          status: "BLOCKED",
          claimAgentId: null,
          claimId: null,
          claimExpiresAt: null,
          blockedByQuestion: true,
          version: sql`${task.version} + 1`,
          updatedAt: now,
        })
        .where(taskIn(project, taskId));
    }
    if (current.creatorAgentId && current.creatorAgentId !== askerAgentId) {
      const kind = "clarification.requested";
      await signalAbout(tx, actor, current.creatorAgentId, kind, row, text, now);
    }
    await outbox.record(host, tx, {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      actor: asker,
      taskId,
      kind: "question.asked",
      payload: { taskId, questionId: row.id, message: text },
      at: now,
      facts:
        wait && askerAgentId
          ? { status: { from: current.status, to: "BLOCKED" }, released: askerAgentId }
          : {},
    });
    return { row, created: true };
  });
  if (result.created) await outbox.wake(host, project.projectId);
  return namedQuestion(host, project, result.row);
}

/**
 * `POST /tasks/:taskId/questions` (`task.write`): a member's question on an open task. The task's
 * creator, when it is an agent, is signalled.
 */
export async function askQuestion(
  host: DevSyncHost,
  ctx: ProjectContext,
  taskId: string,
  input: QuestionInput,
): Promise<Question> {
  requireWrite(ctx);
  const { text } = parse(QuestionInput, input);
  return ask(host, ctx, { taskId: taskIdOf(taskId), text, wait: false, requestId: null });
}

/**
 * `ask_question`: an agent's question on an open task, idempotent by its `requestId`; the task's
 * creator, when it is another agent, is signalled. With `wait`, the agent must hold the task's
 * claim: it ends, and the task moves to Blocked until its questions asked with `wait` are answered.
 */
export async function askAgentQuestion(
  host: DevSyncHost,
  actor: AgentActor,
  input: AskQuestionInput,
): Promise<Question> {
  requireWrite(actor);
  const { taskId, requestId, text, wait = false } = parse(AskQuestionInput, input);
  // Redacted before it is stored, and before a retry's is compared with the stored one.
  return ask(host, actor, { taskId, text: host.redact(text), wait, requestId });
}

async function answer(
  host: DevSyncHost,
  actor: QuestionActor,
  questionId: string,
  text: string,
): Promise<Question> {
  const { project } = actor;
  const noSuchQuestion = () =>
    new DevSyncError(
      "not-found",
      isAgent(actor)
        ? "There's no such question in this project. Check its id with get_briefing."
        : "There's no such question in this project.",
    );
  if (!Id.safeParse(questionId).success) throw noSuchQuestion();
  const answerer = actorIds(actor);
  const answererUserId = "userId" in answerer ? answerer.userId : null;
  const answererAgentId = "agentId" in answerer ? answerer.agentId : null;
  const now = host.clock.now();
  const result = await host.db.transaction(async (tx) => {
    if (isAgent(actor)) await lockAgentRow(tx, actor);
    const asked = and(
      eq(question.id, questionId),
      eq(question.projectId, project.projectId),
      eq(question.workspaceId, project.workspaceId),
    ) as SQL;
    const [found] = await tx.select({ taskId: question.taskId }).from(question).where(asked);
    if (!found) throw noSuchQuestion();
    // The task first, then the question: a task's questions are answered one at a time, so the
    // last answer to its questions asked with `wait` returns it to Ready once.
    const current = await lockTask(tx, actor, found.taskId);
    const [row] = await tx.select().from(question).where(asked).for("update");
    if (!row) throw noSuchQuestion();
    if (answererAgentId !== null && row.askerAgentId === answererAgentId) {
      throw new DevSyncError(
        "forbidden",
        "An agent can't answer its own question: a member or a peer agent answers it.",
      );
    }
    if (row.answeredAt) {
      const same =
        row.answer === text &&
        row.answererUserId === answererUserId &&
        row.answererAgentId === answererAgentId;
      if (!same) {
        throw new DevSyncError(
          "conflict",
          "This question already has an answer. Ask another question if it doesn't settle it.",
        );
      }
      return { row, created: false };
    }
    if (isAgent(actor)) await requireSignalRate(tx, actor, now);

    const [saved] = await tx
      .update(question)
      .set({ answer: text, answererUserId, answererAgentId, answeredAt: now })
      .where(asked)
      .returning();
    if (!saved) throw new Error("The answer wasn't saved.");
    let returns = false;
    if (current.status === "BLOCKED" && current.blockedByQuestion) {
      const [waiting] = await tx
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            eq(question.taskId, current.id),
            eq(question.projectId, project.projectId),
            eq(question.wait, true),
            isNull(question.answeredAt),
          ),
        )
        .limit(1);
      returns = waiting === undefined;
    }
    if (returns) {
      await tx
        .update(task)
        .set({
          status: "READY",
          blockedByQuestion: false,
          version: sql`${task.version} + 1`,
          updatedAt: now,
        })
        .where(taskIn(project, current.id));
    }
    if (saved.askerAgentId) {
      const kind = "clarification.answered";
      await signalAbout(tx, actor, saved.askerAgentId, kind, saved, text, now);
    }
    await outbox.record(host, tx, {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      actor: answerer,
      taskId: current.id,
      kind: "question.answered",
      payload: { taskId: current.id, questionId: saved.id, message: text },
      at: now,
      facts: returns ? { status: { from: "BLOCKED", to: "READY" } } : {},
    });
    return { row: saved, created: true };
  });
  if (result.created) await outbox.wake(host, project.projectId);
  return namedQuestion(host, project, result.row);
}

/**
 * `POST /questions/:questionId/answer` (`task.write`): a member's answer to one of the project's
 * open questions, once; the same answer again by the same member answers it as saved.
 */
export async function answerQuestion(
  host: DevSyncHost,
  ctx: ProjectContext,
  questionId: string,
  input: AnswerInput,
): Promise<Question> {
  requireWrite(ctx);
  const fields = parse(AnswerInput, input);
  return answer(host, ctx, questionId, fields.answer);
}

/**
 * `answer_question`: an agent's answer to an open question of the project, once and never to its
 * own; the same answer again answers it as saved.
 */
export async function answerAgentQuestion(
  host: DevSyncHost,
  actor: AgentActor,
  input: AnswerQuestionInput,
): Promise<Question> {
  requireWrite(actor);
  const fields = parse(AnswerQuestionInput, input);
  // Redacted before it is stored, and before a retry's is compared with the stored one.
  return answer(host, actor, fields.questionId, host.redact(fields.answer));
}
