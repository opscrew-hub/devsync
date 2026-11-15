import { describe, expect, it } from "vitest";
import {
  API_KEY_SECRETS,
  PATCH_ARTIFACT,
  RESULT_ARTIFACT,
  WORKFLOW,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
} from "./workflow";

const FAILURES = [
  "no-key",
  "agent-failed",
  "budget",
  "turns",
  "no-changes",
  "patch-did-not-apply",
  "patch-touches-workflows",
  "push-failed",
  "pull-request-not-allowed",
];

const lines = WORKFLOW.split("\n");
const indent = (line: string) => line.length - line.trimStart().length;

/** The lines nested under `lines[at]`: those indented deeper than `depth`, up to the first not. */
function nested(text: string[], at: number, depth = indent(text[at] ?? "")): string[] {
  const end = text.findIndex((line, i) => i > at && line.trim() !== "" && indent(line) <= depth);
  return text.slice(at + 1, end < 0 ? undefined : end);
}

/** The lines nested under the first line that matches `key`. */
function under(text: string[], key: RegExp): string[] {
  const at = text.findIndex((line) => key.test(line));
  if (at < 0) throw new Error(`No line matches ${key}`);
  return nested(text, at);
}

/** The keys of a mapping's lines, at the mapping's own indentation. */
function keys(mapping: string[]): string[] {
  const depth = Math.min(...mapping.filter((line) => line.trim() !== "").map(indent));
  return mapping
    .filter((line) => indent(line) === depth && !line.trim().startsWith("#"))
    .map((line) => line.trim().split(":")[0] ?? "");
}

const job = (name: string) => under(lines, new RegExp(`^ {2}${name}:$`));

/** A job's steps, each as its lines from its `- ` on. */
function steps(name: string): string[][] {
  const result: string[][] = [];
  for (const line of job(name)) {
    if (/^ {6}- /.test(line)) result.push([line]);
    else result.at(-1)?.push(line);
  }
  return result;
}

const step = (name: string, title: string) => {
  const found = steps(name).find((candidate) => candidate[0] === `      - name: ${title}`);
  if (!found) throw new Error(`No step "${title}" in ${name}`);
  return found;
};

/** Every `run:` script in the file, its lines joined. */
function scripts(): string[] {
  return lines.flatMap((line, at) => {
    const match = /^( *)run:(.*)$/.exec(line);
    if (!match) return [];
    return [[match[2] ?? "", ...nested(lines, at, match[1]?.length)].join("\n")];
  });
}

const text = (block: string[]) => block.join("\n");
/** A GitHub Actions expression as the file writes it. */
const expression = (inner: string) => `\${{ ${inner} }}`;

