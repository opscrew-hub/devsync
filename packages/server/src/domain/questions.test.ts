/**
 * Questions on a task (docs/host.md, Questions): asked by an agent or a member, answered once by a
 * member or a peer agent, the creator and the asker signalled, and a task a waiting question
 * blocked returned to Ready once its questions asked with `wait` are answered.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { question, signal, task } from "../db";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "../host";
import { hostAgent, refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, fakeToken, type TestDb } from "../testing";
import { reportBlocker } from "./activity";
import { claimTask } from "./claims";
import { exportProject } from "./export";
import { answerAgentQuestion, answerQuestion, askAgentQuestion, askQuestion } from "./questions";
import { publishAgentSignal } from "./signals";
import { createTask, getTask, updateTask } from "./tasks";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A project with an owner, a developer and two agents, Codex and Claude, and another project; a
 * Ready task Codex created and one a member created.
 */
async function setup() {
  const project: ProjectRef = {
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    fullName: "acme/shop",
    readOnly: false,
  };
  const other: ProjectRef = { ...project, projectId: crypto.randomUUID(), fullName: "acme/other" };
  const owner: Member = { userId: crypto.randomUUID(), name: "Ana", role: "owner" };
  const developer: Member = { userId: crypto.randomUUID(), name: "Ben", role: "developer" };
  const host = fakeHost(testDb.db, {
    members: { [project.workspaceId]: [owner, developer] },
    projects: [project, other],
  });
  const member = (who: Member = owner, on: ProjectRef = project): ProjectContext => ({
    project: on,
    member: who,
  });
  const register = async (name: string, on = project): Promise<AgentActor> =>
    (await hostAgent(host, on, { name, kind: "CLAUDE" })).actor;
  const codex = await register("Codex");
  const claude = await register("Claude");
  const outsider = await register("Outsider", other);
  const ready = async (by: ProjectContext | AgentActor, title: string) => {
    const created = await createTask(host, by, {
      requestId: crypto.randomUUID(),
      title,
      description: "Card payments",
      acceptanceCriteria: "Pays",
    });
    return updateTask(host, member(), created.id, { version: created.version, status: "READY" });
  };
  const codexTask = await ready(codex, "Ship checkout");
  const memberTask = await ready(member(), "Add a cart");
  let now = Date.parse(FAKE_NOW);
  /** Moves the clock a second on, so each step's events are ordered. */
  const tick = () => {
    now += 1000;
    setClock(host, now);
  };
  /** The agent's signals, oldest first, as `[kind, payload]`. */
  const inbox = async (to: AgentActor) =>
    (
      await testDb.db
        .select()
        .from(signal)
        .where(
          and(eq(signal.projectId, project.projectId), eq(signal.recipientAgentId, to.agentId)),
        )
        .orderBy(signal.createdAt)
    ).map((s) => [s.kind, s.payload]);
  const claim = async (by: AgentActor, taskId: string) => {
    tick();
    const input = { taskId, claimId: crypto.randomUUID() };
    await claimTask(host, by, input);
    return input;
  };
  return {
    host,
    project,
    other,
    owner,
    developer,
    member,
    codex,
    claude,
    outsider,
    codexTask,
    memberTask,
    tick,
    inbox,
    claim,
  };
}

async function readTask(id: string) {
  const [row] = await testDb.db.select().from(task).where(eq(task.id, id));
  if (!row) throw new Error("no task");
  return row;
}

