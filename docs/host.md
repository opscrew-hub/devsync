# DevSync and its host

DevSync is a module of OpsCrew's dashboard (`app.opscrew.dev`): the dashboard is its **host**. The
host signs people in, holds the workspaces, projects, members and roles, the audit log, the GitHub
App and the job queue; DevSync adds a project's planned work and the coding agents that do it.

The dashboard names no module: it has a module system, and DevSync is plugged into it by the
deployment's configuration. DevSync never imports the dashboard's code either. It follows the
dashboard's module contract with its own copy of the types (`DevSyncHost` in
`packages/server/src/host.ts`, `ServerModule` in `module.ts`, the page props in
`packages/web/src/module.tsx`), and type-level tests check them against the contract. In this
repository, tests use a fake host (`fakeHost()` from `@devsync/server/testing`), so DevSync builds
and tests on its own; it runs only inside the dashboard.

This file is DevSync's side of that contract. A change to it is a change to both.

## Plugging DevSync in

The dashboard's deployment lists its modules in `OPSCREW_MODULES`, as GitHub repositories pinned to
a full commit:

```bash
OPSCREW_MODULES="https://github.com/opscrew-hub/devsync#<40-character commit>"
```

Its build downloads that commit into its `modules/` folder, adds DevSync's `packages/*` to its pnpm
workspace, and reads the manifest in DevSync's root `package.json`:

```json
"opscrewModule": {
  "id": "devsync",
  "name": "DevSync",
  "summary": "…",
  "icon": "kanban",
  "workspacePage": true,
  "findingAction": { "label": "Fix with DevSync" },
  "server": "packages/server/src/module.ts",
  "web": "packages/web/src/module.tsx"
}
```

The server imports `serverModule` from the `server` file, the dashboard `webModule` from the `web`
file (as its own chunk). The `id` is DevSync's schema name, the prefix of its queues and audit
actions, and the `devsync` in every address below. `findingAction` is the button on a security
finding (see Security findings).

## Switching DevSync on

