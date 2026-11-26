# DevSync — Security Audit & Penetration Test

| | |
|---|---|
| **Target** | OpsCrew **DevSync** module — `github.com/opscrew-hub/devsync` |
| **Commit audited** | `48ab6f595cf5f6da0de72b6fa11710017b49c866` (`main`, 2026-11-26 14:33 +0100) |
| **Source** | The tree at this commit, verified against upstream `main` |
| **Audit date** | 2026-11-26 |
| **Type** | Grey-box source-assisted web application / API security audit, with targeted dynamic verification |
| **Stack** | TypeScript strict ESM monorepo (pnpm 10.29.1): Hono 4.13.18, Drizzle ORM 0.45.4, zod 4.6.7, `@modelcontextprotocol/server` 2.4.0, React 19.3.1, PostgreSQL (`devsync` schema), Vitest 5.1.0 + PGlite |
| **Code reviewed** | 59 first-party production files / 11,044 LOC, 43 test files / 14,448 LOC, 8 SQL migrations, CI, and the shipped GitHub Actions workflow |
| **Result** | **0 Critical, 0 High, 3 Medium, 6 Low, 4 Informational** (13 findings). No authentication bypass, cross-tenant access, SQL injection, XSS, or command injection found. |
| **Status** | P7 (`e5775fa`) later fixed F-01, F-02, F-07 and F-10, and partly fixed F-03 - see "Status after P7" |

---

## 1. Executive summary

DevSync is a module that runs inside OpsCrew's dashboard. It stores a project's tasks, drives
coding agents over MCP, and starts managed AI runs in the customer's own GitHub Actions. The
security posture is **strong and noticeably above average** for a codebase of this size:

- authorization is centralized in one `can()` table, then re-checked in the domain (defense in
  depth), and every storage query is scoped to a project and workspace;
- every input and every output is parsed with strict zod schemas;
- agent tokens are random 256-bit values, stored only as SHA-256 hashes, verified by the host on
  every request, and never written to logs, audit entries, exports, or API answers;
- the public MCP endpoint is separated from session-authenticated routes, checks `Origin`, answers
  `401` with `WWW-Authenticate`, and marks every answer `no-store`;
- all SQL is parameterized through Drizzle; the few raw `sql` fragments are static or
  parameterized, never built from request data;
- the shipped workflow is a careful least-privilege design (no key in the publishing job, a secret
  backstop before publish, OIDC isolation, a Codex sandbox `/proc` check, explicit prompt-injection
  framing);
- the repository's CI pins actions by commit SHA, runs with `contents: read`, and disables
  persisted git credentials.

No Critical or High findings were identified. The material risks are concentrated in the
**agent/run trust boundary** — the least-trusted principal (a managed run, which reads
attacker-controllable repository content) has broader read access than it needs, runs are not
bound by the task-dependency invariant that binds agent claims, and per-task data can grow without
bound. Most of these are already acknowledged as pending work in the project's own documents
(`docs/managed-runs.md` "What remains", `docs/platform.md` P7); this audit independently confirms
them and adds new findings around read-only enforcement, post-completion task integrity, audit
coverage, and workflow supply chain.

If the workspaces hold client-confidential plans, **F-01 should be treated as High** and fixed
before the first live project.

---

## Status after P7 (updated 2026-11-26)

The audit was performed at `48ab6f5`. Before this report was published, `main` received the P7
change (`fa64889`, `d8c33be`, `e5775fa`). Re-checked against `e5775fa`:

| Finding | Status on `e5775fa` |
|---|---|
| F-01 - a run reads every task | **Fixed**: `reader()` refuses a run, and `taskReader()` binds it to its own task through `runTaskId()` |
| F-02 - runs ignore dependencies | **Fixed**: `openDependency()` is checked in `requestable()` and `decideRun()`; `dispatchRun()` still does not re-check |
| F-07 - result paths and models unredacted | **Fixed**: `recordEnd()` passes `changedFiles` and `models` through `host.redact` |
| F-10 - future caller kinds read the project | **Fixed**: `reader()` refuses any caller that is not a member or an agent |
| F-03 - unbounded growth | **Partly fixed**: at most 50 open questions per task and 50 answered in its detail; revisions, comments, task lists, overlaps and retention remain unbounded |
| F-04, F-05, F-06, F-08, F-09, F-11, F-12, F-13 | **Unchanged** at `e5775fa` |

Issues #74, #75 and #80 are closed as fixed; #76 and #83 stay open for the remainder. The
proof-of-gap tests in `docs/audit/security-audit.test.ts` assert the `48ab6f5` behaviour, so those
for the fixed findings now fail by design.

---
## 2. Scope, method and limitations

### 2.1 In scope

- `packages/schemas` — validation, lifecycle, permissions, MCP tool inputs, run-result checks.
- `packages/server` — host contract, SQL schema and migrations, domain, HTTP routes, public MCP
  endpoint, queues, outbox, removal, export.
- `packages/web` — React pages, API client, link handling.
- `.github/workflows/ci.yml` and the workflow template shipped to customers
  (`packages/schemas/src/workflow.ts`).
- The git history of the upstream repository (secret scan).

### 2.2 Out of scope / not verifiable from this repository

- OpsCrew dashboard implementation: session handling, CSRF, body limits, the guard that builds
  `ProjectContext` / `WorkspaceContext`, `/mcp` caller construction, the GitHub App, OIDC credential
  issuance, the server-side redactor, database roles and network isolation.
- Live deployment, TLS, reverse proxy, WAF, hosting, and billing enforcement of the plan/read-only
  state.
- Denial-of-service at network scale, social engineering, and physical security.

The host is modelled as a **trusted** component that enforces the contract in `docs/host.md`. Where
a finding depends on a host behaviour, the dependency is stated explicitly.

### 2.3 Method

1. Read the requirements, host contract and threat-model documents, then every production file.
2. Mapped entry points, identities, tenant context, and storage access; built an attack tree per
   trust boundary.
