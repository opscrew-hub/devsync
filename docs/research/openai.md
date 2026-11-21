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
    environment through `/proc`.
  - `workspace-write` mounts `/` read-only: **commands can read the whole runner**, not only the
    checkout.
  - Permission profiles (`default_permissions`, `[permissions.<name>]`, beta per the
    [permissions page](https://learn.chatgpt.com/docs/permissions)) can deny reads outside the
    workspace.
- **AGENTS.md** ([`core/src/agents_md.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/agents_md.rs)):
  - It isn't read for an untrusted project, nor with `project_doc_max_bytes = 0`.
- **Models** ([models](https://learn.chatgpt.com/docs/models)):
  - GPT-6.2 Sol (`gpt-6.2-sol`) is for everyday tasks such as editing code, and is the page's
    sample `model`.
  - GPT-6.2 Astra (`gpt-6.2-astra`) is for demanding work.
  - The page names no CLI default. With an API key, availability follows the API organization and
    project.
- **Prices** ([API pricing](https://developers.openai.com/api/docs/pricing), read 2026-11-21; the
  page shows no date of its own):
  - Standard tier, per million tokens, for at most 272K input tokens:

    | Model | Input | Cached input | Output |
    | - | - | - | - |
    | `gpt-6.2-sol` | $2.00 | $0.10 | $10.00 |
    | `gpt-6.2-astra` | $8.00 | $0.40 | $40.00 |

  - Above 272K input tokens, Sol costs $4.00, $0.20 and $15.00.
  - The page doesn't say how reasoning tokens are billed.
- **Token counts** ([`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/protocol/src/protocol.rs),
  [`exec/src/event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs)):
  - `input_tokens` includes the cached ones (`non_cached_input = input - cached`).
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
    DevSync's settings.
  - With the API unreachable, Codex waited and kept retrying.
- **A permission profile** that denies reads outside the workspace (`":root" = "deny"`,
  `":minimal" = "read"`, the workspace writable) made every command fail with exit code 2 on that
  image.
- **The workflow's own step script** ran with a fake Codex address, a real `jq` and only
  `OPENAI_API_KEY` set:
  - It wrote `provider=openai` and an empty `failure`.
  - It wrote
    `usage={"inputTokens":1800,"outputTokens":600,"cacheCreationInputTokens":0,"cacheReadInputTokens":1200,"costUsd":0.00972}`
    and `models=["gpt-6.2-sol"]`, and the patch step found the change.
  - With no key it failed `no-key`. With a Codex that exits non-zero it failed `agent-failed`,
    with zero usage.

## Decision

- **The order.** A run takes `OPENAI_API_KEY` as a third key, after `ANTHROPIC_API_KEY` and
  `OPENROUTER_API_KEY` (D5's rule extended: the first key that is set is used).
  - The two Claude keys run the same agent and models, and stay ahead.
  - An OpenAI key changes the agent, so it is used only when neither of the others is set. A
    workspace that adds an OpenAI key for other work keeps its Claude runs.
- **How Codex runs.** With only the OpenAI key, the agent step runs Codex instead of Claude Code,
  with the same prompt and task on stdin:

  ```
  codex exec --json --ephemeral --strict-config --model "$DEVSYNC_OPENAI_MODEL" --sandbox workspace-write
    -c sandbox_workspace_write.network_access=false -c approval_policy=never -c web_search=disabled
    -c shell_environment_policy.inherit=core -c shell_environment_policy.ignore_default_excludes=false
    -c project_doc_max_bytes=0 -c history.persistence=none --ignore-user-config --ignore-rules
  ```

  - The key reaches Codex as `CODEX_API_KEY` only, and `OPENAI_API_KEY` is unset for it.
  - A run succeeds on exit 0 with a `turn.completed` event and no `turn.failed`. Anything else is
    `agent-failed`.
- **Installing.** A keyless "Install Codex" step installs `@openai/codex@0.171.0` and sets the two
  user-namespace settings, as OpenAI's action does. It runs for every run, since only the agent
  step knows which key is set.
- **The model.** `gpt-6.2-sol`, set as `DEVSYNC_OPENAI_MODEL` in the workflow. `models` names it,
  since Codex's events don't name the model.
- **Usage.**
  - `inputTokens = input_tokens − cached_input_tokens`, `cacheReadInputTokens = cached_input_tokens`,
    `outputTokens = output_tokens` (reasoning included) and `cacheCreationInputTokens = 0`.
  - The cost is worked out in the workflow from those tokens at the prices noted next to the model
    (`DEVSYNC_OPENAI_INPUT_USD` and the rest, from the pricing page on 2026-11-21, standard tier).
  - The dashboard labels it "estimated from OpenAI's prices".
- **Not used.**
  - `openai/codex-action`, since it reports no tokens and adds a third-party action to the
    workflow.
  - A workspace-only read profile, which broke every command in the local check.

## To check live

- **A real run on a GitHub-hosted `ubuntu-latest` runner:**
  - the sandbox after the two settings;
  - the draft pull request;
  - the reported tokens against the OpenAI project's usage page.
- **Reads outside the checkout.** Codex's commands can read the runner's files, where Claude Code
  is held to the checkout. They have no network and no key, so what they read can only reach the
  patch, which people review as a draft. A read profile that works on Ubuntu would close this; try
  it on a real runner.
- **No caps.**
  - Codex has no turn or spend cap: the job's 45-minute timeout and the OpenAI project's budget
    are the limits.
  - An unreachable API makes Codex retry until that timeout.
- **The cost estimate.**
  - It uses the standard rate even for a request above 272K input tokens, which Sol's 500K window
    allows, so it can come out low.
  - Whether `cache_write_input_tokens` is ever non-zero with OpenAI is to check. It is counted
    inside `input_tokens` here.
- **Whether `gpt-6.2-sol` is open to the user's API project.** The models page's table didn't
  render its API column.