In the dashboard, an Owner or Admin switches DevSync on for the workspace (Modules in the sidebar),
then for each project (the project's Modules button). DevSync's routes for a project answer only
while it is on for both; switching it off hides it and keeps its data, which is deleted with the
project or the workspace.

## The host interface

The dashboard gives every module the same `ModuleHost`; DevSync's `DevSyncHost` is the part of it
DevSync uses (`host.ts` has the exact types). In short:

| Member | What the host gives |
|---|---|
| `db` | its PostgreSQL database (or the current transaction). DevSync's tables are in the `devsync` schema of the same database, so DevSync's transactions are the host's, and the host's audit entry commits with the change. They run at the database's default isolation, READ COMMITTED, which the dependency check relies on: after waiting for the project's dependency lock, it reads the dependencies committed meanwhile. DevSync uses Drizzle's query builder only (never `db.query`), and `execute` for one transaction-level advisory lock (the dependency check, see `TaskFields`). |
| `clock` | `now()`: every timestamp DevSync writes comes from it. |
| `log` | `error(message)`: never given a token. |
| `audit(tx, actor, entry)` | appends to the host's audit log in `tx`. Actions start with `devsync.`; details hold names, ids and figures only. |
| `members(workspaceId)` | the workspace's members with their names and roles. |
| `project(projectId)` | the connected project with DevSync on for it and its workspace, or null: checked on every MCP request. |
| `enqueue(queue, payload, options?)` | sends a job to a DevSync queue after the current transaction commits. |
| `github` | DevSync's workflow in the project's repository, through the host's GitHub App: `setup`, `dispatch`, `artifact`, `deleteArtifact` (see Managed runs). |
| `finding(projectId, fingerprint)` | one of the project's open security findings, redacted, or null (see Security findings). |
| `emit(tx, event)` | records one of DevSync's events in `tx`, sent to the modules that consume it once `tx` commits, never if it rolls back (see Events). |
| `agents` | the project's agents, registered once for every module: `verify(token)`, `list(projectId)`, `adopt(tx, agents)`. |
| `context(caller, { subject })` | the other modules' context for a subject, as the caller may see it, with trust set by the host: `get_briefing` asks it for a task's title (see MCP for coding agents). |
| `redact(text)` | the text through the server's redactor; every text DevSync stores from an agent passes it first (see Events). |
| `ai.allowRun({ projectId, runRef, workflow })` | a signed reference for one managed run on the workspace's AI credits, or null for a read-only project or one with DevSync off. |

### Request contexts

The host's guard runs before DevSync's routes and sets `c.var.module`, from its session, never from
the request:

- on project routes, a `ProjectContext`: the project (`workspaceId`, `projectId`, `fullName`,
  `readOnly`) and the member (`userId`, `name`, `role`);
- on workspace routes, a `WorkspaceContext`: the workspace, the member, and its projects with
  DevSync on (disconnected projects left out).

The host has already checked that the member belongs to the workspace (and isn't suspended), that
the project is the workspace's and that DevSync is on for both. It also refuses members' changes
(any method but GET) to a read-only project, one past the workspace's plan, or a disconnected one.
DevSync checks the role.

## Roles and permissions

The host's roles are OpsCrew's: Owner, Admin, Approver, Developer. `can(role, action)` in
`@devsync/schemas` decides, on the server and to lock buttons in the browser:

| Action | Owner | Admin | Approver | Developer |
|---|---|---|---|---|
| read anything (every GET) | yes | yes | yes | yes |
| `task.write`: create, edit, move, assign, comment, link a pull request, message an agent | yes | yes | yes | yes |
| `run.request`: ask for a managed run | yes | yes | yes | yes |
| `run.decide`: approve or reject a managed run | yes | yes | yes | no |

A member who asked for a run may cancel it while it waits for approval, whatever their role; so may
anyone with `run.decide`. Registering, rotating and revoking agents is the host's, with its own
permission (see MCP for coding agents).

## Mount points

| DevSync gives | The host mounts it at | Behind |
|---|---|---|
| `projectRoutes(host)` | `/api/w/<workspace>/projects/<project>/m/devsync` | the session, the workspace, the guard |
| `workspaceRoutes(host)` | `/api/w/<workspace>/m/devsync` | the session, the workspace, DevSync on for it |
| `publicRoutes(host)` | `/m/devsync` | the body limit and `Cache-Control: no-store`; DevSync authenticates agents itself |

Each is a Hono app with its own `onError`, answering refusals as
`{ "error": { "code", "message", "fields"? } }` with the dashboard's codes and statuses:
`invalid` 422, `unauthenticated` 401, `forbidden` 403, `not-found` 404, `conflict` 409,
`rate-limited` 429 (`ERROR_STATUS` in `host.ts`), and `internal` 500 for anything unexpected, logged
without the request's body or any token. Messages are plain English and say what to do next.

## HTTP API

Ids are UUIDs, times ISO 8601. Bodies and answers are the zod schemas of `@devsync/schemas`.

### Project routes

| Method and path | Permission | Body | Answer |
|---|---|---|---|
| `GET /tasks?status=&assignee=` | read | | `{ tasks: Task[] }`; `assignee` is `me`, `none` or a user id |
| `POST /tasks` | `task.write` | `TaskInput` | 201 `Task` |
| `GET /tasks/:taskId` | read | | `TaskDetail` |
| `PATCH /tasks/:taskId` | `task.write` | `TaskUpdate` | `Task` |
| `POST /tasks/:taskId/comments` | `task.write` | `CommentInput` | 201 `Comment` |
| `PUT /tasks/:taskId/pull-request` | `task.write` | `PullRequestLink` | `Task` |
| `POST /tasks/:taskId/questions` | `task.write` | `QuestionInput` | 201 `Question`; a Done or Cancelled task is refused 409 (see Questions) |
| `POST /questions/:questionId/answer` | `task.write` | `AnswerInput` | `Question`; once: the same answer again by the same member answers it as saved, another is refused 409 |
| `GET /findings?fingerprint=` | read | | `FindingAnswer` (see Security findings) |
| `GET /pull-requests` | read | | `{ pullRequests: PullRequest[] }`, the 50 most recently updated |
| `GET /members` | read | | `{ members: Member[] }` |
| `GET /agents` | read | | `{ agents: Agent[] }`: the host's agents that may reach DevSync (`host.agents.list`), then DevSync's own not yet moved, newest first |
| `POST /agents/:agentId/messages` | `task.write` | `AgentMessage` | 201 `{ id, kind, createdAt }`, idempotent by its key; an agent that hasn't connected to DevSync yet is refused 404 |
| `GET /tasks/:taskId/runs` | read | | `{ runs: Run[] }`, the task's 50 latest, newest first |
| `POST /tasks/:taskId/runs` | `run.request` | | 201 `Run`, waiting for approval |
| `GET /runs/setup` | read | | `RunSetup` |
| `POST /runs/:runId/approve` | `run.decide` | | `Run` |
| `POST /runs/:runId/reject` | `run.decide` | | `Run` |
| `POST /runs/:runId/cancel` | the requester, or `run.decide` | | `Run` |

### Workspace routes

| Method and path | Permission | Answer |
|---|---|---|
| `GET /tasks?project=&status=&assignee=` | read | `{ tasks: (Task & { projectName })[] }`; without `status`, the open ones (not Done or Cancelled) |
| `GET /members` | read | `{ members: Member[] }` |

### Shapes

- `TaskInput`: `title` (1–160), `description` (≤ 8000), `acceptanceCriteria` (≤ 8000), the
  task's fields below (each optional: left out, it is empty), and `finding` (`{ fingerprint }`,
  optional: the security finding the task is made from).
- The task's fields (`TaskFields`), none of them part of a requirements revision:
  - `owns`: the paths it may change, at most 50, each once: a POSIX path relative to the
    repository's root of 1–400 characters (no leading `/`, no NUL, no empty, `.` or `..`
    segment); one ending in `/` is the folder and everything under it;
  - `dependsOn`: the ids of the project's tasks it waits for, at most 20, each once, in their
    order. Another project's task, an unknown one or the task itself is refused (422), and so is a
    circle (409, naming the task that already waits for this one), checked under a lock on the
    project's dependencies so two edits at once can't close one;
  - `labels`: at most 10, each 1–40 characters, trimmed, each once whatever its case;
  - `branch`: a branch name git takes (`git check-ref-format --branch`: no space, control
    character or `~^:?*[\`, no `..`, `//` or `@{`, not starting with `-` or `/`, not ending with
    `/` or `.`, no part starting with `.` or ending with `.lock`, neither `@` nor `HEAD`), 1–200
    characters, or null.
- `Finding`: the host's finding as `host.finding` gives it (see Security findings).
  `FindingAnswer`: `finding`, and `task` (the `Task` already linked to it, or null).
