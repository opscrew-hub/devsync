# DevSync

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before proposing changes. Put authorization and transactional behavior in the shared domain package. See `docs/implementation-status.md` for the current integration status.

When DevSync MCP is configured, check project state and pending signals at the start of an assignment. Acknowledge each signal after processing it. See docs/mcp-setup.md.