describe("an agent's question", () => {
  it("signals the task's creator when it is another agent, goes on the timeline, and is asked once", async () => {
    const s = await setup();
    const input = {
      taskId: s.codexTask.id,
      requestId: crypto.randomUUID(),
      text: `Which card network first? Our key is ${fakeToken()}`,
    };
    s.tick();
    const asked = await askAgentQuestion(s.host, s.claude, input);
    expect(asked).toEqual({
      id: asked.id,
      taskId: s.codexTask.id,
      askedBy: { kind: "agent", agentId: s.claude.agentId, name: "Claude" },
      text: "Which card network first? Our key is [redacted]",
      wait: false,
      status: "OPEN",
      answer: null,
      answeredBy: null,
      createdAt: new Date(Date.parse(FAKE_NOW) + 1000).toISOString(),
      answeredAt: null,
    });
    // A retry asks nothing more; the same request id for another question is refused.
    expect(await askAgentQuestion(s.host, s.claude, input)).toEqual(asked);
    const reused = await refusal(
      askAgentQuestion(s.host, s.claude, { ...input, text: "Another?" }),
      "conflict",
    );
    expect(reused.fields).toEqual(["requestId"]);

    expect(await s.inbox(s.codex)).toEqual([
      [
        "clarification.requested",
        { taskId: s.codexTask.id, questionId: asked.id, message: asked.text },
      ],
    ]);
    // The task doesn't move; its detail lists the question and its timeline the event.
    const detail = await getTask(s.host, s.member(), s.codexTask.id);
    expect(detail.status).toBe("READY");
    expect(detail.questions).toEqual([asked]);
    expect(detail.timeline.at(-1)).toMatchObject({
      kind: "question.asked",
      actor: { kind: "agent", agentId: s.claude.agentId },
      message: asked.text,
    });
  });

  it("signals no one on a member's task or the agent's own", async () => {
    const s = await setup();
    await askAgentQuestion(s.host, s.claude, {
      taskId: s.memberTask.id,
      requestId: crypto.randomUUID(),
      text: "Which cart?",
    });
    await askAgentQuestion(s.host, s.codex, {
      taskId: s.codexTask.id,
      requestId: crypto.randomUUID(),
      text: "Note to self?",
    });
    expect(await s.inbox(s.codex)).toEqual([]);
    expect(await s.inbox(s.claude)).toEqual([]);
  });

  it("is refused on a closed task, another project's, a read-only project, and as a member's", async () => {
    const s = await setup();
    const ask = (actor: AgentActor, taskId: string) =>
      askAgentQuestion(s.host, actor, { taskId, requestId: crypto.randomUUID(), text: "Why?" });
    await updateTask(s.host, s.member(), s.memberTask.id, {
      version: s.memberTask.version,
      status: "CANCELLED",
    });
    const closed = await refusal(ask(s.claude, s.memberTask.id), "conflict");
    expect(closed.message).toBe(
      "This task is Cancelled, so it takes no more questions. Ask on an open task.",
    );
    expect((await refusal(ask(s.outsider, s.codexTask.id), "not-found")).message).toBe(
      "There's no such task in this project. Check its id with get_project_state.",
    );
    const frozen = { ...s.claude, project: { ...s.project, readOnly: true } };
    expect((await refusal(ask(frozen, s.codexTask.id), "forbidden")).message).toContain(
      "read-only",
    );
    // A member's question never waits: its input has no `wait`.
    await refusal(
      askQuestion(s.host, s.member(), s.codexTask.id, { text: "Why?", wait: true } as never),
      "invalid",
    );
  });

  it("with wait, ends the asker's claim and blocks the task; without the claim it is refused", async () => {
    const s = await setup();
    const held = await s.claim(s.claude, s.codexTask.id);
    const input = { taskId: held.taskId, requestId: crypto.randomUUID(), text: "Visa or both?" };
    const notHeld = await refusal(
      askAgentQuestion(s.host, s.codex, { ...input, wait: true }),
      "conflict",
    );
    expect(notHeld.message).toBe(
      "Only the agent holding the task's claim can make it wait for an answer. Claim the task first, or ask without wait.",
    );

    const before = await readTask(held.taskId);
    s.tick();
    const asked = await askAgentQuestion(s.host, s.claude, { ...input, wait: true });
    expect(asked).toMatchObject({ wait: true, status: "OPEN" });
    expect(await readTask(held.taskId)).toMatchObject({
      status: "BLOCKED",
      claimAgentId: null,
      claimId: null,
      claimExpiresAt: null,
      blockedByQuestion: true,
      version: before.version + 1,
    });
    // Its retry answers the same question, the claim long gone.
    expect(await askAgentQuestion(s.host, s.claude, { ...input, wait: true })).toEqual(asked);
  });

  it("counts each of the agent's questions and answers against its 20 a minute, signal or not", async () => {
    const s = await setup();
    const publish = () =>
      publishAgentSignal(s.host, s.claude, {
        recipientId: s.codex.agentId,
        kind: "clarification.requested",
        payload: { message: "Which one?" },
        idempotencyKey: crypto.randomUUID(),
      });
    for (let i = 0; i < 17; i++) await publish();
    const ask = (taskId: string, requestId = crypto.randomUUID()) =>
      askAgentQuestion(s.host, s.claude, { taskId, requestId, text: "Why?" });
    // On a member's task: no signal, and still one of the 20.
    const unsignalled = crypto.randomUUID();
    await ask(s.memberTask.id, unsignalled);
    // An answer to a member's question: no signal either.
    const theirs = await askQuestion(s.host, s.member(), s.memberTask.id, { text: "Which cart?" });
    await answerAgentQuestion(s.host, s.claude, { questionId: theirs.id, answer: "Small." });
    // Its signal to Codex counts once, with the question.
    await ask(s.codexTask.id);

    await refusal(ask(s.memberTask.id), "rate-limited");
    await refusal(publish(), "rate-limited");
    const another = await askQuestion(s.host, s.member(), s.memberTask.id, { text: "Colour?" });
    await refusal(
      answerAgentQuestion(s.host, s.claude, { questionId: another.id, answer: "Blue." }),
      "rate-limited",
    );
    // A retry is no new question, and nothing refused was kept.
    expect((await ask(s.memberTask.id, unsignalled)).text).toBe("Why?");
    expect((await getTask(s.host, s.member(), s.codexTask.id)).questions).toHaveLength(1);
    const onMembers = (await getTask(s.host, s.member(), s.memberTask.id)).questions;
    // Asked at the same instant: compared in any order.
    expect(onMembers.map((q) => `${q.text} ${q.status}`).sort()).toEqual([
      "Colour? OPEN",
      "Which cart? ANSWERED",
      "Why? OPEN",
    ]);
  });
});

