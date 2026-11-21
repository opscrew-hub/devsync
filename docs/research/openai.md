# Research: managed runs paid with an OpenAI key, through Codex

2026-11-21. Can a managed run use an OpenAI API key? Not with Claude Code: its models are Claude's,
and OpenAI's API doesn't serve them. With an OpenAI key the run uses OpenAI's own headless coding
agent, the Codex CLI. Official sources only (OpenAI's Codex docs, the `openai/codex` and
`openai/codex-action` repositories at the tag or branch named), plus a local check.

## What the sources say

- **Headless** ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  redirected from developers.openai.com/codex/noninteractive):
  - `codex exec "<prompt>"`: progress goes to stderr, the final message to stdout.
  - With a prompt argument, piped stdin is added as extra context. The CLI's own help says it is
    appended as a `<stdin>` block.
  - `--json` turns stdout into JSON Lines. The events are `thread.started`, `turn.started`,
    `turn.completed`, `turn.failed`, `item.*` and `error`.
  - `turn.completed` carries `usage`: `input_tokens`, `cached_input_tokens`, `output_tokens` and
    `reasoning_output_tokens`. No event carries a cost.
  - `--ephemeral` keeps no session files. `--skip-git-repo-check` allows running outside Git, which
    a checkout doesn't need.
- **The key in CI** (same page): `CODEX_API_KEY=<key> codex exec --json …` for a single run. The
  page advises against setting `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level variable in
  workflows that run repository code.
  - The source agrees ([`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/login/src/auth/manager.rs)):
    exec reads `CODEX_API_KEY`.
- **OpenAI's own action** ([openai/codex-action](https://github.com/openai/codex-action), its
  `action.yml` on `main`):
  - It installs `@openai/codex` at `codex-version`.
  - It keeps the key in a separate Responses API proxy, and by default takes sudo away from the
    runner user before Codex starts (`drop-sudo`).
  - On GitHub-hosted Linux runners it sets `kernel.unprivileged_userns_clone=1` and
    `kernel.apparmor_restrict_unprivileged_userns=0`. Codex's sandbox (bubblewrap) needs
    unprivileged user namespaces, and Ubuntu 24.04 blocks them through AppArmor.
  - Its only output is the final message: no tokens.
  - Its example workflow has the same shape as DevSync's: a Contents-read job uploads a patch, and
    a separate job opens the pull request without the key.
- **Flags** ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and
  `codex exec --help` of 0.171.0):
  - `-m/--model`.
  - `-s/--sandbox read-only|workspace-write|danger-full-access`.
  - `-c key=value`, a config override parsed as TOML.
  - `--ignore-user-config` skips `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`.
  - `--ignore-rules` skips the execpolicy `.rules` files.
  - `--strict-config` refuses unknown config fields.
  - What not to use: `--dangerously-bypass-approvals-and-sandbox`/`--yolo`, `--approve-for-me`,
    `--trust` and `--add-dir`.
