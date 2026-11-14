# DevSync's requirements

What DevSync does inside OpsCrew's dashboard, as the founder asked for it on 2026-11-14 (planning a
project's work with its people and their coding agents, while OpsCrew deploys it), and the rules
its code keeps. Its contract with the dashboard is [host.md](host.md); where the work stands is
[implementation-status.md](implementation-status.md).

## Stories

### Story 1 - Plan a project's work in DevSync (Priority: P1)

Members of the workspace (a client and their developers) plan the project's work as tasks: a title,
a description and acceptance criteria, a status from Backlog to Done, an assignee among the
workspace's members, comments, and the history of every change to the requirements. A workspace
page shows the work across every project with DevSync on.

**Why this priority**: it is the first thing DevSync gives a client, and works without any agent.

**Independent Test**: on a project with DevSync on, create, edit, move, assign and comment on tasks
as each role, edit one task from two browsers at once, and compare the revision history and the
workspace page with what was done.

**Acceptance Scenarios**:

1. **Given** any member, **When** they create a task, **Then** it starts in Backlog with revision 1
   of its requirements (title, description, acceptance criteria).
2. **Given** a task, **When** a member edits its requirements, **Then** a new revision is kept with
   the previous ones; the task page shows every revision with who made it and when.
3. **Given** two members editing the same task, **When** the second saves after the first, **Then**
   the second is refused with "This task changed. Reload it and try again", and nothing is lost.
4. **Given** a task, **Then** its status moves only along DevSync's lifecycle (Backlog, Ready,
   Claimed, In progress, Blocked, Review, Done, Cancelled, as `lifecycle.ts` defines it), and an
   impossible move is refused in plain English.
5. **Given** a task, **When** a member assigns it, **Then** they pick among the workspace's members;
   a member removed from the workspace is unassigned from every task.
6. **Given** any member, **When** they comment on a task, **Then** the comment appears on the task's
   timeline with their name.
7. **Given** a workspace with DevSync on for several projects, **When** a member opens DevSync in the
   sidebar, **Then** they see the open tasks of every such project, filterable by project, status
   and "assigned to me", each linking to its task.

---

### Story 2 - Coding agents work the tasks through MCP (Priority: P2)

An Owner or Admin registers a coding agent (Claude Code or Codex, on the developer's own computer)
for a project and copies its token once. The agent connects to DevSync's MCP endpoint, reads the
project's tasks and its inbox, claims a Ready task, reports progress or a blocker, asks for review,
and a peer agent approves or requests changes. Members send messages to an agent's inbox and see
every report on the task's timeline.

**Why this priority**: it is what makes DevSync more than a task list, and it carries over every piece of
the standalone version's agent work unchanged in behaviour.

**Independent Test**: register two agents on one project, drive DevSync's MCP tools as each (the
automated MCP tests), then connect Claude Code with the documented configuration and run one
claim-to-review handoff.

**Acceptance Scenarios**:

1. **Given** an Owner or Admin, **When** they register an agent (a name, Claude Code or Codex),
   **Then** its token is shown once, only its hash is kept, and an audit entry records it; rotating
   or revoking it is recorded too, and a revoked or expired token is refused.
2. **Given** an agent's token, **Then** the MCP endpoint lets it act only on its own project, and
   only while DevSync is on for that project and the workspace.
3. **Given** a Ready task, **When** an agent claims it, **Then** the claim holds for DevSync's lease
   (15 minutes, renewable) and another agent can't claim it until it is released or expires.
4. **Given** a claim, **When** the agent reports progress, a blocker or a review request, **Then**
   the report is on the task's timeline, a blocker moves the task to Blocked and a review request to
   Review, and peer agents receive it in their inbox.
5. **Given** a review request, **When** a peer agent approves or requests changes, **Then** the
   decision is on the timeline; changes requested return the task to Ready, and an approval leaves
   completion to a member.
6. **Given** changes to tasks, **Then** the agents of the project receive them in their inboxes
   exactly once, delivered after the change commits and retried until acknowledged (DevSync's
   transactional outbox), with signals' hop and rate limits as DevSync has them.

---

### Story 3 - Tasks linked to the project's pull requests (Priority: P2)

