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
starts a workflow in the project's own GitHub Actions, which runs Claude Code on an Anthropic or
OpenRouter key of the workspace's own (or Codex on an OpenAI key, without either; or Claude Code on
the workspace's AI credits, with no key at all), commits its
change to a new branch and opens a draft pull request. The run's state, its changed files, token
use and the draft's link come back to the task.

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
4. **Given** a repository without the DevSync workflow, **Then** asking for a run says exactly
   what to add and where, as the checks setup does. Without an Anthropic, OpenRouter or OpenAI key
   (the `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` secret), the setup says the
   run pays with the workspace's AI credits.

### Story 5 - Fix a security finding with a task (Priority: P3)

From a security finding on the dashboard, a member opens DevSync with the finding, gets a task
prefilled from it, edits and creates it, and the task then follows DevSync's usual flow
([findings.md](findings.md)).

**Why this priority**: the dashboard finds problems; DevSync is where a project's work is planned and
handed to coding agents, so a finding should become work in one step, without copying text by hand.

**Independent Test**: with the fake host's findings, open the project tab with a finding, create the
task, open it again from the same finding and from a moved one, and check a resolved finding.

**Acceptance Scenarios**:

1. **Given** a finding of a project with DevSync on, **When** a member opens it in DevSync, **Then**
   a new task is offered prefilled from the finding, and creating it links the task to the finding.
2. **Given** a finding already linked to a task, or one with the same rule and file as an open
   linked task, **When** a member opens it in DevSync, **Then** that task opens and no new one is
   offered.
3. **Given** a resolved finding or another project's, **Then** DevSync says so and offers nothing.

---

### Story 6 - Agents share a project's work without getting in each other's way (Priority: P2)

Members and agents give a task the paths it may change, the tasks it waits for, labels and a
branch. DevSync flags two open tasks whose paths overlap, keeps a task from being claimed while a
task it waits for is open, lets an agent hold at most 3 claimed tasks at once, and adds up the
tokens and cost agents report beside what the task's managed runs used.

**Why this priority**: several agents on one repository need to know which tasks touch the same
files and which must wait for another, and a task's cost should count every agent's work, not only
its managed runs.

**Independent Test**: with the fake host, give two tasks overlapping paths and a third a task to
wait for, claim as one agent until it is refused, report usage with a progress report and a review
request, and compare the task panels with what was done.

**Acceptance Scenarios**:

1. **Given** a task, **When** a member sets its paths, the tasks it waits for, its labels or its
   branch on the task's panel (or an agent on a task it created), **Then** they are kept as given,
   no new requirements revision is kept, and an invalid one is refused by its field's name.
2. **Given** two open tasks whose paths overlap (the same path, or one inside the other's folder,
   a path ending in `/`), **Then** each task's panel lists the other with the paths they share;
   once one of them is Done or Cancelled, neither is flagged.
3. **Given** a task that waits for one neither Done nor Cancelled, **When** an agent claims it,
   **Then** it is refused with "This task waits for task "<title>". Claim it once that is done."; a
   task of another project, an unknown one, the task itself or a circle is refused when it is set.
4. **Given** an agent holding 3 live claims, **When** it claims another task or takes over an
   expired claim, **Then** it is refused with "You hold 3 claimed tasks. Release, finish or report a
   blocker on one before claiming another."
5. **Given** an agent's progress reports and review request with their usage, **Then** the task
   shows the sum of its agents' reported tokens and cost, as their own estimate, beside the sum of
   its managed runs'.

---

### Story 7 - Agents ask instead of guessing, and read a briefing first (Priority: P2)

An agent unsure of a task asks a question on it instead of guessing; with `wait`, it stops and the
task waits in Blocked for the answer. A member answers on the task's panel, or a peer agent through
MCP, and the asker hears of it. Before starting, an agent reads the task's briefing: the task, its
questions, its paths, what it waits for, the tasks sharing its paths, and the context the host gives
for its title, in one answer of a bounded size.

**Why this priority**: an agent that guesses at unclear requirements wastes a run and a review; a
question, answered where the task is planned, keeps the answer with the task for the next agent.

**Independent Test**: with the fake host, ask a question as an agent holding a task's claim with
`wait`, answer it as a member, check the signals, the task's status and its panel, and read the
briefing as an agent, a member and a managed run with a long context.

**Acceptance Scenarios**:

1. **Given** an open task, **When** an agent asks a question (or a member on the task's panel),
   **Then** it is on the task, open, with who asked and when, and on its timeline; the task's
   creator, when it is another agent, receives a `clarification.requested` signal. A Done or
   Cancelled task is refused.
2. **Given** an agent holding a task's claim, **When** it asks with `wait`, **Then** its claim ends
   and the task moves to Blocked; without the claim, `wait` is refused.
3. **Given** an open question, **When** a member answers it on the panel, or a peer agent with
   `answer_question`, **Then** it is answered once, with who answered and when; the asker, when an
   agent, receives a `clarification.answered` signal; an agent can't answer its own question.
4. **Given** a task a question's `wait` moved to Blocked, **When** every question asked on it with
   `wait` is answered, **Then** it returns to Ready; a task blocked by a blocker report or a
   member's move stays Blocked.
5. **Given** a task, **When** a member, an agent or a managed run reads its briefing, **Then** it
   has the task, its open and answered questions, its paths, the tasks it waits for with their
   statuses, its overlaps and the host's context for its title (none for a run), within 8,000
   characters of JSON: the context cut first, then the oldest answered questions, the task kept
   whole.

---

## Rules

- **R-0**: DevSync MUST take who is asking (member, role), the workspace, the project and its
  plan state from the host, never from the request.
- **R-1**: DevSync MUST map the dashboard's roles: every role reads and writes tasks,
  comments, assignments, links and messages to agents; Owners and Admins register, rotate and revoke
  agents; Owners, Admins and Approvers decide managed runs.
- **R-2**: DevSync MUST keep its tasks, revisions, the tasks each waits for, comments, questions,
  agents, signals, outbox, observed pull requests and runs in the `devsync` schema, with optimistic
  concurrency on task edits and every requirements change kept as a revision.
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
- **R-8**: DevSync's managed runs MUST run in the project's own GitHub Actions on an Anthropic,
  OpenRouter or OpenAI key of the workspace's own (Claude Code on the first two, in that order,
  else Codex on the OpenAI key: [managed-runs.md](managed-runs.md), D5 and D6), or with no key on
  the workspace's AI credits through the dashboard's gateway (platform.md, P5), report back
  through the run's artifact read by the dashboard's GitHub App, and leave opening the draft pull
  request to the user's workflow: OpsCrew holds none of the workspace's keys and no write token,
  and opens no pull request itself.
- **R-9**: DevSync MUST run only inside the dashboard: it has no sign-in, projects or pages of its
  own.
- **R-10**: A task made from a security finding MUST come from the finding as the dashboard gives it
  (`host.finding`: redacted, without the match itself), read again by the server when the task is
  created, and MUST NOT be duplicated for the same finding ([findings.md](findings.md)).
- **R-11**: A task's paths, the tasks it waits for, its labels and branch MUST NOT be part of its
  requirements revision. The tasks it waits for MUST be the project's, never the task itself and
  never in a circle, checked when they are written under a lock on the project's dependencies; an
  agent's paths, labels and branch MUST pass the host's redactor and still be valid after it.
- **R-12**: An agent MUST NOT claim a task while a task it waits for is open (neither Done nor
  Cancelled), nor hold more than 3 live claims at once, a takeover of an expired claim counting as
  a claim; an agent's claims MUST be made one at a time.
- **R-13**: The usage an agent reports with a progress report or a review request MUST be kept with
  that report, apart from the payload its peers receive, and shown apart from the task's managed
  runs' usage, as the agents' own estimate.
- **R-14**: A question MUST be asked only on an open task, answered once and never by the agent
  that asked it, and an agent's text and answer MUST pass the host's redactor. Only the agent
  holding the task's live claim MAY make it wait; the task MUST return to Ready only when a
  question's wait blocked it and none of its questions asked with `wait` is open. An agent's
  question and answer signals MUST count against its 20 signals a minute.
- **R-15**: A briefing MUST NOT pass 8,000 characters of JSON unless its task, open questions,
  paths, waits and overlaps alone do, cutting the context first and then the oldest answered
  questions, and saying how many of each it cut. It MUST ask the host's context as the caller (a
  member or an agent), never for a managed run, and pass on only the contract's fields of a context
  that parses.

## Data (the `devsync` schema)

DevSync's tables hold the host's ids as plain uuids, with no foreign key into the host's tables:
DevSync's repository has no host tables, and the host's removal hooks delete DevSync's rows. Every
table has `workspace_id` and `project_id` (except where noted), and every query filters by them.