describe("an answer", () => {
  it("is given once, signals the asking agent, and goes on the timeline", async () => {
    const s = await setup();
    const asked = await askAgentQuestion(s.host, s.claude, {
      taskId: s.memberTask.id,
      requestId: crypto.randomUUID(),
      text: "Which cart?",
    });
    s.tick();
    const answered = await answerQuestion(s.host, s.member(s.developer), asked.id, {
      answer: "The small one.",
    });
    expect(answered).toMatchObject({
      id: asked.id,
      status: "ANSWERED",
      answer: "The small one.",
      answeredBy: { kind: "member", userId: s.developer.userId, name: "Ben" },
      answeredAt: new Date(Date.parse(FAKE_NOW) + 1000).toISOString(),
    });
    // The same answer again by the same member answers it as saved; any other is refused.
    expect(
      await answerQuestion(s.host, s.member(s.developer), asked.id, { answer: "The small one." }),
    ).toEqual(answered);
    expect(
      (await refusal(answerQuestion(s.host, s.member(), asked.id, { answer: "The big one." })))
        .message,
    ).toBe("This question already has an answer. Ask another question if it doesn't settle it.");
    await refusal(
      answerAgentQuestion(s.host, s.codex, { questionId: asked.id, answer: "Either." }),
      "conflict",
    );

    expect(await s.inbox(s.claude)).toEqual([
      [
        "clarification.answered",
        { taskId: s.memberTask.id, questionId: asked.id, message: "The small one." },
      ],
    ]);
    const detail = await getTask(s.host, s.member(), s.memberTask.id);
    expect(detail.questions).toEqual([answered]);
    expect(detail.timeline.at(-1)).toMatchObject({
      kind: "question.answered",
      actor: { kind: "member", userId: s.developer.userId, name: "Ben" },
      message: "The small one.",
    });
  });

  it("from a peer agent is redacted; the asking agent can't answer its own", async () => {
    const s = await setup();
    const asked = await askQuestion(s.host, s.member(), s.codexTask.id, { text: "Which port?" });
    expect(asked.askedBy).toEqual({ kind: "member", userId: s.owner.userId, name: "Ana" });
    // The task's creator is an agent: a member's question signals it too.
    expect(await s.inbox(s.codex)).toEqual([
      [
        "clarification.requested",
        { taskId: s.codexTask.id, questionId: asked.id, message: "Which port?" },
      ],
    ]);
    const secret = fakeToken();
    const answered = await answerAgentQuestion(s.host, s.codex, {
      questionId: asked.id,
      answer: `8080, with ${secret}`,
    });
    expect(answered).toMatchObject({
      answer: "8080, with [redacted]",
      answeredBy: { kind: "agent", agentId: s.codex.agentId, name: "Codex" },
    });
    // A member asked: no answer signal.
    expect(await s.inbox(s.claude)).toEqual([]);

    const own = await askAgentQuestion(s.host, s.claude, {
      taskId: s.codexTask.id,
      requestId: crypto.randomUUID(),
      text: "Mine?",
    });
    expect(
      (
        await refusal(
          answerAgentQuestion(s.host, s.claude, { questionId: own.id, answer: "Yes." }),
          "forbidden",
        )
      ).message,
    ).toBe("An agent can't answer its own question: a member or a peer agent answers it.");
  });

  it("is refused for another project's question, an unknown one, and a role or project that can't write", async () => {
    const s = await setup();
    const asked = await askQuestion(s.host, s.member(), s.memberTask.id, { text: "Which cart?" });
    expect(
      (
        await refusal(
          answerAgentQuestion(s.host, s.outsider, { questionId: asked.id, answer: "No." }),
          "not-found",
        )
      ).message,
    ).toBe("There's no such question in this project. Check its id with get_briefing.");
    await refusal(answerQuestion(s.host, s.member(), "q1", { answer: "No." }), "not-found");
    await refusal(
      answerQuestion(s.host, s.member(), crypto.randomUUID(), { answer: "No." }),
      "not-found",
    );
    const frozen = s.member(s.owner, { ...s.project, readOnly: true });
    await refusal(answerQuestion(s.host, frozen, asked.id, { answer: "No." }), "forbidden");
    await refusal(answerQuestion(s.host, s.member(), asked.id, { answer: " " }), "invalid");
  });

  it("returns a task its waiting question blocked to Ready, one a member moved past not counting", async () => {
    const s = await setup();
    // A first wait, then a member moves the task back to Ready without answering it.
    const first = await s.claim(s.claude, s.memberTask.id);
    const earlierAsk = {
      taskId: first.taskId,
      requestId: crypto.randomUUID(),
      text: "Which cart?",
      wait: true,
    };
    const earlier = await askAgentQuestion(s.host, s.claude, earlierAsk);
    const blocked = await readTask(first.taskId);
    await updateTask(s.host, s.member(), first.taskId, {
      version: blocked.version,
      status: "READY",
    });
    expect(await readTask(first.taskId)).toMatchObject({
      status: "READY",
      blockedByQuestion: false,
    });
    // The member moved past it: it is still open, and the task no longer waits for it.
    expect((await getTask(s.host, s.member(), first.taskId)).questions).toMatchObject([
      { id: earlier.id, status: "OPEN", wait: false },
    ]);
    // Its retry still answers it, its wait cleared.
    expect(await askAgentQuestion(s.host, s.claude, earlierAsk)).toMatchObject({
      id: earlier.id,
      wait: false,
    });

    // A second wait blocks it again: answering that one returns it to Ready.
    await s.claim(s.codex, first.taskId);
    const later = await askAgentQuestion(s.host, s.codex, {
      taskId: first.taskId,
      requestId: crypto.randomUUID(),
      text: "Which colour?",
      wait: true,
    });
    const version = (await readTask(first.taskId)).version;
    s.tick();
    await answerQuestion(s.host, s.member(), later.id, { answer: "Blue." });
    expect(await readTask(first.taskId)).toMatchObject({
      status: "READY",
      blockedByQuestion: false,
      version: version + 1,
    });
    // Claimable again; answering the first changes nothing more.
    await s.claim(s.claude, first.taskId);
    await answerAgentQuestion(s.host, s.codex, { questionId: earlier.id, answer: "Small." });
    expect((await readTask(first.taskId)).status).toBe("CLAIMED");
    const detail = await getTask(s.host, s.member(), first.taskId);
    expect(detail.questions.map((q) => [q.text, q.status, q.wait])).toEqual([
      ["Which cart?", "ANSWERED", false],
      ["Which colour?", "ANSWERED", true],
    ]);
  });

  it("leaves a task a blocker report blocked as it is", async () => {
    const s = await setup();
    const first = await s.claim(s.claude, s.memberTask.id);
    const waited = await askAgentQuestion(s.host, s.claude, {
      taskId: first.taskId,
      requestId: crypto.randomUUID(),
      text: "Which cart?",
      wait: true,
    });
    const blocked = await readTask(first.taskId);
    await updateTask(s.host, s.member(), first.taskId, {
      version: blocked.version,
      status: "READY",
    });
    const again = await s.claim(s.claude, first.taskId);
    await reportBlocker(s.host, s.claude, {
      ...again,
      revision: 1,
      requestId: crypto.randomUUID(),
      message: "The card form is missing.",
    });
    await answerQuestion(s.host, s.member(), waited.id, { answer: "Small." });
    expect(await readTask(first.taskId)).toMatchObject({
      status: "BLOCKED",
      blockedByQuestion: false,
    });
  });

  it("lists a task's open questions first, each group oldest first", async () => {
    const s = await setup();
    const ask = async (text: string) => {
      s.tick();
      return askQuestion(s.host, s.member(), s.memberTask.id, { text });
    };
    const one = await ask("One?");
    const two = await ask("Two?");
    const three = await ask("Three?");
    await answerQuestion(s.host, s.member(), two.id, { answer: "2" });
    await answerQuestion(s.host, s.member(), one.id, { answer: "1" });
    const listed = (await getTask(s.host, s.member(), s.memberTask.id)).questions;
    expect(listed.map((q) => q.id)).toEqual([three.id, one.id, two.id]);
  });
});

