# DevSync on the host's module platform

The dashboard's module platform gives every module the same pieces: events between modules,
actions declared once, the project's agents registered once, one MCP address (`/mcp`) for every
module's tools, a run's own token for it, the server's redactor, and AI on the workspace's
credits. This is DevSync's move onto them, with the task-side ideas once proposed for coordinating
people and agents across tools. The host's side is the
dashboard's module contract; DevSync's copy of it is `host.ts` and `module.ts`, as for the rest.

DevSync names no other module. It emits its events for whoever consumes them, and its actions and
the context it reads come through the host without naming who gives them.

## What changes

### Events (P1)

DevSync emits each event with `host.emit` in the transaction that makes the change, so a rolled
back change sends nothing. The data is names and ids only: never a title, a description, a message
or a question's text. A consumer that wants the text reads it through DevSync's actions.

| Event | When | Data |
|---|---|---|
| `devsync.task.created` | a task is created | `taskId`, `status` |
| `devsync.task.updated` | its requirements change (a new revision) | `taskId`, `revision` |
| `devsync.task.moved` | its status changes | `taskId`, `from`, `to` |
| `devsync.task.done` | it reaches Done | `taskId` |
| `devsync.task.claimed` / `devsync.task.released` | an agent claims it, or the claim ends without a review | `taskId`, `agentId` |
| `devsync.review.requested` | an agent asks for a review | `taskId`, `agentId` |
| `devsync.review.approved` / `devsync.review.changes_requested` | a review's decision | `taskId`, `reviewRequestId` |
| `devsync.question.asked` / `devsync.question.answered` | a question on a task (P6) | `taskId`, `questionId` |
| `devsync.pr.linked` / `devsync.pr.merged` | a pull request is linked to a task, or merged | `taskId`, `number` |
| `devsync.run.finished` | a managed run ends | `taskId`, `runId`, `status`, `failure` |

Every task event already passes through `outbox.record`, so the mapping lives there once.

Text DevSync stores from an agent or a run passes `host.redact` first: reports, signals, a task's
fields and a question's text and answer.

A project's export (`exportProject`) holds DevSync's rows of the project: its tasks with their
revisions and comments, runs, pull requests, questions and timeline. It never holds a token hash.

### The host's agents (P2)

The host registers a project's agents once for every module. DevSync's own agents move there with
their tokens still working:
- the hourly job `devsync.agents-move` adopts every agent row that still has a token hash, with
  `host.agents.adopt`, project by project (one with DevSync off is skipped and tried again next
  hour), then nulls that row's token columns in the same transaction. The ids stay, so claims,
  signals and the timeline still point at the same agents;
- DevSync's MCP authentication asks `host.agents.verify(token)` first, then its own rows not yet
  moved. A host agent seen for the first time gets a DevSync row (no token), so the foreign keys
  hold;
- registering, rotating and revoking move to the host. DevSync's Agents section lists the agents
  that may reach DevSync (`host.agents.list`) and says they are registered from the project's
  Agents button. Its own register, rotate and revoke routes go.

A later release drops the fallback and the token columns, once every moved token is past its 24
hours.

A follow-up (from P2): DevSync never hears of a revoke on the dashboard. The agent is refused at
once everywhere, but its DevSync row keeps receiving its inbox and peers' signals, and its claim
lasts until it expires, 15 minutes at most. Reading the host's list when delivering would close
that.

### Actions, served through `/mcp` (P3)

Each MCP tool is declared once as an action (`serverModule.actions`), and DevSync's own endpoint
serves the same list until it goes, so the two never differ. The host serves them at `/mcp` as
`devsync_<name>`, adding the project. Kinds: `read` for what only reads, `write` for what changes
DevSync's records, `start` for asking for a managed run.

| Action | Kind | Who |
|---|---|---|
| `get_project_state`, `list_tasks`, `get_task` (a task, its run and its pull request) | read | everyone |
| `get_pending_signals` | read | agents |
| `acknowledge_signal`, `publish_signal`, `claim_task`, `renew_task_claim`, `release_task`, `report_progress`, `report_blocker`, `request_review`, `submit_review` | write | agents |
| `create_task`, `update_task` | write | agents, and members whose role may |
| `request_run` | start | members whose role may (`run.request`); the run still waits for an approval |

- **Callers.** A member acts with their role through `can()`; an agent is an `AgentActor`, as
  today; a run reads only its own task (P7), and its writes are refused.
- **Refusals.** An action answers DevSync's refusals as its result, `{ refused: { code, message } }`,
  with the same plain-English message as today. It throws only for a fault, which the host reports
  as "failed".
- **Guidance.** The rules an agent needs are in the descriptions of the actions they concern, since
  `/mcp` lists only actions: claim before working, renew within 15 minutes, report a blocker
  instead of waiting, request a review when done, and, when memory tools are listed, recall before
  working and remember what was learned before requesting a review. DevSync's own endpoint gives
  the same as its MCP `instructions`.
- **Size.** A test fails when the actions' list (names, descriptions and input schemas, as JSON)
  grows past its budget, set at the size P3 reaches.

### The task-side ideas (P4 and P6)

