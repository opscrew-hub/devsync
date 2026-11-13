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

## Phase 4 progress

Project writers can request a managed run for a Ready task revision. Owners and admins can approve, reject, or cancel requests. Approved runs are stored as queued. Checkout isolation, SDK execution, and draft PR creation remain pending.
