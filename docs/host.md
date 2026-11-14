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
  "server": "packages/server/src/module.ts",
  "web": "packages/web/src/module.tsx"
}
```

The server imports `serverModule` from the `server` file, the dashboard `webModule` from the `web`
file (as its own chunk). The `id` is DevSync's schema name, the prefix of its queues and audit
actions, and the `devsync` in every address below.

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
| `db` | its PostgreSQL database (or the current transaction). DevSync's tables are in the `devsync` schema of the same database, so DevSync's transactions are the host's, and the host's audit entry commits with the change. DevSync uses Drizzle's query builder only. |
| `clock` | `now()`: every timestamp DevSync writes comes from it. |
| `log` | `error(message)`: never given a token. |
| `audit(tx, actor, entry)` | appends to the host's audit log in `tx`. Actions start with `devsync.`; details hold names, ids and figures only. |
| `members(workspaceId)` | the workspace's members with their names and roles. |
| `project(projectId)` | the connected project with DevSync on for it and its workspace, or null: checked on every MCP request. |
| `enqueue(queue, payload, options?)` | sends a job to a DevSync queue after the current transaction commits. |
| `github` | DevSync's workflow in the project's repository, through the host's GitHub App: `setup`, `dispatch`, `artifact`, `deleteArtifact` (see Managed runs). |

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
| `agent.manage`: register, rotate, revoke an agent | yes | yes | no | no |
| `run.request`: ask for a managed run | yes | yes | yes | yes |
| `run.decide`: approve or reject a managed run | yes | yes | yes | no |

A member who asked for a run may cancel it while it waits for approval, whatever their role; so may
anyone with `run.decide`.

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
| `GET /pull-requests` | read | | `{ pullRequests: PullRequest[] }`, the 50 most recently updated |
| `GET /members` | read | | `{ members: Member[] }` |
| `GET /agents` | read | | `{ agents: Agent[] }` |
| `POST /agents` | `agent.manage` | `AgentInput` | 201 `{ agent: Agent, token: string }` |
| `POST /agents/:agentId/rotate` | `agent.manage` | | `{ agent: Agent, token: string }` |
| `DELETE /agents/:agentId` | `agent.manage` | | 204 |
| `POST /agents/:agentId/messages` | `task.write` | `AgentMessage` | 201 `{ id, kind, createdAt }`, idempotent by its key |
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

- `TaskInput`: `title` (1–160), `description` (≤ 8000), `acceptanceCriteria` (≤ 8000).
- `TaskUpdate`: `version`, and any of `title`, `description`, `acceptanceCriteria`, `status`,
  `assigneeUserId` (a member's id, or null).
- `Task`: `id`, `projectId`, `title`, `status`, `revision`, `version`, `assigneeUserId`, `claim`
  (`{ agentId, agentName, expiresAt }` or null), `pullRequestNumber`, `createdAt`, `updatedAt`.
- `TaskDetail`: a `Task` with `description`, `acceptanceCriteria`, `creator`, `revisions` (newest
  first: `number`, the three fields, `author`, `createdAt`), `comments` (newest first: `id`,
  `author`, `body`, `createdAt`), `timeline` (the task's events oldest first: `id`, `kind`, `actor`,
  `message`, `revision`, `createdAt`) and `pullRequest` (or null).
- An author or actor: `{ kind: "member", userId, name }` or `{ kind: "agent", agentId, name }`; a
  member who has left the workspace is named "Former member".
- `CommentInput`: `body` (1–4000). `PullRequestLink`: `number` (a positive integer, or null).
- `PullRequest`: `number`, `title`, `state` (`open`, `closed`, `merged`), `url`, `updatedAt`.
- `Member`: `userId`, `name`, `role`.
- `AgentInput`: `name` (1–80), `kind` (`CLAUDE` or `CODEX`). `Agent`: `id`, `name`, `kind`,
  `status` (`Recently active`, `Offline`, `Expired`, `Revoked`), `expiresAt`, `lastSeenAt`,
  `createdAt`.
- `AgentMessage`: `kind` (`clarification.requested`, `clarification.answered`, `review.requested`,
  `system.warning`), `message` (1–4000), `idempotencyKey` (a UUID).
- `Run`: `id`, `taskId`, `revision` (the requirements revision it runs on), `status` (`REQUESTED`,
  `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `REJECTED`, `CANCELLED`), `requestedBy`, `decidedBy`
  (who approved, rejected or cancelled it, or null), `createdAt`, `decidedAt`, `startedAt`,
  `finishedAt`, `failure` (`{ code, message }`: why it failed and what to do, or null),
  `changedFiles`, `usage` (`inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens`, `costUsd`, `models`, or null), `draftPullRequestUrl` and `githubRunUrl`
  (`https://github.com/<owner>/<repo>/actions/runs/<id>`, once GitHub started it).
