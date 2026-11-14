# DevSync: agent guidance

DevSync is a module of OpsCrew's dashboard, its host. Read `README.md` (what it is, the layout,
the commands) and `docs/host.md` (the contract with the host) before changing anything.

- `packages/schemas`, `packages/server`, `packages/web`: TypeScript strict ESM, consumed from
  source (`exports` → `./src/index.ts`). Never import the host's code; what DevSync needs from it
  goes through `DevSyncHost` (`packages/server/src/host.ts`), and a change to that interface or to
  `docs/host.md` is a change to the host too.
- Permissions live in `can()` in `@devsync/schemas`; every query filters by the project (or the
  workspace); every input and every answer is parsed with zod; every timestamp comes from
  `host.clock`.
- Tests: Vitest, colocated `src/**/*.test.ts`, PGlite through `createTestDb()` and a `fakeHost()`;
  never a real network call. Never commit a token-shaped literal: generate one with `fakeToken()`.
- Errors are `DevSyncError`s in plain English that say what to do next. Tokens never reach a log,
  an audit entry or an error.
- Before proposing a change: `pnpm check` (lint, typecheck, test). Format with `pnpm format`
  (Biome: 2 spaces, double quotes, trailing commas, width 100).
- Commits: Conventional Commits.

When DevSync's MCP server is configured for you, check the project's state and your pending
signals at the start of an assignment, and acknowledge each signal once processed.
