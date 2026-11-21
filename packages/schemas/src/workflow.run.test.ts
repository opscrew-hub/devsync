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
 * A grep that errors (exit 2) as BusyBox's does on `--exclude-dir`: on the contents check
 * (`-rqsF`), on the names check (the other one), or on both, else the real grep at `REAL_GREP`.
 */
const FAKE_GREP = `#!/usr/bin/env bash
case "$FAKE_GREP:$1" in
  all:*|contents:-rqsF) exit 2 ;;
  names:-rqsF) ;;
  names:*) exit 2 ;;
esac
exec "$REAL_GREP" "$@"
`;

/** A find that lists the files, then exits 1 as on a folder it can't read. */
const FAKE_FIND = `#!/usr/bin/env bash
"$REAL_FIND" "$@"
exit 1
`;

/** Where the real tools are, for the fakes that hand on to them. */
const real = (tool: string) =>
  tools
    ? spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
    : tool;

const tools =
  process.platform !== "win32" && spawnSync("bash", ["-c", "command -v jq"]).status === 0;

/** The sandbox profile the install step leaves when its check passed: one flag per line. */
const profileOf = (temp: string, home: string) => [
  "-c",
  "default_permissions=devsync",
  "-c",
  'permissions.devsync.extends=":workspace"',
  "-c",
  `permissions.devsync.filesystem={'${temp}'='deny','${home}/runners'='deny','${home}/actions-runner'='deny'}`,
  "-c",
  "permissions.devsync.network.enabled=false",
];

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
    find?: boolean;
    emptyProfile?: boolean;
    /** The runner's RUNNER_TEMP and HOME as the Install Codex step left them, its profile in. */
    after?: { temp: string; home: string };
  } = {},
): Run {
  const root = mkdtempSync(join(tmpdir(), "devsync-workflow-"));
  folders.push(root);
  const [bin, fake, ownTemp, ownHome, checkout] = ["bin", "fake", "temp", "home", "checkout"].map(
    (name) => {
      const folder = join(root, name);
      mkdirSync(folder);
      return folder;
    },
  ) as [string, string, string, string, string];
  const temp = options.after?.temp ?? ownTemp;
  const home = options.after?.home ?? ownHome;
  const fakes: [string, string][] = [
    ["codex", FAKE_CODEX],
    ["claude", FAKE_CLAUDE],
  ];
  if (options.grep) fakes.push(["grep", FAKE_GREP]);
  if (options.find) fakes.push(["find", FAKE_FIND]);
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
  if (options.emptyProfile) writeFileSync(join(temp, "devsync-codex-sandbox-checked"), "");
  if (!options.after && (options.checked ?? true)) {
    writeFileSync(
      join(temp, "devsync-codex-sandbox-checked"),
      `${profileOf(temp, home).join("\n")}\n`,
    );
  }
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
    REAL_GREP: real("grep"),
    REAL_FIND: real("find"),
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
    // The profile the install step's check passed, as it left it, right before the prompt.
    const profile = profileOf(run.temp, run.home);
    const dashes = args.indexOf("--");
    expect(args.slice(dashes - profile.length, dashes)).toEqual(profile);
    expect(run.log).not.toContain(run.key);
  });

  it("never starts Codex when the install step left an empty profile", () => {
    const run = runStep({ checked: false, emptyProfile: true });
    expect(run.ran).toBe(false);
    expect(run.outputs.get("failure")).toBe("agent-failed");
    expect(run.log).toContain("::error::Codex's sandbox failed its check");
  });

  it("never prints a missing profile's file error", () => {
    const run = runStep({ checked: false });
    expect(run.log).not.toContain("No such file");
  });

  it.each(["openai", "anthropic"] as const)(
    "fails closed with %s's key when the names check's find exits 1",
    (provider) => {
      const run = runStep({ provider, find: true });
      expect(run.ran).toBe(true);
      expect(run.outputs.get("failure")).toBe("agent-failed");
      expect(run.published).toBe(false);
      expect(run.log).toContain("in the change failed, so the change is not published.");
    },
  );

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

/** Stand-ins for the Install Codex step's tools, each recording its arguments under `$FAKE`. */
const INSTALL_FAKES: [string, string][] = [
  ["npm", `#!/usr/bin/env bash\necho "$*" >> "$FAKE/npm"\nexit "\${FAKE_NPM:-0}"\n`],
  [
    "sysctl",
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE/sysctl"
case "$1" in
  -n) [ "$2" = kernel.apparmor_restrict_unprivileged_userns ] && echo 1 && exit 0; exit 1 ;;
  *) exit "\${FAKE_SYSCTL_WRITE:-0}" ;;
