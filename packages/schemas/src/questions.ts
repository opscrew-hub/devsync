import { z } from "zod";
import { Author, Id, LIMITS, Timestamp } from "./common";

/** A question's text, or its answer's: 1 to 4,000 characters, trimmed. */
const QuestionText = z.string().trim().min(1).max(LIMITS.question);

/** `POST /tasks/:taskId/questions`: a member's question on a task. */
export const QuestionInput = z.strictObject({ text: QuestionText });
export type QuestionInput = z.infer<typeof QuestionInput>;

/** `POST /questions/:questionId/answer`: a member's answer. */
export const AnswerInput = z.strictObject({ answer: QuestionText });
export type AnswerInput = z.infer<typeof AnswerInput>;

/**
 * A question on a task, from an agent or a member: open until it is answered, once. `wait`: an
 * agent asked it holding the task's claim, and the task waits for it in Blocked; an open one's is
 * cleared once the task leaves Blocked another way, so it no longer holds the task.
 */
export const Question = z.object({
  id: Id,
  taskId: Id,
  askedBy: Author,
  text: z.string(),
  wait: z.boolean(),
  status: z.enum(["OPEN", "ANSWERED"]),
  answer: z.string().nullable(),
  answeredBy: Author.nullable(),
  createdAt: Timestamp,
  answeredAt: Timestamp.nullable(),
});
export type Question = z.infer<typeof Question>;
