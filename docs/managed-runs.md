# Managed runs

How DevSync runs a coding agent on a task in the project's own GitHub Actions (story 4, R-8):
Claude Code, or Codex with an OpenAI key, paid with a key of the workspace's own or, without one,
with the workspace's AI credits. The research behind it is in
[research/managed-runs.md](research/managed-runs.md), [research/openrouter.md](research/openrouter.md)
and [research/openai.md](research/openai.md); the host's side is `ModuleHost.github` and
`ModuleHost.ai` (see [host.md](host.md), "Managed runs").

## The flow

1. A member asks for a run on a Ready task. DevSync records it, `REQUESTED`, at the task's current
   revision. A task has at most one run that hasn't ended.
2. An Owner, Admin or Approver approves or rejects it; the requester, or any of them, may cancel it
   while it is `REQUESTED`. Approving is refused when the task's requirements changed since the
   request, or the task is no longer Ready: "The task changed since this run was asked for. Cancel
   it and ask for a new run."
3. Approved, it is `QUEUED`, and the `devsync.runs` job asks the host for its reference for the run
   (`host.ai.allowRun`), then dispatches the project's `devsync.yml` through
   `host.github.dispatch` with `run_id` (the run's id), `task` (the requested revision's title,
   description and acceptance criteria as JSON) and, when the host gave a reference,
   `opscrew_origin` and `opscrew_request` ("The run's MCP and the AI credits"). The run is then
   `RUNNING`, with GitHub's run id. A refusal ends it `FAILED` with what to do.
4. The workflow (the file the user adds, `WORKFLOW_FILE` in `@devsync/schemas`) runs three jobs: an
   `agent` job with Contents read only, the only one given a key (`ANTHROPIC_API_KEY`,
   `OPENROUTER_API_KEY` or `OPENAI_API_KEY`) or an OIDC token, which runs Claude Code headless
   with file tools only (or Codex in its sandbox, with only the OpenAI key) and uploads the change
   as a patch; a `publish` job with
   Contents and Pull requests write and no key, which applies the patch (refusing one that touches
   `.github/`), pushes `devsync/<run id>` and opens a draft pull request; and a `report` job, always
   run, which uploads the `devsync-result` artifact.
5. When GitHub says the run completed (a `workflow_run` fact on `devsync.github`), DevSync reads
   `devsync-result` through `host.github.artifact`, checks it, stores it, deletes the run's
   artifacts and ends the run `SUCCEEDED` or `FAILED`. A succeeded run's draft pull request is
   linked to the task when the task has none. A run still `RUNNING` six hours after its dispatch is
   read once more and, without a result, ends `FAILED` (`no-result`).

## The workflow's contract

Inputs (all strings): `run_id`, a uuid; `task`, JSON `{ "title", "description",
"acceptanceCriteria" }` of the approved revision, at most 60,000 characters (GitHub takes 65,535 for
all inputs); a longer task is refused when the run is asked for. Optional, from the host's
`ai.allowRun`: `opscrew_origin`, the dashboard's https origin (at most 255 characters), and
`opscrew_request`, its signed reference for the run (at most 4,000), both empty without one. Anyone
who can see the repository's Actions runs can read the inputs: the reference is of no use without
the run's own OIDC token.

`devsync-result` holds `result.json`:

```json
{
  "schemaVersion": 1,
  "runId": "<the run_id input>",
  "status": "succeeded",
  "failure": null,
  "changedFiles": ["src/app.ts"],
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheCreationInputTokens": 0,
             "cacheReadInputTokens": 0, "costUsd": 0 },
  "models": ["claude-sonnet-5-5"],
  "provider": "anthropic",
  "turns": 12,
  "pullRequestUrl": "https://github.com/<owner>/<repo>/pull/<number>",
  "branch": "devsync/<run id>"
}
```