- **Sandbox and approvals** ([approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
  [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)):
  - `workspace-write` writes in the working directory and temporary folders. `.git`, `.agents`,
    `.codex` and `.aws` stay read-only.
  - Network is off in it by default (`sandbox_workspace_write.network_access`).
  - `approval_policy = "never"` is the setting for non-interactive runs. Exec defaults to it
    ([`exec/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/exec/src/lib.rs)).
  - Project `.codex/config.toml` (hooks, rules, MCP servers) loads only for a trusted project.
  - `web_search` takes `disabled`, `cached` (the default), `indexed` or `live`.
- **The commands' environment**
  ([`shell_environment_policy.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/config/src/shell_environment_policy.rs),
  [`protocol/src/shell_environment.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/protocol/src/shell_environment.rs)):
  - The defaults are `inherit = all` and `ignore_default_excludes = true`. So **by default the
    model's commands inherit `CODEX_API_KEY`**.
  - `inherit = core` keeps only `PATH`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `HOME`, `LANG`,
    `LC_ALL`, `LC_CTYPE`, `LOGNAME` and `USER`.
  - `ignore_default_excludes = false` also drops every `*KEY*`, `*SECRET*` and `*TOKEN*` name.
- **The Linux sandbox**
  ([`linux-sandbox/src/bwrap.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/linux-sandbox/src/bwrap.rs)):
  - Each command runs in new user, PID and IPC namespaces, with a fresh `/proc` and all
    capabilities dropped.
  - It also gets a new network namespace when network is off. So a command can't read Codex's own
    environment, nor the agent step's, through `/proc`.
  - **The fresh `/proc` can silently go**
    ([`linux-sandbox/src/linux_run_main.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/linux-sandbox/src/linux_run_main.rs),
    `run_bwrap_with_proc_fallback`). A preflight runs `/bin/true` under bubblewrap with
    `--proc /proc`. If that mount fails ("restricted containers"), the real command runs without
    a fresh `/proc`, and nothing is reported. The command then sees the runner's `/proc`,
    including the `/proc/<pid>/environ` of the step that holds the key.
  - `workspace-write` mounts `/` read-only: **commands can read the whole runner**, not only the
    checkout.
  - Permission profiles (`default_permissions`, `[permissions.<name>]`, beta per the
    [permissions page](https://learn.chatgpt.com/docs/permissions)) can deny reads of chosen
    paths. `--sandbox` sets them aside, so a profile replaces it.
  - **What the commands can't do** ([`linux-sandbox/src/seccomp.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/linux-sandbox/src/seccomp.rs)):
    - `no_new_privs` is set before seccomp, so a setuid `sudo` gains nothing inside the sandbox.
    - seccomp denies `ptrace`, `process_vm_readv` and `process_vm_writev`, so commands can't
      read another process's memory.
    - With network off, seccomp also denies `connect`, `accept`, `bind`, `listen` and the
      sending calls.
- **AGENTS.md** ([`core/src/agents_md.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/agents_md.rs)):
  - It isn't read for an untrusted project, nor with `project_doc_max_bytes = 0`.
- **Repository skills**
  ([`ext/skills/src/host_roots.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/ext/skills/src/host_roots.rs),
  lines 113-121; [`config/src/skills_config.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/config/src/skills_config.rs)):
  - The repository's `.agents/skills` are skill roots whether the project is trusted or not.
  - `skills.include_instructions = false` keeps the skills catalog out of the model's context.
- **Models** ([models](https://learn.chatgpt.com/docs/models)):
  - GPT-6.2 Sol (`gpt-6.2-sol`) is for everyday tasks such as editing code, and is the page's
    sample `model`.
  - GPT-6.2 Astra (`gpt-6.2-astra`) is for demanding work.
  - The page names no CLI default. With an API key, availability follows the API organization and
    project.
- **Prices** ([API pricing](https://developers.openai.com/api/docs/pricing), read 2026-11-21; the
  page shows no date of its own):
  - Standard tier, per million tokens, for at most 272K input tokens:

    | Model | Input | Cached input | 30m write | 12h write | Output |
    | - | - | - | - | - | - |
    | `gpt-6.2-sol` | $2.00 | $0.10 | $2.50 | $5.00 | $10.00 |
    | `gpt-6.2-astra` | $8.00 | $0.40 | $10.00 | $20.00 | $40.00 |

  - Above 272K input tokens, Sol costs $4.00, $0.20, $5.00, $10.00 and $15.00.
  - The page doesn't say what decides between the 30-minute and the 12-hour write, nor how
    reasoning tokens are billed.
- **Token counts** ([`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/protocol/src/protocol.rs),
  [`exec/src/event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs)):
  - `input_tokens` includes the cached ones (`non_cached_input = input - cached`).
  - It includes the cache-written ones too. `cache_write_input_tokens` comes from the API's
    `input_tokens_details.cache_write_tokens`, and Codex's own test
    ([`codex-api/src/sse/responses.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/codex-api/src/sse/responses.rs),
    `parses_cache_write_token_usage`) has 100 input tokens made of 40 cached and 60 written.
  - `turn.completed`'s usage is the thread's running total.
  - `turn.failed` carries only an error message.
- **Version:** `@openai/codex` 0.171.0 is the latest on npm (2026-11-21), `codex-cli 0.171.0`.

## Checked locally

Codex 0.171.0 in a throwaway container (`node:24-alpine`, unprivileged user, seccomp off as on a
VM runner), with `codex exec` pointed at a local fake Responses API through `-c openai_base_url`.
The fake answered with two shell calls, then a final message, each response with token usage.

- **The key.** With only `CODEX_API_KEY` set (`OPENAI_API_KEY` unset), every request carried
  `Authorization: Bearer <that key>`.
- **The commands' environment.**
  - With `-c shell_environment_policy.inherit=core -c shell_environment_policy.ignore_default_excludes=false`,
    the model's commands saw only core variables and Codex's own `CODEX_*` markers, with no key.
  - Without those settings, they saw `CODEX_API_KEY`.
- **The sandbox.** With `--sandbox workspace-write -c sandbox_workspace_write.network_access=false`:
  - Writing `.git/config` was refused, and so was writing in `$HOME`. Writing in the checkout and
    in `/tmp` was allowed.
  - The local server was unreachable from a command.
  - Files in `$HOME` and `/tmp` could be read.
- **The repository's files.**
  - With `-c project_doc_max_bytes=0`, the repository's `AGENTS.md` never reached the model.
    Without that setting it did.
  - A `.codex/config.toml` MCP server in the repository was not started.
- **The events.**
  - `--json` printed `turn.completed` with the run's totals:
    `{"input_tokens":3000,"cached_input_tokens":1200,"cache_write_input_tokens":0,"output_tokens":600,"reasoning_output_tokens":150}`.
  - It also printed `error` events for WebSocket reconnects, which the fake didn't serve. The run
    still exited 0.
  - So `error` events alone don't mean failure; `turn.failed` does.
- **Strict config.**
  - `--strict-config` refused an unknown `-c` key and a bad `web_search` value, and accepted all of
    DevSync's settings, `skills.include_instructions` and the permission profile's included.
  - With the API unreachable, Codex waited and kept retrying.
- **Repository skills.** A `.agents/skills/pwn/SKILL.md` in the repository reached the model's
  context without `-c skills.include_instructions=false`, and didn't with it.
- **Deny-read profiles.**
  - A profile that denies reads outside the workspace (`":root" = "deny"`, `":minimal" = "read"`,
    the workspace writable) made every command fail with exit code 2 on that image.
  - So did one that extends `:workspace` and denies all of `$HOME` when the checkout is inside
    it, as on a runner (`$HOME/work/<repo>/<repo>`). The deny on the parent wins over the
    workspace.
  - Narrow entries work: a profile that extends `:workspace` and denies `$HOME/work/_temp` (the
    runner's `RUNNER_TEMP`), `$HOME/runners` and `$HOME/.*`. Those reads failed with
    "Permission denied".
  - With those entries the checkout stayed readable and writable, `git status` worked, `.git`
    stayed read-only, `/tmp` was writable and the network was blocked
    (`permissions.<name>.network.enabled = false`).
- **The `/proc` probe**, the workflow's own Install Codex script (its `npm install` a shim),
  run from the checkout as a step is:
  - With the real `codex sandbox` and the run's profile it saw 5 processes and not the outside
    one, and left the profile for the agent step. A missing `$HOME/runners` was skipped, and an
    existing `$HOME/actions-runner` was denied.
  - Run from `/` instead, bubblewrap couldn't create the workspace's `/.codex`, and the probe
    failed closed. A step runs in the checkout, where the probe left nothing behind.
  - With a `codex` shim whose `sandbox` runs the command with no sandbox (what the fallback
    leaves of `/proc`), it warned and left none.
  - Docker refuses mounts inside `/proc`, so the real fallback couldn't be triggered here.
- **The workflow's own step script** ran with a fake Codex address, a real `jq` and only
  `OPENAI_API_KEY` set, on a runner marked `github-hosted` whose probe passed:
  - The fake reported 200 cache-written tokens per response, and Codex's `turn.completed` was
    `{"input_tokens":3000,"cached_input_tokens":1200,"cache_write_input_tokens":600,"output_tokens":600,"reasoning_output_tokens":150}`.
  - The step wrote `provider=openai` and an empty `failure`.
  - It wrote
    `usage={"inputTokens":1200,"outputTokens":600,"cacheCreationInputTokens":600,"cacheReadInputTokens":1200,"costUsd":0.01002}`
    and `models=["gpt-6.2-sol"]`, and the patch step found the change.
  - Its commands couldn't read the job's temp folder or the runner's folder.
  - On a runner marked `self-hosted`, or after a failed probe, it failed `agent-failed` with its
    reason and never started Codex.
  - With no key it failed `no-key`. With a Codex that exits non-zero it failed `agent-failed`.
  - `workflow.run.test.ts` runs that step with a fake `codex` printing these recorded events,
    and the Install Codex step with fake `npm`, `sysctl`, `sudo` and a `codex sandbox` that
    falls back.

## Decision

- **The order.** A run takes `OPENAI_API_KEY` as a third key, after `ANTHROPIC_API_KEY` and
  `OPENROUTER_API_KEY` (D5's rule extended: the first key that is set is used).
  - The two Claude keys run the same agent and models, and stay ahead.
  - An OpenAI key changes the agent, so it is used only when neither of the others is set. A
    workspace that adds an OpenAI key for other work keeps its Claude runs.
- **Where Codex runs.** Only on GitHub-hosted runners (`RUNNER_ENVIRONMENT=github-hosted`), as
  OpenAI's action sets its sandbox up only there.
  - A keyless "Install Codex" step runs for every run, since only the agent step knows which key
    is set. On a runner that isn't GitHub-hosted it does nothing.
  - On a hosted runner it installs `@openai/codex@0.171.0` and sets the two user-namespace
    settings.
  - It then runs the `/proc` probe through `codex sandbox` with the run's own sandbox profile, so
    the profile parses before any key is there. A `sleep` outside the sandbox must not show
    inside it, and inside it at most 10 processes may show.
  - Only a passed probe writes the profile, one flag per line, to
    `$RUNNER_TEMP/devsync-codex-sandbox-checked`. It is written to a `.tmp` file and moved into
    place, so a cut-off write leaves no profile rather than a weaker one; a failed write warns.
  - A failed install or a refused setting warns, skips the probe and writes nothing.
  - The step has `continue-on-error: true` and `timeout-minutes: 5`: a failure or a hang (npm,
    the probe) never stops the job, so Claude Code's runs go on, and Codex fails closed for want
    of the profile.
  - The agent step starts Codex only on a hosted runner and with that profile, which it adds to
    Codex's flags. Otherwise the run fails `agent-failed`, and the step's log says why.
- **How Codex runs.** With only the OpenAI key, the agent step runs Codex instead of Claude Code,
  with the same prompt and task on stdin:

  ```
  codex exec --json --ephemeral --strict-config --model "$DEVSYNC_OPENAI_MODEL"
    -c approval_policy=never -c web_search=disabled
    -c shell_environment_policy.inherit=core -c shell_environment_policy.ignore_default_excludes=false
    -c project_doc_max_bytes=0 -c skills.include_instructions=false -c history.persistence=none
    --ignore-user-config --ignore-rules
    -c default_permissions=devsync -c 'permissions.devsync.extends=":workspace"'
    -c "permissions.devsync.filesystem={'$RUNNER_TEMP'='deny','$HOME/runners'='deny','$HOME/actions-runner'='deny'}"
    -c permissions.devsync.network.enabled=false
  ```

  - The key reaches Codex as `CODEX_API_KEY` only, and `OPENAI_API_KEY` is unset for it.
  - A run succeeds on exit 0 with a `turn.completed` event and no `turn.failed`. Anything else is
    `agent-failed`.
- **The sandbox's reads.**
  - The profile keeps `:workspace`'s writes and `.git` protection, and denies the step's
    temporary folder (`RUNNER_TEMP`: the step scripts, the task, Codex's output) and the
    runner's own folder, `$HOME/runners` or `$HOME/actions-runner`, as images differ. A missing
    path is skipped.
  - Denying `$HOME` itself breaks every command, because the checkout is inside it.
  - `$HOME/.*` worked locally, but it would also hide any toolchain the runner keeps in a dot
    folder of `$HOME` and puts on `PATH`. It waits for the live listing below.
- **Sudo stays.** OpenAI's action takes sudo away from the runner user (`drop-sudo`) before Codex
  starts; DevSync doesn't.
  - The install step needs sudo for the two settings, and it runs before any key is present.
  - Inside the sandbox `no_new_privs` stops a setuid `sudo` from gaining anything.
  - seccomp denies `ptrace`, `process_vm_readv` and `process_vm_writev`, and with network off
    `connect` too. So a command can neither use sudo nor read Codex's or the step's memory.
  - Codex itself runs nothing outside its sandbox: approvals are `never`, with no bypass flag.
- **The model.** `gpt-6.2-sol`, set as `DEVSYNC_OPENAI_MODEL` in the workflow. `models` names it,
  since Codex's events don't name the model.
- **Usage.**
  - `cacheReadInputTokens = cached_input_tokens` and `cacheCreationInputTokens = cache_write_input_tokens`.
  - `inputTokens` is `input_tokens` less both, and `outputTokens = output_tokens` (reasoning
    included).
  - The cost is worked out in the workflow from those tokens at the prices noted next to the model
    (from the pricing page on 2026-11-21, standard tier): `DEVSYNC_OPENAI_INPUT_USD` $2.00,
    `DEVSYNC_OPENAI_CACHED_INPUT_USD` $0.10, `DEVSYNC_OPENAI_CACHE_WRITE_USD` $2.50 and
    `DEVSYNC_OPENAI_OUTPUT_USD` $10.00.
  - Cache writes are priced at the 30-minute rate. The 12-hour rate is $5.00, and the page doesn't
    say which one Codex's requests get.
  - The dashboard labels the cost "estimated from OpenAI's prices".
- **Not used.**
  - `openai/codex-action`, since it reports no tokens and adds a third-party action to the
    workflow.

## To check live

- **A real run on a GitHub-hosted `ubuntu-latest` runner:**
  - the sandbox after the two settings;
  - the `/proc` probe passing;
  - the deny-read profile;
  - the draft pull request;
  - the reported tokens and cache writes against the OpenAI project's usage page.
- **The `/proc` fallback.** Codex 0.171.0 drops the fresh `/proc` silently when mounting one
  fails.
  - The probe and the agent step's marker keep Codex from running then, but the fallback itself
    couldn't be triggered locally.
  - Check that the probe fails where the mount fails, for example in a job `container:`.
  - Watch for a Codex release that reports the fallback or lets a run refuse it.
- **What the runner user can read.** List it on a hosted runner, from a step with no key, with
  `ls -la` and `find -maxdepth 3`:
  - `/home/runner/runners` and `/home/runner/actions-runner`: which of them holds the runner's
    own files, credentials included, if any. Both are denied to Codex's commands now.
  - Whether `/home/runner/work` (and so `RUNNER_TEMP`) is a symlink. A deny names a path, and a
    command that reaches the folder through its real path may not meet it.
  - `/home/runner/work/_temp` (`RUNNER_TEMP`): the step scripts, `GITHUB_OUTPUT`'s files and
    the task. Denied now.
  - `$HOME`'s dot files and folders: `.gitconfig`, `.docker`, `.npm`, toolchains. They are
    readable now. Decide from the listing whether `$HOME/.*` can be denied without hiding a
    toolchain on `PATH`.
- **Anything readable can be published.** Codex's commands can still read the rest of the runner.
  - They have no network and no key, so what they read can leave only in the change.
  - The `publish` job pushes the branch and opens the draft pull request before anyone reviews
    it. In a public repository the change is public at once.
- **No caps.**
  - Codex has no turn or spend cap: the job's 45-minute timeout and the OpenAI project's budget
    are the limits.
  - An unreachable API makes Codex retry until that timeout.
- **The cost estimate.**
  - It uses the standard rate even for a request above 272K input tokens, which Sol's 500K window
    allows, so it can come out low.
  - Cache writes are priced at the 30-minute rate. A request that gets the 12-hour write costs
    more.
- **Whether `gpt-6.2-sol` is open to the user's API project.** The models page's table didn't
  render its API column.
