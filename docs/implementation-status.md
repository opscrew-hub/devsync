# Implementation status

The foundation uses a Next.js App Router web app and versioned HTTP routes, Prisma with PostgreSQL, Auth.js with GitHub OAuth, and shared Zod and domain packages. Project membership controls access. Optimistic concurrency checks protect task edits and transactions persist requirement revisions.

## Finish the foundation

Add project membership management, task assignment, dependencies, labels, priority, comments, and a dedicated task detail and activity view. Add database integration tests for project isolation and simultaneous updates and Playwright coverage for the foundation. Verify live OAuth with a development OAuth App and confirm both themes and mobile layout.

## Subsequent phases

1. Add the agent registry, credential scoping, atomic claim leases, durable signals, transactional outbox, authenticated MCP tools, and a replayable event stream. Test two independent clients against the same project.
2. Add GitHub App setup, signed webhook ingest, delivery deduplication, installation authorization, queue retries, and read-only tracking of commits, pull requests, and checks. Test with recorded fixtures.
3. Add managed coding jobs with isolated checkouts, scoped credentials, cancellation, revision checks, budgets, and draft PRs. Verify SDK APIs against official docs and test with mocked clients.
4. Verify the OpsCrew CLI and artifacts, then add planning, deployment observation, health checks, and approvals bound to immutable artifacts. Test dry-run workflows before enabling any external write action.
5. Verify the full Claude/Codex acceptance scenario, failure recovery, operational monitoring, and self-hosting documentation.