3. Grep-driven checks for injection sinks, unsafe HTML, secret-shaped strings, dynamic SQL, and
   missing auth middleware.
4. Wrote six targeted tests against PGlite + the in-repo fake host to confirm or refute suspected
   weaknesses (Appendix A). The tests assert the *current* behaviour and pass, documenting it.
5. Ran `pnpm audit`, a working-tree and full-history secret scan, and compared the snapshot with
   upstream `main`.
6. Ran the project's quality gates (lint, typecheck, package test suites).

### 2.4 Limitations

- Time-boxed review; no fuzzing or long-running concurrency stress.
- The project's own suite could not be run through `pnpm check` in this environment because
  Vitest's default `forks` pool needs to spawn child processes, which the sandbox denies
  (`spawn EPERM`). Each package was run with `--pool=threads --no-file-parallelism` instead.
- Findings that require the host to misbehave are rated as defense-in-depth, not as exploitable.

---

## 3. Architecture and trust boundaries

```
 Member browser ──session cookie──▶ Host guard ──▶ /api/w/:ws/projects/:pid/m/devsync ─┐
                                   │             /api/w/:ws/m/devsync ─────────────────┤
                                   │                                                   ▼
 Coding agent ──Bearer token──▶ /m/devsync/mcp ──▶ authenticateAgent ──▶ actions ──▶ domain ──▶ Drizzle ──▶ PostgreSQL
                                   ▲                                                   ▲
 OpsCrew /mcp (member/agent/run) ──┘ host-built Caller ───────────────────────────────┘
 GitHub webhook ──host queue──▶ devsync.github ────────────────────────────────────────┘
 Cron ──▶ devsync.outbox / devsync.runs / devsync.agents-move ────────────────────────┘
```

Identities and their trust level:

| Principal | Authenticated by | Trust | Notes |
|---|---|---|---|
| Member | Host session | Trusted for their role | Role comes from the host, never the request |
| Coding agent | Bearer token, host-verified | Semi-trusted | Acts only in its own project; may be prompt-injected by repo content it reads |
| Managed run | Host-issued run token (`kind: "run"`) | Least trusted | Processes untrusted repository content; read-only in DevSync |
| Host / queues | In-process contract | Trusted | Payloads still schema-checked |
| GitHub facts | Host → `devsync.github` | Trusted-but-validated | `GithubJob` parsed with zod |

The tenant boundary is (workspace, project). DevSync stores both on every row and filters every
query by both — with a few low-risk exceptions noted in F-12.

---

## 4. Findings

### 4.1 Summary

| ID | Severity | CVSS 3.1¹ | Finding | Status vs. project docs |
|---|---|---|---|---|
| **F-01** | **Medium** | 6.1 `AV:N/AC:H/PR:L/UI:N/S:C/C:H/I:N/A:N` | A managed run's token can read **every task** in the project | Acknowledged as residual (`managed-runs.md`, P7) |
| **F-02** | **Medium** | 5.4 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:L` | Managed runs ignore task dependencies (claims enforce them) | Acknowledged as pending (P7) |
| **F-03** | **Medium** | 6.8 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H` | Unbounded per-task data growth and unpaginated reads → storage/memory exhaustion | Partly acknowledged (P7: cap on open questions) |
| **F-04** | **Low** | 4.6 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | Member can message agents on a read-only (past-plan) project; DevSync skips its own read-only check | New |
| **F-05** | **Low** | 4.6 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | Requirements of a Done/Cancelled task can still be rewritten | New |
| **F-06** | **Low** | 4.6 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | Audit coverage limited to runs and PR links: task lifecycle is not audited | New |
| **F-07** | **Low** | 3.2 `AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N` | A run's `changedFiles` and `models` are stored and shown without `host.redact` | Acknowledged as pending (P7) |
| **F-08** | **Low** | 4.7 `AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N` | Shipped workflow pins GitHub Actions by mutable tag and installs CLIs by npm version only | New |
| **F-09** | **Low** | 3.7 `AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L` | Public MCP endpoint has no local rate or body limit before authentication | New |
| **F-10** | Info | — | Any future `Caller.kind` is silently treated as a read-only run | New |
| **F-11** | Info | — | Host verification clears DevSync's `revoked_at` (revoke resurrection) | Intentional (comment) |
| **F-12** | Info | — | A few queries scope by `project_id` only, not `workspace_id` | New |
| **F-13** | Info | — | Enum/state integrity is application-enforced only (no DB `CHECK` constraints) | New |

¹ Analyst-assigned CVSS 3.1 base vectors; they describe the code as written, assuming the host
enforces its documented contract. They are prioritization aids, not formal certifications.

---

### F-01 — A managed run's token can read every task in the project

**Severity: Medium (6.1)** · Component: `packages/server/src/actions.ts` · CWE-269 / CWE-200

**Status:** the project documents this as a known residual risk
(`docs/managed-runs.md`, "What remains") and plans to narrow it (`docs/platform.md`, P7).

#### Description

`reader()` maps a caller to `{ project }` for anything that is not a member or an agent:

```ts
// packages/server/src/actions.ts:100-105
async function reader(ctx: DevSyncActionContext): Promise<TaskReader> {
  const { caller, project, host } = ctx;
  if (caller.kind === "agent") return callerActor(host, project, caller);
  return memberOf(ctx) ?? { project };      // ← a run gets the whole project
}
```

The four read actions then answer project-wide data to a run token:

- `get_project_state` — the project, its agents, and the 100 most recently updated tasks **with
  description and acceptance criteria** (`domain/signals.ts:289-313`);
- `list_tasks` — every task of the project, unpaginated;
- `get_task` — any task's full detail: revisions, comments, questions, timeline, pull request,
  dependencies, overlaps, usage;
- `get_briefing` — the full briefing of any task.