DevSync accepts it only when `runId` is the run's, `pullRequestUrl` is a pull request of the
project's own repository, `changedFiles` has at most 1,000 paths of at most 400 characters each,
every figure is a non-negative number, `provider` is `anthropic`, `openrouter`, `openai` or
`opscrew` (the AI credits; null only on a failed run), and `turns`, the agent's turn count, is a
non-negative whole number or null (Claude Code's `num_turns`; Codex reports none; a result without
the field counts as null); otherwise the run fails `bad-result`. `failure` is one of `no-key`,
`no-credits`, `agent-failed`, `budget`, `turns`, `no-changes`, `patch-did-not-apply`,
`patch-touches-workflows`, `push-failed`, `pull-request-not-allowed`, each shown with what to do
(`pull-request-not-allowed`: "Turn on Settings > Actions > General > Allow GitHub Actions to create
and approve pull requests, or open the pull request from the `devsync/<run id>` branch"). The run
shows its turns beside its tokens.

The models, turn cap and budget cap are in the workflow file, which the user may edit: Claude
Code's model, turn cap and budget cap, and Codex's model with its prices.

## Setup

The task panel's runs section asks the host's `github.setup` for `devsync.yml` and the secrets'
names, and shows what is missing: the workflow file (shown in full, to copy) and the pull-request
setting. A key (the `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` secret,
repository or organization) is no longer required: without one the section says runs pay with the
workspace's AI credits and links to where a key is added, and the approve dialog says so too.
Asking for a run while the file is missing answers 409 with the same words.

## Paying through OpenRouter

A run can use an OpenRouter API key instead of an Anthropic one (research:
[research/openrouter.md](research/openrouter.md)).

- The user adds `OPENROUTER_API_KEY` as an Actions secret, repository or organization, instead of
  `ANTHROPIC_API_KEY`. With both, the Anthropic key is used.
- The `agent` job gets the secrets. Without an Anthropic key, it runs Claude Code with
  `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` set to the OpenRouter
  key and `ANTHROPIC_API_KEY` empty; the models stay Claude's. Without either, it takes the OpenAI
  key ("Paying through OpenAI"). Without any key, it pays with the workspace's AI credits ("The
  run's MCP and the AI credits"); with no key and no reference from the host, the run fails
  `no-key`: "Add the ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY Actions secret to the
  repository or its organization."
- The backstop refuses a change that contains any key, and no other job gets one. It fails
  closed: a check that errors (a `grep` that answers neither "found" nor "nothing found", or a
  `find` that fails) fails the run `agent-failed` too, and the change isn't published. It never
  prints a file name.
- `result.json` says which provider the run used (`provider`: `anthropic` or `openrouter`). The
  run shows it, and its cost reads as Claude Code's estimate, from Anthropic's prices: through
  OpenRouter, OpenRouter's own usage page has what it bills.
- The setup counts any of the secrets. The README tells OpenRouter users to set a spending limit
  on the key and to put Anthropic first in the account's provider routing, as OpenRouter
  recommends.

## Paying through OpenAI

A run can use an OpenAI API key (research: [research/openai.md](research/openai.md)). An OpenAI
key can't run Claude's models, so with it the run uses OpenAI's own headless coding agent, the Codex
CLI.

- The user adds `OPENAI_API_KEY` as an Actions secret, repository or organization. It comes last:
  with an Anthropic or an OpenRouter key too, Claude Code runs on that one. The Claude keys run the
  same agent and models; an OpenAI key changes the agent, so a workspace that has one for other
  work keeps its Claude runs.
- Codex runs only on GitHub-hosted runners, as OpenAI's own action sets its sandbox up only
  there. A keyless step does the setup, on a hosted runner only; on another runner it does nothing.
  - It installs `@openai/codex` at a pinned version, and lets the runner create the unprivileged
    user namespaces Codex's sandbox needs.
  - It then checks, through `codex sandbox` with the run's own sandbox profile, that a sandboxed
    command gets a `/proc` of its own. Codex 0.171.0 silently keeps the runner's `/proc` when it
    can't mount one, and a command could then read the agent step's environment.
  - Only a passed check leaves the profile for the agent step, written whole or not at all. A
    failed install or a refused setting skips the check and leaves nothing, with a warning.
  - The step has `continue-on-error` and a 5-minute timeout, so nothing in it, a hang included,
    stops the job: Claude Code's runs go on, and Codex, without the profile, doesn't start.
  - Without a hosted runner or that profile, the agent step doesn't start Codex. The run fails
    `agent-failed`, and the step's log says why.
- With only the OpenAI key, the agent step runs `codex exec --json` with the same prompt and the
  task on stdin:
  - The model is the workflow's `DEVSYNC_OPENAI_MODEL` (`gpt-6.2-sol`).
  - It runs in its sandbox with a permission profile that extends `:workspace`. It writes only in
    the checkout and temporary folders, `.git` stays read-only, and it has no network, no
    approvals and no web search.
  - The profile denies reads of the job's temporary folder (`RUNNER_TEMP`) and of the runner's
    own folder, wherever GitHub's images keep it (`$HOME/runners` or `$HOME/actions-runner`; a
    missing one is skipped).
  - Its commands get only core variables, never the key.
  - It reads no `AGENTS.md`, no repository skills, no user config and no rules, and
    `--strict-config` refuses a misspelled setting.
  - The key reaches Codex as `CODEX_API_KEY` only; Claude Code never gets the OpenAI key's
    variable.
