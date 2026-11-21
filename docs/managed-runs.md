# Managed runs

How DevSync runs a coding agent on a task in the project's own GitHub Actions (story 4, R-8):
Claude Code, or Codex with an OpenAI key. The research behind it is in
[research/managed-runs.md](research/managed-runs.md), [research/openrouter.md](research/openrouter.md)
and [research/openai.md](research/openai.md); the host's side is `ModuleHost.github` (see
[host.md](host.md), "Managed runs").

## The flow

1. A member asks for a run on a Ready task. DevSync records it, `REQUESTED`, at the task's current
   revision. A task has at most one run that hasn't ended.
2. An Owner, Admin or Approver approves or rejects it; the requester, or any of them, may cancel it
   while it is `REQUESTED`. Approving is refused when the task's requirements changed since the
   request, or the task is no longer Ready: "The task changed since this run was asked for. Cancel
   it and ask for a new run."
3. Approved, it is `QUEUED`, and the `devsync.runs` job dispatches the project's `devsync.yml`
   through `host.github.dispatch` with two inputs: `run_id` (the run's id) and `task` (the
   requested revision's title, description and acceptance criteria as JSON). The run is then
   `RUNNING`, with GitHub's run id. A refusal ends it `FAILED` with what to do.
4. The workflow (the file the user adds, `WORKFLOW_FILE` in `@devsync/schemas`) runs three jobs: an
   `agent` job with Contents read only, the only one given a key (`ANTHROPIC_API_KEY`,
   `OPENROUTER_API_KEY` or `OPENAI_API_KEY`), which runs Claude Code headless with file tools
   only (or Codex in its sandbox, with only the OpenAI key) and uploads the change as a patch; a
   `publish` job with
   Contents and Pull requests write and no key, which applies the patch (refusing one that touches
   `.github/`), pushes `devsync/<run id>` and opens a draft pull request; and a `report` job, always
   run, which uploads the `devsync-result` artifact.
5. When GitHub says the run completed (a `workflow_run` fact on `devsync.github`), DevSync reads
   `devsync-result` through `host.github.artifact`, checks it, stores it, deletes the run's
   artifacts and ends the run `SUCCEEDED` or `FAILED`. A succeeded run's draft pull request is
   linked to the task when the task has none. A run still `RUNNING` six hours after its dispatch is
   read once more and, without a result, ends `FAILED` (`no-result`).

## The workflow's contract

Inputs (both strings): `run_id`, a uuid; `task`, JSON `{ "title", "description",
"acceptanceCriteria" }` of the approved revision, at most 60,000 characters (GitHub takes 65,535 for
all inputs); a longer task is refused when the run is asked for. Anyone who can see the
repository's Actions runs can read the inputs.

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
  "pullRequestUrl": "https://github.com/<owner>/<repo>/pull/<number>",
  "branch": "devsync/<run id>"
}
```

DevSync accepts it only when `runId` is the run's, `pullRequestUrl` is a pull request of the
project's own repository, `changedFiles` has at most 1,000 paths of at most 400 characters each,
every figure is a non-negative number, and `provider` is `anthropic`, `openrouter` or `openai`
(null only on a failed run); otherwise the run fails `bad-result`. `failure` is one of `no-key`,
`agent-failed`, `budget`, `turns`, `no-changes`, `patch-did-not-apply`,
`patch-touches-workflows`, `push-failed`, `pull-request-not-allowed`, each shown with what to do
(`pull-request-not-allowed`: "Turn on Settings > Actions > General > Allow GitHub Actions to create
and approve pull requests, or open the pull request from the `devsync/<run id>` branch").

The models, turn cap and budget cap are in the workflow file, which the user may edit: Claude
Code's model, turn cap and budget cap, and Codex's model with its prices.

## Setup

The task panel's runs section asks the host's `github.setup` for `devsync.yml` and the secrets'
names, and shows what is missing: the workflow file (shown in full, to copy), a key (the
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` secret, repository or
organization), and the pull-request setting. Asking for a
run while the file or the secret is missing answers 409 with the same words.

## Paying through OpenRouter

A run can use an OpenRouter API key instead of an Anthropic one (research:
[research/openrouter.md](research/openrouter.md)).

- The user adds `OPENROUTER_API_KEY` as an Actions secret, repository or organization, instead of
  `ANTHROPIC_API_KEY`. With both, the Anthropic key is used.
- The `agent` job gets the secrets. Without an Anthropic key, it runs Claude Code with
  `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` set to the OpenRouter
  key and `ANTHROPIC_API_KEY` empty; the models stay Claude's. Without either, it takes the OpenAI
  key ("Paying through OpenAI"). With no key at all, the run fails `no-key`: "Add the
  ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY Actions secret to the repository or its
  organization."
- The backstop refuses a change that contains any key, and no other job gets one.
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
- A keyless step installs `@openai/codex` at a pinned version and lets the runner create the
  unprivileged user namespaces Codex's sandbox needs, as OpenAI's own action does.
- With only the OpenAI key, the agent step runs `codex exec --json` with the same prompt and the
  task on stdin:
  - The model is the workflow's `DEVSYNC_OPENAI_MODEL` (`gpt-6.2-sol`).
  - It runs in the `workspace-write` sandbox: writes only in the checkout and temporary folders,
    `.git` read-only, no network, no approvals and no web search.
  - Its commands get only core variables, never the key.
  - It reads no `AGENTS.md`, no user config and no rules, and `--strict-config` refuses a
    misspelled setting.
  - The key reaches Codex as `CODEX_API_KEY` only; Claude Code never gets the OpenAI key's
    variable.
- A Codex run succeeds on exit 0 with a `turn.completed` event and no `turn.failed`; anything
  else is `agent-failed`, and its message names Codex. Codex has no turn or spend cap, so
  `budget` and `turns` never happen: the job's timeout and the OpenAI project's budget are the
  limits.
- `result.json` says `provider: openai`. `models` names the workflow's model, since Codex's
  events name none.
- The usage comes from the last `turn.completed` event: `inputTokens` are its input tokens less
  the cached ones, which are `cacheReadInputTokens`; `outputTokens` include reasoning; nothing is
  cache-written.
- Codex reports no cost, so the workflow works it out from those tokens at the prices next to the
  model (`DEVSYNC_OPENAI_INPUT_USD`, `DEVSYNC_OPENAI_CACHED_INPUT_USD`,
  `DEVSYNC_OPENAI_OUTPUT_USD`: OpenAI's standard prices on 2026-11-21, $2.00, $0.10 and $10.00 per
  million). The run shows it as estimated from OpenAI's prices. A user who changes the model
  changes the prices with it.
- Unlike Claude Code, Codex's commands can read files outside the checkout. They have no network
  and no key, so what they read can only reach the patch, which people review as a draft.

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
  the Codex install and its step (its flags, the key as `CODEX_API_KEY` only, success and
  `agent-failed`, the usage and the cost at the workflow's prices); `provider` `openai` (its
  schema and checks); the failure messages naming Codex; the dashboard's provider, cost label,
  approve dialog and setup wording; tests for each, including the workflow text's Codex lines.
  Left to the live test: a Codex run on a hosted runner, its draft pull request and its tokens.