A managed run is the **least-trusted** principal in the system: its agent reads files from the
repository's default branch, which may contain attacker-controlled instructions (the workflow
itself warns the model that repository files are untrusted). A prompt injection can therefore make
the run call `devsync_get_task` for unrelated tasks and copy the content into the change. The
workflow's secret backstop only looks for the **keys and tokens**, not for project data
(`docs/managed-runs.md`, "What remains"), and `publish` pushes the branch and opens the draft pull
request **before any human reviews it** — in a public repository, that data is public immediately.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/actions.ts:100-105` | Run caller → `{ project }` reader |
| `packages/server/src/actions.ts:169-197` | All four read actions accept that reader |
| `packages/server/src/domain/signals.ts:289-313` | `agentProjectState` selects by project, 100 tasks, includes description/AC |
| `packages/server/src/domain/tasks.ts:330-346` | `listTasks` has no limit |
| `docs/managed-runs.md` § "What remains" | The project accepts this today |

#### Preconditions

A managed run must be approved (Owner/Admin/Approver) on a project whose default branch contains
injected content, and the run must receive an MCP token (`host.ai.allowRun` returns non-null). No
special agent capability beyond the run's own token is required.

#### Impact

Confidentiality of the project's entire planning record (titles, descriptions, acceptance criteria,
comments, questions, usage/cost) to a process that is designed to follow untrusted text. Data can
leave through the draft pull request, whose contents are published before review.

#### Remediation

1. Pass the run identity into the read path (`caller.runRef`) and bind it to `run.taskId`: a run may
   read only its own task (and its briefing), not the project state or other tasks.
2. Until that ships: do not issue project-scoped read tokens to runs; return a minimal
   `get_task`-for-own-task surface, and have the host's `/mcp` enforce the same scope server-side
   (defense in depth, not only in DevSync).
3. Reduce the value of exfiltration: restrict managed runs to private repositories, or require an
   explicit opt-in before issuing a project-scoped token to a run.

#### Verification

Copy `docs/audit/security-audit.test.ts` into `packages/server/src/`, run it, and observe
`GAP 1` pass: a `kind: "run"` caller receives tasks it is not running. After the fix, that test
must fail (the action should answer only the run's own task).

---

### F-02 — Managed runs ignore task dependencies

**Severity: Medium (5.4)** · Component: `packages/server/src/domain/runs.ts` · CWE-863 / CWE-841

**Status:** acknowledged as pending in `docs/platform.md` P7 ("a run asked for only once its task's
dependencies are done").

#### Description

Agent claims enforce the dependency invariant:

```ts
// packages/server/src/domain/claims.ts:81-111
async function requireClaimable(tx, actor, taskId, now) {
  const [waiting] = await tx.select(...).from(taskDependency)...
    .where(and(eq(taskDependency.taskId, taskId), notInArray(task.status, ["DONE","CANCELLED"])));
  if (waiting) throw new DevSyncError("conflict", `This task waits for task "${waiting.title}"...`);
```

Managed runs do not:

```ts
// packages/server/src/domain/runs.ts:241-266
async function requestable(db, project, taskId, lock) {
  ... if (current.status !== "READY") throw ...;
  if (taskInput(current).length > TASK_INPUT_LIMIT) throw ...;
  const [unended] = await db.select(...).from(run)...;   // only "no run that hasn't ended"
```

`decideRun` re-checks only status and revision (`runs.ts:528-540`), and `dispatchRun` does not check
dependencies either. A dependency that is still open (neither Done nor Cancelled) therefore does not
prevent asking for, approving, or starting a run.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/domain/runs.ts:241-266` | `requestable` checks status, size, unended run — no `task_dependency` |
| `packages/server/src/domain/runs.ts:518-540` | `decideRun` checks `READY` + `revision` only |
| `packages/server/src/domain/runs.ts:665-740` | `dispatchRun` re-reads the run/revision, not dependencies |
| `packages/server/src/domain/claims.ts:81-118` | The invariant that *is* enforced for claims |

#### Preconditions

A member with `run.request` asks for a run on a `READY` task whose dependency is still open; an
Owner/Admin/Approver approves it. Both actions are legitimate UI operations.

#### Impact

Work starts on a task whose prerequisite is unfinished: the agent codes against an interface that
does not exist yet, produces a draft PR that must be redone, burns AI credits/keys, and can create
conflicting changes with the dependency's own task. It undermines the project's core scheduling
invariant and is a direct business-logic bypass.

#### Remediation

Add the same `notInArray(task.status, ["DONE","CANCELLED"])` dependency check to
`requestable()` (both callers) and re-check it inside `decideRun`'s transaction (and optionally at
dispatch, failing the run with a new `dependency-open` failure code). Reuse the exact message from
`requireClaimable` so the UI can explain it.

#### Verification

`GAP 2` in `docs/audit/security-audit.test.ts`: a claim of the task is refused with "This task waits for
task …", while `requestRun` succeeds and returns `REQUESTED`. After the fix, `requestRun` must reject
with the same refusal.

---

### F-03 — Unbounded per-task data growth and unpaginated reads

**Severity: Medium (6.8)** · Components: `domain/questions.ts`, `domain/tasks.ts`,
`domain/briefing.ts`, `domain/delivery.ts` · CWE-770 / CWE-400

**Status:** partly acknowledged (`docs/platform.md` P7: "a cap on a task's open questions").

#### Description

The only write-rate limit is **20 signals/questions/answers per agent per minute**
(`domain/common.ts:188-243`). It bounds a *rate*, not a *total*. Everything else has no cap:

- **Questions** are inserted per call (`domain/questions.ts:264-277`); 20/min sustained is
  ~28,800/day, ~115 MB/day at the 4 KB maximum, per agent, per project.
- **Requirements revisions**: `update_task`/`PATCH` creates a row in `task_revision` on every
  requirements change (`domain/tasks.ts:1018-1056`) and an outbox event, with **no rate limit and no
  per-task cap**. A loop of 16 KB edits can add tens of GB per day.
- **Comments** (`POST /tasks/:id/comments`) have no cap.
- **Outbox events, signals and questions are never deleted** — `deliverDue` only sets
  `processed_at` (`domain/delivery.ts:66`), so delivered rows are retained forever.
- **Reads are unpaginated**: `getTask` returns *all* revisions, comments, questions, overlaps and
  100 timeline events (`domain/tasks.ts:547-581`); `listTasks` returns every task
  (`domain/tasks.ts:330-346`); `overlapsOf` returns every overlapping open task
  (`domain/tasks.ts:435-458`).
- `getBriefing` cuts only context and questions; **`overlaps` is never cut**
  (`domain/briefing.ts:96-129`), so a briefing can exceed its 8,000-character budget by design when
  many open tasks share a path.
- `refuseCircle` loads every dependency edge of the project on each dependency edit
  (`domain/tasks.ts:698-724`) — O(E) per write.

Agents are semi-trusted but **read untrusted repository content**; a prompt-injected agent can
create a task and then loop `update_task` on it (it may edit tasks it created), or loop
`ask_question` across minutes. A member account can do the same. The first visible effect is a task
panel that cannot be loaded (the server builds one giant JSON answer) and a database that only
grows.

#### Evidence

| Location | What it shows |
|---|---|
| `domain/questions.ts:264-277` | Unlimited questions per task |
| `domain/common.ts:188-243` | Per-minute limit only |
| `domain/tasks.ts:1018-1056` | One revision + one event per edit, no cap |
| `domain/tasks.ts:547-581` | `getTask` reads all children, no limit |
| `domain/tasks.ts:330-346` | `listTasks` unpaginated |
| `domain/tasks.ts:435-458` | `overlaps` unbounded |
| `domain/briefing.ts:96-129` | `overlaps` never cut |
| `domain/delivery.ts:66` | Delivered events retained forever |

#### Preconditions

Any valid agent token for the project, or any member with `task.write` (all four roles).

#### Impact

Availability and cost: database storage growth with no retention, pathological response sizes,
memory pressure on the dashboard/server, and denial of service for the project's UI and MCP tools.
No confidentiality or integrity impact on other tenants.

#### Remediation

1. Per-task caps: open questions (e.g. 20), revisions retained/returned (e.g. latest 100 with
   pagination), comments (pagination), overlaps (e.g. 20 with a count).
2. Paginate `GET /tasks` and `list_tasks` (`limit`/`cursor`), and `get_task` children.
3. Add write rate limits for `create_task`/`update_task` per agent and per member.
4. Retention: delete or archive processed outbox events, acknowledged signals and answered questions
   after N days; add a queue or cron for it.
5. Cap `overlaps` inside the briefing budget, and count it in `omitted`.

#### Verification

`GAP 3` in `docs/audit/security-audit.test.ts`: 40 open questions are kept across two clock minutes and
all returned by `getTask`. A cap should refuse the 21st question with a plain-English `409`.

---

### F-04 — Member can message agents on a read-only project

**Severity: Low (4.6)** · Component: `packages/server/src/domain/signals.ts` · CWE-863

#### Description

Every member write path calls `requireWritable(project)` before touching data — `createTask`,
`updateTask`, `commentOnTask`, `linkPullRequest`, `askQuestion`, `answerQuestion`, `requestRun`,
`decideRun`, `cancelRun`. The one exception is `publishSignal` (the member→agent message route), which
checks only the role:

```ts
// packages/server/src/domain/signals.ts:84-105
export async function publishSignal(host, ctx, agentId, input) {
  if (!can(ctx.member.role, "task.write")) throw ...;
  const fields = parse(AgentMessage, input);
  ...
  // no requireWritable / requireWrite
```

The host is documented to refuse members' non-GET requests to a read-only (past-plan) project
before DevSync's routes run, so this is **defense in depth**, not a live bypass under the contract.
It becomes a real bypass if the host's plan check is ever widened, misconfigured, or bypassed (e.g.
a new route or an internal caller that sets `readOnly: true` but does not guard the method).

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/domain/signals.ts:84-140` | No `requireWritable` |
| `packages/server/src/domain/common.ts:88-91` | The check every other write uses |
| `packages/server/src/domain/tasks.ts:226-230` | `requireWrite` pattern |

#### Preconditions

A member of the workspace, and a host that does not block the message (or a future caller that
reaches the domain directly).

#### Impact

Low: unsolicited messages/notifications to the project's agents on a project the workspace is not
paying for; potential agent actions triggered by a member whose workspace is read-only.

#### Remediation

One line: `requireWritable(ctx.project)` (or `requireWrite(ctx)`) at the top of `publishSignal`,
matching every other member write. Add a route test for a read-only project.

#### Verification

`GAP 4` in `docs/audit/security-audit.test.ts`: `publishSignal` succeeds on a `readOnly: true` project
while `createTask` is refused.

---

### F-05 — Requirements of a Done/Cancelled task remain editable

**Severity: Low (4.6)** · Component: `packages/server/src/domain/tasks.ts` · CWE-778 / CWE-696

#### Description

`updateTask` guards **status** moves with `TRANSITIONS` (`tasks.ts:1004-1006`) but never checks
whether the task is already final before accepting a requirements change. A member (or the agent
that created the task) can rewrite `title`, `description` and `acceptanceCriteria` of a `DONE` or
`CANCELLED` task, creating a new revision and bumping the version, while the status stays Done:

```ts
// tasks.ts:1008-1036 — no CLOSED check before the update
const fields = { title: update.title ?? current.title, ... };
const revised = fields.title !== current.title || ...;
const [saved] = await tx.update(task).set({ ...fields, revision: revised ? current.revision + 1 : ... })
```

The `CLOSED` constant already exists in this file (`tasks.ts:164-165`) but is used only by
`overlapsOf`; `questions.ts` has its own copy for the question rules.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/domain/tasks.ts:948-1006` | Version, claim and status checks; no final-state check |
| `packages/server/src/domain/tasks.ts:164-165` | `CLOSED` defined |
| `packages/server/src/domain/tasks.ts:1018-1056` | Revision and event written regardless of status |