A member links a task to one of the repository's pull requests; the task shows the pull request's
title and state as GitHub reports it, and agents hear about pushes and pull requests opened or
merged on the project's repository.

**Why this priority**: it ties planned work to the code that OpsCrew then deploys, with the GitHub
App and webhooks the dashboard already has.

**Independent Test**: with recorded webhook deliveries for a connected project, check the observed
pull requests, a task's link and its state, and the signals delivered to registered agents.

**Acceptance Scenarios**:

1. **Given** a project with DevSync on, **When** GitHub delivers a pull request or push event for its
   repository, **Then** DevSync records the pull request's number, title and state (open, closed,
   merged), and the project's agents receive branch-updated, pull-request-opened and
   pull-request-merged signals.
2. **Given** a task, **When** a member links it to an observed pull request, **Then** the task shows
   the pull request's title, state and link; a merge doesn't complete the task.
3. **Given** a delivery for a project with DevSync off, **Then** DevSync records nothing.

---

### Story 4 - Managed coding runs in the user's own Actions (Priority: P3)

A member asks for a managed run on a Ready task; an Owner, Admin or Approver approves it; OpsCrew
starts a workflow in the project's own GitHub Actions, which runs Claude Code on the workspace's own
Anthropic key, commits its change to a new branch and opens a draft pull request. The run's state,
its changed files, token use and the draft's link come back to the task.

**Why this priority**: it carries over the standalone version's managed runs in the way OpsCrew
runs everything else: in the user's Actions, holding no AI key and no write token, never opening a
pull request itself.

**Independent Test**: with the fake GitHub, request, approve and complete a run and check the
dispatch, the result's verification and the task's run panel; then one live run on a private test
repository.

**Acceptance Scenarios**:

1. **Given** a Ready task, **When** a member asks for a run, **Then** it waits for approval; an
   Owner, Admin or Approver approves or rejects it, and the requester may cancel it.
2. **Given** an approved run, **Then** OpsCrew dispatches the project's DevSync workflow with the
   run's id and the task's requirements at the approved revision; approving is refused if the
   task's requirements changed since the run was asked for.
3. **Given** a finished run, **Then** its result (succeeded or failed with why, changed files, token
   use, the draft pull request's link) is read through the dashboard's GitHub App from the run
   OpsCrew started in that repository, and from no other, checked, and shown on the task.
4. **Given** a repository without the DevSync workflow or without the `ANTHROPIC_API_KEY` secret,
   **Then** asking for a run says exactly what to add and where, as the checks setup does.

---

## Rules

- **R-0**: DevSync MUST take who is asking (member, role), the workspace, the project and its
  plan state from the host, never from the request.
- **R-1**: DevSync MUST map the dashboard's roles: every role reads and writes tasks,
  comments, assignments, links and messages to agents; Owners and Admins register, rotate and revoke
  agents; Owners, Admins and Approvers decide managed runs.
- **R-2**: DevSync MUST keep its tasks, revisions, comments, agents, signals, outbox, observed
  pull requests and runs in the `devsync` schema, with optimistic concurrency on task edits and every
  requirements change kept as a revision.
- **R-3**: DevSync MUST write its audit entries through the host's audit log (kind `project`,
  actions prefixed `devsync.`), with names and ids only.
- **R-4**: DevSync's MCP endpoint MUST authenticate agents by bearer token (hash stored, 24-hour
  expiry, rotation, revocation) and expose DevSync's current tools with their current behaviour.
- **R-5**: DevSync's outbox MUST be drained by a worker queue started after each commit and on a
  one-minute schedule, delivering each event once per recipient, retrying a failed delivery with a backoff capped at
  10 minutes.
- **R-6**: DevSync's pages MUST use the dashboard's styles, icons, dialogs and empty states, and
  refresh by polling as the dashboard's other pages do.
- **R-7**: DevSync MUST build, typecheck and test in its own repository without the dashboard,
  against a fake host; the dashboard plugs it in at a pinned commit through its deployment's
  configuration.
- **R-8**: DevSync's managed runs MUST run in the project's own GitHub Actions on the workspace's
  own Anthropic key, report back through the run's artifact read by the dashboard's GitHub App
  ([managed-runs.md](managed-runs.md)), and leave opening the draft pull
  request to the user's workflow: OpsCrew holds no AI key and no write token, and opens no pull request itself.
