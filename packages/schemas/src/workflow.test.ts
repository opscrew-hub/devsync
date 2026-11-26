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
  "no-credits",
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

/**
 * A job's steps, each as its lines from its `- ` on, without the comment that introduces the
 * next one.
 */
function steps(name: string): string[][] {
  const result: string[][] = [];
  for (const line of job(name)) {
    if (/^ {6}- /.test(line)) result.push([line]);
    else result.at(-1)?.push(line);
  }
  for (const found of result) {
    while (/^( {6}#.*|\s*)$/.test(found.at(-1) ?? "x")) found.pop();
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
  it("is devsync.yml, dispatched with the run's two inputs and OpsCrew's two optional ones", () => {
    expect(WORKFLOW_FILE).toBe("devsync.yml");
    expect(WORKFLOW_PATH).toBe(".github/workflows/devsync.yml");
    expect(keys(under(lines, /^on:$/))).toEqual(["workflow_dispatch"]);
    const inputs = under(lines, /^ {4}inputs:$/);
    expect(keys(inputs)).toEqual(["run_id", "task", "opscrew_origin", "opscrew_request"]);
    const fields = (input: string) =>
      under(inputs, new RegExp(`^ {6}${input}:$`)).map((line) => line.trim());
    for (const input of ["run_id", "task"]) {
      expect(fields(input)).toContain("required: true");
      expect(fields(input)).toContain("type: string");
    }
    for (const input of ["opscrew_origin", "opscrew_request"]) {
      expect(fields(input)).toContain("required: false");
      expect(fields(input)).toContain("type: string");
      expect(fields(input)).toContain('default: ""');
    }
  });

  it("checks OpsCrew's origin before it goes into any address, when OpsCrew sent a request", () => {
    const read = text(step("agent", "Read the inputs"));
    expect(read).toContain("origin='^https://[A-Za-z0-9.-]+(:[0-9]+)?$'");
    expect(read).toContain(
      [
        'if [ -n "$OPSCREW_REQUEST" ] && ! [[ $OPSCREW_ORIGIN =~ $origin ]]; then',
        '  echo "::error::The opscrew_origin input is not the address DevSync sends."',
        "  exit 1",
        "fi",
      ]
        .map((line) => `          ${line}`)
        .join("\n"),
    );
    const at = (title: string) =>
      steps("agent").findIndex((s) => s[0] === `      - name: ${title}`);
    expect(at("Read the inputs")).toBeLessThan(at("Ask OpsCrew for the run's MCP token"));
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
      "id-token: write",
    ]);
    // Only the agent job may ask GitHub for an OIDC token.
    expect(WORKFLOW.match(/id-token/g)).toHaveLength(1);
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
      `          OPSCREW_ORIGIN: ${expression("inputs.opscrew_origin")}`,
      `          OPSCREW_REQUEST: ${expression("inputs.opscrew_request")}`,
    ]);
    expect(WORKFLOW.match(/secrets\./g)).toHaveLength(3);
    // The keys' names, the run's MCP token and AI credential, and what carries a key or the
    // credential to Claude Code or Codex: in that step and no other.
    const keys =
      /ANTHROPIC_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPSCREW_MCP_TOKEN|OPSCREW_AI_CREDENTIAL/g;
    const mentions = (source: string) => source.match(keys)?.length ?? 0;
    expect(mentions(text(run))).toBeGreaterThan(0);
    expect(mentions(WORKFLOW)).toBe(mentions(text(run)));
    for (const name of ["publish", "report"]) {
      expect(text(job(name)), name).not.toMatch(/secrets|API_KEY|AUTH_TOKEN/);
    }
    expect(text(run)).toContain(`claude "\${flags[@]}"`);
    expect(text(run)).toContain(`codex "\${flags[@]}"`);
  });

  it("runs on the Anthropic key, else on the OpenRouter key through OpenRouter, else Codex on the OpenAI key, else on the AI credits", () => {
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
      'elif [ -n "$OPSCREW_REQUEST" ]; then',
      "  provider=opscrew",
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
    // A gateway is set through OpenRouter and on the AI credits only; the models stay the
    // workflow's own, but for the credits' gateway, which answers with its own.
    expect(run.match(/ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN/g)).toHaveLength(4);
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

  it("fails no-key with no key and no request from OpsCrew, before an agent runs", () => {
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
    expect(at).toBeGreaterThan(run.indexOf('elif [ -n "$OPSCREW_REQUEST" ]; then'));
    expect(at).toBeLessThan(run.indexOf(`codex "\${flags[@]}"`));
    expect(at).toBeLessThan(run.indexOf(`claude "\${flags[@]}"`));
    // The patch is built only without a failure, so a run without a key publishes nothing.
    expect(step("agent", "Build the patch")).toContain(
      "        if: steps.agent.outputs.failure == ''",
    );
  });

  it("never prints a key or a token, nor traces the script that holds them", () => {
    const run = text(step("agent", "Run the coding agent"));
    const key =
      /\$\{?(ANTHROPIC_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_AUTH_TOKEN|OPSCREW_MCP_TOKEN|OPSCREW_AI_CREDENTIAL|ACTIONS_ID_TOKEN_REQUEST_TOKEN|oidc|token|!key)\b/;
    // A token is only masked, or written to a file, a pipe or curl's header file: never to the log.
    const handled = [
      /^ *echo "::add-mask::\$(oidc|token|OPSCREW_AI_CREDENTIAL)"$/,
      /^ *(\S+=\$\(|\(umask 077 && )?printf '%s' "\$(oidc|token|OPSCREW_MCP_TOKEN)" (\||> "\$RUNNER_TEMP\/devsync-[a-z-]+")/,
      /--header @<\(printf 'Authorization: bearer %s\\n' "\$ACTIONS_ID_TOKEN_REQUEST_TOKEN"\) \\$/,
    ];
    let masked = 0;
    for (const script of scripts()) {
      for (const line of script.split("\n").filter((l) => /\b(echo|printf)\b/.test(l))) {
        if (!key.test(line)) continue;
        expect(
          handled.some((form) => form.test(line)),
          line,
        ).toBe(true);
        if (line.includes("::add-mask::")) masked++;
      }
      expect(script).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    }
    // The job's OIDC token, the MCP token and the AI credential, each masked once it is had.
    expect(masked).toBe(3);
    // A key's value is read only where the run chooses, hands over and checks it.
    expect(run.match(/\$ANTHROPIC_API_KEY/g)).toHaveLength(1);
    expect(run.match(/\$OPENROUTER_API_KEY/g)).toHaveLength(2);
    expect(run.match(/\$OPENAI_API_KEY/g)).toHaveLength(2);
    expect(run).not.toMatch(/\$\{?CODEX_API_KEY/);
    expect(run.match(/\$\{!key\}/g)).toHaveLength(1);
  });

  it("starts each agent with only its own key's variable, the shell keeping every key", () => {
    const run = text(step("agent", "Run the coding agent"));
    // Through OpenRouter the key, and on the credits the credential, reaches Claude Code only as
    // ANTHROPIC_AUTH_TOKEN; with the Anthropic key, Claude Code never sees the OpenRouter or the
    // OpenAI key. Its MCP token is in its MCP configuration only.
    expect(run).toContain(
      `            env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u OPSCREW_MCP_TOKEN -u OPSCREW_AI_CREDENTIAL "\${limit[@]}" claude "\${flags[@]}" -- "$prompt" < "$RUNNER_TEMP/task.json" > "$RUNNER_TEMP/claude.json"\n`,
    );
    expect(run.match(/\bclaude "\$\{flags/g)).toHaveLength(1);
    // Codex gets the OpenAI key as CODEX_API_KEY only, chosen when the other two are empty.
    expect(run).toContain(
      `              env -u OPENAI_API_KEY codex "\${flags[@]}" "\${profile[@]}" -- "$prompt" < "$RUNNER_TEMP/task.json" > "$RUNNER_TEMP/codex.jsonl"\n`,
    );
    expect(run.match(/\bcodex "\$\{flags/g)).toHaveLength(1);
    expect(run.match(/CODEX_API_KEY/g)).toHaveLength(2);
    // The shell drops and changes no key the check reads: the Anthropic key is emptied only
    // through OpenRouter, which is chosen only when that key is empty already. It unsets only
    // GitHub's means to ask for OIDC tokens.
    expect(run.match(/\bunset\b.*/g)).toEqual([
      "unset ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    ]);
    expect(run).not.toMatch(/export -n|OPENROUTER_API_KEY=|OPENAI_API_KEY=/);
    const emptied = run.indexOf("export ANTHROPIC_API_KEY=");
    expect(run.match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1);
    expect(emptied).toBeGreaterThan(run.indexOf('elif [ -n "$OPENROUTER_API_KEY" ]; then'));
    expect(emptied).toBeLessThan(run.indexOf('elif [ -n "$OPENAI_API_KEY" ]; then'));
    // The MCP token and the credential are exported, for the check to read them.
    expect(run).toContain("export OPSCREW_MCP_TOKEN=\n");
    expect(run).toContain("export OPSCREW_AI_CREDENTIAL=\n");
    const loop = run.indexOf(
      "for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OPSCREW_MCP_TOKEN OPSCREW_AI_CREDENTIAL; do",
    );
    expect(loop).toBeGreaterThan(run.indexOf(`claude "\${flags[@]}"`));
    expect(loop).toBeGreaterThan(run.indexOf("env -u OPENAI_API_KEY codex"));
  });

  it("refuses a change that holds any key or token, every one that is set, never putting one in argv", () => {
    const run = text(step("agent", "Run the coding agent"));
    const loop = run.indexOf(
      "for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OPSCREW_MCP_TOKEN OPSCREW_AI_CREDENTIAL; do",
    );
    const guard = run.indexOf(`if [ -z "$failure" ] && [ -n "\${!key}" ]; then`);
    const files = run.indexOf('grep -rqsF --exclude-dir=.git -f <(printenv "$key") .');
    const names = run.indexOf(
      'find . -name .git -prune -o -print 2>/dev/null | grep -qsF -f <(printenv "$key")',
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
    // It fails closed: only grep's 1 (nothing found) on both checks, and a clean find, pass.
    const failedCheck = run.indexOf(
      'echo "::error::The check for the $key secret in the change failed, so the change is not published."',
    );
    for (const part of [
      "contents=$?",
      `names=("\${PIPESTATUS[@]}")`,
      `if [ "$contents" = 0 ] || [ "\${names[1]}" = 0 ]; then`,
      `elif [ "$contents" != 1 ] || [ "\${names[0]}" != 0 ] || [ "\${names[1]}" != 1 ]; then`,
    ]) {
      expect(run.slice(loop, done)).toContain(part);
    }
    expect(failedCheck).toBeGreaterThan(refusal);
    expect(failedCheck).toBeLessThan(done);
    expect(run.slice(failedCheck, done)).toContain("failure=agent-failed");
    // No grep's answer is folded into another's: each is read on its own.
    expect(run.slice(loop, done)).not.toMatch(/grep[^\n]*\|\|/);
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
    expect(all).toHaveLength(8);
    for (const script of all) expect(script).not.toContain("${{");
    const uses = lines.filter((line) => line.includes("inputs."));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(
        /^( {10}[A-Z_]+: \$\{\{ inputs\.(run_id|task|opscrew_origin|opscrew_request) \}\}| {2}group: devsync-\$\{\{ inputs\.run_id \}\}| {8}if: inputs\.opscrew_request != '')$/,
      );
    }
  });

  it("asks OpsCrew for the run's MCP token with the job's OIDC token, only when OpsCrew sent a request", () => {
    const ask = step("agent", "Ask OpsCrew for the run's MCP token");
    expect(ask.slice(1, 4).map((line) => line.trim())).toEqual([
      "if: inputs.opscrew_request != ''",
      // A refusal or a hang only means no MCP: the run goes on.
      "continue-on-error: true",
      "timeout-minutes: 2",
    ]);
    expect(text(ask)).not.toMatch(/secrets|API_KEY/);
    const titles = steps("agent").map((s) => s[0]);
    expect(titles.indexOf("      - name: Ask OpsCrew for the run's MCP token")).toBe(
      titles.indexOf("      - name: Run the coding agent") - 1,
    );
    const script = text(ask);
    // The OIDC token, for OpsCrew's origin only, its request token never in curl's arguments.
    for (const part of [
      "set +e",
      `audience=$(jq -rn --arg origin "$OPSCREW_ORIGIN" '$origin | @uri')`,
      `--header @<(printf 'Authorization: bearer %s\\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN") \\`,
      `"$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$audience" | jq -r '.value | strings')`,
      'echo "::add-mask::$oidc"',
      `(umask 077 && printf '%s' "$oidc" > "$RUNNER_TEMP/devsync-oidc")`,
      // Exchanged at OpsCrew's /mcp/credential, the token through stdin, never in argv.
      `token=$(printf '%s' "$oidc" | jq -Rsc --arg request "$OPSCREW_REQUEST" '{token: ., request: $request}' |`,
      "--data-binary @- \"$OPSCREW_ORIGIN/mcp/credential\" | jq -r '.token | strings')",
      'echo "::add-mask::$token"',
      `(umask 077 && printf '%s' "$token" > "$RUNNER_TEMP/devsync-mcp-token")`,
    ]) {
      expect(script).toContain(part);
    }
    // Each value is masked before it is written anywhere.
    expect(script.indexOf('echo "::add-mask::$oidc"')).toBeLessThan(
      script.indexOf(`printf '%s' "$oidc" >`),
    );
    expect(script.indexOf('echo "::add-mask::$token"')).toBeLessThan(
      script.indexOf(`printf '%s' "$token" >`),
    );
    for (const warning of [
      "::warning::GitHub gave this job no OIDC token, so the agent works without OpsCrew's tools or AI credits.",
      "::warning::OpsCrew refused this run its MCP token, so the agent works without OpsCrew's tools.",
    ]) {
      expect(script).toContain(`echo "${warning}"`);
    }
    expect(script).not.toMatch(/exit [1-9]/);
    // Only this step asks GitHub for an OIDC token; the agent step unsets the means to.
    const asking = lines.filter((line) => line.includes("ACTIONS_ID_TOKEN_REQUEST"));
    expect(asking).toHaveLength(3);
    expect(asking.filter((line) => script.includes(line))).toHaveLength(2);
  });

  it("keeps GitHub's OIDC means from the agents, and the OIDC token too once it is used", () => {
    const run = text(step("agent", "Run the coding agent"));
    const unset = run.indexOf("unset ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(unset).toBeGreaterThan(run.indexOf("set +e"));
    expect(unset).toBeLessThan(run.indexOf("if [ -n"));
    // The step's own env can't blank them: the runner sets them over it.
    expect(text(step("agent", "Run the coding agent"))).not.toMatch(
      /ACTIONS_ID_TOKEN_REQUEST_\w+:/,
    );
    // The files the step before left are read and removed before anything else.
    const removed = run.indexOf(
      'rm -f "$RUNNER_TEMP/devsync-oidc" "$RUNNER_TEMP/devsync-mcp-token"',
    );
    expect(removed).toBeGreaterThan(unset);
    expect(removed).toBeLessThan(run.indexOf('if [ -n "$ANTHROPIC_API_KEY" ]; then'));
    expect(run).toContain(
      '[ ! -f "$RUNNER_TEMP/devsync-oidc" ] || oidc=$(< "$RUNNER_TEMP/devsync-oidc")',
    );
    expect(run).toContain(
      '[ ! -f "$RUNNER_TEMP/devsync-mcp-token" ] || OPSCREW_MCP_TOKEN=$(< "$RUNNER_TEMP/devsync-mcp-token")',
    );
    // The OIDC token is a shell variable only, never exported to an agent.
    expect(run).not.toMatch(/export oidc|oidc=.*&&|env [^\n]*oidc/);
    expect(run).toContain(`trap 'rm -f "$RUNNER_TEMP/devsync-mcp.json"' EXIT`);
  });

  it("pays with the workspace's AI credits with no key, through OpsCrew's gateway, for 30 minutes at most", () => {
    const run = text(step("agent", "Run the coding agent"));
    const credits = run.indexOf('          if [ "$provider" = opscrew ]; then\n');
    const agents = run.indexOf('          if [ "$provider" = openai ]; then\n');
    expect(credits).toBeGreaterThan(run.indexOf('echo "provider=$provider" >> "$GITHUB_OUTPUT"'));
    expect(agents).toBeGreaterThan(credits);
    const branch = run.slice(credits, agents);
    for (const part of [
      'if [ -n "$oidc" ]; then',
      `OPSCREW_AI_CREDENTIAL=$(printf '%s' "$oidc" | jq -Rsc --arg request "$OPSCREW_REQUEST" '{token: ., request: $request}' |`,
      "--data-binary @- \"$OPSCREW_ORIGIN/ai/credential\" | jq -r '.token | strings')",
      'if [ -z "$OPSCREW_AI_CREDENTIAL" ]; then',
      `echo "::error::OpsCrew didn't let this run use the workspace's AI credits (they may be switched off, used up or at their cap). Buy AI credits on the dashboard's Billing page, or add the ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY Actions secret to the repository or its organization."`,
      'echo "failure=no-credits" >> "$GITHUB_OUTPUT"',
      'echo "::add-mask::$OPSCREW_AI_CREDENTIAL"',
      'export ANTHROPIC_BASE_URL="$OPSCREW_ORIGIN/ai"',
      'export ANTHROPIC_AUTH_TOKEN="$OPSCREW_AI_CREDENTIAL"',
    ]) {
      expect(branch).toContain(part);
    }
    // A refused exchange ends the run before an agent starts.
    expect(branch.slice(branch.indexOf("failure=no-credits"))).toMatch(
      /^failure=no-credits[^\n]*\n +exit 0\n/,
    );
    expect(branch.indexOf("::add-mask::")).toBeGreaterThan(branch.indexOf("failure=no-credits"));
    expect(branch.indexOf("::add-mask::")).toBeLessThan(
      branch.indexOf("export ANTHROPIC_BASE_URL"),
    );
    // The credits run Claude Code only, on the gateway's model, for the credential's 30 minutes.
    const claude = run.indexOf("\n          else\n", agents);
    const model = run.indexOf(
      '            if [ "$provider" = opscrew ]; then\n              model=claude-haiku-5-5\n              limit=(timeout 30m)\n            fi\n',
    );
    expect(model).toBeGreaterThan(claude);
    expect(run.match(/\/ai\/credential/g)).toHaveLength(1);
    expect(WORKFLOW.match(/\/ai\/credential/g)).toHaveLength(1);
    expect(run.match(/claude-haiku-5-5/g)).toHaveLength(1);
  });

  it("gives each agent OpsCrew's MCP as its one server, with the run's token, when it has one", () => {
    const run = text(step("agent", "Run the coding agent"));
    // Claude Code: a configuration only it reads, the server's tools allowed besides the file
    // tools, and no MCP tool at all without the token.
    const configured = run.indexOf(
      '            if [ -n "$OPSCREW_MCP_TOKEN" ]; then\n',
      run.indexOf("\n          else\n", run.indexOf('if [ "$provider" = openai ]')),
    );
    expect(configured).toBeGreaterThan(0);
    for (const part of [
      `(umask 077 && printf '%s' "$OPSCREW_MCP_TOKEN" | jq -Rc --arg url "$OPSCREW_ORIGIN/mcp" \\`,
      `'{mcpServers: {opscrew: {type: "http", url: $url, headers: {Authorization: ("Bearer " + .)}}}}' \\`,
      '> "$RUNNER_TEMP/devsync-mcp.json")',
      'mcp=(--mcp-config "$RUNNER_TEMP/devsync-mcp.json" --allowedTools "mcp__opscrew__*")',
      "denied=Bash,WebFetch,WebSearch\n",
      `mcp=(--mcp-config '{"mcpServers":{}}')`,
      "denied='Bash,WebFetch,WebSearch,mcp__*'",
    ]) {
      expect(run.slice(configured), part).toContain(part);
    }
    expect(run).toContain(`--strict-mcp-config "\${mcp[@]}"`);
    // Codex: the same server, its token from Codex's environment, which its commands never get.
    const codex = run.slice(
      run.indexOf('if [ "$provider" = openai ]'),
      run.indexOf("\n          else\n", run.indexOf('if [ "$provider" = openai ]')),
    );
    expect(codex).toMatch(
      / {12}if \[ -n "\$OPSCREW_MCP_TOKEN" \]; then\n(?: *#[^\n]*\n)* {14}flags\+=\(\n {16}-c "mcp_servers\.opscrew\.url=\\"\$OPSCREW_ORIGIN\/mcp\\""\n {16}-c 'mcp_servers\.opscrew\.bearer_token_env_var="OPSCREW_MCP_TOKEN"'\n {16}-c 'mcp_servers\.opscrew\.default_tools_approval_mode="approve"'\n {14}\)\n {12}fi\n/,
    );
    expect(codex.indexOf("mcp_servers")).toBeLessThan(codex.indexOf(`codex "\${flags[@]}"`));
  });

  it("reports the agent's turns: Claude Code's count, none from Codex", () => {
    const run = text(step("agent", "Run the coding agent"));
    expect(run).toContain(
      `turns=$(jq -c '.num_turns | if type == "number" and . >= 0 then floor else null end' "$RUNNER_TEMP/claude.json")`,
    );
    expect(run).toMatch(/ {12}# Codex reports no count of its turns\.\n {12}turns=null\n/);
    expect(run).toContain('echo "turns=$turns" >> "$GITHUB_OUTPUT"');
    expect(job("agent")).toContain(`      turns: ${expression("steps.agent.outputs.turns")}`);
    const write = text(step("report", "Write the result"));
    expect(write).toContain(`TURNS: ${expression("needs.agent.outputs.turns")}`);
    expect(write).toContain('--arg turns "$TURNS"');
    expect(write).toContain("turns: parsed($turns; null),");
  });

  it("runs a pinned Claude Code headless, with file tools only and nothing from the repository", () => {
    const install = text(step("agent", "Install Claude Code"));
    const version = /@anthropic-ai\/claude-code@(\d+)\.(\d+)\.(\d+)$/.exec(install);
    expect(version).not.toBeNull();
    const [major = 0, minor = 0, patch = 0] = (version ?? []).slice(1).map(Number);
    expect(major).toBe(2);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(1259);

    const run = text(step("agent", "Run the coding agent"));
    for (const flag of [
      "--bare -p --output-format json",
      '--model "$model"',
      '--max-turns "$DEVSYNC_MAX_TURNS"',
      '--max-budget-usd "$DEVSYNC_MAX_BUDGET_USD"',
      '--tools "Read,Glob,Grep,Edit,Write"',
      '--disallowedTools "$denied"',
      "--permission-mode acceptEdits",
      "--permission-prompts none",
      `--strict-mcp-config "\${mcp[@]}"`,
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
    // The workflow's model, but on the credits, whose gateway answers with its own.
    expect(run).toContain("            model=$DEVSYNC_MODEL\n");
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
    expect(install).not.toMatch(/secrets|API_KEY/);
    // Nothing happens on a runner that isn't GitHub's: the whole script is this one branch.
    const hosted = install.indexOf(
      '          if [ "$RUNNER_ENVIRONMENT" = github-hosted ]; then\n',
    );
    const end = install.lastIndexOf("\n          fi");
    expect(hosted).toBeGreaterThan(0);
    expect(install.slice(0, hosted)).not.toMatch(/^ {10}[^ #]/m);
    expect(end).toBe(install.trimEnd().length - "\n          fi".length);
    // A pinned Codex; a failed install keeps Codex from running, never fails the step.
    const version = /npm install --global @openai\/codex@(\d+)\.(\d+)\.(\d+); then\n/.exec(install);
    expect(version).not.toBeNull();
    const [major = 0, minor = 0] = (version ?? []).slice(1).map(Number);
    expect([major, minor]).toEqual([0, 171]);
    expect(install.indexOf("npm install")).toBeGreaterThan(hosted);
    expect(install).toContain(`echo "::warning::Codex didn't install, so Codex won't run here."`);
    // The sandbox's user namespaces, as OpenAI's own action enables them; a refusal warns and
    // keeps Codex from running, so Claude Code's runs go on.
    const settings = install.indexOf(
      "for setting in kernel.unprivileged_userns_clone=1 kernel.apparmor_restrict_unprivileged_userns=0; do",
    );
    expect(settings).toBeGreaterThan(hosted);
    expect(install).toMatch(
      /if \[ "\$current" != "\$\{setting#\*=\}" \] && ! sudo -n sysctl -q -w "\$setting"; then\n {16}echo "::warning::Codex's sandbox needs \$setting, which this runner refused, so Codex won't run here\."\n {16}ready=false\n/,
    );
    expect(install).not.toMatch(/\bexit\b/);
    // The run's sandbox profile, defined once, here.
    for (const part of [
      "-c default_permissions=devsync",
      `-c 'permissions.devsync.extends=":workspace"'`,
      `-c "permissions.devsync.filesystem={'$RUNNER_TEMP'='deny','$HOME/runners'='deny','$HOME/actions-runner'='deny'}"`,
      "-c permissions.devsync.network.enabled=false",
    ]) {
      expect(install).toContain(part);
      expect(WORKFLOW.split(part)).toHaveLength(2);
    }
    // The /proc check: run through Codex's own sandbox with that profile, only when everything
    // before it went right; a process outside must not show inside, and only a passed check leaves
    // the profile the agent step requires.
    const ready = install.indexOf('            if [ "$ready" = true ]; then\n');
    expect(ready).toBeGreaterThan(settings);
    for (const part of [
      "sleep 120 &",
      "outside=$!",
      `fresh='[ -d /proc/1 ] && [ ! -e "/proc/$1" ] && [ "$(ls /proc | grep -c "^[0-9]*$")" -le 10 ]'`,
      `if codex sandbox "\${profile[@]}" -- sh -c "$fresh" probe "$outside"; then`,
      // Written whole, then moved into place: never a cut-off profile.
      '  marker="$RUNNER_TEMP/devsync-codex-sandbox-checked"',
      `  printf '%s\\n' "\${profile[@]}" > "$marker.tmp" && mv "$marker.tmp" "$marker" ||`,
      `    echo "::warning::Codex's sandbox profile couldn't be saved, so Codex won't run here."`,
      'kill "$outside" 2>/dev/null || true',
    ]) {
      expect(install).toContain(part);
      expect(install.indexOf(part)).toBeGreaterThan(ready);
      expect(install.indexOf(part)).toBeLessThan(end);
    }
    expect(install.match(/devsync-codex-sandbox-checked/g)).toHaveLength(1);
    expect(install.match(/> "\$marker/g)).toHaveLength(1);
    // The step can't fail or hang the job: Claude Code's runs never wait on it.
    const header = step("agent", "Install Codex")
      .slice(1, 3)
      .map((line) => line.trim());
    expect(header).toEqual(["continue-on-error: true", "timeout-minutes: 5"]);
  });

  it("runs Codex headless only once its sandbox is checked: checkout writes only, no network, no key for its commands", () => {
    const run = text(step("agent", "Run the coding agent"));
    for (const flag of [
      "exec --json --ephemeral --strict-config",
      '--model "$DEVSYNC_OPENAI_MODEL"',
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
    // The sandbox's profile isn't the step's own: it is the one the install step's check passed.
    expect(run).not.toContain("permissions.devsync");
    // Codex starts only on a GitHub-hosted runner whose sandbox passed the install step's check.
    const hosted = run.indexOf('            if [ "$RUNNER_ENVIRONMENT" != github-hosted ]; then\n');
    const checked = run.indexOf(
      `            elif ! mapfile -t profile 2>/dev/null < "$RUNNER_TEMP/devsync-codex-sandbox-checked" || [ "\${#profile[@]}" = 0 ]; then\n`,
    );
    const started = run.indexOf(`env -u OPENAI_API_KEY codex "\${flags[@]}" "\${profile[@]}"`);
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
      "turns: parsed($turns; null)",
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