#### Preconditions

A member with `task.write`, or the agent that created the task (agents edit only their own tasks).

#### Impact

The reviewed record can be altered after delivery so that the description "matches" what was
actually built, or so that a cancelled task looks like different work. History is preserved in
`task_revision`, so this is a record-integrity/review-assurance weakness rather than evidence loss;
combined with F-06 (no audit), the change is also not visible in the audit log.

#### Remediation

Refuse a requirements change when `current.status` is `DONE`/`CANCELLED` with a `409` telling the
user to reopen the task (or to create a follow-up). If a controlled post-hoc edit is required, add an
explicit "amend" action that is audited and marked on the timeline. Cover both `PATCH` and
`update_task`.

#### Verification

`GAP 6` in `docs/audit/security-audit.test.ts`: a `CANCELLED` task accepts a new description and reports
`revision: 2` with the new revision first. After the fix it must be refused.

---

### F-06 — Audit coverage is limited to runs and PR links

**Severity: Low (4.6)** · Components: `domain/tasks.ts`, `domain/runs.ts` · CWE-778

#### Description

`host.audit` is called from exactly two places:

- `runs.ts:298-315` — `devsync.run.requested|approved|rejected|cancelled|finished`;
- `tasks.ts:1185-1190` — `devsync.task.pull_request_linked`.