- `RunSetup`: `workflow` (`.github/workflows/devsync.yml` is on the default branch), `secret`
  (runs can read the `ANTHROPIC_API_KEY` Actions secret), `missing` (what to add, in plain English;
  empty when nothing is).

### Task statuses

Backlog, Ready, Claimed, In progress, Blocked, Review, Done, Cancelled. The moves allowed are
`TRANSITIONS` in `@devsync/schemas`. A claimed task changes status only by its claim (or by being
cancelled) until the claim expires or its agent is revoked; then anyone may move it, and the claim
is cleared. Every change to a task's title, description or acceptance criteria keeps a new
revision; every edit checks the task's `version` and is refused with "This task changed. Reload it
and try again." when another came first.

## MCP for coding agents

`POST /m/devsync/mcp`: a stateless Streamable HTTP MCP endpoint with JSON responses. An Owner or
Admin registers an agent on the project's DevSync tab and copies its token once; the token is a
bearer token for that agent and project only, expires after 24 hours, and can be rotated or
revoked. DevSync keeps only its SHA-256 hash. A missing, invalid, expired or revoked token is
refused 401 with `WWW-Authenticate: Bearer`; a valid token whose project is gone, disconnected or
has DevSync off is refused 403 ("DevSync is off for this project"), as is a request with an origin
other than the host's. Every answer carries `Cache-Control: no-store`.

| Tool | Input | What it does |
|---|---|---|
| `get_project_state` | | the project and its 100 most recently updated tasks |
| `get_pending_signals` | | the agent's oldest unacknowledged signals |
| `acknowledge_signal` | `id` | acknowledges one |
| `publish_signal` | `recipientId`, `kind`, `payload.message`, `idempotencyKey`, `replyToId`? | to a peer agent: one follow-up per signal, four replies per chain, 20 new signals a minute |
| `claim_task` | `taskId`, `claimId` | claims a Ready task (or an expired claim) for 15 minutes |
| `renew_task_claim` | `taskId`, `claimId` | renews it; answers the current requirements revision |
| `release_task` | `taskId`, `claimId` | releases it and returns the task to Ready |
| `create_task` | `requestId`, `title`, `description`, `acceptanceCriteria` | creates a task, idempotent by `requestId` |
| `update_task` | `taskId`, `version`, the fields, `status` (`BACKLOG` or `READY`) | edits a task the agent created |
| `report_progress` | `taskId`, `claimId`, `revision`, `requestId`, `message` | a progress report on the timeline |
| `report_blocker` | the same | ends the claim, moves the task to Blocked |
| `request_review` | the same | ends the claim, moves the task to Review |
| `submit_review` | `taskId`, `reviewRequestId`, `revision`, `requestId`, `decision` (`APPROVED`, `CHANGES_REQUESTED`), `message` | a peer's decision; changes requested return the task to Ready |

Agents' writes to a read-only project are refused. For Claude Code:

```json
{
  "mcpServers": {
    "devsync": {
      "type": "http",
      "url": "https://app.opscrew.dev/m/devsync/mcp",
      "headers": { "Authorization": "Bearer ${DEVSYNC_AGENT_TOKEN}" }
    }
  }
}
```

For Codex, in `config.toml`:

```toml
[mcp_servers.devsync]
url = "https://app.opscrew.dev/m/devsync/mcp"
bearer_token_env_var = "DEVSYNC_AGENT_TOKEN"
```

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

## Migrations and removal

- `migrations` (`{ folder, schema: "devsync" }`): the host applies them after its own, with the
  journal in `devsync.__drizzle_migrations`.
- `removeProject(db, projectId)`, `removeWorkspace(db, workspaceId)`: delete every DevSync row of
  it, its runs too, in the host's removal transaction. `removeMember(db, workspaceId, userId)`:
  unassigns them; the runs they asked for or decided are kept, and name them "Former member".

## Pages

`webModule` (`packages/web/src/module.tsx`) gives the host two pages, `ProjectTab` and
`WorkspacePage`, which take the props every module's pages get:

