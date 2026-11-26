import { z } from "zod";

const UUID = z.uuid();

/**
 * Every id DevSync takes or answers: what zod's `uuid` takes, but a JSON Schema of only
 * `{ type: "string", format: "uuid" }`, without the long pattern zod adds beside the format, which
 * every id field of the actions' list would repeat.
 */
export const Id = z
  .string()
  .refine((value) => UUID.safeParse(value).success, "Invalid UUID")
  .meta({ format: "uuid" });
/** Every time DevSync answers: ISO 8601, from `Date.toISOString()`. */
export const Timestamp = z.iso.datetime();

/**
 * A security finding's fingerprint, as the host gives it: 1 to 128 characters of
 * `A–Z a–z 0–9 . _ : / -`. It may hold a `/`, so it goes in a query parameter, never a path segment.
 */
export const FindingFingerprint = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);

/** The limits on text people and agents write. */
export const LIMITS = {
  title: 160,
  description: 8000,
  acceptanceCriteria: 8000,
  comment: 4000,
  message: 4000,
  question: 4000,
  name: 80,
} as const;

/** A positive whole number: a task's revision or version. */
export const Counter = z.number().int().positive();

/** The largest pull request number DevSync keeps (a PostgreSQL `integer`). */
export const MAX_PULL_REQUEST = 2_147_483_647;

/** Who wrote or did something: a member (named "Former member" once they left) or an agent. */
export const Author = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: Id, name: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: Id, name: z.string() }),
]);
export type Author = z.infer<typeof Author>;

/**
 * A refusal's answer: `{ error: { code, message, fields? } }` (docs/host.md, Mount points), and an
 * unexpected failure's (`internal`, 500), answered without its details.
 */
export const ErrorAnswer = z.object({
  error: z.object({
    code: z.enum([
      "invalid",
      "unauthenticated",
      "forbidden",
      "not-found",
      "conflict",
      "rate-limited",
      "internal",
    ]),
    message: z.string(),
    fields: z.array(z.string()).optional(),
  }),
});
export type ErrorAnswer = z.infer<typeof ErrorAnswer>;
