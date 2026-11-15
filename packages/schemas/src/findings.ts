/**
 * A task from one of the host's security findings (docs/findings.md): the finding as `host.finding`
 * gives it, parsed before DevSync uses any of it, and `GET /findings`' query and answer.
 */
import { z } from "zod";
import { FindingFingerprint } from "./common";
import { Task } from "./tasks";

/** The limits the host cuts a finding's texts to (a cut text ends with "…"). */
export const FINDING_LIMITS = {
  ruleId: 200,
  title: 200,
  file: 1000,
  description: 4000,
  remediation: 4000,
} as const;

export const FindingSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/** Why a finding is marked "Not a problem". */
export const DismissalReason = z.enum(["false-positive", "accepted-risk"]);
export type DismissalReason = z.infer<typeof DismissalReason>;

/** A POSIX path relative to the repository's root: no leading `/`, no `..` segment, no backslash. */
const RepositoryPath = z
  .string()
  .min(1)
  .max(FINDING_LIMITS.file)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  );

/** A time the host gives, ISO 8601. */
const HostTime = z.iso.datetime({ offset: true });

/**
 * One of a project's open security findings, as the host gives it (`host.finding`, the contract's
 * `ModuleFinding`): every text already redacted and cut to its limit, never the match itself. What
 * the contract doesn't name is dropped. The fingerprint includes the line, so it changes when code
 * above the problem moves.
 */
export const Finding = z.object({
  fingerprint: FindingFingerprint,
  ruleId: z.string().max(FINDING_LIMITS.ruleId),
  title: z.string().max(FINDING_LIMITS.title),
  severity: FindingSeverity,
  file: RepositoryPath.nullable(),
  line: z.number().int().positive().nullable(),
  description: z.string().max(FINDING_LIMITS.description).nullable(),
  remediation: z.string().max(FINDING_LIMITS.remediation).nullable(),
  firstSeenAt: HostTime,
  lastSeenAt: HostTime,
  /** Marked "Not a problem" on the dashboard. */
  dismissal: z.object({ reason: DismissalReason }).nullable(),
});
export type Finding = z.infer<typeof Finding>;

/** `GET /findings`' query. */
export const FindingQuery = z.strictObject({ fingerprint: FindingFingerprint });
export type FindingQuery = z.infer<typeof FindingQuery>;

/**
 * `GET /findings`: the finding, and the open task already linked to it (made from the same
 * fingerprint, or from the same rule and file), or null.
 */
export const FindingAnswer = z.object({ finding: Finding, task: Task.nullable() });
export type FindingAnswer = z.infer<typeof FindingAnswer>;
