# Implementation status

As of 2026-11-26. What DevSync must do is in [requirements.md](requirements.md); its contract with
OpsCrew's dashboard is in [host.md](host.md).

## Done

DevSync was reworked from a standalone Next.js app into a module of OpsCrew's dashboard. Each step
below was built test-first, and the domain and the host's side were reviewed by fresh reviewers,
their findings fixed.

- **The toolchain and layout**: three packages (`@devsync/schemas`, `@devsync/server`,
  `@devsync/web`) on the dashboard's stack (Hono, Drizzle, React, zod, Biome, Vitest with PGlite),
  the host interface (`host.ts`), CI.
- **Schemas**: the task statuses and their moves, the permission table for the dashboard's roles,
  every API body and answer, every MCP tool's input.
- **The database**: the `devsync` schema and its migration; `createTestDb()`, `fakeHost()` and
  `fakeToken()` for tests.
- **Tasks**: create, read, edit with a version check, move along the lifecycle, assign to the
  workspace's members, comment, link a pull request; a revision on every requirements change; the
  timeline from the task's outbox events; the removal hooks.
- **Agents**: registered, rotated and revoked on the dashboard (its Agents button); DevSync's own
  agents move there hourly with their tokens still working (`devsync.agents-move`); the inbox and
  signals (hop limit, one follow-up, 20 a minute), claims with a 15-minute lease, progress, blocker
  and review reports, peer review decisions, the outbox's delivery with a backoff capped at 10
  minutes.
- **HTTP and MCP**: the project, workspace and public routes; DevSync's 16 actions, declared once
  and served at the dashboard's `/mcp` as `devsync_<name>` and at DevSync's own
  `POST /m/devsync/mcp` until a later release; unexpected errors logged without bodies or tokens
  and answered generically.
- **The module platform** ([platform.md](platform.md)): DevSync's events through the host, agents'
  text redacted before it is stored, the project's export, and managed runs on the workspace's AI
  credits when it has no key, each with its own `/mcp` token; tasks' paths (overlaps flagged),
  dependencies, labels and branch, at most 3 claims per agent, agents' reported usage, questions on
  a task (a waited one blocks it until answered), and a briefing for the agent that takes a task.
- **Queues**: `devsync.outbox` and `devsync.github` (pull requests' latest state, signals to agents,
  once per delivery).
- **Pages**: the project tab (tasks by status, the task panel with its revisions, comments,
  timeline and pull request, agents) and the workspace page (open tasks across projects).
- **The plug-in entries**: the `opscrewModule` manifest, `serverModule` and `webModule`, checked
  against the dashboard's contract by type-level tests.
- **Verified inside the dashboard** (plugged in by `OPSCREW_MODULES` at a commit): its typecheck and
  build against DevSync's code, its migrations through the dashboard's release on PostgreSQL 17, and
  an end-to-end run: switch on, plan a task as a Developer, another workspace refused, an agent's
  token on MCP, the audit entry without the token, switch off.
- **Managed runs** ([managed-runs.md](managed-runs.md), research in
  [research/managed-runs.md](research/managed-runs.md)): asking, approving the exact text,
  rejecting and cancelling; one dispatch per run, never repeated; the result read from the run's
  artifact through the dashboard's GitHub App and checked; the draft pull request linked; the
  six-hour sweep; the workflow file the user adds (the `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
  or `OPENAI_API_KEY` key only in the agent's job, which has no write token; a change holding any
  key never published); the task's runs section. Verified through the dashboard's real host with
  a fake GitHub, end to end. With only an OpenAI key the run uses Codex in its sandbox, its cost
  worked out from its tokens at OpenAI's prices ([research/openai.md](research/openai.md)):
  checked locally against a fake OpenAI API, not yet live.
- **Fixing a security finding** ([findings.md](findings.md)): `host.finding` and the manifest's
  `findingAction`; `GET /findings` with the open task already linked to the finding (the same
  fingerprint, or the same rule and file); the task prefilled from the finding within DevSync's
  limits, its fingerprint, rule and file read again from the host on create, and a second open task
  for the finding refused. On the branch `finding-action`, merged once the dashboard's side is
  deployed.

What the standalone version had and the module drops, because the dashboard has it: its own sign-in,
projects and project members, audit log, GitHub App, webhook intake and repository linking, live
updates over SSE (the dashboard polls), Redis, and the dedicated Codex and Claude workers.

## Next

1. **A live test** on a real project (under way): Claude Code and Codex connected
   over MCP, and one managed run on a private test repository (what the research left to check
   live: the CLI's flags together, the reads it refuses, GitHub's answer when pull requests from
   Actions are off), and one with only an OpenAI key (Codex's sandbox on a hosted runner, its
   tokens against the OpenAI project's usage).

## Later

A model chosen per managed run; task dependencies, labels and priorities; status and assignment
events in the timeline; check runs on linked pull requests.
