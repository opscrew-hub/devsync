import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withManagedCheckout } from "./managed-run.ts";

test("checkout pins the requested revision and cleans up after adapter failure", async () => {
  const source = await mkdtemp(join(tmpdir(), "devsync-source-"));
  let checkout: string | undefined;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: source, encoding: "utf8" });
    git("init", "-q");
    await writeFile(join(source, "fixture.txt"), "original");
    git("add", "fixture.txt");
    git("commit", "-qm", "original");
    const revision = git("rev-parse", "HEAD").trim();
    await writeFile(join(source, "fixture.txt"), "newer");
    git("commit", "-qam", "newer");
    const run = { id: "run", projectId: "project", taskId: "task", revision: 1,
      title: "Fixture", description: "", acceptanceCriteria: "", repository: "fixture/repo", repositoryId: "1", installationId: "2" };
    const execute = withManagedCheckout(async context => {
      assert.equal(context.repository, "fixture/repo");
      return { repository: source, commit: revision };
    }, async (context, { directory, commit }) => {
      assert.equal(context.revision, 1);
      assert.equal(commit, revision);
      checkout = directory;
      assert.equal(await readFile(join(directory, "fixture.txt"), "utf8"), "original");
      throw new Error("fixture adapter failed");
    });
    await assert.rejects(execute(run, new AbortController().signal), /fixture adapter failed/);
    assert.ok(checkout);
    await assert.rejects(stat(checkout), { code: "ENOENT" });
  } finally {
    await rm(source, { recursive: true, force: true, maxRetries: 3 });
  }
});