- A Codex run succeeds on exit 0 with a `turn.completed` event and no `turn.failed`; anything
  else is `agent-failed`, and its message names Codex. Codex has no turn or spend cap, so
  `budget` and `turns` never happen: the job's timeout and the OpenAI project's budget are the
  limits.
- `result.json` says `provider: openai`. `models` names the workflow's model, since Codex's
  events name none.
- The usage comes from the last `turn.completed` event:
  - `cacheReadInputTokens` are its cached tokens and `cacheCreationInputTokens` its cache-written
    ones.
  - `inputTokens` are its input tokens less both, and `outputTokens` include reasoning.
- Codex reports no cost, so the workflow works it out from those tokens at the prices next to the
  model:
  - The prices are `DEVSYNC_OPENAI_INPUT_USD`, `DEVSYNC_OPENAI_CACHED_INPUT_USD`,
    `DEVSYNC_OPENAI_CACHE_WRITE_USD` and `DEVSYNC_OPENAI_OUTPUT_USD`: OpenAI's standard prices on
    2026-11-21, $2.00, $0.10, $2.50 and $10.00 per million.
  - Cache writes are priced at the 30-minute rate; the 12-hour rate is $5.00.
  - The run shows the cost as estimated from OpenAI's prices. A user who changes the model changes
    the prices with it.
- Unlike Claude Code, Codex's commands can read the rest of the runner outside the checkout and
  the two denied folders. They have no network and no key, so what they read can leave only in the
  change.
  - But `publish` pushes the branch and opens the draft pull request before anyone reviews it.
  - In a public repository, anything a command copied into the change is public at once.

## The run's MCP and the AI credits

The dashboard gives every managed run its own token to OpsCrew's MCP (`/mcp`) and, when the
repository has no key of the workspace's own, pays for it with the workspace's AI credits. Research:
[research/managed-runs.md](research/managed-runs.md), "The run's MCP and the AI credits".

- **The reference.** Before the dispatch, outside any transaction and before the run is claimed,
  the `devsync.runs` job asks `host.ai.allowRun({ projectId, runRef: <run id>, workflow:
  "devsync.yml" })`. Its answer, an https origin and a signed request, parsed with zod, becomes the
  inputs `opscrew_origin` and `opscrew_request`. With null (a read-only project, or DevSync off)
  the run is dispatched with its two inputs only, and has neither `/mcp` nor the credits. An
  answer that doesn't parse is logged, without it, and treated as null. A host that fails leaves
  the run unclaimed, so the job's retry dispatches it.