/**
 * Writes `count` of the owner's questions on `taskId` straight into the table, a second apart
 * from `from` (in milliseconds), answered when `answered`: many questions without a transaction
 * each.
 */
async function insertQuestions(
  s: Awaited<ReturnType<typeof setup>>,
  taskId: string,
  count: number,
  answered: boolean,
  from = Date.parse(FAKE_NOW),
) {
  const rows = Array.from({ length: count }, (_, n) => {
    const at = new Date(from + n * 1000);
    return {
      workspaceId: s.project.workspaceId,
      projectId: s.project.projectId,
      taskId,
      askerUserId: s.owner.userId,
      text: `Question ${n}?`,
      createdAt: at,
      ...(answered
        ? { answer: `Answer ${n}.`, answererUserId: s.owner.userId, answeredAt: at }
        : {}),
    };
  });
  return testDb.db.insert(question).values(rows).returning({ id: question.id });
}

describe("a task's many questions", () => {
  it("holds a task to 50 open questions, for members and agents alike", async () => {
    const s = await setup();
    const taskId = s.codexTask.id;
    await insertQuestions(s, taskId, 49, false);
    await insertQuestions(s, taskId, 5, true);
    s.tick();
    const fiftieth = { taskId, requestId: crypto.randomUUID(), text: "The fiftieth?" };
    const saved = await askAgentQuestion(s.host, s.claude, fiftieth);

    const full = "This task has 50 open questions. Answer some before asking another.";
    const byMember = await refusal(askQuestion(s.host, s.member(), taskId, { text: "51?" }));
    expect([byMember.code, byMember.message]).toEqual(["conflict", full]);
    const byAgent = await refusal(
      askAgentQuestion(s.host, s.codex, { taskId, requestId: crypto.randomUUID(), text: "51?" }),
    );
    expect([byAgent.code, byAgent.message]).toEqual(["conflict", full]);
    // A retry of a question already saved is no new question: it answers what was saved.
    expect(await askAgentQuestion(s.host, s.claude, fiftieth)).toEqual(saved);
    // Another task takes its own 50.
    await askQuestion(s.host, s.member(), s.memberTask.id, { text: "Elsewhere?" });

    // One answered makes room for one more.
    await answerQuestion(s.host, s.member(), saved.id, { answer: "Yes." });
    s.tick();
    await askQuestion(s.host, s.member(), taskId, { text: "The new fiftieth?" });
    await refusal(askQuestion(s.host, s.member(), taskId, { text: "51?" }), "conflict");
  });

  it("lists every open question and the 50 most recently asked answered ones, counting the rest", async () => {
    const s = await setup();
    const taskId = s.memberTask.id;
    const answered = await insertQuestions(s, taskId, 55, true);
    const open = await insertQuestions(s, taskId, 3, false, Date.parse(FAKE_NOW) + 100_000);

    const detail = await getTask(s.host, s.member(), taskId);
    expect(detail.questions.map((q) => q.id)).toEqual([
      ...open.map((q) => q.id),
      ...answered.slice(5).map((q) => q.id),
    ]);
    expect(detail.answeredNotShown).toBe(5);
    // The export keeps them all.
    const exported = await exportProject(testDb.db, s.project.projectId);
    expect(exported.tasks.find((t) => t.id === taskId)?.questions).toHaveLength(58);

    // With none past the 50, none goes unshown.
    expect((await getTask(s.host, s.member(), s.codexTask.id)).answeredNotShown).toBe(0);
  });
});
