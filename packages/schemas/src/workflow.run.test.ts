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

const tools =
  process.platform !== "win32" && spawnSync("bash", ["-c", "command -v jq"]).status === 0;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Run {
  outputs: Map<string, string>;
  log: string;
  ran: boolean;
  fake: string;
  temp: string;
  home: string;
  key: string;
}

/** Runs the agent step with only an OpenAI key, as a runner would, Codex being `FAKE_CODEX`. */
function runStep(
  options: {
    environment?: string;
    checked?: boolean;
    events?: string[];
    exit?: number;
    leak?: boolean;
    key?: boolean;
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
  writeFileSync(join(bin, "codex"), FAKE_CODEX);
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(fake, "events"), `${(options.events ?? RECORDED).join("\n")}\n`);
  writeFileSync(
    join(temp, "task.json"),
    '{"title":"T","description":"D","acceptanceCriteria":"C"}',
  );
  if (options.checked ?? true) writeFileSync(join(temp, "devsync-codex-sandbox-checked"), "");
  writeFileSync(join(checkout, "README.md"), "base\n");
  const key = `test-${randomUUID()}`;
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
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENAI_API_KEY: options.key === false ? "" : key,
    FAKE_EXIT: String(options.exit ?? 0),
    ...(options.leak ? { FAKE_LEAK: "1" } : {}),
  };
  const step = spawnSync("bash", ["-e", "-c", script("Run the coding agent")], {
    cwd: checkout,
    env,
    encoding: "utf8",
  });
  expect(step.status, step.stderr).toBe(0);
  const written = existsSync(env.GITHUB_OUTPUT ?? "")
    ? readFileSync(join(root, "output"), "utf8")
    : "";
  const outputs = new Map(
    written
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    outputs,
    log: `${step.stdout}${step.stderr}`,
    ran: existsSync(join(fake, "args")),
    fake,
    temp,
    home,
    key,
  };
}

const usageOf = (run: Run) => JSON.parse(run.outputs.get("usage") ?? "null");
const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0,
};

describe.skipIf(!tools)("the agent step with only an OpenAI key, run (needs bash and jq)", () => {
  it("runs Codex on a checked GitHub-hosted runner and reads its tokens and cost from its events", () => {
    const run = runStep();
    expect(run.outputs.get("provider")).toBe("openai");
    expect(run.outputs.get("failure")).toBe("");
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

  it("refuses a change that holds the key", () => {
    const run = runStep({ leak: true });
    expect(run.outputs.get("failure")).toBe("agent-failed");
    expect(run.log).toContain(
      "::error::The change holds the OPENAI_API_KEY secret, so it is not published.",
    );
    expect(run.log).not.toContain(run.key);
  });

  it("fails no-key without any key, running nothing", () => {
    const run = runStep({ key: false });
    expect(run.ran).toBe(false);
    expect(run.outputs.get("failure")).toBe("no-key");
    expect(run.outputs.has("provider")).toBe(false);
  });
});