- **The OIDC token.** The `agent` job alone has `id-token: write`. GitHub grants it per job, not
  per step, so the job's install steps (the pinned Claude Code and Codex packages from npm) could
  ask for OIDC tokens too. That adds little: those packages already run in the step that holds the
  keys. The step "Ask OpsCrew for the run's MCP token" runs only with a request, right before the
  agent step:
  - it asks GitHub for the job's OIDC token, with the origin as its audience; GitHub's request
    token reaches curl in a header file, never in its arguments;
  - it exchanges that token, through stdin, at `POST <origin>/mcp/credential { token, request }`
    for the run's MCP token, which works at `<origin>/mcp` until the run ends;
  - it masks both, and leaves them for the agent step in two files of `RUNNER_TEMP` only the
    runner's user can read;
  - a refusal (one plain 403), no OIDC token or a hang only means no `/mcp`: the step warns, and
    the run goes on (`continue-on-error`, a 2-minute limit).
- **The agent step never sees GitHub's means to ask for OIDC tokens.** The runner sets
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` in every step of a job that
  may ask for one, over the step's own `env`, so the step can't blank them there. Its shell unsets
  both first thing, so neither agent's process gets them. It reads the two files and removes them
  before anything else; the OIDC token stays a shell variable, never exported.
- **Paying with the AI credits.** The key order stays `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`. With none of them and a request, the agent step exchanges the same OIDC token,
  through stdin, at `POST <origin>/ai/credential { token, request }` for a gateway credential that
  lasts 30 minutes, and masks it.
  - Claude Code then runs with `ANTHROPIC_BASE_URL=<origin>/ai` and the credential as
    `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer`; `ANTHROPIC_API_KEY` is empty.
  - Its model is `claude-haiku-5-5`, which the gateway sets whatever is asked, and it runs under
    `timeout 30m`, the credential's life. A run stopped there fails `agent-failed`, its log saying
    why. The turn and budget caps are the workflow's, as with a key.
  - `provider` is `opscrew`, shown as "via AI credits". Its cost is Claude Code's estimate from
    Anthropic's prices, as with a key.
  - A refused exchange, or no OIDC token, ends the run `no-credits` before an agent starts. DevSync
    can't tell why (a network error, a request over 24 hours old, a dashboard without its own AI
    key, or credits switched off, used up or at their cap all look alike), so the message says what
    may be the cause: "OpsCrew didn't let this run use the workspace's AI credits (they may be
    switched off, used up or at their cap). Buy AI credits on the dashboard's Billing page, or add a key of your own as the … Actions secret of the repository
    or its organization, then ask for a new run."
  - The credits never run Codex: the gateway speaks Anthropic's API only. With only an OpenAI key,
    Codex runs on it.
- **The run's `/mcp`.** With the MCP token, each agent gets `<origin>/mcp` as its one MCP server,
  named `opscrew`:
  - Claude Code reads it from a configuration file in `RUNNER_TEMP` (readable by the runner's user
    only, removed when the step ends), with the token as a bearer header. It keeps
    `--strict-mcp-config`, gets `--allowedTools "mcp__opscrew__*"` besides the file tools, and
    still has Bash, WebFetch and WebSearch refused. Without the token, its MCP configuration is
    empty and `mcp__*` is refused too.
  - Codex gets it through `-c mcp_servers.opscrew.*`: the URL, `bearer_token_env_var =
    "OPSCREW_MCP_TOKEN"` and `default_tools_approval_mode = "approve"`. With `approval_policy =
    never`, Codex refuses an MCP call that needs an approval, so OpsCrew's calls are approved here:
    OpsCrew decides what the run's token may do. Its sandboxed commands never get the token.
  - Neither agent gets the AI credential's or the MCP token's own variable: Claude Code has the
    credential as its auth token and the MCP token in its configuration only; Codex has the MCP
    token in its environment.
- **The backstop** checks the change for the MCP token and the gateway credential as it does for
  the keys, every one that is set, failing closed.

What remains: through `/mcp`, a run's agent can read the project's data on the dashboard, whatever
the run's token lets it read. A prompt injection in the default branch's code, which the agent
reads as it works, could make it copy that data into the change. The backstop looks for the keys
and tokens only, not for that data, and `publish` pushes the branch and opens the draft pull request
before anyone reviews it, so in a public repository what was copied is public at once.

## Not in the first version

A model chosen per run, cancelling a run already in GitHub (the user cancels
it there; DevSync then records it `FAILED`, `cancelled`), and CI on the draft pull request (GitHub
starts no workflow for a pull request opened with the workflow's own token; the user pushes a
commit or reopens it).

## Tasks

Each runs in its own worktree, test-first, with a fresh reviewer; the lead merges them one at a
time.

- [x] **D1, the server** (`packages/server/**`, `packages/schemas/src/runs.ts`,
  `packages/schemas/src/index.ts`, `docs/host.md`). The host interface's copy: `github`
  (`ModuleHost.github` as the dashboard's contract has it), `workflows: ["devsync.yml"]` on
  `serverModule`, the `workflow_run` fact; `fakeHost().github`. The `run` table (requirements.md's
  Data, its migration), the API's shapes (`packages/schemas/src/runs.ts`), the domain (request,
  approve, reject, cancel, as above, with `can()`'s `run.request` and `run.decide`, audit entries
  `devsync.run.requested|approved|rejected|cancelled|finished`, the task's timeline events), the
  `devsync.runs` queue (dispatch, and the six-hour sweep on a schedule), the `workflow_run`
  handling in `devsync.github`, the result's checks, the routes
  (`GET|POST /tasks/:taskId/runs`, `POST /runs/:runId/approve|reject|cancel`, `GET /runs/setup`),
  the removal hooks.
- [x] **D2, the workflow file** (`packages/schemas/src/workflow.ts` and its test). `WORKFLOW_FILE`
  (`devsync.yml`) and `WORKFLOW` (the file's text) from the research's skeleton, adapted to the
  contract above: the two inputs, `permissions: {}` at the top, the three jobs, inputs only through
  `env`, the patch with its changed files as one artifact, the result as `devsync-result`, the
  failures' names; tested for the inputs, the jobs' permissions, the key only in `agent`, and the
  artifact names.
- [x] **D3, the dashboard** (`packages/web/**`), after D1 and D2. The task panel's runs section: the
  setup's missing pieces (the workflow to copy), asking for a run on a Ready task, the runs with
  their state, approve and reject for the roles that may, cancel, and a run's result (changed files,
  tokens and cost, the models, the draft pull request, the GitHub run).
- [x] **D4, the standalone version removed** (lead): its folder deleted once D1 and D2 had ported
  its runs, with every mention in the README, the agents' guides, the docs and the code's comments.
- [x] **D5, paying through OpenRouter** (`packages/**`, `docs/host.md` if it names the secret,
  `docs/requirements.md`'s story 4 and R-8, `README.md`). As "Paying through OpenRouter" above: the
  workflow's `agent` job choosing the key, the `no-key` failure, the backstop for both keys,
  `provider` in `result.json` (its schema and checks) and on the run, the cost labelled an estimate,
  the setup counting either secret (its step and the dashboard's link wording), the README; tests
  for each, including the workflow text's env lines and that no other job gets either key.
- [x] **D6, paying through OpenAI** (`packages/**`, `docs/host.md`, `docs/requirements.md`'s story
  4 and R-8, `README.md`). As "Paying through OpenAI" above: the third key, last in the order;
  the Codex install, on hosted runners only, with its `/proc` check; its step (hosted runners
  only and after that check, its flags and deny-read profile, the key as `CODEX_API_KEY` only,
  success and `agent-failed`, the usage with cache writes and the cost at the workflow's prices);
  `provider` `openai` (its schema and checks); the failure messages naming Codex; the dashboard's
  provider, cost label, approve dialog and setup wording; tests for each, including the workflow
  text's Codex lines and the agent step run with a fake Codex. Left to the live test: a Codex run
  on a hosted runner, its draft pull request and its tokens, and what its commands can read
  (research/openai.md, "To check live").
