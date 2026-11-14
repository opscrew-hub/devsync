# Implementation status

As of 2026-11-14. What DevSync must do is in [requirements.md](requirements.md); its contract with
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
- **Agents**: registration with a one-time token (only its SHA-256 kept, 24-hour expiry, rotation,
  revocation, audited), the inbox and signals (hop limit, one follow-up, 20 a minute), claims with a
  15-minute lease, progress, blocker and review reports, peer review decisions, the outbox's
  delivery with a backoff capped at 10 minutes.
- **HTTP and MCP**: the project, workspace and public routes; `POST /m/devsync/mcp` with the 13
  tools; unexpected errors logged without bodies or tokens and answered generically.
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
  six-hour sweep; the workflow file the user adds (the Anthropic key only in the agent's job, which
  has no write token; a change holding the key never published); the task's runs section. Verified
  through the dashboard's real host with a fake GitHub, end to end.

What the standalone version had and the module drops, because the dashboard has it: its own sign-in,
projects and project members, audit log, GitHub App, webhook intake and repository linking, live
updates over SSE (the dashboard polls), Redis, and the dedicated Codex and Claude workers.

## Next

1. **A live test** on a real project, the inventory project first: Claude Code and Codex connected
   over MCP, and one managed run on a private test repository (what the research left to check
   live: the CLI's flags together, the reads it refuses, GitHub's answer when pull requests from
   Actions are off).

## Later

More models for managed runs; task dependencies, labels and priorities; status and assignment
events in the timeline; check runs on linked pull requests.
