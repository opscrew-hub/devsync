import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW } from "./workflow";

/** A step's `run: |` script in the agent job, as the runner gets it. */
function script(title: string): string {
  const lines = WORKFLOW.split("\n");
  const at = lines.indexOf(`      - name: ${title}`);
  const run = lines.findIndex((line, i) => i > at && line === "        run: |");
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/**
 * What `codex exec --json` 0.171.0 printed in a local run against a fake Responses API (see
 * docs/research/openai.md), cut to one event of each kind: a reconnect `error` that isn't a failure,
 * and the run's totals, cache writes included.
 */
const RECORDED = [
  '{"type":"thread.started","thread_id":"01a1fcbb-0d81-74d0-a4f9-f7e728960d9a"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: 0, url: ws://127.0.0.1:8080/v1/responses)"}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/sh -lc \\"printf \'hello\\\\\\\\n\' > hello.txt\\"","aggregated_output":"","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":3000,"cached_input_tokens":1200,"cache_write_input_tokens":600,"output_tokens":600,"reasoning_output_tokens":150}}',
];

/** Stands in for Codex: records what it was given, changes a file and prints `FAKE/events`. */
const FAKE_CODEX = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE/args"
env | cut -d= -f1 > "$FAKE/env-names"
printenv CODEX_API_KEY > "$FAKE/codex-api-key"
cat > "$FAKE/stdin"
[ -z "\${FAKE_LEAK:-}" ] || printenv CODEX_API_KEY > leaked.txt
printf 'changed\\n' > change.txt
cat "$FAKE/events"
exit "\${FAKE_EXIT:-0}"
`;

/** Stands in for Claude Code: changes a file and prints `FAKE/claude.json`. */
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE/args"
cat > "$FAKE/stdin"
[ -z "\${FAKE_LEAK:-}" ] || printenv ANTHROPIC_API_KEY > leaked.txt
printf 'changed\\n' > change.txt
cat "$FAKE/claude.json"
`;

const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.05,
  modelUsage: {
    "claude-sonnet-5-5": {
      inputTokens: 900,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
});

/**
 * A grep that errors (exit 2) as BusyBox's does on `--exclude-dir`: on the contents check (`-rqF`),
 * on the names check (the other one), or on both, else the real grep at `REAL_GREP`.
 */
const FAKE_GREP = `#!/usr/bin/env bash
case "$FAKE_GREP:$1" in
  all:*|contents:-rqF) exit 2 ;;
  names:-rqF) ;;
  names:*) exit 2 ;;
esac
exec "$REAL_GREP" "$@"
`;

const tools =
  process.platform !== "win32" && spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const realGrep = tools ? spawnSync("bash", ["-c", "command -v grep"], { encoding: "utf8" }) : null;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Run {
  outputs: Map<string, string>;
  log: string;
  ran: boolean;
  /** The patch step ran after the agent step and handed a change on to `publish`. */
  published: boolean;
  fake: string;
  temp: string;
  home: string;
  key: string;
}

/**
 * Runs the agent step as a runner would, with only an OpenAI key (Codex being `FAKE_CODEX`) or with
 * only an Anthropic key (Claude Code being `FAKE_CLAUDE`); then, as the job does when the step
 * reports no failure, the patch step.
 */
function runStep(
  options: {
    provider?: "openai" | "anthropic";
    environment?: string;
    checked?: boolean;
    events?: string[];
    exit?: number;
    leak?: boolean;
    key?: boolean;
    grep?: "all" | "contents" | "names";
  } = {},
): Run {
  const root = mkdtempSync(join(tmpdir(), "devsync-workflow-"));
  folders.push(root);
  const [bin, fake, temp, home, checkout] = ["bin", "fake", "temp", "home", "checkout"].map(
    (name) => {
      const folder = join(root, name);
      mkdirSync(folder);
      return folder;
    },
  ) as [string, string, string, string, string];
  const fakes: [string, string][] = [
    ["codex", FAKE_CODEX],
    ["claude", FAKE_CLAUDE],
  ];
  if (options.grep) fakes.push(["grep", FAKE_GREP]);
  for (const [name, text] of fakes) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(fake, "events"), `${(options.events ?? RECORDED).join("\n")}\n`);
  writeFileSync(join(fake, "claude.json"), CLAUDE_RESULT);
  writeFileSync(
    join(temp, "task.json"),
    '{"title":"T","description":"D","acceptanceCriteria":"C"}',
  );
  if (options.checked ?? true) writeFileSync(join(temp, "devsync-codex-sandbox-checked"), "");
  writeFileSync(join(checkout, "README.md"), "base\n");
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: checkout });
  git("init", "-q");
  git("add", "--all");
  git("commit", "-qm", "base");
  const key = `test-${randomUUID()}`;
  const anthropic = options.provider === "anthropic";
  const given = options.key === false ? "" : key;
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    RUNNER_TEMP: temp,
    RUNNER_ENVIRONMENT: options.environment ?? "github-hosted",
    GITHUB_OUTPUT: join(root, "output"),
    FAKE: fake,
    DEVSYNC_MODEL: "sonnet",
    DEVSYNC_MAX_TURNS: "40",
    DEVSYNC_MAX_BUDGET_USD: "5.00",
    DEVSYNC_OPENAI_MODEL: "gpt-6.2-sol",
    DEVSYNC_OPENAI_INPUT_USD: "2.00",
    DEVSYNC_OPENAI_CACHED_INPUT_USD: "0.10",
    DEVSYNC_OPENAI_CACHE_WRITE_USD: "2.50",
    DEVSYNC_OPENAI_OUTPUT_USD: "10.00",
    ANTHROPIC_API_KEY: anthropic ? given : "",
    OPENROUTER_API_KEY: "",
    OPENAI_API_KEY: anthropic ? "" : given,
    FAKE_EXIT: String(options.exit ?? 0),
    REAL_GREP: realGrep?.stdout.trim() ?? "grep",
    ...(options.leak ? { FAKE_LEAK: "1" } : {}),
    ...(options.grep ? { FAKE_GREP: options.grep } : {}),
  };
  const step = spawnSync("bash", ["-e", "-c", script("Run the coding agent")], {
    cwd: checkout,
    env,
    encoding: "utf8",
  });
  expect(step.status, step.stderr).toBe(0);
  const outputs = outputsOf(join(root, "output"));
  let published = false;
  if (outputs.get("failure") === "") {
    // The job's `if: steps.agent.outputs.failure == ''` on the patch step.
    const patch = spawnSync("bash", ["-e", "-c", script("Build the patch")], {
      cwd: checkout,
      env: { ...env, GITHUB_OUTPUT: join(root, "patch-output") },
      encoding: "utf8",
    });
    expect(patch.status, patch.stderr).toBe(0);
    published = outputsOf(join(root, "patch-output")).get("has_changes") === "true";
  }
  return {
    outputs,
    log: `${step.stdout}${step.stderr}`,
    ran: existsSync(join(fake, "args")),
    published,
    fake,
    temp,
    home,
    key,
  };
}