- both: `apiBase` (the mount point above), `userId` and `role` (the member's), and `ui`, the host's
  pieces, so DevSync looks like the rest of the dashboard: `Icon` (`{ name, className? }`),
  `Dialog` (`{ title, icon, onSubmit?, children }`), `EmptyState` (`{ icon, title, children,
  action? }`) and `Link` (`{ to, className?, children }`, the host's router link);
- `ProjectTab`: `project` (`{ id, fullName, readOnly }`), `query` (the page's search parameters) and
  `setQuery` (replaces them): the selected task is `?task=<id>`;
- `WorkspacePage`: `projectHref(projectId, query?)`, the address of a project's DevSync tab, which
  task links use with `{ task }`.

Inside, each wraps DevSync's own component in `DevSyncProvider` (which also takes an optional
`fetch` for tests).

They use the host's TanStack Query client, refetch every 10 seconds while visible, and use the
host's global classes (`card`, `card-h`, `card-t`, `btn`, `btn-primary`, `btn-secondary`,
`btn-ghost`, `btn-danger`, `btn-sm`, `bordered`, `i-sm`, `field`, `status` with `s-good`, `s-warning`, `s-serious`,
`s-muted`, `chip`, `feed`, `kv`, `tabs`, `tab`, `is-table`, `sub`, `mono`, `cream`) and its CSS
variables (`--c-*`, `--s-*`, `--radius-card`, `--radius-inner`, `--font-*`) in their own CSS
modules. No `style` attributes: the host's Content-Security-Policy forbids them. The icons DevSync
names (the host's sprite must have them, Phosphor regular): `kanban`, `plus`, `robot`,
`git-pull-request`, `copy`, `trash`, `paper-plane-tilt`, `arrows-clockwise`,
`clock-counter-clockwise`, `chat-circle-text`, `check-circle`, `warning`.

## Managed runs

A member asks for a run on a Ready task; an Owner, Admin or Approver approves it; the host starts
DevSync's workflow in the project's own GitHub Actions, which runs Claude Code on the workspace's
own Anthropic key and opens a draft pull request itself. The design is
[managed-runs.md](managed-runs.md); this is what DevSync asks of the host.

`serverModule` declares `workflows: ["devsync.yml"]` (with `github: true`), so the host lets DevSync
start `.github/workflows/devsync.yml` and nothing else. DevSync calls `host.github`, the contract's
`ModuleHost.github`, whose calls answer `{ ok: true, … }` or `{ ok: false, failure }` and never
throw GitHub's errors:

| Call | When | What DevSync does with the answer |
|---|---|---|
| `setup(projectId, "devsync.yml")` | `GET /runs/setup`, and before a run is asked for | `workflow`, and whether `secrets` holds `ANTHROPIC_API_KEY`, give `RunSetup`; asking for a run while either is missing answers 409 with `missing`'s words |
| `dispatch(projectId, "devsync.yml", { run_id, task })` | `devsync.runs`, at most once per approved run | `run_id` is the run's id; `task` is `{ "title", "description", "acceptanceCriteria" }` of the requested revision as JSON, at most 60,000 characters (a longer task is refused when the run is asked for). The run is then `RUNNING` with `githubRunId`; a failure ends it `FAILED` with that failure as its reason |
| `artifact(projectId, githubRunId, "devsync-result")` | a `workflow_run` fact, and the six-hour sweep | `result.json` (schema version 1, `RunResult` in `@devsync/schemas`) is checked (the run's own id, a pull request of the project's own repository, at most 1,000 changed paths of at most 400 characters with no NUL or lone surrogate, every figure non-negative) and kept; a result that fails a check ends the run `bad-result`, none `no-result`. A failure fails the fact's job, so the host retries it |
| `deleteArtifact(projectId, githubRunId, name)` | once the run has ended | both `devsync-result` and `devsync-patch`; a failure is logged, and GitHub removes them when they expire |

A dispatch never holds a transaction open while GitHub is asked. It first claims the run, setting
its `started_at` while it is `QUEUED` and has none, in one statement that commits on its own; only a
job that claimed the run calls `dispatch`, and a second short transaction then records GitHub's
answer. A run is thus dispatched at most once: if a dispatch breaks off between the claim and the
answer, GitHub may have started the run, so the sweep ends it `FAILED` (`unavailable`, telling the
user to look for it in the repository's Actions) instead of dispatching it again.

A run whose `workflow_run` conclusion is `cancelled` ends `FAILED` (`cancelled`), whatever its
result says. A succeeded run's draft pull request is linked to the task when the task has none
(audited as `devsync.task.pull_request_linked`, by the host). The `failure` codes are the workflow's
(`agent-failed`, `budget`, `turns`, `no-changes`, `patch-did-not-apply`, `patch-touches-workflows`,
`push-failed`, `pull-request-not-allowed`), the host's `GithubFailure` when it couldn't start the run
(`not-found`, `unavailable`, `workflow-missing`, `workflow-disabled`, `forbidden`), and DevSync's own
(`bad-result`, `no-result`, `cancelled`); each `Run` shows its plain-English message.

Each change is a timeline event of the task (`run.requested`, `run.approved`, `run.rejected`,
`run.cancelled`, `run.started`, `run.finished`) and, but for the start, an audit entry
(`devsync.run.requested`, `approved`, `rejected`, `cancelled`, `finished`, the last by the host),
with ids and figures only.