| Table | Columns (beyond `id` uuid pk, `workspace_id`, `project_id`, `created_at`) | Keys and indexes |
|---|---|---|
| `task` | `title`, `description`, `acceptance_criteria`, `status` (BACKLOG, READY, CLAIMED, IN_PROGRESS, BLOCKED, REVIEW, DONE, CANCELLED), `revision` int, `version` int, `creator_user_id` uuid?, `creator_agent_id` uuid?, `create_request_id` uuid?, `assignee_user_id` uuid?, `claim_agent_id` uuid?, `claim_id` uuid?, `claim_expires_at`?, `pull_request_number` int?, `finding_fingerprint`?, `finding_rule`?, `finding_file`? (the security finding it was made from, as the host gave it), `owns` text[] and `labels` text[] (empty by default), `branch`?, `blocked_by_question` bool (a question's `wait` moved it to Blocked; cleared when it leaves Blocked), `updated_at` | (`project_id`, `status`); (`project_id`, `assignee_user_id`); unique (`project_id`, `creator_agent_id`, `create_request_id`) |
| `task_dependency` | (no `id` or `created_at`) `task_id` → task cascade, `depends_on_task_id` → task cascade (a task it waits for, of the same project), `position` int (its order, from 0) | pk (`task_id`, `depends_on_task_id`); (`depends_on_task_id`) |
| `question` | `task_id` → task cascade, `asker_user_id`?, `asker_agent_id`?, `request_id` uuid? (an agent's), `text`, `wait` bool, `answer`?, `answerer_user_id`?, `answerer_agent_id`?, `answered_at`? | (`task_id`, `created_at`); unique (`project_id`, `asker_agent_id`, `request_id`) |
| `task_revision` | `task_id` → task cascade, `number`, `title`, `description`, `acceptance_criteria`, `author_user_id`?, `author_agent_id`? | pk (`task_id`, `number`) |
| `task_comment` | `task_id` → task cascade, `author_user_id`, `body` | (`task_id`, `created_at`) |
| `agent` | `name`, `kind` (CLAUDE, CODEX), `token_hash` unique, `expires_at`, `revoked_at`?, `last_seen_at`?, `registered_by_user_id`? | (`project_id`) |
| `signal` | `recipient_agent_id` → agent cascade, `sender_user_id`?, `sender_agent_id`?, `github_delivery_id`?, `reply_to_id`? unique, `hop_count`, `kind`, `payload` jsonb, `idempotency_key` uuid, `acknowledged_at`? | (`project_id`, `recipient_agent_id`, `acknowledged_at`, `created_at`); unique (`recipient_agent_id`, `github_delivery_id`); unique (`project_id`, `sender_user_id`, `idempotency_key`); unique (`project_id`, `sender_agent_id`, `idempotency_key`) |
| `outbox_event` | `actor_user_id`?, `actor_agent_id`?, `task_id`?, `request_id`?, `review_request_id`? → outbox_event unique, `kind`, `payload` jsonb, `usage` jsonb? (the usage an agent reported with a progress report or a review request, never delivered to peers), `available_at`, `processed_at`?, `attempts`. It is also the task's timeline: agents' progress, blocker, review request and review decision reports are outbox events of the task | (`processed_at`, `available_at`); (`project_id`, `task_id`, `created_at`); unique (`project_id`, `actor_agent_id`, `request_id`) |
| `pull_request` | `number`, `title`, `state` (open, closed, merged), `url`, `head_ref`, `head_sha`, `source_updated_at` | unique (`project_id`, `number`) |
| `github_delivery` | `delivery_id` text, `received_at`: a delivery already applied to the project | pk (`delivery_id`, `project_id`) |
| `run` | `task_id` → task cascade, `revision`, `requested_by_user_id`, `decided_by_user_id`?, `status` (REQUESTED, QUEUED, RUNNING, SUCCEEDED, FAILED, REJECTED, CANCELLED), `decided_at`?, `started_at`?, `finished_at`?, `failure`?, `token_usage` jsonb? (the result's `usage` and `models`), `changed_files` jsonb?, `draft_pull_request_url`?, `github_run_id` bigint? | (`project_id`, `created_at`); (`task_id`, `created_at`); unique (`task_id`) where `status` in (REQUESTED, QUEUED, RUNNING); unique (`project_id`, `github_run_id`) |

The standalone version's tables `User`, `Project`, `ProjectMember`, `AuditLog`, `ProjectRealtime`, `GithubEvent`
(raw payloads) and `GithubRepository` have no successor: the host holds users, projects, roles and
the audit log, and DevSync receives `GithubFact`s rather than payloads. Its `AgentRun`'s
`dispatchToken`, `patch` and draft retry columns go with the dedicated workers.
