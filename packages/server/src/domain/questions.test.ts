/**
 * Questions on a task (docs/host.md, Questions): asked by an agent or a member, answered once by a
 * member or a peer agent, the creator and the asker signalled, and a task a waiting question
 * blocked returned to Ready once its questions asked with `wait` are answered.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signal, task } from "../db";
import type { AgentActor, Member, ProjectContext, ProjectRef } from "../host";
import { hostAgent, refusal, setClock } from "../test/helpers";
import { createTestDb, FAKE_NOW, fakeHost, fakeToken, type TestDb } from "../testing";
import { reportBlocker } from "./activity";
import { claimTask } from "./claims";
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
    await refusal(askAgentQuestion(s.host, s.claude, { ...input, wait: true }), "conflict");

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

  it("counts its signal against the agent's 20 a minute, with what it published", async () => {
    const s = await setup();
    for (let i = 0; i < 19; i++) {
      await publishAgentSignal(s.host, s.claude, {
        recipientId: s.codex.agentId,
        kind: "clarification.requested",
        payload: { message: `Question ${i}` },
        idempotencyKey: crypto.randomUUID(),
      });
    }
    const ask = (taskId: string) =>
      askAgentQuestion(s.host, s.claude, { taskId, requestId: crypto.randomUUID(), text: "Why?" });
    await ask(s.codexTask.id);
    // The 21st signal is refused, and the question that would send it isn't saved.
    await refusal(ask(s.codexTask.id), "rate-limited");
    await refusal(
      publishAgentSignal(s.host, s.claude, {
        recipientId: s.codex.agentId,
        kind: "clarification.requested",
        payload: { message: "One more" },
        idempotencyKey: crypto.randomUUID(),
      }),
      "rate-limited",
    );
    expect((await getTask(s.host, s.member(), s.codexTask.id)).questions).toHaveLength(1);
    // A question that signals no one isn't held back.
    await ask(s.memberTask.id);
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

  it("returns a task its waiting questions blocked to Ready once they are all answered", async () => {
    const s = await setup();
    // A first wait, then a member moves the task back to Ready without answering it.
    const first = await s.claim(s.claude, s.memberTask.id);
    const earlier = await askAgentQuestion(s.host, s.claude, {
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
    expect(await readTask(first.taskId)).toMatchObject({
      status: "READY",
      blockedByQuestion: false,
    });

    // A second wait blocks it again: answering it leaves the first one waiting.
    await s.claim(s.codex, first.taskId);
    const later = await askAgentQuestion(s.host, s.codex, {
      taskId: first.taskId,
      requestId: crypto.randomUUID(),
      text: "Which colour?",
      wait: true,
    });
    await answerQuestion(s.host, s.member(), later.id, { answer: "Blue." });
    expect((await readTask(first.taskId)).status).toBe("BLOCKED");

    const version = (await readTask(first.taskId)).version;
    s.tick();
    await answerAgentQuestion(s.host, s.codex, { questionId: earlier.id, answer: "Small." });
    expect(await readTask(first.taskId)).toMatchObject({
      status: "READY",
      blockedByQuestion: false,
      version: version + 1,
    });
    // Claimable again.
    await s.claim(s.claude, first.taskId);
    const detail = await getTask(s.host, s.member(), first.taskId);
    expect(detail.questions.map((q) => [q.text, q.status])).toEqual([
      ["Which cart?", "ANSWERED"],
      ["Which colour?", "ANSWERED"],
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
