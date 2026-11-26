import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FindingFingerprint } from "./common";
import { Finding, FindingAnswer, FindingQuery } from "./findings";
import type { Task } from "./tasks";

const now = "2026-11-15T10:00:00.000Z";

function finding(fields: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "config/client-exposed-secret:src/app.ts:12",
    ruleId: "config/client-exposed-secret",
    title: "A secret is exposed to the browser",
    severity: "high",
    file: "src/app.ts",
    line: 12,
    description: "The value is bundled into the client.",
    remediation: "Read it on the server only.",
    firstSeenAt: now,
    lastSeenAt: now,
    dismissal: null,
    ...fields,
  };
}

describe("FindingFingerprint", () => {
  it("takes 1 to 128 characters of A–Z a–z 0–9 . _ : / -", () => {
    for (const valid of ["a", "A.b_c:d/e-f0", "x".repeat(128)]) {
      expect(FindingFingerprint.safeParse(valid).success, valid).toBe(true);
    }
    for (const invalid of ["", "x".repeat(129), "a b", "a?b", "a#b", "a%2Fb", "a\\b", "é"]) {
      expect(FindingFingerprint.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it("is the query of GET /findings, nothing else", () => {
    expect(FindingQuery.safeParse({ fingerprint: "a/b:1" }).success).toBe(true);
    expect(FindingQuery.safeParse({}).success).toBe(false);
    expect(FindingQuery.safeParse({ fingerprint: "a", page: "2" }).success).toBe(false);
  });
});

describe("Finding", () => {
  it("parses the host's finding, without a file, a line or texts, and dismissed", () => {
    expect(Finding.parse(finding())).toEqual(finding());
    const bare = finding({ file: null, line: null, description: null, remediation: null });
    expect(Finding.parse(bare)).toEqual(bare);
    for (const reason of ["false-positive", "accepted-risk"] as const) {
      expect(Finding.safeParse(finding({ dismissal: { reason } })).success).toBe(true);
    }
  });

  it("drops what the contract doesn't name", () => {
    const parsed = Finding.parse({ ...finding(), match: "the matched text" });
    expect(parsed).not.toHaveProperty("match");
  });

  it("keeps each text within the host's limits", () => {
    const limits = { ruleId: 200, title: 200, description: 4000, remediation: 4000, file: 1000 };
    for (const [field, max] of Object.entries(limits)) {
      expect(Finding.safeParse(finding({ [field]: "a".repeat(max) })).success, field).toBe(true);
      expect(Finding.safeParse(finding({ [field]: "a".repeat(max + 1) })).success, field).toBe(
        false,
      );
    }
  });

  it("takes a file relative to the repository's root only", () => {
    for (const file of ["src/app.ts", "a..b/c", ".env"]) {
      expect(Finding.safeParse(finding({ file })).success, file).toBe(true);
    }
    for (const file of ["/etc/passwd", "../app.ts", "src/../../app.ts", "src\\app.ts"]) {
      expect(Finding.safeParse(finding({ file })).success, file).toBe(false);
    }
  });

  it("takes an empty file as none, as the host may give it", () => {
    expect(Finding.parse(finding({ file: "" })).file).toBeNull();
    expect(FindingAnswer.parse({ finding: finding({ file: "" }), task: null }).finding.file).toBe(
      null,
    );
  });

  it("refuses a bad fingerprint, severity, line, dismissal or time", () => {
    for (const fields of [
      { fingerprint: "a b" },
      { severity: "urgent" },
      { line: 0 },
      { line: 1.5 },
      { dismissal: { reason: "fixed" } },
      { firstSeenAt: "yesterday" },
    ]) {
      expect(Finding.safeParse({ ...finding(), ...fields }).success, JSON.stringify(fields)).toBe(
        false,
      );
    }
  });
});

describe("FindingAnswer", () => {
  it("is the finding with its linked task, or none", () => {
    const task: Task = {
      id: randomUUID(),
      projectId: randomUUID(),
      title: "Fix: A secret is exposed to the browser",
      status: "READY",
      revision: 1,
      version: 1,
      assigneeUserId: null,
      claim: null,
      pullRequestNumber: null,
      owns: [],
      dependsOn: [],
      labels: [],
      branch: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(FindingAnswer.safeParse({ finding: finding(), task }).success).toBe(true);
    expect(FindingAnswer.safeParse({ finding: finding(), task: null }).success).toBe(true);
    expect(FindingAnswer.safeParse({ finding: finding() }).success).toBe(false);
  });
});