Task creation, requirements edits, status moves (including **Done** and **Cancelled**), assignment,
comments, questions and answers, agent claims, releases, progress/blocker reports, review requests
and review decisions are **not** written to the host's audit log. They exist only as outbox events on
the task's timeline — which are not the audit log, are not exposed as one, and have no retention
policy of their own (F-03).

Requirements R-3 (`docs/requirements.md:241-242`) requires DevSync to write its audit entries
through the host's audit log, with names and ids only; it does not enumerate the events. For a
product sold around secure delivery and compliance, "who marked this task Done", "who rewrote the
requirements after review", and "which agent approved this" are exactly the questions an audit log
must answer.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/domain/runs.ts:298-315` | Only run audit entries |
| `packages/server/src/domain/tasks.ts:1185-1190` | Only PR-link audit entry |
| `packages/server/src/domain/outbox.ts:100-153` | Host events carry ids only; not an audit log |
| `docs/requirements.md:241-242` | R-3 |

#### Impact

Repudiation: sensitive lifecycle changes cannot be attributed after the fact through OpsCrew's audit
log; incident response and customer compliance queries are weakened.

#### Remediation

Add `host.audit(tx, actor, …)` inside the existing transactions for: `task.created`,
`task.requirements_changed`, `task.moved` (with `from`/`to`, especially `DONE`/`CANCELLED`),
`task.assigned`, `task.comment_added` (id only, no body), `question.asked`/`answered` (ids),
`agent.claimed`/`released`, `review.requested`/`decided`. Keep the same "ids and figures only" rule.
Add a test that asserts one audit entry per state change.

#### Verification

Static: `grep -R "host.audit(" packages/server/src` returns two call sites. After the change, a
`Done` move must produce an entry in `host.audits`.

---

### F-07 — A run's `changedFiles` and `models` bypass `host.redact`

**Severity: Low (3.2)** · Component: `packages/server/src/domain/runs.ts` · CWE-200

#### Description

Every text an **agent** stores passes `host.redact` (requirements, fields, messages, signals,
questions, answers, usage model). A **run's** result does not: `readResult` parses `result.json` with
`checkRunResult` (shape, run id, same-repo PR URL) and `recordEnd` stores `result.changedFiles` and
`result.models` verbatim, then `toRun` returns them to every project member:

```ts
// runs.ts:750-766
const checked = checkRunResult(value, { runId: row.id, fullName: project.fullName });
if (!checked.ok) return { kind: "bad" };
return { kind: "result", result: checked.result, ... };

// runs.ts:343-353
tokenUsage: result ? { ...result.usage, models: result.models, turns: result.turns } : null,
changedFiles: result ? result.changedFiles : null,
```

`result.json` is produced by the workflow from the agent's `git diff --name-only` and the model's
`modelUsage` keys, so both are influenced by the run. The workflow has a strong secret backstop
(contents **and** paths) before publish, so a real key normally cannot reach it; this is a
defense-in-depth gap for secrets the backstop misses and for non-key sensitive strings (client names,
ticket ids) in path or model names.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/domain/runs.ts:750-766` | No `host.redact` on the result |
| `packages/server/src/domain/runs.ts:343-353` | Stored verbatim |
| `packages/server/src/domain/runs.ts:176-207` | Returned in `Run` |
| `packages/server/src/domain/tasks.ts:123-133` | The agent-text pattern that is applied elsewhere |

#### Impact

Low: project members (and the workspace export) can see a secret-shaped or sensitive value that the
redactor would have removed, if it survives the workflow's own scan.

#### Remediation

Apply `host.redact` to each `changedFiles` entry and each `models` entry before storing, then
re-check the field's constraints (a redacted path is still a string; a redacted model is still
≤200 characters) — mirroring `redactFields` in `tasks.ts`.

#### Verification

`GAP 5` in `docs/audit/security-audit.test.ts`: a `fakeToken()`-shaped value in `changedFiles[0]` and
`models[0]` is stored and returned by `listRuns`, while `host.redact` would have replaced it.

---

### F-08 — Shipped workflow pins actions by tag and installs CLIs by version only

**Severity: Low (4.7)** · Component: `packages/schemas/src/workflow.ts` · CWE-1357 / CWE-1104

#### Description

The workflow DevSync asks customers to add to their repository uses tag-pinned actions and npm
installs without integrity pinning:

```
uses: actions/checkout@v7            (workflow.ts:111)
uses: actions/upload-artifact@v7     (workflow.ts:480)
uses: actions/download-artifact@v8   (workflow.ts:506)
npm install --global @anthropic-ai/claude-code@2.1.311   (workflow.ts:143)
npm install --global @openai/codex@0.171.0               (workflow.ts:156)
```

