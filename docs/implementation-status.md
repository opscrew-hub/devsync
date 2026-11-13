# Implementation status

The foundation uses a Next.js App Router web app and versioned HTTP routes, Prisma with PostgreSQL, Auth.js with GitHub OAuth, and shared Zod and domain packages. Project membership controls access. Optimistic concurrency checks protect task edits and transactions persist requirement revisions. Task detail pages show saved comments and revision snapshots. Project members can read activity, and members with write access can post comments.

## Finish the foundation

Project owners can grant, change, or revoke access for registered DevSync accounts. Tasks can be assigned to project members with write access. Downgrading or revoking access clears their assignments.

Add dependencies, labels, priority, and status and assignment events in the task timeline. Add database integration tests for project isolation and simultaneous updates and Playwright coverage for the foundation. Verify live OAuth with a development OAuth App and confirm both themes and mobile layout.

## Subsequent phases

1. Add the agent registry, credential scoping, atomic claim leases, durable signals, transactional outbox, authenticated MCP tools, and a replayable event stream. Test two independent clients against the same project.
2. Add GitHub App setup, signed webhook ingest, delivery deduplication, installation authorization, queue retries, and read-only tracking of commits, pull requests, and checks. Test with recorded fixtures.
3. Add managed coding jobs with isolated checkouts, scoped credentials, cancellation, revision checks, budgets, and draft PRs. Verify SDK APIs against official docs and test with mocked clients.
4. Verify the OpsCrew CLI and artifacts, then add planning, deployment observation, health checks, and approvals bound to immutable artifacts. Test dry-run workflows before enabling any external write action.
5. Verify the full Claude/Codex acceptance scenario, failure recovery, operational monitoring, and self-hosting documentation.

## Phase 2 progress

Project owners can register agents and revoke or rotate scoped credentials. Human project writers can send messages to an agent inbox. Unacknowledged messages persist through disconnections and credential rotation. The MCP endpoint exposes project state, inbox reads, and acknowledgements.

Agents can claim Ready tasks, renew their leases, release claims, and recover expired leases through MCP.

Agents can discover project peers and publish durable signals through MCP. Replies are linked to inbox signals and bounded by a hop limit and per-agent rate limit.

Human task creation and edits write transactional outbox records. A standalone PostgreSQL worker delivers them to agent inboxes with duplicate protection and retries.

Agents can create and update their own tasks through MCP. Task creation is idempotent. Requirements revisions and task events retain the agent identity and reach project peers through the outbox.

Claim holders can report progress and blockers and request review through MCP. Reports appear in the task timeline and are delivered to project peers.

Peer agents can approve or request changes against a current review request. Decisions are recorded in the task timeline and delivered to agent inboxes. Human completion remains a separate action.

Project creation, member role changes, and agent credential changes are recorded atomically in an administrative audit log. Owners and admins can read it from the dashboard or the project audit API.

The dashboard and task detail pages subscribe to authenticated project updates through SSE. Changes refresh the current snapshot and revoking project membership closes the subscription.

Remaining work includes audit coverage for other mutations and an end-to-end handoff driven by both live clients.

## Phase 3 progress

Signed GitHub App webhook intake validates the raw request body and a deployment-configured installation/repository allowlist. Accepted deliveries are persisted and deduplicated by delivery ID. See [GitHub webhook intake](github-integration.md) for configuration.

Project owners can link a deployment-authorized repository after GitHub verifies its identity using a repository-scoped installation token. Event processing, GitHub dashboard synchronization, and live App verification remain pending.

The worker now processes webhook deliveries for linked repositories. The project dashboard shows recent activity and refreshes through SSE. Branch, PR, and check state projections and agent signals remain pending.

## Phase 4 progress: managed coding jobs

Project writers can request a managed run for a Ready task revision. Owners and admins can approve, reject, or cancel requests. Approval queues the run for a worker.

The PostgreSQL dispatch API reserves approved runs by agent type with a two-minute lease and an opaque reservation token. Expired leases can be reclaimed. The run lifecycle checks the reservation token when starting and finishing a run and supports cancellation and expiry cleanup.

The dedicated Codex worker runs the adapter in a temporary checkout pinned to the resolved commit. Successful results can store the base commit, changed-file summary, and a tracked-file patch. The summary includes untracked files, which must be staged or committed to appear in the patch. A regression test covers committed adapter edits. A PostgreSQL integration test covers the path from approval to patch persistence using a local Git repository and a test adapter.

Set `DEVSYNC_CODEX_DRAFT_PRS=true` to enable a draft pull request attempt after a successful run saves a patch. The GitHub App needs Contents and Pull requests write permissions on the linked repository. The worker logs the run ID and PR URL on success, or the run ID on publication failure. The successful run and patch remain available after a publication failure.

The worker queues publication in the same database update that saves the successful run. Unfinished attempts become eligible again after five minutes, including after a worker restart. Publication uses the saved patch and the original GitHub repository and installation IDs. A successful attempt saves the draft URL. Deploy the database migrations before running the updated worker. Live verification of the SDK and private GitHub App checkout remains pending.

### Dedicated Codex worker

For Claude runs, use `pnpm --filter @devsync/worker start:claude` on a dedicated execution host. Set `DEVSYNC_CLAUDE_BINARY` to the absolute path of the native Claude Code executable and configure `DEVSYNC_CLAUDE_API_KEY`, `DATABASE_URL`, and the same GitHub App settings. Optional settings are `DEVSYNC_CLAUDE_TOKEN_BUDGET` and `DEVSYNC_CLAUDE_DRAFT_PRS=true`. The adapter exposes file reading and editing tools and uses the shared checkout, patch, and publication lifecycle. Live Claude verification remains pending.

Run `pnpm --filter @devsync/worker start:codex` on a dedicated execution host alongside the regular outbox worker. Set `DATABASE_URL`, `DEVSYNC_CODEX_API_KEY`, and the GitHub App settings documented in [GitHub integration](github-integration.md). The Codex worker consumes approved CODEX runs serially. The ordinary worker and Docker preview do not start it. Live SDK and private checkout verification remain pending.

Set `DEVSYNC_CODEX_TOKEN_BUDGET` to a positive integer to check total input and output tokens before accepting a successful result. Over-budget results and results without usage are rejected. The check happens after execution, so it does not cap API spend.
