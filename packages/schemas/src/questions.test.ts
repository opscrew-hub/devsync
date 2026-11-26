import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AnswerInput, Question, QuestionInput } from "./questions";

const text = (length: number) => "a".repeat(length);
const now = new Date().toISOString();

describe("a question's input and its answer's", () => {
  it("take 1 to 4,000 characters, trimmed, and nothing else", () => {
    expect(QuestionInput.safeParse({ text: text(4000) }).success).toBe(true);
    expect(QuestionInput.safeParse({ text: text(4001) }).success).toBe(false);
    expect(QuestionInput.safeParse({ text: "   " }).success).toBe(false);
    expect(QuestionInput.parse({ text: "  Which port?  " })).toEqual({ text: "Which port?" });
    expect(QuestionInput.safeParse({ text: "Which port?", wait: true }).success).toBe(false);

    expect(AnswerInput.safeParse({ answer: text(4000) }).success).toBe(true);
    expect(AnswerInput.safeParse({ answer: text(4001) }).success).toBe(false);
    expect(AnswerInput.safeParse({ answer: "" }).success).toBe(false);
    expect(AnswerInput.safeParse({ answer: "8080", extra: 1 }).success).toBe(false);
  });
});

describe("a question", () => {
  const agent = { kind: "agent", agentId: randomUUID(), name: "Codex" } as const;
  const member = { kind: "member", userId: randomUUID(), name: "Ana" } as const;
  const open = {
    id: randomUUID(),
    taskId: randomUUID(),
    askedBy: agent,
    text: "Which port?",
    wait: true,
    status: "OPEN",
    answer: null,
    answeredBy: null,
    createdAt: now,
    answeredAt: null,
  };

  it("is open, or answered with who answered and when", () => {
    expect(Question.safeParse(open).success).toBe(true);
    const answered = {
      ...open,
      status: "ANSWERED",
      answer: "8080",
      answeredBy: member,
      answeredAt: now,
    };
    expect(Question.safeParse(answered).success).toBe(true);
    expect(Question.safeParse({ ...open, status: "CLOSED" }).success).toBe(false);
    expect(Question.safeParse({ ...open, askedBy: null }).success).toBe(false);
  });
});
