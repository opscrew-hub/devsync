import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createGithubDraftClient } from "@devsync/core/github-app";
import { createCodexExecutor } from "./codex-executor.ts";
import { createClaudeExecutor } from "./claude-executor.ts";
import { ensureDraftBranch } from "./draft-pr-branch.ts";
import { planDraftPullRequest, publishDraftPullRequest } from "./draft-pr-plan.ts";
import { withManagedCheckout } from "./managed-run.ts";

test("GitHub draft client scopes its token and looks up the run branch", async t => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const [key, value] of Object.entries({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    GITHUB_PROJECT_REPOSITORIES: "project:456:789",
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const request: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    if (url.pathname === "/app/installations/456/access_tokens") {
      assert.deepEqual(JSON.parse(String(options?.body)), {
        repository_ids: [789],
        permissions: { metadata: "read", contents: "write", pull_requests: "write" },
      });
      return Response.json({ token: "fixture" });
    }
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture");
    if (url.pathname === "/repositories/789") {
      return Response.json({ id: 789, full_name: "fixture/devsync", default_branch: "main" });
    }
    assert.equal(url.pathname, "/repos/fixture/devsync/pulls");
    if (options?.method === "POST") {
      assert.equal(JSON.parse(String(options.body)).draft, true);
      return Response.json({ number: 1, html_url: "https://github.com/fixture/devsync/pull/1" });
    }
    assert.equal(url.searchParams.get("head"), "fixture:devsync/run-fixture");
    assert.equal(url.searchParams.get("base"), "main");
    assert.equal(url.searchParams.get("state"), "all");
    return Response.json([]);
  };
  const client = await createGithubDraftClient({ projectId: "project", installationId: "456", repositoryId: "789" },
    new AbortController().signal, request);
  assert.equal(await client.findPull("devsync/run-fixture", client.base), null);
  assert.equal((await client.createPull({ head: "devsync/run-fixture", base: client.base, title: "Fixture", body: "", draft: true })).number, 1);
});

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
    const codex = createCodexExecutor("fixture-key", options => {
      assert.equal(options.env?.DATABASE_URL, undefined);
      return { startThread(threadOptions) {
        assert.equal(threadOptions?.networkAccessEnabled, false);
        assert.equal(threadOptions?.sandboxMode, "workspace-write");
        return { async run(prompt, turnOptions) {
          assert.match(String(prompt), /Fixture/);
          assert.equal(await readFile(join(threadOptions!.workingDirectory!, "fixture.txt"), "utf8"), "original");
          assert.equal(turnOptions?.signal?.aborted, false);
          return { items: [], finalResponse: "", usage: null };
        } };
      } };
    }, async () => ({ repository: source, commit: revision }));
    await codex(run, new AbortController().signal);
    let claudeConfig = "";
    const claude = createClaudeExecutor(process.execPath, "fixture-key",
      async () => ({ repository: source, commit: revision }),
      async (file, args, options) => {
        assert.equal(file, process.execPath);
        assert.equal(options.env.ANTHROPIC_API_KEY, "fixture-key");
        assert.equal(options.env.DATABASE_URL, undefined);
        assert.equal(options.env.GITHUB_APP_PRIVATE_KEY, undefined);
        assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write");
        assert.match(args.at(-1) ?? "", /Fixture/);
        claudeConfig = options.env.CLAUDE_CONFIG_DIR!;
        assert.ok((await stat(claudeConfig)).isDirectory());
        assert.equal(await readFile(join(options.cwd, "fixture.txt"), "utf8"), "original");
        await writeFile(join(options.cwd, "fixture.txt"), "claude edit");
        return { stdout: JSON.stringify({
          subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5 },
        }) };
      });
    const claudeResult = await claude(run, new AbortController().signal);
    assert.deepEqual(claudeResult?.tokenUsage, { inputTokens: 10, outputTokens: 5 });
    assert.match(claudeResult?.patch ?? "", /[+]claude edit/);
    await assert.rejects(stat(claudeConfig), { code: "ENOENT" });
    const summarize = withManagedCheckout(async () => ({ repository: source, commit: revision }),
      async (_, { directory }) => {
        await writeFile(join(directory, "fixture.txt"), "edited");
        execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
          "commit", "-qam", "Adapter edit"], { cwd: directory });
        await writeFile(join(directory, "new file.txt"), "new");
      },
      async (id, changes) => {
        assert.equal(id, run.id);
        assert.deepEqual(changes, [
          { status: " M", path: "fixture.txt" },
          { status: "??", path: "new file.txt" },
        ]);
      },
    );
    const summary = await summarize(run, new AbortController().signal);
    assert.match(summary?.patch ?? "", /[+]edited/);
    assert.ok(summary);
    const draft = planDraftPullRequest(run, summary);
    assert.ok(draft);
    assert.equal(draft.baseCommit, revision);
    assert.equal(draft.patch, summary.patch);
    assert.equal(draft.draft, true);
    assert.equal(planDraftPullRequest(run, summary)?.head, draft.head);
    assert.notEqual(planDraftPullRequest({ ...run, id: "another-run" }, summary)?.head, draft.head);
    assert.equal(planDraftPullRequest(run, { baseCommit: revision }), null);
    const signal = new AbortController().signal;
    await ensureDraftBranch(source, draft, signal);
    const published = git("rev-parse", draft.head).trim();
    assert.equal(git("rev-parse", published + "^").trim(), revision);
    assert.equal(git("show", published + ":fixture.txt"), "edited");
    await ensureDraftBranch(source, draft, signal);
    assert.equal(git("rev-parse", draft.head).trim(), published);
    assert.ok(checkout);
    await assert.rejects(stat(checkout), { code: "ENOENT" });
  } finally {
    await rm(source, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("draft publication recovers a lost create response and reuses the same pull request", async () => {
  const plan = planDraftPullRequest({ id: "run", revision: 1, title: "Fixture" },
    { baseCommit: "a".repeat(40), patch: "fixture patch" });
  assert.ok(plan);
  const pull = { number: 1, url: "https://github.com/fixture/repo/pull/1" };
  let created = false;
  let branchWrites = 0;
  const github = {
    async findPull(head: string, base: string) {
      assert.equal(head, plan.head);
      assert.equal(base, "main");
      return created ? pull : null;
    },
    async ensureBranch(input: typeof plan) {
      assert.deepEqual(input, plan);
      branchWrites++;
    },
    async createPull(input: { draft: boolean }) {
      assert.equal(input.draft, true);
      assert.equal(created, false);
      created = true;
      throw new Error("response lost");
    },
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await publishDraftPullRequest(plan, "main", github, signal), pull);
  assert.deepEqual(await publishDraftPullRequest(plan, "main", github, signal), pull);
  assert.equal(branchWrites, 1);
});