- **Task fields.** `owns`: the paths a task may change (at most 50, each at most 400 characters);
  two open tasks whose paths overlap are flagged on both. `dependsOn`: the project's tasks it waits
  for; it can't be claimed while one isn't Done, and a cycle is refused. `labels` (at most 10, each
  at most 40 characters) and `branch` (a branch name, at most 200).
- **Questions.** A question is a record on a task: who asked, the text, open or answered, the
  answer and who gave it. An agent asks with `ask_question`; it still sends today's
  `clarification.requested` signal to the task's creator when that is an agent. With `wait`, the
  claim ends and the task moves to Blocked, as with a blocker. A member answers on the task's
  panel, an agent with `answer_question`; the answer sends `clarification.answered` to the asker,
  and a Blocked task whose open questions are all answered returns to Ready.
- **Usage.** `report_progress` and `request_review` take an optional `usage` (tokens and cost), so
  a task's cost counts every agent's work, not only managed runs; the task shows the sum.
- **A limit per agent.** An agent holds at most 3 claimed tasks at once.
- **A briefing.** `get_briefing` answers the task, its acceptance criteria, its open questions, its
  paths, and the context the host gives for its title (`host.context`), within 8,000 characters.

### Managed runs on credits, with the run's own `/mcp` token (P5)

- **Its token.** Every managed run gets `host.ai.allowRun({ projectId, runRef: <run id>,
  workflow: "devsync.yml" })`, passed to the workflow as the inputs `opscrew_origin` and
  `opscrew_request`. The `agent` job (`id-token: write` added) asks GitHub for an OIDC token with
  the origin as its audience and exchanges it at `<origin>/mcp/credential` for the run's `/mcp`
  token. Claude Code gets `<origin>/mcp` as an MCP server with that token, and only its tools
  (`mcp__opscrew__*`); Codex gets the same through its `config.toml`. The step that runs the agent
  never sees the OIDC request variables.
- **On credits.** With no key of the workspace's own in the repository's secrets, the run pays with
  the workspace's AI credits: the same OIDC token is exchanged at `<origin>/ai/credential` for a
  30-minute gateway credential, and Claude Code reaches the model through `<origin>/ai`. Its
  `provider` is `opscrew`. The agent step's limit is then 30 minutes, the credential's life. A
  refusal (credits off, empty or at their cap) ends the run `no-credits`, with what to do. Codex
  needs an OpenAI key; credits run Claude Code.
- **Setup.** A key is no longer required: the setup says the run uses credits when no key is set,
  and the approve dialog says so too.
- **Turns.** `result.json` gains `turns`, the agent's turn count, shown on the run.

## Tasks

Each runs in its own worktree, test-first, with a fresh reviewer; the lead merges them one at a
time. Then `app.opscrew.dev` pins the reviewed commit.

- [x] **P1, the host interface, events and export** (`packages/server/src/host.ts`, `module.ts`,
  `testing.ts`, `packages/server/src/domain/**`, `packages/server/src/removal.ts` if needed,
  `docs/host.md`, `docs/platform.md` for its tick). The copy of `ModuleHost` gains `emit`,
  `agents`, `context`, `redact` and `ai.allowRun`, typed as the contract has them, and
  `fakeHost()` implements each (recording emits, an agents table in memory, a fixed context, a
  redactor that replaces a marker, an `allowRun` that answers a fixed request). The events above,
  through `outbox.record`; `host.redact` on stored agent text; `exportProject`. Type-level tests
  against the contract, as `module.test.ts` does.
- [x] **P2, the host's agents** (after P1; `packages/server/src/domain/agents.ts`,
  `packages/server/src/http/**`, `packages/server/src/jobs.ts`, `packages/server/src/db/**`,
  `packages/server/migrations/**`, `packages/schemas/src/agents.ts`, `packages/web/src/Agents*`,
  `docs/host.md`). As above: the move job, `verify` first, the row for a new host agent, the
  Agents section, the routes removed; a migration making the token columns nullable.
- [x] **P3, the actions** (after P2; `packages/server/src/actions.ts` (new),
  `packages/server/src/http/mcp.ts`, `module.ts`, `packages/schemas/src/mcp.ts`, `docs/host.md`).
  As above, with a test per caller kind and the size budget.
- [x] **P4, the task fields, the claim rules and usage** (after P3; `packages/schemas/src/**`,
  `packages/server/src/domain/**`, `packages/server/src/db/**`, `packages/server/migrations/**`,
  `packages/server/src/actions.ts`, `packages/web/src/TaskPanel*`, `docs/host.md`,
  `docs/requirements.md`). The Task fields, the limit per agent and Usage of "The task-side
  ideas", above.
- [x] **P6, questions and the briefing** (after P4; the same files). Questions and the briefing of
  "The task-side ideas", above, with the two question events of the Events table.
- [x] **P5, managed runs on credits and the run's token** (after P1, beside P2 to P4;
  `packages/schemas/src/workflow.ts`, `packages/schemas/src/runs.ts` and their tests,
  `packages/server/src/domain/runs.ts`, `packages/web/src/Runs*`, `docs/managed-runs.md`,
  `docs/host.md`'s Managed runs).
- [x] **P7, the whole change's review** (after P6; the files below). The review of everything since the
  last pinned commit: the briefing measured once per item and a cap on a task's open questions; a
  run's token reads only its own task; a run asked for only once its task's dependencies are done;
  a run's changed paths and models redacted; the OIDC request token in the key backstop.