- **R-9**: DevSync MUST run only inside the dashboard: it has no sign-in, projects or pages of its
  own.

## Data (the `devsync` schema)

DevSync's tables hold the host's ids as plain uuids, with no foreign key into the host's tables:
DevSync's repository has no host tables, and the host's removal hooks delete DevSync's rows. Every
table has `workspace_id` and `project_id` (except where noted), and every query filters by them.

| Table | Columns (beyond `id` uuid pk, `workspace_id`, `project_id`, `created_at`) | Keys and indexes |
|---|---|---|
| `task` | `title`, `description`, `acceptance_criteria`, `status` (BACKLOG, READY, CLAIMED, IN_PROGRESS, BLOCKED, REVIEW, DONE, CANCELLED), `revision` int, `version` int, `creator_user_id` uuid?, `creator_agent_id` uuid?, `create_request_id` uuid?, `assignee_user_id` uuid?, `claim_agent_id` uuid?, `claim_id` uuid?, `claim_expires_at`?, `pull_request_number` int?, `updated_at` | (`project_id`, `status`); (`project_id`, `assignee_user_id`); unique (`project_id`, `creator_agent_id`, `create_request_id`) |
| `task_revision` | `task_id` → task cascade, `number`, `title`, `description`, `acceptance_criteria`, `author_user_id`?, `author_agent_id`? | pk (`task_id`, `number`) |
| `task_comment` | `task_id` → task cascade, `author_user_id`, `body` | (`task_id`, `created_at`) |
| `agent` | `name`, `kind` (CLAUDE, CODEX), `token_hash` unique, `expires_at`, `revoked_at`?, `last_seen_at`?, `registered_by_user_id`? | (`project_id`) |
| `signal` | `recipient_agent_id` → agent cascade, `sender_user_id`?, `sender_agent_id`?, `github_delivery_id`?, `reply_to_id`? unique, `hop_count`, `kind`, `payload` jsonb, `idempotency_key` uuid, `acknowledged_at`? | (`project_id`, `recipient_agent_id`, `acknowledged_at`, `created_at`); unique (`recipient_agent_id`, `github_delivery_id`); unique (`project_id`, `sender_user_id`, `idempotency_key`); unique (`project_id`, `sender_agent_id`, `idempotency_key`) |
| `outbox_event` | `actor_user_id`?, `actor_agent_id`?, `task_id`?, `request_id`?, `review_request_id`? → outbox_event unique, `kind`, `payload` jsonb, `available_at`, `processed_at`?, `attempts`. As in legacy, it is also the task's timeline: agents' progress, blocker, review request and review decision reports are outbox events of the task | (`processed_at`, `available_at`); (`project_id`, `task_id`, `created_at`); unique (`project_id`, `actor_agent_id`, `request_id`) |
| `pull_request` | `number`, `title`, `state` (open, closed, merged), `url`, `head_ref`, `head_sha`, `source_updated_at` | unique (`project_id`, `number`) |
| `github_delivery` | `delivery_id` text, `received_at`: a delivery already applied to the project | pk (`delivery_id`, `project_id`) |
| `run` | `task_id` → task cascade, `revision`, `requested_by_user_id`, `decided_by_user_id`?, `status` (REQUESTED, QUEUED, RUNNING, SUCCEEDED, FAILED, REJECTED, CANCELLED), `decided_at`?, `started_at`?, `finished_at`?, `failure`?, `token_usage` jsonb? (the result's `usage` and `models`), `changed_files` jsonb?, `draft_pull_request_url`?, `github_run_id` bigint? | (`project_id`, `created_at`); (`task_id`, `created_at`); unique (`task_id`) where `status` in (REQUESTED, QUEUED, RUNNING); unique (`project_id`, `github_run_id`) |

The legacy tables `User`, `Project`, `ProjectMember`, `AuditLog`, `ProjectRealtime`, `GithubEvent`
(raw payloads) and `GithubRepository` have no successor: the host holds users, projects, roles and
the audit log, and DevSync receives `GithubFact`s rather than payloads. The legacy `AgentRun`'s
`dispatchToken`, `patch` and draft retry columns go with the dedicated workers.