The repository's own CI does the right thing — every action is pinned to a full commit SHA
(`.github/workflows/ci.yml:21-27`). The shipped workflow instead runs tag-pinned actions in every
job: the `agent` job holds the workspace's model keys and `id-token: write`, and the `publish` job
holds `contents: write` and `pull-requests: write`. A compromised or retagged action — or a
malicious npm dependency installed before the agent step — therefore executes with whatever that
job has, including the OIDC capability, and can persist a replacement binary that later receives the
keys.

The project partially covers this: the install steps have no keys in their env, and the docs note
that the OIDC token is available per job. But the tags are still the weakest link in an otherwise
excellent supply-chain design.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/schemas/src/workflow.ts:111,480,506` | Tag-pinned actions |
| `packages/schemas/src/workflow.ts:143,156` | Global npm installs |
| `.github/workflows/ci.yml:21-27` | The contrast: SHA-pinned CI |
| `docs/managed-runs.md:190-193` | OIDC is per job, not per step |

#### Impact

Low probability, high consequence: a supply-chain compromise of an action or CLI package gives the
attacker repository write (draft PR), OIDC token exchange, and the workspace's model keys/flows.

#### Remediation

1. Pin every action to a full commit SHA (as CI already does), and say so in the workflow comments.
2. Install CLIs with `npm install --global --ignore-scripts` where possible, verify `npm audit
   signatures`/provenance, or download a checksum-verified release tarball.
3. Move the install steps into a job without `id-token: write` and pass the binaries to the agent
   job via the artifact cache (or accept the documented risk explicitly).

#### Verification

Static: the `uses:` lines above are tags, not 40-hex SHAs; `npm` installs have no `--ignore-scripts`.

---

### F-09 — Public MCP endpoint has no local rate/body limit before authentication

**Severity: Low (3.7)** · Component: `packages/server/src/http/mcp.ts` · CWE-770

#### Description

`POST /m/devsync/mcp` runs `authenticateAgent` (which calls `host.agents.verify`, a database lookup on
the host) before any DevSync-level throttling, and has no request-size check of its own. Every request
calls `host.agents.verify`; a 43-character base64url token also reaches DevSync's own hash lookup. The
host mounts the route "behind the body limit" and presumably an edge rate limiter, so this is a
defense-in-depth gap: a flood of unauthenticated requests consumes host DB capacity. Token guessing is
infeasible (256-bit tokens), so the risk is availability, not credential compromise.

#### Evidence

| Location | What it shows |
|---|---|
| `packages/server/src/http/mcp.ts:89-111` | Auth before any limit |
| `packages/server/src/domain/agents.ts:150-162` | `verify` then own-row lookup per request |

#### Impact

Low: resource consumption on the host's token-verification path, bounded by whatever the host's edge
already enforces.

#### Remediation

Add a cheap per-IP token bucket at the edge (host), and a DevSync-level cap on concurrent MCP
requests per token; reject over-size declared bodies before parsing.

**Related, same theme:** `GET /runs/setup` is open to every role and calls `host.github.setup` on
every request (`runs.ts:435-446`), which costs several GitHub API calls. A member can loop it and
burn the workspace installation's GitHub quota (and host egress). Cache it briefly per project, or
rate-limit it per member.

---

### F-10 — Any future `Caller.kind` is silently treated as a read-only run

**Severity: Informational** · `packages/server/src/actions.ts:100-105`

`memberOf()` returns null for anything that is not `kind: "member"`, and `reader()` then returns
`{ project }`. Today the host produces only `member | agent | run`; if the contract ever adds a
caller kind (e.g. `system`), that kind inherits full project **read** access without an explicit
decision. Make the switch exhaustive (`switch (caller.kind)`) or refuse unknown kinds.

---

### F-11 — Host verification clears DevSync's `revoked_at`

**Severity: Informational** · `packages/server/src/domain/agents.ts:185-214`

`seenAgent`'s upsert sets `revokedAt: null` whenever the host verifies the agent, with the comment
"the host verified it, so it is live: a revoke DevSync recorded before the move is undone." This is
intentional for the migration path, but it means a DevSync-side revoke is not durable if the host
still verifies the same token. Once the legacy token columns are removed (the planned follow-up),
this branch should be deleted; until then, document that DevSync's revoke is advisory.

---

### F-12 — A few queries scope by `project_id` only

**Severity: Informational** · CWE-566

Most queries filter by both `workspace_id` and `project_id`; these filter by project only:

- `listPullRequests` — `pull-requests.ts:223-228`;
- `exportProject` — every query in `export.ts:35-74`;
- the dependency advisory lock key — `tasks.ts:681-684`;
- `applyGithubFact` takes `project` from `host.project(job.projectId)` and ignores
  `job.workspaceId` — `pull-requests.ts:162-166` (safe: the host is the source of both).

Project ids are globally unique UUIDs generated by the host, so cross-tenant access is not
reachable. This is a consistency gap against the project's own rule that every query filters by
both; add the workspace predicate where cheap, and validate `job.workspaceId === project.workspaceId`
in the GitHub job for defense in depth.

---

### F-13 — State/enum integrity is application-enforced only

**Severity: Informational** · `packages/server/migrations/*.sql`

`status`, `kind`, `state`, `provider` and `failure` are `text` columns with no `CHECK` constraint;
the zod schemas enforce the enums. A future code path (a migration, a manual fix, another service
sharing the schema) could write an invalid status that the UI cannot represent. Add `CHECK`
constraints for the small closed sets; the cost is low and it hardens the data layer.

---

## 5. Verified security controls

These were tested or traced and are working as intended; they are recorded so future changes do not
regress them silently.

### 5.1 Authentication

- Agent tokens are 32 random bytes, base64url (`agents.ts:28-34`); only `sha256` is stored.
- `authenticateAgent` always asks the host first, then DevSync's own unmigrated rows, then the host
  again to close the migration race (`agents.ts:150-162`); never cached.
- Own tokens require a non-revoked row with `expires_at > now` (`agents.ts:274-300`).
- The public endpoint refuses foreign `Origin` before authenticating (`http/mcp.ts:89-93`), answers
  `401` with `WWW-Authenticate: Bearer`, and `403` when the project is gone or DevSync is off.
- Every answer is `Cache-Control: no-store` (`http/errors.ts:50-54`).
- No token appears in a response, log, audit entry, export, or fixture (verified by grep and the
  export test).

### 5.2 Authorization and tenancy

- One permission table, `can()` (`schemas/permissions.ts:8-17`), used by routes, UI and domain.
- Write routes require the role **before** the body is read (`http/project.ts:51-64`); the domain
  re-checks (`domain/common.ts:83-91`, `tasks.ts:226-230`).
- Per-verb invariants: agents edit only tasks they created (`tasks.ts:983-988`), agents cannot
  assign (`schemas/mcp.ts:39-43`), runs can only read (`actions.ts:107-114`), members cannot use
  agent-only tools (`actions.ts:120-129`), assignees must be workspace members
  (`tasks.ts:966-975`).
- Every task/run/question/signal query is scoped through `taskIn`/`runIn`/project predicates
  (`common.ts:116-126`, `runs.ts:219-226`); the workspace route filters against the host's project
  list (`tasks.ts:352-384`).
- Cross-project and cross-workspace access is covered by existing tests (e.g.
  `domain/tasks.test.ts:401,584,837`, `http/routes.test.ts:346,529,667`, `mcp.test.ts:414`).

### 5.3 Input and output handling

- Every body, query string and MCP tool input is a **strict** zod object (`schemas/*.ts`), so
  unknown keys are refused, and every answer is re-parsed before it leaves (`http/errors.ts:72-86`).
- Ids are UUID-checked before they reach SQL (`common.ts:110-114`); paths reject `..`, leading `/`
  and NUL (`schemas/tasks.ts:33-37`); branches follow `git check-ref-format` (`tasks.ts:47-58`);
  findings have a strict character set (`schemas/common.ts:21`).
- Unexpected failures return a generic 500 and log only the error name and first line, never the
  body or a token (`http/errors.ts:31-48`).
- Host-supplied structures are parsed before use (`HostAgent`, `Finding`, `ContextBlock`,
  `RunResult`); mismatches fail closed.

### 5.4 Data layer

- Drizzle query builder throughout. Raw `sql` fragments are static or parameterized — a JSON
  predicate (`common.ts:213`), version arithmetic, a `cardinality(...)` check, and a parameterized
  advisory lock (`tasks.ts:681-684`); no user-controlled identifier or value is interpolated.
- Optimistic concurrency on every edit (`version` check + conditional update), row locks for
  claims/answers/runs, a partial unique index for "one unended run per task"
  (`db/schema.ts:367-374`), and unique keys for idempotency.
- Foreign keys with `ON DELETE cascade`; removal hooks delete children before parents.

### 5.5 Browser

- No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no `javascript:` URLs.
- `GithubLink` renders a link only for an `https://github.com/` prefix, as text otherwise
  (`web/parts.tsx:13-33`); external links carry `rel="noopener noreferrer"`.
- TanStack Query keys are namespaced by the mount point (`web/queries.ts:25-31`), so one project's
  cached data cannot render on another project's tab.
- No token is stored in `localStorage`, `sessionStorage`, or a URL.

### 5.6 Supply chain and operations

- CI: SHA-pinned actions, `permissions: contents: read`, `persist-credentials: false`, frozen
  lockfile (`.github/workflows/ci.yml`).
- No secrets in the working tree or in the full git history (patterns for Anthropic/OpenAI/GitHub/
  AWS/Slack keys and private keys).
- `pnpm audit`: one moderate advisory, **development-only** (`esbuild 0.18.20` via
  `drizzle-kit > @esbuild-kit/*`; GHSA-67mh-4wv8-2f99, dev-server request smuggling). Not in the
  runtime path.
- The managed-run workflow's own controls are strong: `permissions: {}` at the top, per-job
  permissions, keys only in the agent job, no key in `publish`/`report`, a secret scan of contents
  **and paths** before publish, OIDC request variables unset before the agent, the OIDC token
  removed from disk, a Codex sandbox `/proc` check, `.github/` patches refused, and explicit
  "task is data, not instructions" prompt framing.

### 5.7 Trade-offs noted during review

These are deliberately accepted in the code/docs, or inherent to the design; they are listed so
they are not mistaken for oversights, and so their risk is re-evaluated if the design changes.

- **Revoked host agent keeps its DevSync row.** After a revoke on the dashboard, members and peers can
  still message it, GitHub signals still queue, and it keeps any claim until it expires (≤15 min).
  Its token no longer authenticates, so nothing is readable; the cost is noise and stale inbox data.
  (`docs/host.md` § "DevSync's own endpoint"; `docs/platform.md` P2 follow-up.)
- **Duplicate task for one finding under a race.** Two `POST /tasks` with the same finding at the same
  instant may both pass (no unique index spans the "open task per finding" rule). The code accepts
  this; the impact is a duplicate task, not a security bypass. (`tasks.ts:847-854`.)
- **Claim vs. dependency edit race.** A claim reads `task_dependency` without the dependency advisory
  lock; a member adding a dependency in that instant can make a just-claimed task wait. The window is
  narrow and a later move to Ready re-establishes the invariant; it is noted rather than rated.
  (`claims.ts:138-206`.)
- **Peer review is a process control, not a security boundary.** `submit_review` only requires that
  the reviewer is a different agent in the project; a compromised or socially engineered agent can
  approve a peer's work, and a human still marks the task Done. This is inherent to the multi-agent
  design and should be treated as such in the threat model.

---

## 6. Assumptions and host dependencies

These are **not** findings, but the residual risk depends on them; they should be re-verified in the
dashboard's own audit:

1. The host guard authenticates the session, enforces CSRF (or `SameSite` cookies plus JSON
   semantics), checks workspace membership and project ownership, and refuses members' writes to a
   read-only/disconnected project. DevSync's project routes add no CSRF token of their own.
2. The host's `/mcp` builds `Caller` exclusively from the authenticated token/session and adds the
   project; a bug there would let a token act on another project, and DevSync's `callerActor` only
   partially re-validates (it checks the agent row and the host's project list).
3. `host.redact` is effective for the workspace's real secrets; it is the only redaction layer for
   agent text.
4. `host.finding` returns only the caller's project's finding and already-redacted text.
5. `host.ai.allowRun` scopes the run reference to one run and refuses read-only/off projects.
6. The host's GitHub App is scoped to the project's repository and refuses other workflows;
   DevSync declares `workflows: ["devsync.yml"]` and passes only that name.
7. The database role used by the host does not expose `devsync` tables to other tenants/modules
   (there is no RLS in this repository).
8. Body-size limits on the mounted routes are enforced by the host (DevSync parses the whole body).

---

## 7. Quality gates and tooling

| Gate | Result |
|---|---|
| Biome lint (`pnpm lint`) | ✅ 114 files, no fixes |
| TypeScript (`turbo run typecheck --force`) | ✅ 3/3 packages |
| `@devsync/schemas` tests | ✅ 10 files passed (1 skipped), 96 tests passed, 41 skipped |
| `@devsync/web` tests | ✅ 8 files, 109 tests |
| `@devsync/server` tests | ✅ 23 files, 279 tests |
| `pnpm audit` | 1 moderate, dev-only (`esbuild` via `drizzle-kit`) |
| Secret scan, tree + full git history | ✅ none |
| Snapshot vs. upstream `main` | ✅ byte-identical (146 files, line endings aside) |
| Audit validation tests (6) | ✅ all pass (they assert the gaps above) |

> **Note on the test runner:** `pnpm check` cannot run in this sandbox because Vitest's default
> `forks` pool spawns children and the sandbox denies it (`spawn EPERM`). The suites were therefore
> run with `--pool=threads --no-file-parallelism`, which executes them in worker threads. Total:
> **484 tests passed** across the three packages (96 + 279 + 109). The 41 skipped schema tests are
> the workflow-text execution tests that need `bash`/`jq` (`describe.skipIf(!tools)` in
> `workflow.run.test.ts`), not suppressed security tests.

---

## 8. Remediation plan

### Before the first live project (1–2 days)

| # | Change | Finding |
|---|---|---|
| 1 | Scope a run's reads to its own task in `actions.ts` + `reader()`; have the host's `/mcp` mirror it | F-01 |
| 2 | Enforce `dependsOn` in `requestable`, `decideRun`, and optionally `dispatchRun` | F-02 |
| 3 | Add per-task caps (questions, revisions, overlaps) and a retention job for outbox/signals/questions | F-03 |
| 4 | `requireWritable` in `publishSignal` | F-04 |

### Next release (2–5 days)

| # | Change | Finding |
|---|---|---|
| 5 | Refuse requirements edits on `DONE`/`CANCELLED` (or add an audited "amend") | F-05 |
| 6 | Audit task lifecycle changes through `host.audit` | F-06 |
| 7 | `host.redact` on `changedFiles`/`models` | F-07 |
| 8 | SHA-pin the workflow's actions; `--ignore-scripts` or checksum-verified CLI installs | F-08 |

### Hardening backlog

| # | Change | Finding |
|---|---|---|
| 9 | Edge rate limit + body cap for `/m/devsync/mcp` | F-09 |
| 10 | Exhaustive caller-kind switch | F-10 |
| 11 | Remove the legacy revoke-resurrection branch once tokens are migrated | F-11 |
| 12 | Add `workspace_id` predicates / validate job workspace | F-12 |
| 13 | `CHECK` constraints for closed enums | F-13 |

---

## Appendix A — Reproduction: validation tests

`docs/audit/security-audit.test.ts` contains six tests (GAP 1–6) that **assert the current,
weak behaviour** and therefore pass. They need the repository's test harness:

```bash
cp docs/audit/security-audit.test.ts packages/server/src/
pnpm install --frozen-lockfile
pnpm exec vitest run --pool=threads --no-file-parallelism --root packages/server src/security-audit.test.ts
```

Observed result: **6 passed**. Each test's name states the gap; after the corresponding fix it
should fail, which makes it a regression test in reverse.

| Test | Finding |
|---|---|
| GAP 1 — run token answers all the project's tasks | F-01 |
| GAP 2 — run created while a claim of the same task is refused | F-02 |
| GAP 3 — 40 open questions kept across two minutes | F-03 |
| GAP 4 — member signal kept on a read-only project | F-04 |
| GAP 5 — token-shaped result values stored and returned | F-07 |
| GAP 6 — cancelled task accepts a new revision | F-05 |

The test is kept in `docs/audit/` and is not part of any package's test run.

## Appendix B — Evidence index

| Area | Files |
|---|---|
| Permissions / identity | `packages/schemas/src/permissions.ts`, `roles.ts`, `packages/server/src/domain/common.ts`, `host.ts` |
| HTTP / MCP | `packages/server/src/http/{project,workspace,mcp,errors}.ts` |
| Agent auth | `packages/server/src/domain/agents.ts` |
| Task domain | `packages/server/src/domain/tasks.ts`, `claims.ts`, `activity.ts`, `questions.ts`, `signals.ts` |
| Runs | `packages/server/src/domain/runs.ts`, `packages/schemas/src/{runs,workflow}.ts` |
| Tenancy / storage | `packages/server/src/db/schema.ts`, `migrations/*.sql`, `domain/export.ts`, `removal.ts` |
| Browser | `packages/web/src/{parts,queries,provider,client}.ts(x)`, `ProjectTab.tsx`, `TaskPanel.tsx`, `Runs.tsx` |
| Supply chain | `.github/workflows/ci.yml`, `packages/schemas/src/workflow.ts` |
| Project's own risk notes | `docs/managed-runs.md` ("What remains"), `docs/platform.md` (P7), `docs/host.md` |

---

*Report prepared from source review and dynamic tests. No production systems were accessed; no
secrets or customer data were handled. All observations can be reproduced from the pinned commit.*