- `TaskUpdate`: `version`, and any of `title`, `description`, `acceptanceCriteria`, `status`,
  `assigneeUserId` (a member's id, or null) and the task's fields (one given replaces it: an empty
  list or a null branch clears it). Changing only the task's fields keeps no revision and records no
  timeline event; the version is bumped as for any edit.
- `Task`: `id`, `projectId`, `title`, `status`, `revision`, `version`, `assigneeUserId`, `claim`
  (`{ agentId, agentName, expiresAt }` or null), `pullRequestNumber`, `owns`, `dependsOn`,
  `labels`, `branch`, `createdAt`, `updatedAt`.
- `TaskDetail`: a `Task` with `description`, `acceptanceCriteria`, `creator`, `revisions` (newest
  first: `number`, the three fields, `author`, `createdAt`), `comments` (newest first: `id`,
  `author`, `body`, `createdAt`), `questions` (each a `Question`, the open ones first, each group
  oldest first), `timeline` (the task's events oldest first: `id`, `kind`, `actor`, `message`,
  `revision`, `createdAt`), `pullRequest` (or null), `dependencies` (the tasks it waits
  for in their order, each `{ id, title, status }`), `overlaps` (while it is open, the project's
  other open tasks, neither Done nor Cancelled, whose paths overlap its own, oldest first: `task`
  (`{ id, title, status }`) and `paths`, the paths they share, sorted: a path both name, or the one
  inside the other's folder) and `usage` (`{ agents, runs }`: the sum of its agents' reported usage
  and, kept apart, of its managed runs', each a `UsageTotal` or null when there is none).
- `UsageTotal`: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`
  (a figure a report left out counts 0), `costUsd` (to the millionth of a dollar; the agents' is
  their own estimate), `models` (each once, sorted) and `count` (the reports or runs it adds up).
- An author or actor: `{ kind: "member", userId, name }` or `{ kind: "agent", agentId, name }`; a
  member who has left the workspace is named "Former member".
- `CommentInput`: `body` (1–4000). `PullRequestLink`: `number` (a positive integer, or null).
- `QuestionInput`: `text` (1–4000, trimmed). `AnswerInput`: `answer` (1–4000, trimmed).
- `Question`: `id`, `taskId`, `askedBy` (an author), `text`, `wait` (an agent asked it holding the
  task's claim, and the task waits for it in Blocked; cleared on an open one once the task leaves
  Blocked another way), `status` (`OPEN` or `ANSWERED`), `answer`,
  `answeredBy` (an author) and `answeredAt` (each null while it is open), `createdAt`.
- `PullRequest`: `number`, `title`, `state` (`open`, `closed`, `merged`), `url`, `updatedAt`.
- `Member`: `userId`, `name`, `role`.
- `Agent`: `id`, `name`, `kind` (`CLAUDE`, `CODEX` or `OTHER`: the host's `claude`, `codex` and
  `other`), `status` (`Recently active`, `Offline`, `Expired`, `Revoked`), `expiresAt` (when
  DevSync's own token expires; null for the host's agents, whose tokens the host shows),
  `lastSeenAt` (last seen by DevSync) and `createdAt` (when DevSync first had the agent; null for
  one of the host's that hasn't connected yet). The host's list doesn't say which of its agents are
  revoked or expired, so the host's agents are `Recently active` or `Offline`, or `Revoked` for one
  DevSync revoked before its move.
- `AgentMessage`: `kind` (`clarification.requested`, `clarification.answered`, `review.requested`,
  `system.warning`), `message` (1–4000), `idempotencyKey` (a UUID).
- `Run`: `id`, `taskId`, `revision` (the requirements revision it runs on), `status` (`REQUESTED`,
  `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `REJECTED`, `CANCELLED`), `requestedBy`, `decidedBy`
  (who approved, rejected or cancelled it, or null), `createdAt`, `decidedAt`, `startedAt`,
  `finishedAt`, `failure` (`{ code, message }`: why it failed and what to do, or null),
  `changedFiles`, `usage` (`inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens`, `costUsd` (an estimate: Claude Code's, or with Codex the workflow's from
  OpenAI's prices), `models`, `turns` (the agent's turn count, or null), or null), `provider`
  (`anthropic`, `openrouter` or `openai`: whose key it used; `opscrew`: the workspace's AI
  credits; or null), `draftPullRequestUrl` and
  `githubRunUrl` (`https://github.com/<owner>/<repo>/actions/runs/<id>`, once GitHub started it).
- `RunSetup`: `workflow` (`.github/workflows/devsync.yml` is on the default branch), `secret`
  (runs can read the `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` Actions secret),
  `missing` (what to
  add, in plain English; empty when nothing is).

### Task statuses

Backlog, Ready, Claimed, In progress, Blocked, Review, Done, Cancelled. The moves allowed are
`TRANSITIONS` in `@devsync/schemas`. A claimed task changes status only by its claim (or by being
cancelled) until the claim expires or its agent is revoked; then anyone may move it, and the claim
is cleared. Every change to a task's title, description or acceptance criteria keeps a new
revision; every edit checks the task's `version` and is refused with "This task changed. Reload it
and try again." when another came first. An agent claims a task only once every task it waits for
is Done or Cancelled, and holds at most 3 live claims at once (see `claim_task`). A question asked
with `wait` moves a claimed task to Blocked, and its answers back to Ready (see Questions).

### Questions

A question is a record on a task: who asked (a member, or an agent), its text, open or answered,
the answer, who gave it and when. Asking and answering are timeline events of the task
(`question.asked`, `question.answered`, with the text as their message), delivered to the project's
agents as every timeline event is, and host events (see Events).

- **Asking.** On an open task only (neither Done nor Cancelled): a member on the task's panel
  (`POST /tasks/:taskId/questions`), an agent with `ask_question`, idempotent by its `requestId`
  (the same id for another question is refused 409). When the task's creator is an agent other than
  the asker, it gets a `clarification.requested` signal, `{ taskId, questionId, message }`; a
  revoked creator gets none. Each question an agent asks counts against its 20 signals a minute,
  with what it publishes, whether or not it signals anyone (one past them is refused 429, and the
  question isn't kept); a retry under the same `requestId` is no new question.
- **Waiting.** With `wait: true`, an agent holding the task's live claim ends it and the task moves
  to Blocked, as `report_blocker` does; without the claim, `wait` is refused 409. The task keeps
  `blocked_by_question` while it stays Blocked, which tells it apart from a task a blocker report
  or a member's move blocked. Any other move off Blocked clears it, and the `wait` of the task's
  open questions with it: they no longer hold the task, so only the current block's question
  counts.
- **Answering.** Once: a member on the panel (`POST /questions/:questionId/answer`), an agent with
  `answer_question`, never an agent's own question. The asker, when an agent, gets a
  `clarification.answered` signal, `{ taskId, questionId, message }`; each answer an agent gives
  counts against the same limit, signal or not. A task Blocked by a question's wait returns to
  Ready once none of its open questions has `wait`; a task blocked otherwise stays Blocked whatever
  is answered.

## MCP for coding agents

DevSync's MCP tools are its actions (`serverModule.actions`, `packages/server/src/actions.ts`),
each declared once. The host serves them at its own MCP address, `https://app.opscrew.dev/mcp`, with
every other module's, as `devsync_<name>`, so one token reaches every module. The host adds the
project: a member gives `projectId`, while an agent's or a run's token has its own. It lists two
tools by default, `search` and `execute`, which reach every action;
`https://app.opscrew.dev/mcp?tools=all` lists each action as a tool. DevSync's own endpoint serves
the same list until a later release (see DevSync's own endpoint below).

| Action | Kind | Who | Input | What it does |
|---|---|---|---|---|
| `get_project_state` | read | everyone | | the project, its agents and its 100 most recently updated tasks |
| `list_tasks` | read | everyone | `status`?, `assignee`? (`me`, `none` or a user id) | `{ tasks }`, as `GET /tasks`; `me` is a member's own |
| `get_task` | read | everyone | `taskId` | `{ task, latestRun }`: the `TaskDetail`, with its questions, its pull request, the tasks it waits for, the open tasks sharing its paths and its usage, and its latest `Run` (or null) |
| `get_briefing` | read | everyone | `taskId` | the task's briefing (see Briefing below): `task` (`id`, `title`, `description`, `acceptanceCriteria`, `status`, `revision`), `openQuestions`, `answeredQuestions`, `owns`, `waitsFor` (the tasks it waits for, each `{ id, title, status }`), `overlaps`, `context` (`{ instructions, facts }`, the host's entries with their trust) and `omitted` (`{ contextEntries, answeredQuestions, openQuestions }`) |
| `get_pending_signals` | read | agents | | the agent's oldest unacknowledged signals |
| `acknowledge_signal` | write | agents | `id` | acknowledges one |
| `publish_signal` | write | agents | `recipientId`, `kind`, `payload.message`, `idempotencyKey`, `replyToId`? | to a peer agent: one follow-up per signal, four replies per chain, 20 new signals a minute |
| `claim_task` | write | agents | `taskId`, `claimId` | claims a Ready task (or an expired claim) for 15 minutes, once every task in its `dependsOn` is Done or Cancelled ("This task waits for task "<title>". Claim it once that is done.") and while the agent holds fewer than 3 other live claims ("You hold 3 claimed tasks. Release, finish or report a blocker on one before claiming another."); taking over an expired claim counts as a claim, and claiming again under the same live claim is the same claim. An agent's claims are made one at a time |
| `renew_task_claim` | write | agents | `taskId`, `claimId` | renews it; answers the current requirements revision |
| `release_task` | write | agents | `taskId`, `claimId` | releases it and returns the task to Ready |
| `create_task` | write | agents, and members whose role may (`task.write`) | `requestId`, `title`, `description`, `acceptanceCriteria`, and optionally `owns`, `dependsOn`, `labels`, `branch` | creates a Backlog task, idempotent by `requestId` for its creator (an agent or a member; a retry is compared by its requirements) |
| `update_task` | write | agents, and members whose role may (`task.write`) | `taskId`, `version`, the requirements, the task's fields, `status` (`BACKLOG` or `READY`) | edits a task; an agent edits only the tasks it created |
| `report_progress` | write | agents | `taskId`, `claimId`, `revision`, `requestId`, `message`, `usage`? | a progress report on the timeline; `usage` (`AgentUsage`: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, each a non-negative whole number, `costUsd` a non-negative number, `model` 1–100 characters, all optional) is what the agent used since its previous report on the task, its own estimate, kept with the report apart from what peers receive. A retry under the same `requestId` must carry the same usage |
| `report_blocker` | write | agents | `taskId`, `claimId`, `revision`, `requestId`, `message` | ends the claim, moves the task to Blocked |
| `ask_question` | write | agents | `taskId`, `requestId`, `text` (1–4000), `wait`? | a `Question` on an open task, idempotent by `requestId`; with `wait`, the agent holding the task's claim ends it and the task moves to Blocked (see Questions) |
| `answer_question` | write | agents | `questionId`, `answer` (1–4000) | answers an open question, once, never the agent's own; a task Blocked by questions asked with `wait` returns to Ready once they are all answered |
| `request_review` | write | agents | as `report_progress`, `usage`? too | ends the claim, moves the task to Review |
| `submit_review` | write | agents | `taskId`, `reviewRequestId`, `revision`, `requestId`, `decision` (`APPROVED`, `CHANGES_REQUESTED`), `message` | a peer's decision; changes requested return the task to Ready |
| `request_run` | start | members whose role may (`run.request`) | `taskId` | checks the task may get a run, as asking for one does (the setup too), and answers what it would ask for (`taskId`, `title`, `revision`) with `confirm: { label: "Ask for a managed run" }`; it creates nothing |

- **Kinds.** The host runs a `read` and answers its result. It runs a `write` directly for agents
  and members over `/mcp` and for other modules; in its chat it proposes one with a confirm button
  and runs it when the member presses it. A `start` only proposes: the member asks for the run from
  the task's runs section, and the run still waits for an approval.
- **Callers.** No action names a host permission: DevSync's checks stay `can()`'s, in the domain. A
  member acts with their role. An agent acts as itself, with the host's name: DevSync's row of it is
  made at its first call, its kind read from `host.agents.list`, so its inbox, claims and timeline
  point at it, as on DevSync's own endpoint. A managed run (`kind: "run"`) reads the project's state
  and its tasks only (`get_briefing` too). Every other action refuses it, as an agents-only action
  refuses a member (`ask_question` and `answer_question` say a member asks and answers on the
  task's panel) and `request_run` refuses an agent, each saying who can.
- **Refusals.** An action answers DevSync's refusals as its result,
  `{ refused: { code, message } }`, with the codes and plain-English messages of the HTTP API, and
  agents' writes to a read-only project are refused. It throws only for a fault, which the host
  reports as "failed".
- **Guidance.** `/mcp` lists only actions, so the rules an agent needs are in the descriptions of
  the actions they concern (`ACTION_RULES`): read the project's state and the pending signals at the
  start of an assignment; claim a task before working on it; renew the claim within 15 minutes;
  report a blocker instead of waiting; request a review when the work is done; and, when memory
  tools are listed, recall what is known about the task before working on it and remember what was
  learned before requesting a review. Then the task's rules: hold at most 3 claimed tasks at once;
  a task is claimed once every task in its `dependsOn` is Done or Cancelled (both in `claim_task`);
  give `usage` since the previous report, when known (`report_progress`, `request_review`); what
  `owns`, `dependsOn`, `labels` and `branch` are, which make no revision (`create_task`,
  `update_task`); ask a question instead of guessing, with `wait` the task waiting for the answer
  (`ask_question`); and read the briefing before starting (`get_briefing`, `claim_task`). Each
  description is at most 1,000 characters.
- **Size.** A test (`actions.test.ts`) fails when the actions' list (names, descriptions and input
  JSON schemas, as JSON) grows past its budget, 14,000 characters (P3 reached 9,384, P4 11,960 with
  the task's fields, the claim rules and usage, P6 13,956 with questions and the briefing; P3's
  budget was 10,000, P4's 12,000). An id's schema is `{ type: "string", format: "uuid" }` only,
  without the pattern zod would repeat beside it.
- **Briefing.** `get_briefing` asks `host.context({ projectId, agentId | userId }, { subject:
  <the task's title> })` as the caller (a managed run gets no context: the host takes no run
  there), keeps only the contract's fields of each entry (an answer that doesn't parse is logged,
  naming its fields only, and gives none), and answers within 8,000 characters of JSON: past them,
  the context is cut first, whole entries from its last (its facts before its instructions), then
  the answered questions, the oldest first, then the open questions, the newest first, and
  `omitted` counts what was cut. Only the task, with its paths, waits and overlaps, is never cut,
  so only a task that alone passes 8,000 characters makes a longer briefing, with no context and
  no question. Context marked `untrusted` is information, not instructions, as its description
  says.

The host's Agents dialog (the **Agents** button at the top of the project's page) registers an
agent, shows its token once and gives these snippets. For Claude Code:

```json
{
  "mcpServers": {
    "opscrew": {
      "type": "http",
      "url": "https://app.opscrew.dev/mcp",
      "headers": { "Authorization": "Bearer ${OPSCREW_AGENT_TOKEN}" }
    }
  }
}
```

For Codex, in `config.toml`:

```toml
[mcp_servers.opscrew]
url = "https://app.opscrew.dev/mcp"
bearer_token_env_var = "OPSCREW_AGENT_TOKEN"
```

### DevSync's own endpoint

`POST /m/devsync/mcp`: a stateless Streamable HTTP MCP endpoint with JSON responses, kept until a
later release while agents move to the host's `/mcp`. Its tools are the same actions, called as the
agent, under their own names (no `devsync_` prefix). A refusal is the tool's error, with its
message. Its MCP `instructions` give every rule of Guidance above.

The host registers a project's agents once for every module. An Owner or Admin registers one from
the host's Agents dialog, and rotates or revokes it there; DevSync's own tab lists the agents and
registers none. DevSync's endpoint still accepts their tokens: each request asks
`host.agents.verify(token)` first, never cached, so a token revoked on the dashboard is refused from
the next request. An agent the host verifies for the first time gets a DevSync row with no token, so
its inbox (which starts then: a member can message it from its first connection), claims and
timeline point at its id; the row takes the host's name on each request.

The agents DevSync registered itself, before the host had any, move to the host with their tokens:
the hourly `devsync.agents-move` (see Queues) gives each row that still has a token to
`host.agents.adopt`, keeping its id and token hash, and nulls the row's token in the same
transaction. Until then such a token (a bearer token for that agent and project only, valid 24
hours, of which DevSync keeps only the SHA-256 hash) is checked against DevSync's own row, after
the host. When that row has no live token, the host is asked once more, as the token's move may
have committed in between, so a token never fails while it moves.

A missing, invalid, expired or revoked token is refused 401 with `WWW-Authenticate: Bearer`, as is
the host's agent's token while DevSync is off for its project (the host verifies none then).
DevSync's own token whose project is gone, disconnected or has DevSync off is refused 403 ("DevSync
is off for this project"), as is a request with an origin other than the host's. Every answer
carries `Cache-Control: no-store`.

An agent revoked on the dashboard is refused at once. DevSync's row of it isn't marked revoked,
though (only a revoke DevSync made before the move is), so until a later release reads the host's
revokes, a revoke on the dashboard after the move leaves the agent:

- listed in `get_project_state` and in the Agents section;
- messaged by members and peers, asked for reviews, and sent GitHub signals, all into an inbox it
  can no longer read;
- holding any task it had claimed until the claim expires, 15 minutes at most.

## Queues

The host's worker runs DevSync's queues (`jobs` from `@devsync/server`):

- `devsync.outbox`: delivers due outbox events to the agents' inboxes, each once per recipient,
  backing off failures up to 10 minutes. Enqueued after each change that records an event, and
  run every minute.
- `devsync.github`: one GitHub fact for a project with DevSync on, as the host forwards it from its
  webhooks: `{ workspaceId, projectId, fact }`, where `fact` is
  `{ kind: "push", deliveryId, ref, before, after, defaultBranch }`,
  `{ kind: "pull_request", deliveryId, action, number, title, state, merged, url, headRef, headSha, updatedAt }`
  or `{ kind: "workflow_run", deliveryId, githubRunId, conclusion }`. For a push or a pull request,
  DevSync keeps the pull request's latest state and sends the project's agents branch-updated,
  pull-request-opened and pull-request-merged signals, once per delivery. A `workflow_run` fact,
  which the host sends only for a completed run DevSync started, ends that run (see Managed runs);
  a repeated delivery changes nothing, and a fact for a run the project doesn't have yet fails the
  job, so the host retries it.
- `devsync.runs`: `{ projectId, runId }` dispatches an approved run, at most once, enqueued once
  its approval commits. Every ten minutes (`*/10 * * * *`), with an empty payload, it sweeps every
  project's runs: it enqueues the dispatch of an approved run not claimed ten minutes after its
  approval; it ends `FAILED` (`unavailable`) a run claimed ten minutes ago whose dispatch was never
  recorded, without dispatching it again; and it reads a run still in GitHub six hours after its
  dispatch once more, ending it `FAILED` (`no-result`) without a result (while GitHub doesn't
  answer, it tries again at each sweep until a day after the dispatch).
- `devsync.agents-move`: every hour (`0 * * * *`), with an empty payload, moves DevSync's own
  agents to the host (see MCP for coding agents): for each project the host answers, one
  transaction gives `host.agents.adopt` its rows that still have a token and nulls their
  `token_hash` and `expires_at`. A project with DevSync off waits for the next hour; one whose move
  fails is logged (the error's name only) and tried again then.

## Events

DevSync emits its events with `host.emit` in the transaction that makes the change, for whichever
modules consume them; it names none of them. The events and their data are the table in
[platform.md](platform.md) (Events): `devsync.task.created`, `updated`, `moved`, `done`, `claimed`
and `released`, `devsync.review.requested`, `approved` and `changes_requested`,
`devsync.question.asked` and `answered` (`taskId`, `questionId`), `devsync.pr.linked` and
`merged`, and `devsync.run.finished`. Their data is names and ids only, never a title, a
description, a message or a question's text. A question asked with `wait` emits `released` and
`moved` (Claimed to Blocked) beside `asked`, and the answer that returns its task to Ready emits
`moved` (Blocked to Ready) beside `answered`. A change with a timeline event emits through
`outbox.record`, which maps it once; a claim, a release, a pull request linked or merged emit at
the change, through the same mapping. `released` comes whenever a claim ends other than by a review
request: a release, a blocker, a member's move or cancel, or another claim taking over an expired
one. `merged` comes for each task linked to the pull request.

Every text DevSync stores from an agent passes `host.redact` first: a report's or a review's
message, a signal's message, a question's text and an answer, the requirements of a task an agent
creates or edits, its paths, labels and branch (checked again after the redactor: a branch it
turned into `[redacted]` is no branch name, and is refused by its field), and the model a report's
usage names. Members' text is kept as they wrote it.

## Migrations and removal

- `migrations` (`{ folder, schema: "devsync" }`): the host applies them after its own, with the
  journal in `devsync.__drizzle_migrations`.
- `removeProject(db, projectId)`, `removeWorkspace(db, workspaceId)`: delete every DevSync row of
  it, its runs too, in the host's removal transaction. `removeMember(db, workspaceId, userId)`:
  unassigns them; the runs they asked for or decided are kept, and name them "Former member".

## Export

`exportProject(tx, projectId)` answers DevSync's rows of the project for its export, read through
the host's read-only `tx` only: its tasks with their revisions, comments, questions (with their
answers), paths, labels, branch and the tasks they wait for (`dependsOn`, in their order), its
runs, its pull requests and its timeline (the outbox's events, each with the `usage` an agent
reported, or null). The agents are the host's to export; the timeline names them by id.

## Pages

`webModule` (`packages/web/src/module.tsx`) gives the host two pages, `ProjectTab` and
`WorkspacePage`, which take the props every module's pages get:

- both: `apiBase` (the mount point above), `userId` and `role` (the member's), and `ui`, the host's
  pieces, so DevSync looks like the rest of the dashboard: `Icon` (`{ name, className? }`),
  `Dialog` (`{ title, icon, onSubmit?, children }`), `EmptyState` (`{ icon, title, children,
  action? }`) and `Link` (`{ to, className?, children }`, the host's router link);
- `ProjectTab`: `project` (`{ id, fullName, defaultBranch, readOnly }`, `defaultBranch` being the
  repository's default branch, which the runs section's links to GitHub use), `query` (the page's
  search parameters) and `setQuery` (replaces them): the selected task is `?task=<id>`, and a
  security finding to make a task from is `?finding=<fingerprint>` (see Security findings);
- `WorkspacePage`: `projectHref(projectId, query?)`, the address of a project's DevSync tab, which
  task links use with `{ task }`.

Inside, each wraps DevSync's own component in `DevSyncProvider` (which also takes an optional
`fetch` for tests, and `readOnly`: on a read-only or disconnected project every change DevSync
offers is disabled, as the host refuses them).

They use the TanStack Query client the host gives the page (one of the module's own), refetch every
10 seconds while visible (except the runs' setup, `GET runs/setup`, which costs several GitHub
calls: read when the tab opens and on "Check again"), and use the
host's global classes (`card`, `card-h`, `card-t`, `btn`, `btn-primary`, `btn-secondary`,
`btn-ghost`, `btn-danger`, `btn-sm`, `bordered`, `i-sm`, `field`, `status` with `s-good`, `s-warning`, `s-serious`,
`s-muted`, `chip`, `feed`, `kv`, `tabs`, `tab`, `is-table`, `sub`, `mono`, `cream`) and its CSS
variables (`--c-*`, `--s-*`, `--radius-card`, `--radius-inner`, `--font-*`) in their own CSS
modules. No `style` attributes: the host's Content-Security-Policy forbids them. The icons DevSync
names (the host's sprite must have them, Phosphor regular): `kanban`, `plus`, `robot`,
`git-pull-request`, `copy`, `trash`, `paper-plane-tilt`, `arrows-clockwise`,
`clock-counter-clockwise`, `chat-circle-text`, `check-circle`, `warning`, `arrow-square-out`.

## Managed runs

A member asks for a run on a Ready task; an Owner, Admin or Approver approves it; the host starts
DevSync's workflow in the project's own GitHub Actions, which runs Claude Code on an Anthropic or
OpenRouter key of the workspace's own (or Codex on an OpenAI key), or, without a key, on the
workspace's AI credits, and opens a draft pull request itself. The design is
[managed-runs.md](managed-runs.md); this is what DevSync asks of the host.

`serverModule` declares `workflows: ["devsync.yml"]` (with `github: true`), so the host lets DevSync
start `.github/workflows/devsync.yml` and nothing else. DevSync calls `host.github`, the contract's
`ModuleHost.github`, whose calls answer `{ ok: true, … }` or `{ ok: false, failure }` and never
throw GitHub's errors:

| Call | When | What DevSync does with the answer |
|---|---|---|
| `setup(projectId, "devsync.yml")` | `GET /runs/setup`, and before a run is asked for | `workflow`, and whether `secrets` holds `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY`, give `RunSetup`; asking for a run while the workflow is missing answers 409 with `missing`'s words. A key is never missing: without one, the run pays with the workspace's AI credits |
| `dispatch(projectId, "devsync.yml", { run_id, task, opscrew_origin?, opscrew_request? })` | `devsync.runs`, at most once per approved run | `run_id` is the run's id; `task` is `{ "title", "description", "acceptanceCriteria" }` of the requested revision as JSON, at most 60,000 characters (a longer task is refused when the run is asked for); `opscrew_origin` and `opscrew_request` are `ai.allowRun`'s answer, when it gave one (below). The run is then `RUNNING` with `githubRunId`; a failure ends it `FAILED` with that failure as its reason |
| `artifact(projectId, githubRunId, "devsync-result")` | a `workflow_run` fact, and the six-hour sweep | `result.json` (schema version 1, `RunResult` in `@devsync/schemas`) is checked (the run's own id, a pull request of the project's own repository, at most 1,000 changed paths of at most 400 characters with no NUL or lone surrogate, every figure non-negative, a known `provider` (`opscrew` for the AI credits), which a succeeded run must have, and `turns` a non-negative whole number or null) and kept, its `turns` with its usage (`Run.usage.turns`); a result that fails a check ends the run `bad-result`, none `no-result`. A failure fails the fact's job, so the host retries it |
| `deleteArtifact(projectId, githubRunId, name)` | once the run has ended | both `devsync-result` and `devsync-patch`; a failure is logged, and GitHub removes them when they expire |

Before each dispatch, outside any transaction and before the run is claimed, `devsync.runs` calls
`host.ai.allowRun({ projectId, runRef: <the run's id>, workflow: "devsync.yml" })`, the contract's
`ModuleHost.ai`:

- An answer `{ origin, request }` (an https origin of at most 255 characters, and a request of 1
  to 4,000, checked with zod) is passed on as the inputs `opscrew_origin` and `opscrew_request`.
  The workflow's `agent` job (`id-token: write`) then asks GitHub for an OIDC token with the
  origin as its audience and exchanges it, with the request, at `POST <origin>/mcp/credential` for
  the run's token to `<origin>/mcp`, and, when the repository has no key of the workspace's own, at
  `POST <origin>/ai/credential` for a 30-minute credential to `<origin>/ai`, the host's gateway.
  Each exchange answers `{ token }` or one plain 403; a refused `/ai/credential` ends the run
  `no-credits`.
- Null (a read-only project, or DevSync off), or an answer that doesn't parse (logged without its
  values), dispatches the run with `run_id` and `task` only: it has neither `/mcp` nor the
  credits.
- A call that throws fails the job before the run is claimed, so the host's retry dispatches it.

A dispatch never holds a transaction open while GitHub is asked. It first claims the run, setting
its `started_at` while it is `QUEUED` and has none, in one statement that commits on its own; only a
job that claimed the run calls `dispatch`, and a second short transaction then records GitHub's
answer. A run is thus dispatched at most once: if a dispatch breaks off between the claim and the
answer, GitHub may have started the run, so the sweep ends it `FAILED` (`unavailable`, telling the
user to look for it in the repository's Actions) instead of dispatching it again.

A run whose `workflow_run` conclusion is `cancelled` ends `FAILED` (`cancelled`), whatever its
result says. A succeeded run's draft pull request is linked to the task when the task has none
(audited as `devsync.task.pull_request_linked`, by the host). The `failure` codes are the workflow's
(`no-key`, `no-credits`, `agent-failed`, `budget`, `turns`, `no-changes`, `patch-did-not-apply`,
`patch-touches-workflows`, `push-failed`, `pull-request-not-allowed`), the host's `GithubFailure`
when it couldn't start the run (`not-found`, `unavailable`, `workflow-missing`, `workflow-disabled`,
`forbidden`), and DevSync's own (`bad-result`, `no-result`, `cancelled`); each `Run` shows its
plain-English message.

Each change is a timeline event of the task (`run.requested`, `run.approved`, `run.rejected`,
`run.cancelled`, `run.started`, `run.finished`) and, but for the start, an audit entry
(`devsync.run.requested`, `approved`, `rejected`, `cancelled`, `finished`, the last by the host),
with ids and figures only.

## Security findings

A member turns one of the dashboard's security findings into a DevSync task. The design is
[findings.md](findings.md); this is what DevSync asks of the host.

The manifest's `"findingAction": { "label": "Fix with DevSync" }` (1–40 characters, plain text)
names the button the dashboard shows on a finding's details, also on one marked "Not a problem",
when DevSync is on for the project. It opens DevSync's project tab with `?finding=<fingerprint>`;
the tab clears `finding` from the address once the finding's task is open or its dialog closed.

`host.finding(projectId, fingerprint)`, the contract's `ModuleFinding` (`Finding` in `host.ts`),
answers one of the project's open findings:

| Field | What it holds |
|---|---|
| `fingerprint` | 1–128 characters of `A–Z a–z 0–9 . _ : / -`. It includes the line, so the same problem gets a new fingerprint when code above it moves |
| `ruleId`, `title` | at most 200 characters each |
| `severity` | `critical`, `high`, `medium`, `low` or `info` |
| `file`, `line` | a POSIX path relative to the repository's root (no leading `/`, no `..`, no backslash, at most 1,000 characters; an empty one counts as none) and a positive line, or null |
| `description`, `remediation` | at most 4,000 characters each, or null |
| `firstSeenAt`, `lastSeenAt` | ISO 8601 |
| `dismissal` | `{ reason: "false-positive" \| "accepted-risk" }` for one marked "Not a problem", or null |

Every text is already redacted and cut to its limit with "…"; the match itself never reaches
DevSync. It answers null for a fingerprint outside the character set, for a finding the project
doesn't have, for a resolved one, and while DevSync is off for the project or its workspace. Any
member may read it.

DevSync parses the answer with `Finding` from `@devsync/schemas` (an answer that doesn't parse, or
names another fingerprint, fails as unexpected) and uses it twice:

- `GET /findings?fingerprint=` (any member) refuses a fingerprint outside the character set (422,
  `invalid`) before asking the host, and answers null as 404: "This finding is resolved or isn't
  this project's. Open it again from the project's security findings." Otherwise it answers the
  finding and the open task (neither Done nor Cancelled) already linked to it: made from the same
  fingerprint, or from a finding with the same rule and file. The fingerprint may hold a `/`, so it
  is always a query parameter, never a path segment.
- `POST /tasks` with `finding: { fingerprint }` reads the finding again (404 as above when it is
  gone), refuses 409 (`conflict`) when it has an open task linked to it (the same fingerprint, or
  the same rule and file) ("This finding already has a task, "<title>". Open it instead."), and
  keeps its fingerprint, rule and file on
  the task (`finding_fingerprint`, `finding_rule`, `finding_file`), from the host's answer, never
  the browser's. The task's text is what the member wrote, prefilled by the tab from the finding
  within DevSync's limits.