/** A `GITHUB_OUTPUT` file's `name=value` lines. */
function outputsOf(file: string): Map<string, string> {
  const written = existsSync(file) ? readFileSync(file, "utf8") : "";
  return new Map(
    written
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const usageOf = (run: Run) => JSON.parse(run.outputs.get("usage") ?? "null");
const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0,
};

describe.skipIf(!tools)("the agent step, run (needs bash and jq)", () => {
  it("runs Codex on a checked GitHub-hosted runner and reads its tokens and cost from its events", () => {
    const run = runStep();
    expect(run.outputs.get("provider")).toBe("openai");
    expect(run.outputs.get("failure")).toBe("");
    expect(run.published).toBe(true);
    expect(JSON.parse(run.outputs.get("models") ?? "null")).toEqual(["gpt-6.2-sol"]);
    // 3,000 input tokens hold 1,200 cached and 600 cache-written ones: 1,200 are fresh.
    const usage = usageOf(run);
    expect(usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 600,
      cacheCreationInputTokens: 600,
      cacheReadInputTokens: 1200,
    });
    // (1,200 × 2.00 + 1,200 × 0.10 + 600 × 2.50 + 600 × 10.00) / 1,000,000
    expect(usage.costUsd).toBeCloseTo(0.01002, 10);
    expect(readFileSync(join(run.fake, "stdin"), "utf8")).toContain('"title":"T"');
  });

  it("hands Codex the key as CODEX_API_KEY only, and its sandbox the folders it may not read", () => {
    const run = runStep();
    expect(readFileSync(join(run.fake, "codex-api-key"), "utf8").trim()).toBe(run.key);
    const names = readFileSync(join(run.fake, "env-names"), "utf8").split("\n");
    expect(names).toContain("CODEX_API_KEY");
    expect(names).not.toContain("OPENAI_API_KEY");
    const args = readFileSync(join(run.fake, "args"), "utf8").split("\n");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain(
      `permissions.devsync.filesystem={'${run.temp}'='deny','${run.home}/runners'='deny'}`,
    );
    expect(run.log).not.toContain(run.key);
  });

  it.each([
    [
      "a self-hosted runner",
      { environment: "self-hosted" },
      "Codex runs only on GitHub-hosted runners",
    ],
    ["no runner kind at all", { environment: "" }, "Codex runs only on GitHub-hosted runners"],
    ["a sandbox that failed its check", { checked: false }, "Codex's sandbox failed its check"],
  ])("never starts Codex on %s, failing agent-failed with why", (_, options, why) => {
    const run = runStep(options);
    expect(run.ran).toBe(false);
    expect(run.outputs.get("failure")).toBe("agent-failed");
    expect(run.outputs.get("provider")).toBe("openai");
    expect(usageOf(run)).toEqual(ZERO);
    expect(run.log).toContain(`::error::${why}`);
  });

  it("fails agent-failed when Codex exits non-zero or its turn failed, keeping its tokens", () => {
    const exited = runStep({ exit: 1 });
    expect(exited.outputs.get("failure")).toBe("agent-failed");
    expect(usageOf(exited)).toMatchObject({ inputTokens: 1200, outputTokens: 600 });

    const turnFailed = runStep({
      events: [...RECORDED.slice(0, 3), '{"type":"turn.failed","error":{"message":"boom"}}'],
    });
    expect(turnFailed.outputs.get("failure")).toBe("agent-failed");
    expect(usageOf(turnFailed)).toEqual(ZERO);
  });

  it("reads past a line that isn't JSON, and takes the last turn.completed", () => {
    const earlier = RECORDED.at(-1)?.replace('"input_tokens":3000', '"input_tokens":9999') ?? "";
    const run = runStep({ events: ["not json", earlier, ...RECORDED] });
    expect(run.outputs.get("failure")).toBe("");
    expect(usageOf(run)).toMatchObject({ inputTokens: 1200, cacheCreationInputTokens: 600 });
  });

  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const)("refuses a change that holds the key, with %s's", (provider, secret) => {
    const run = runStep({ provider, leak: true });
    expect(run.outputs.get("provider")).toBe(provider);
    expect(run.outputs.get("failure")).toBe("agent-failed");
    expect(run.published).toBe(false);
    expect(run.log).toContain(
      `::error::The change holds the ${secret} secret, so it is not published.`,
    );
    expect(run.log).not.toContain(run.key);
  });

  it.each([
    ["openai", "all"],
    ["openai", "contents"],
    ["openai", "names"],
    ["anthropic", "all"],
    ["anthropic", "contents"],
    ["anthropic", "names"],
  ] as const)(
    "fails closed with %s's key when the key check's grep errors (%s)",
    (provider, grep) => {
      const secret = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      const run = runStep({ provider, grep });
      expect(run.ran).toBe(true);
      expect(run.outputs.get("failure")).toBe("agent-failed");
      expect(run.published).toBe(false);
      expect(run.log).toContain(
        `::error::The check for the ${secret} secret in the change failed, so the change is not published.`,
      );
      expect(run.log).not.toContain(run.key);
    },
  );

  it("publishes Claude Code's clean change, the key check finding nothing", () => {
    const run = runStep({ provider: "anthropic" });
    expect(run.outputs.get("provider")).toBe("anthropic");
    expect(run.outputs.get("failure")).toBe("");
    expect(run.published).toBe(true);
    expect(usageOf(run)).toMatchObject({ inputTokens: 900, outputTokens: 100, costUsd: 0.05 });
  });

  it("fails no-key without any key, running nothing", () => {
    const run = runStep({ key: false });
    expect(run.ran).toBe(false);
    expect(run.outputs.get("failure")).toBe("no-key");
    expect(run.outputs.has("provider")).toBe(false);
  });
});