esac
`,
  ],
  ["sudo", `#!/usr/bin/env bash\n[ "$1" = -n ] && shift\nexec "$@"\n`],
  // A sandbox that falls back as Codex's does when it can't mount a /proc: the command runs with
  // the runner's own /proc.
  [
    "codex",
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE/sandbox"
# With FAKE_SANDBOX_PASS, a sandbox whose /proc is its own: the probe passes.
[ -z "\${FAKE_SANDBOX_PASS:-}" ] || exit 0
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`,
  ],
];

/** Runs the Install Codex step with `INSTALL_FAKES` first on PATH. */
function install(
  options: { environment?: string; npm?: number; sysctl?: number; pass?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "devsync-install-"));
  folders.push(root);
  const [bin, fake, temp, home] = ["bin", "fake", "temp", "home"].map((name) => {
    const folder = join(root, name);
    mkdirSync(folder);
    return folder;
  }) as [string, string, string, string];
  for (const [name, text] of INSTALL_FAKES) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const step = spawnSync("bash", ["-e", "-c", script("Install Codex")], {
    cwd: home,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      RUNNER_TEMP: temp,
      RUNNER_ENVIRONMENT: options.environment ?? "github-hosted",
      FAKE: fake,
      FAKE_NPM: String(options.npm ?? 0),
      FAKE_SYSCTL_WRITE: String(options.sysctl ?? 0),
      ...(options.pass ? { FAKE_SANDBOX_PASS: "1" } : {}),
    },
    encoding: "utf8",
  });
  const read = (name: string) =>
    existsSync(join(fake, name)) ? readFileSync(join(fake, name), "utf8") : null;
  return {
    status: step.status,
    log: `${step.stdout}${step.stderr}`,
    marked: existsSync(join(temp, "devsync-codex-sandbox-checked")),
    npm: read("npm"),
    sysctl: read("sysctl"),
    sandbox: read("sandbox"),
    temp,
    home,
  };
}

describe.skipIf(!tools)("the Install Codex step, run (needs bash)", () => {
  it("leaves the probed profile whole, and the agent step hands Codex exactly that profile", () => {
    const installed = install({ pass: true });
    expect(installed.status).toBe(0);
    expect(installed.log).not.toContain("::warning::");
    expect(installed.marked).toBe(true);
    // One flag per line, nothing more: the profile the probe ran with, whole.
    const marker = join(installed.temp, "devsync-codex-sandbox-checked");
    const profile = profileOf(installed.temp, installed.home);
    expect(readFileSync(marker, "utf8")).toBe(`${profile.join("\n")}\n`);
    expect(existsSync(`${marker}.tmp`)).toBe(false);
    const probe = (installed.sandbox ?? "").split("\n");
    const probed = probe.slice(1, probe.indexOf("--"));
    expect(probed).toEqual(profile);

    // The agent step on the same runner: Codex's sandbox flags are the probe's, in order.
    const run = runStep({ after: { temp: installed.temp, home: installed.home } });
    expect(run.ran).toBe(true);
    expect(run.outputs.get("failure")).toBe("");
    const args = readFileSync(join(run.fake, "args"), "utf8").split("\n");
    const dashes = args.indexOf("--");
    expect(args.slice(dashes - probed.length, dashes)).toEqual(probed);
    expect(args.filter((arg) => arg.includes("permissions"))).toEqual(
      probed.filter((arg) => arg.includes("permissions")),
    );
  });

  it("leaves no profile when the sandbox falls back to the runner's /proc", () => {
    const run = install();
    expect(run.status).toBe(0);
    expect(run.npm).toBe("install --global @openai/codex@0.171.0\n");
    expect(run.sysctl).toContain("-q -w kernel.apparmor_restrict_unprivileged_userns=0");
    // The probe ran through the sandbox with the run's own profile.
    expect(run.sandbox?.split("\n").slice(0, 10)).toEqual([
      "sandbox",
      ...profileOf(run.temp, run.home),
      "--",
    ]);
    expect(run.log).toContain(
      "::warning::Codex's sandbox has no /proc of its own on this runner, so Codex won't run here.",
    );
    expect(run.marked).toBe(false);
  });

  it("warns, skips the probe and leaves no profile when a setting is refused, the step still passing", () => {
    const run = install({ sysctl: 1 });
    expect(run.status).toBe(0);
    expect(run.log).toContain(
      "::warning::Codex's sandbox needs kernel.apparmor_restrict_unprivileged_userns=0, which this runner refused, so Codex won't run here.",
    );
    expect(run.sandbox).toBeNull();
    expect(run.marked).toBe(false);
  });

  it("warns, skips the probe and leaves no profile when Codex doesn't install, the step still passing", () => {
    const run = install({ npm: 1 });
    expect(run.status).toBe(0);
    expect(run.log).toContain("::warning::Codex didn't install, so Codex won't run here.");
    expect(run.sandbox).toBeNull();
    expect(run.marked).toBe(false);
  });

  it.each(["self-hosted", ""])("changes nothing on a runner that is %j", (environment) => {
    const run = install({ environment });
    expect(run.status).toBe(0);
    expect([run.npm, run.sysctl, run.sandbox]).toEqual([null, null, null]);
    expect(run.marked).toBe(false);
  });
});