describe("the managed runs' workflow file", () => {
  it("is devsync.yml, dispatched with exactly the two string inputs", () => {
    expect(WORKFLOW_FILE).toBe("devsync.yml");
    expect(WORKFLOW_PATH).toBe(".github/workflows/devsync.yml");
    expect(keys(under(lines, /^on:$/))).toEqual(["workflow_dispatch"]);
    const inputs = under(lines, /^ {4}inputs:$/);
    expect(keys(inputs)).toEqual(["run_id", "task"]);
    for (const input of ["run_id", "task"]) {
      const fields = under(inputs, new RegExp(`^ {6}${input}:$`)).map((line) => line.trim());
      expect(fields).toContain("required: true");
      expect(fields).toContain("type: string");
    }
  });

  it("runs one run id at a time", () => {
    expect(text(under(lines, /^concurrency:$/))).toContain(
      `group: devsync-${expression("inputs.run_id")}`,
    );
  });

  it("grants nothing at the top, and each job only what it needs", () => {
    expect(lines).toContain("permissions: {}");
    expect(keys(under(lines, /^jobs:$/))).toEqual(["agent", "publish", "report"]);
    expect(under(job("agent"), /^ {4}permissions:$/).map((line) => line.trim())).toEqual([
      "contents: read",
    ]);
    expect(under(job("publish"), /^ {4}permissions:$/).map((line) => line.trim())).toEqual([
      "contents: write",
      "pull-requests: write",
    ]);
    expect(job("report")).toContain("    permissions: {}");
  });

  it("names the two secrets a run takes its key from, Anthropic's first", () => {
    expect(API_KEY_SECRETS).toEqual(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
  });

  it("gives either key only to the step that runs Claude Code, through its env", () => {
    const run = step("agent", "Run Claude Code");
    expect(under(run, /^ {8}env:$/)).toEqual([
      `          ANTHROPIC_API_KEY: ${expression("secrets.ANTHROPIC_API_KEY")}`,
      `          OPENROUTER_API_KEY: ${expression("secrets.OPENROUTER_API_KEY")}`,
    ]);
    expect(WORKFLOW.match(/secrets\./g)).toHaveLength(2);
    // The keys' names, and what carries a key to Claude Code: in that step and no other.
    const keys = /ANTHROPIC_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL/g;
    const mentions = (source: string) => source.match(keys)?.length ?? 0;
    expect(mentions(text(run))).toBeGreaterThan(0);
    expect(mentions(WORKFLOW)).toBe(mentions(text(run)));
    for (const name of ["publish", "report"]) {
      expect(text(job(name)), name).not.toMatch(/secrets|API_KEY|AUTH_TOKEN/);
    }
    expect(text(run)).toContain(`claude "\${flags[@]}"`);
  });

  it("runs on the Anthropic key, else on the OpenRouter key through OpenRouter", () => {
    const run = text(step("agent", "Run Claude Code"));
    const choice = [
      'if [ -n "$ANTHROPIC_API_KEY" ]; then',
      "  provider=anthropic",
      'elif [ -n "$OPENROUTER_API_KEY" ]; then',
      "  provider=openrouter",
      "  export ANTHROPIC_BASE_URL=https://openrouter.ai/api",
      '  export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"',
      "  export ANTHROPIC_API_KEY=",
      "else",
    ]
      .map((line) => `          ${line}`)
      .join("\n");
    const chosen = run.indexOf(choice);
    expect(chosen).toBeGreaterThan(run.indexOf("set +e"));
    const said = run.indexOf('echo "provider=$provider" >> "$GITHUB_OUTPUT"');
    expect(said).toBeGreaterThan(chosen);
    expect(said).toBeLessThan(run.indexOf(`claude "\${flags[@]}"`));
    // The gateway is set in that branch only; the models stay the workflow's own.
    expect(run.match(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN/g)).toHaveLength(2);
    expect(run).not.toMatch(/ANTHROPIC_\w*MODEL/);
    expect(job("agent")).toContain(
      `      provider: ${expression("steps.claude.outputs.provider")}`,
    );
  });

  it("fails no-key with neither key, before Claude Code runs", () => {
    const run = text(step("agent", "Run Claude Code"));
    const missing = [
      "else",
      '  echo "::error::Add the ANTHROPIC_API_KEY or OPENROUTER_API_KEY Actions secret to the repository or its organization."',
      '  echo "failure=no-key" >> "$GITHUB_OUTPUT"',
      "  exit 0",
      "fi",
    ]
      .map((line) => `          ${line}`)
      .join("\n");
    const at = run.indexOf(missing);
    expect(at).toBeGreaterThan(run.indexOf('elif [ -n "$OPENROUTER_API_KEY" ]; then'));
    expect(at).toBeLessThan(run.indexOf(`claude "\${flags[@]}"`));
    // The patch is built only without a failure, so a run without a key publishes nothing.
    expect(step("agent", "Build the patch")).toContain(
      "        if: steps.claude.outputs.failure == ''",
    );
  });

  it("never prints a key, nor traces the script that holds them", () => {
    const run = text(step("agent", "Run Claude Code"));
    const key = /\$\{?(ANTHROPIC_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_AUTH_TOKEN|!key)\b/;
    for (const script of scripts()) {
      for (const line of script.split("\n").filter((l) => /\b(echo|printf)\b/.test(l))) {
        expect(line).not.toMatch(key);
      }
      expect(script).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    }
    // A key's value is read only where the run chooses, hands over and checks it.
    expect(run.match(/\$ANTHROPIC_API_KEY/g)).toHaveLength(1);
    expect(run.match(/\$OPENROUTER_API_KEY/g)).toHaveLength(2);
    expect(run.match(/\$\{!key\}/g)).toHaveLength(1);
  });

  it("refuses a change that holds either key, both when both are set, never putting one in argv", () => {
    const run = text(step("agent", "Run Claude Code"));
    const loop = run.indexOf("for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY; do");
    const guard = run.indexOf(`if [ -z "$failure" ] && [ -n "\${!key}" ]; then`);
    const files = run.indexOf('grep -rqF --exclude-dir=.git -f <(printenv "$key") .');
    const names = run.indexOf(
      'find . -name .git -prune -o -print | grep -qF -f <(printenv "$key")',
    );
    const refusal = run.indexOf(
      'echo "::error::The change holds the $key secret, so it is not published."',
    );
    const done = run.indexOf("done", refusal);
    const output = run.indexOf('echo "failure=$failure" >> "$GITHUB_OUTPUT"');
    expect(loop).toBeGreaterThan(run.indexOf("code=$?"));
    for (const at of [guard, files, names, refusal, done]) {
      expect(at).toBeGreaterThan(loop);
      expect(at).toBeLessThan(output);
    }
    expect(run.slice(refusal, done)).toContain("failure=agent-failed");
    // Each key that is set is checked: the loop never stops early.
    expect(run.slice(loop, done)).not.toMatch(/\bbreak\b/);
  });

  it("keeps the write token out of the agent job, which checks out without credentials", () => {
    expect(text(step("agent", "Check out the repository"))).toContain("persist-credentials: false");
    expect(text(job("agent"))).not.toMatch(/\bref:|github\.token|GH_TOKEN/);
    expect(text(job("report"))).not.toMatch(/github\.token|GH_TOKEN/);
    expect(text(step("publish", "Push the branch and open a draft pull request"))).toContain(
      `GH_TOKEN: ${expression("github.token")}`,
    );
  });

  it("hands the inputs to scripts only through env", () => {
    const all = scripts();
    expect(all).toHaveLength(6);
    for (const script of all) expect(script).not.toContain("${{");
    const uses = lines.filter((line) => line.includes("inputs."));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(
        /^( {10}[A-Z_]+: \$\{\{ inputs\.(run_id|task) \}\}| {2}group: devsync-\$\{\{ inputs\.run_id \}\})$/,
      );
    }
  });

  it("runs a pinned Claude Code headless, with file tools only and nothing from the repository", () => {
    const install = text(step("agent", "Install Claude Code"));
    const version = /@anthropic-ai\/claude-code@(\d+)\.(\d+)\.(\d+)\n/.exec(install);
    expect(version).not.toBeNull();
    const [major = 0, minor = 0, patch = 0] = (version ?? []).slice(1).map(Number);
    expect(major).toBe(2);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(1259);

    const run = text(step("agent", "Run Claude Code"));
    for (const flag of [
      "--bare -p --output-format json",
      '--model "$DEVSYNC_MODEL"',
      '--max-turns "$DEVSYNC_MAX_TURNS"',
      '--max-budget-usd "$DEVSYNC_MAX_BUDGET_USD"',
      '--tools "Read,Glob,Grep,Edit,Write"',
      '--disallowedTools "Bash,WebFetch,WebSearch,mcp__*"',
      "--permission-mode acceptEdits",
      "--permission-prompts none",
      `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
      "--setting-sources user",
      `--settings '{"disableAllHooks":true,"permissions":{"blockReadsOutsideWorkingDirectories":true,"deny":["Read(//proc/**)"]}}'`,
      "--disable-slash-commands",
      "--no-session-persistence",
    ]) {
      expect(run).toContain(flag);
    }
    const mode = run.split("\n").find((line) => line.includes("--permission-mode"));
    expect(mode).toMatch(/--permission-mode acceptEdits +# .*never .*auto.*bypassPermissions/);
    expect(run).toContain("untrusted data");
    expect(run).toContain('< "$RUNNER_TEMP/task.json"');
    expect(under(job("agent"), /^ {4}env:$/).map((line) => line.trim())).toEqual([
      "# The model, the turn cap and the spend cap (US dollars) of every run: edit them here.",
      "DEVSYNC_MODEL: sonnet",
      'DEVSYNC_MAX_TURNS: "40"',
      'DEVSYNC_MAX_BUDGET_USD: "5.00"',
    ]);
  });

  it("hands the change over as one patch artifact and leaves the result in another", () => {
    const artifact = (block: string[]) => {
      const name = block.find((line) => line.trim().startsWith("name: devsync-"));
      return name?.trim().slice("name: ".length);
    };
    const uploads = ["agent", "publish", "report"].flatMap((name) =>
      steps(name).filter((candidate) =>
        text(candidate).includes("uses: actions/upload-artifact@v7"),
      ),
    );
    expect(uploads.map(artifact)).toEqual([PATCH_ARTIFACT, RESULT_ARTIFACT]);
    expect(text(step("agent", "Upload the patch"))).toContain("retention-days: 1");
    expect(text(step("report", "Upload the result"))).toContain("retention-days: 7");
    expect(artifact(step("publish", "Download the patch"))).toBe(PATCH_ARTIFACT);
    expect(artifact(step("report", "Download the changed files"))).toBe(PATCH_ARTIFACT);
    expect(text(step("agent", "Build the patch"))).toContain("git diff --cached --binary");
  });

  it("publishes only a change, refusing one that touches .github/", () => {
    expect(job("publish")).toContain("    needs: agent");
    expect(job("publish")).toContain("    if: needs.agent.outputs.has_changes == 'true'");
    const publish = text(step("publish", "Push the branch and open a draft pull request"));
    expect(publish).toMatch(
      /if ! git diff --cached --quiet -- ':\(icase\)\.github'; then\n +fail patch-touches-workflows\n/,
    );
    expect(publish).not.toContain("grep");
    expect(publish).toContain('git push --quiet origin "$branch"');
    expect(publish).toContain('gh pr create --draft --base "$GITHUB_REF_NAME" --head "$branch"');
  });

  it("always reports, and only the design's failures", () => {
    expect(job("report")).toContain("    needs: [agent, publish]");
    expect(job("report")).toContain("    if: always()");
    const write = text(step("report", "Write the result"));
    for (const field of [
      "schemaVersion: 1",
      "runId:",
      "status:",
      "failure:",
      "changedFiles:",
      "usage:",
      "models:",
      "provider: present($provider)",
      "pullRequestUrl:",
      "branch:",
    ]) {
      expect(write).toContain(field);
    }
    expect(write).toContain(`PROVIDER: ${expression("needs.agent.outputs.provider")}`);
    expect(text(step("agent", "Run Claude Code"))).toMatch(
      /error_max_budget_usd \]; then\n {12}failure=budget\n.*error_max_turns \]; then\n {12}failure=turns/,
    );
    const written = [...WORKFLOW.matchAll(/(?:failure=|fail )([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(FAILURES));
  });
});
