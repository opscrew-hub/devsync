import { FindingAnswer } from "@devsync/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevSyncError, type Member, type ProjectContext, type ProjectRef } from "../host";
import { refusal, sampleFinding } from "../test/helpers";
import { createTestDb, type FakeHost, fakeHost, type TestDb } from "../testing";
import { findingTask } from "./findings";
import { createTask, updateTask } from "./tasks";

const workspaceId = "00000000-0000-4000-8000-0000000000a1";
const projectA: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b1",
  fullName: "acme/shop",
  readOnly: false,
};
const projectB: ProjectRef = {
  workspaceId,
  projectId: "00000000-0000-4000-8000-0000000000b2",
  fullName: "acme/api",
  readOnly: false,
};
const developer: Member = {
  userId: "00000000-0000-4000-8000-0000000000c4",
  name: "Dev",
  role: "developer",
};
const GONE =
  "This finding is resolved or isn't this project's. Open it again from the project's security findings.";

const found = sampleFinding();
/** The same problem after code above it moved: a new line, so a new fingerprint. */
const moved = sampleFinding({
  fingerprint: "config/client-exposed-secret:src/app.ts:30",
  line: 30,
});

let testDb: TestDb;
let host: FakeHost;

beforeEach(async () => {
  testDb = await createTestDb();
  host = fakeHost(testDb.db, {
    members: { [workspaceId]: [developer] },
    projects: [projectA, projectB],
    findings: { [projectA.projectId]: [found, moved] },
  });
});

afterEach(async () => {
  await testDb.close();
});

function as(project: ProjectRef = projectA): ProjectContext {
  return { project, member: developer };
}

/** A task made from `fingerprint` on `project`. */
function fromFinding(fingerprint: string, project: ProjectRef = projectA) {
  return createTask(host, as(project), {
    title: "Fix the exposed secret",
    description: "",
    acceptanceCriteria: "",
    finding: { fingerprint },
  });
}

describe("findingTask", () => {
  it("answers the host's finding, parsed, and no task while none is linked", async () => {
    host.directory.findings[projectA.projectId] = [{ ...found, match: "the match" } as never];
    const answer = await findingTask(host, as(), { fingerprint: found.fingerprint });
    expect(FindingAnswer.parse(answer)).toEqual({ finding: found, task: null });
    expect(answer.finding).not.toHaveProperty("match");
  });

  it("refuses a fingerprint outside its character set before asking the host", async () => {
    const asked = vi.spyOn(host, "finding");
    for (const fingerprint of ["", "a b", "a?b", "x".repeat(129)]) {
      const error = await refusal(findingTask(host, as(), { fingerprint }), "invalid");
      expect(error.fields).toEqual(["fingerprint"]);
    }
    expect((await refusal(findingTask(host, as(), {} as never), "invalid")).fields).toEqual([
      "fingerprint",
    ]);
    expect(asked).not.toHaveBeenCalled();
  });

  it("says a finding the host doesn't give is resolved or not this project's", async () => {
    const unknown = await refusal(findingTask(host, as(), { fingerprint: "a:1" }), "not-found");
    expect(unknown.message).toBe(GONE);
    // Another project's finding.
    const theirs = findingTask(host, as(projectB), { fingerprint: found.fingerprint });
    expect((await refusal(theirs, "not-found")).message).toBe(GONE);
    // Resolved: the host no longer gives it.
    host.directory.findings[projectA.projectId] = [moved];
    await refusal(findingTask(host, as(), { fingerprint: found.fingerprint }), "not-found");
    // DevSync switched off for the project.
    host.directory.projects = [projectB];
    await refusal(findingTask(host, as(), { fingerprint: moved.fingerprint }), "not-found");
  });

  it("answers the task made from the same fingerprint, whatever its status", async () => {
    const created = await fromFinding(found.fingerprint);
    const cancelled = await updateTask(host, as(), created.id, {
      version: created.version,
      status: "CANCELLED",
    });
    const answer = await findingTask(host, as(), { fingerprint: found.fingerprint });
    expect(answer.task).toEqual(cancelled);
  });

  it("answers an open task made from the same rule and file once the line moved, not a Done one", async () => {
    const created = await fromFinding(found.fingerprint);
    const answer = await findingTask(host, as(), { fingerprint: moved.fingerprint });
    expect(answer).toEqual({ finding: moved, task: created });

    let current = created;
    for (const status of ["READY", "IN_PROGRESS", "REVIEW"] as const) {
      current = await updateTask(host, as(), created.id, { version: current.version, status });
      const linked = await findingTask(host, as(), { fingerprint: moved.fingerprint });
      expect(linked.task, status).toEqual(current);
    }
    await updateTask(host, as(), created.id, { version: current.version, status: "DONE" });
    expect((await findingTask(host, as(), { fingerprint: moved.fingerprint })).task).toBeNull();
    // The same fingerprint still opens it, Done.
    const same = await findingTask(host, as(), { fingerprint: found.fingerprint });
    expect(same.task?.status).toBe("DONE");
  });

  it("matches a finding without a file to an open task from the same rule without one", async () => {
    const repository = sampleFinding({
      fingerprint: "repo/no-branch-protection:1",
      ruleId: "repo/no-branch-protection",
      file: null,
      line: null,
    });
    const later = { ...repository, fingerprint: "repo/no-branch-protection:2" };
    host.directory.findings[projectA.projectId] = [found, repository, later];
    const created = await fromFinding(repository.fingerprint);
    expect((await findingTask(host, as(), { fingerprint: later.fingerprint })).task).toEqual(
      created,
    );
    // The same rule with a file is another problem.
    expect((await findingTask(host, as(), { fingerprint: found.fingerprint })).task).toBeNull();
  });

  it("never answers another project's task", async () => {
    host.directory.findings[projectB.projectId] = [found];
    await fromFinding(found.fingerprint, projectB);
    expect((await findingTask(host, as(), { fingerprint: found.fingerprint })).task).toBeNull();
  });

  it("fails as unexpected, without the finding's text, when the host's answer isn't a finding", async () => {
    host.directory.findings[projectA.projectId] = [
      { ...found, severity: "urgent", title: "Secret title" } as never,
    ];
    const bad = await findingTask(host, as(), { fingerprint: found.fingerprint }).catch((e) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(bad).not.toBeInstanceOf(DevSyncError);
    expect(bad.message).toContain("severity");
    expect(bad.message).not.toContain("Secret title");

    host.finding = async () => moved;
    const other = await findingTask(host, as(), { fingerprint: found.fingerprint }).catch((e) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(DevSyncError);
  });
});
