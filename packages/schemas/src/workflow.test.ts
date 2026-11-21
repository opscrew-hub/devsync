import { describe, expect, it } from "vitest";
import {
  API_KEY_SECRET_NAMES,
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

  it("names the three secrets a run takes its key from, in the order it picks them", () => {
    expect(API_KEY_SECRETS).toEqual(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]);
    expect(API_KEY_SECRET_NAMES).toBe("ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY");
  });

  it("gives every key only to the step that runs the coding agent, through its env", () => {
    const run = step("agent", "Run the coding agent");
    expect(under(run, /^ {8}env:$/)).toEqual([
      `          ANTHROPIC_API_KEY: ${expression("secrets.ANTHROPIC_API_KEY")}`,
      `          OPENROUTER_API_KEY: ${expression("secrets.OPENROUTER_API_KEY")}`,
      `          OPENAI_API_KEY: ${expression("secrets.OPENAI_API_KEY")}`,
    ]);
    expect(WORKFLOW.match(/secrets\./g)).toHaveLength(3);
    // The keys' names, and what carries a key to Claude Code or Codex: in that step and no other.
    const keys =
      /ANTHROPIC_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL/g;
    const mentions = (source: string) => source.match(keys)?.length ?? 0;
    expect(mentions(text(run))).toBeGreaterThan(0);
    expect(mentions(WORKFLOW)).toBe(mentions(text(run)));
    for (const name of ["publish", "report"]) {
      expect(text(job(name)), name).not.toMatch(/secrets|API_KEY|AUTH_TOKEN/);
    }
    expect(text(run)).toContain(`claude "\${flags[@]}"`);
    expect(text(run)).toContain(`codex "\${flags[@]}"`);
  });

  it("runs on the Anthropic key, else on the OpenRouter key through OpenRouter, else Codex on the OpenAI key", () => {
    const run = text(step("agent", "Run the coding agent"));
    const choice = [
      'if [ -n "$ANTHROPIC_API_KEY" ]; then',
      "  provider=anthropic",
      'elif [ -n "$OPENROUTER_API_KEY" ]; then',
      "  provider=openrouter",
      "  export ANTHROPIC_BASE_URL=https://openrouter.ai/api",
      '  export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"',
      "  export ANTHROPIC_API_KEY=",
      'elif [ -n "$OPENAI_API_KEY" ]; then',
      "  provider=openai",
      '  export CODEX_API_KEY="$OPENAI_API_KEY"',
      "else",
    ]
      .map((line) => `          ${line}`)
      .join("\n");
    const chosen = run.indexOf(choice);
    expect(chosen).toBeGreaterThan(run.indexOf("set +e"));
    const said = run.indexOf('echo "provider=$provider" >> "$GITHUB_OUTPUT"');
    expect(said).toBeGreaterThan(chosen);
    expect(said).toBeLessThan(run.indexOf(`codex "\${flags[@]}"`));
    expect(said).toBeLessThan(run.indexOf(`claude "\${flags[@]}"`));
    // The gateway is set in OpenRouter's branch only; the models stay the workflow's own.
    expect(run.match(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN/g)).toHaveLength(2);
    expect(run).not.toMatch(/ANTHROPIC_\w*MODEL/);
    // Codex runs with the OpenAI key and only then; Claude Code with either of the others.
    const codex = run.indexOf('          if [ "$provider" = openai ]; then\n');
    const claude = run.indexOf("\n          else\n", codex);
    expect(codex).toBeGreaterThan(said);
    expect(run.indexOf(`codex "\${flags[@]}"`)).toBeGreaterThan(codex);
    expect(run.indexOf(`codex "\${flags[@]}"`)).toBeLessThan(claude);
    expect(run.indexOf(`claude "\${flags[@]}"`)).toBeGreaterThan(claude);
    expect(job("agent")).toContain(`      provider: ${expression("steps.agent.outputs.provider")}`);
    expect(WORKFLOW).not.toContain("steps.claude.");
  });

  it("fails no-key with no key, before an agent runs", () => {
    const run = text(step("agent", "Run the coding agent"));
    const missing = [
      "else",
      '  echo "::error::Add the ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY Actions secret to the repository or its organization."',
      '  echo "failure=no-key" >> "$GITHUB_OUTPUT"',
      "  exit 0",
      "fi",
    ]
      .map((line) => `          ${line}`)
      .join("\n");
    const at = run.indexOf(missing);
    expect(at).toBeGreaterThan(run.indexOf('elif [ -n "$OPENAI_API_KEY" ]; then'));
    expect(at).toBeLessThan(run.indexOf(`codex "\${flags[@]}"`));
    expect(at).toBeLessThan(run.indexOf(`claude "\${flags[@]}"`));
    // The patch is built only without a failure, so a run without a key publishes nothing.
    expect(step("agent", "Build the patch")).toContain(
      "        if: steps.agent.outputs.failure == ''",
    );
  });

  it("never prints a key, nor traces the script that holds them", () => {
    const run = text(step("agent", "Run the coding agent"));
    const key =
      /\$\{?(ANTHROPIC_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_AUTH_TOKEN|!key)\b/;
    for (const script of scripts()) {
      for (const line of script.split("\n").filter((l) => /\b(echo|printf)\b/.test(l))) {
        expect(line).not.toMatch(key);
      }
      expect(script).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    }
    // A key's value is read only where the run chooses, hands over and checks it.
    expect(run.match(/\$ANTHROPIC_API_KEY/g)).toHaveLength(1);
    expect(run.match(/\$OPENROUTER_API_KEY/g)).toHaveLength(2);
    expect(run.match(/\$OPENAI_API_KEY/g)).toHaveLength(2);
    expect(run).not.toMatch(/\$\{?CODEX_API_KEY/);
    expect(run.match(/\$\{!key\}/g)).toHaveLength(1);
  });

  it("starts each agent with only its own key's variable, the shell keeping every key", () => {
    const run = text(step("agent", "Run the coding agent"));
    // Through OpenRouter the key reaches Claude Code only as ANTHROPIC_AUTH_TOKEN; with the
    // Anthropic key, Claude Code never sees the OpenRouter or the OpenAI key.
    expect(run).toContain(
      `            env -u OPENROUTER_API_KEY -u OPENAI_API_KEY claude "\${flags[@]}" -- "$prompt" < "$RUNNER_TEMP/task.json" > "$RUNNER_TEMP/claude.json"\n`,
    );
    expect(run.match(/\bclaude "\$\{flags/g)).toHaveLength(1);
    // Codex gets the OpenAI key as CODEX_API_KEY only, chosen when the other two are empty.
    expect(run).toContain(
      `              env -u OPENAI_API_KEY codex "\${flags[@]}" -- "$prompt" < "$RUNNER_TEMP/task.json" > "$RUNNER_TEMP/codex.jsonl"\n`,
    );
    expect(run.match(/\bcodex "\$\{flags/g)).toHaveLength(1);
    expect(run.match(/CODEX_API_KEY/g)).toHaveLength(2);
    // The shell drops and changes no key the check reads: the Anthropic key is emptied only
    // through OpenRouter, which is chosen only when that key is empty already.
    expect(run).not.toMatch(/\bunset\b|export -n|OPENROUTER_API_KEY=|OPENAI_API_KEY=/);
    const emptied = run.indexOf("export ANTHROPIC_API_KEY=");
    expect(run.match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1);
    expect(emptied).toBeGreaterThan(run.indexOf('elif [ -n "$OPENROUTER_API_KEY" ]; then'));
    expect(emptied).toBeLessThan(run.indexOf('elif [ -n "$OPENAI_API_KEY" ]; then'));
    const loop = run.indexOf("for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY; do");
    expect(loop).toBeGreaterThan(run.indexOf("env -u OPENROUTER_API_KEY -u OPENAI_API_KEY claude"));
    expect(loop).toBeGreaterThan(run.indexOf("env -u OPENAI_API_KEY codex"));
  });

  it("refuses a change that holds any key, every one that is set, never putting one in argv", () => {
    const run = text(step("agent", "Run the coding agent"));
    const loop = run.indexOf("for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY; do");
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
    expect(all).toHaveLength(7);
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

    const run = text(step("agent", "Run the coding agent"));
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
      "# With only an OpenAI key: Codex's model, and its prices in US dollars per million input,",
      "# cached input, cache-written input (at the 30-minute rate) and output tokens, from OpenAI's",
      "# pricing page on 2026-11-21. Change the prices with the model. Codex has no turn or spend",
      "# cap: set a budget on the key's OpenAI project.",
      "DEVSYNC_OPENAI_MODEL: gpt-6.2-sol",
      'DEVSYNC_OPENAI_INPUT_USD: "2.00"',
      'DEVSYNC_OPENAI_CACHED_INPUT_USD: "0.10"',
      'DEVSYNC_OPENAI_CACHE_WRITE_USD: "2.50"',
      'DEVSYNC_OPENAI_OUTPUT_USD: "10.00"',
    ]);
  });

  it("installs a pinned Codex, and on GitHub-hosted runners only enables and checks its sandbox", () => {
    const install = text(step("agent", "Install Codex"));
    const version = /npm install --global @openai\/codex@(\d+)\.(\d+)\.(\d+)\n/.exec(install);
    expect(version).not.toBeNull();
    const [major = 0, minor = 0] = (version ?? []).slice(1).map(Number);
    expect([major, minor]).toEqual([0, 171]);
    expect(install).not.toMatch(/secrets|API_KEY/);
    // Nothing changes on a runner that isn't GitHub's: the rest sits inside this one branch.
    const hosted = install.indexOf(
      '          if [ "$RUNNER_ENVIRONMENT" = github-hosted ]; then\n',
    );
    const end = install.lastIndexOf("\n          fi");
    expect(hosted).toBeGreaterThan(install.indexOf("npm install"));
    expect(end).toBe(install.trimEnd().length - "\n          fi".length);
    // The sandbox's user namespaces, as OpenAI's own action enables them; a refusal fails the step.
    const settings = install.indexOf(
      "for setting in kernel.unprivileged_userns_clone=1 kernel.apparmor_restrict_unprivileged_userns=0; do",
    );
    expect(settings).toBeGreaterThan(hosted);
    expect(install).toMatch(
      /if \[ "\$current" != "\$\{setting#\*=\}" \] && ! sudo -n sysctl -q -w "\$setting"; then\n {16}echo "::error::Codex's sandbox needs \$setting, which this runner refused\."\n {16}exit 1\n/,
    );
    expect(install).not.toContain("::warning::Codex's sandbox needs");
    // The /proc check: run through Codex's own sandbox, a process outside must not show inside,
    // and only a passed check leaves the marker the agent step requires.
    for (const part of [
      "sleep 120 &",
      "outside=$!",
      `fresh='[ -d /proc/1 ] && [ ! -e "/proc/$1" ] && [ "$(ls /proc | grep -c "^[0-9]*$")" -le 10 ]'`,
      'if codex sandbox -- sh -c "$fresh" probe "$outside"; then',
      '  touch "$RUNNER_TEMP/devsync-codex-sandbox-checked"',
      'kill "$outside" 2>/dev/null || true',
    ]) {
      expect(install).toContain(part);
      expect(install.indexOf(part)).toBeGreaterThan(settings);
      expect(install.indexOf(part)).toBeLessThan(end);
    }
    expect(install.match(/devsync-codex-sandbox-checked/g)).toHaveLength(1);
  });

  it("runs Codex headless only once its sandbox is checked: checkout writes only, no network, no key for its commands", () => {
    const run = text(step("agent", "Run the coding agent"));
    for (const flag of [
      "exec --json --ephemeral --strict-config",
      '--model "$DEVSYNC_OPENAI_MODEL"',
      "-c default_permissions=devsync",
      `-c 'permissions.devsync.extends=":workspace"'`,
      `-c "permissions.devsync.filesystem={'$RUNNER_TEMP'='deny','$HOME/runners'='deny'}"`,
      "-c permissions.devsync.network.enabled=false",
      "-c approval_policy=never",
      "-c web_search=disabled",
      "-c shell_environment_policy.inherit=core",
      "-c shell_environment_policy.ignore_default_excludes=false",
      "-c project_doc_max_bytes=0",
      "-c skills.include_instructions=false",
      "-c history.persistence=none",
      "--ignore-user-config --ignore-rules",
    ]) {
      expect(run).toContain(flag);
    }
    // Never outside the sandbox, never with automatic approvals, never with the network; and no
    // --sandbox, which would set the permission profile aside.
    expect(run).not.toMatch(
      /danger-full-access|dangerously-bypass|--yolo|--approve-for-me|--trust|--add-dir|--sandbox|enabled=true/,
    );
    // Codex starts only on a GitHub-hosted runner whose sandbox passed the install step's check.
    const hosted = run.indexOf('            if [ "$RUNNER_ENVIRONMENT" != github-hosted ]; then\n');
    const checked = run.indexOf(
      '            elif [ ! -f "$RUNNER_TEMP/devsync-codex-sandbox-checked" ]; then\n',
    );
    const started = run.indexOf(`env -u OPENAI_API_KEY codex "\${flags[@]}"`);
    expect(hosted).toBeGreaterThan(run.indexOf('if [ "$provider" = openai ]; then'));
    expect(checked).toBeGreaterThan(hosted);
    expect(started).toBeGreaterThan(checked);
    expect(run.slice(hosted, checked)).toContain("failure=agent-failed");
    expect(run.slice(checked, started)).toContain("failure=agent-failed");
    // It succeeds only on a clean exit with a completed turn and no failed one.
    expect(run).toContain(
      `events='[inputs | fromjson? | objects | .type] | any(. == "turn.completed") and all(. != "turn.failed")'`,
    );
    expect(run).toMatch(
      /if \[ "\$code" = 0 \] && \[ "\$completed" = true \]; then\n {16}failure=\n {14}else\n {16}failure=agent-failed\n/,
    );
  });

  it("prices Codex's tokens at the workflow's prices, cache writes at the 30-minute rate", () => {
    // workflow.run.test.ts runs these programs on Codex's recorded events.
    const run = text(step("agent", "Run the coding agent"));
    for (const part of [
      '[inputs | fromjson? | objects | select(.type == "turn.completed") | .usage | objects]',
      '| count("cached_input_tokens") as $cached | count("cache_write_input_tokens") as $written',
      '| ([count("input_tokens") - $cached - $written, 0] | max) as $fresh',
      "{inputTokens: $fresh, outputTokens: $output, cacheCreationInputTokens: $written,",
      "+ $written * ($writeUsd | tonumber) + $output * ($outputUsd | tonumber))",
      '--arg inputUsd "$DEVSYNC_OPENAI_INPUT_USD"',
      '--arg cachedUsd "$DEVSYNC_OPENAI_CACHED_INPUT_USD"',
      '--arg writeUsd "$DEVSYNC_OPENAI_CACHE_WRITE_USD"',
      '--arg outputUsd "$DEVSYNC_OPENAI_OUTPUT_USD"',
      `usage=$(jq -cRn "\${prices[@]}" "$totals" "$RUNNER_TEMP/codex.jsonl")`,
      `models=$(jq -cn --arg model "$DEVSYNC_OPENAI_MODEL" '[$model]')`,
    ]) {
      expect(run).toContain(part);
    }
    // Both agents' usage and models leave the step the same way.
    expect(run).toContain('echo "usage=$usage" >> "$GITHUB_OUTPUT"');
    expect(run).toContain('echo "models=$models" >> "$GITHUB_OUTPUT"');
    expect(run.match(/\busage=\$\(/g)).toHaveLength(2);
    expect(run.match(/\bmodels=\$\(/g)).toHaveLength(2);
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
    expect(text(step("agent", "Run the coding agent"))).toMatch(
      /error_max_budget_usd \]; then\n {14}failure=budget\n.*error_max_turns \]; then\n {14}failure=turns/,
    );
    const written = [...WORKFLOW.matchAll(/(?:failure=|fail )([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(FAILURES));
  });
});
