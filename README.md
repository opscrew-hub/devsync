# DevSync

DevSync is where a project's work is planned and followed, by its people and by their coding
agents. It is a module of [OpsCrew](https://opscrew.dev)'s dashboard at `app.opscrew.dev`, built
for OpsCrew only.

OpsCrew takes an app from its GitHub repository to a hardened production deployment on the user's
own cloud, and keeps it running and secure. DevSync covers what comes before each deploy: what the
project should do next, who or which agent is doing it, and whether it has been reviewed. A client
and their developers plan the work in DevSync, their coding agents do it, and OpsCrew deploys it.

## What it does

- **Tasks with their requirements' history.** Each task has a title, a description and acceptance
  criteria. Every change to them is kept as a numbered revision, so everyone sees what was asked
  and when it changed. A task moves from Backlog through Ready, Claimed, In progress, Blocked and
  Review to Done (or Cancelled), and can be assigned to any member of the workspace.
- **Comments and a timeline** on every task: people's comments, and the agents' progress, blockers,
  review requests and review decisions.
- **Coding agents through MCP.** An Owner or Admin registers an agent (Claude Code or Codex, on a
  developer's computer) and gives it a token. The agent connects to DevSync's MCP endpoint, reads
  the project's tasks and its inbox, claims a Ready task, reports progress or a blocker and asks
  for review; a peer agent approves or requests changes, and a person marks the task done.
  Messages reach agents exactly once, even across disconnections.
- **Pull requests.** A task links to one of the repository's pull requests and shows its state as
  GitHub reports it; agents hear about pushes and pull requests opened or merged.
- **Across projects.** A workspace page lists the open tasks of every project with DevSync on,
  filterable by project, status and "assigned to me".
- **Managed runs (coming).** A member asks for a run on a task; once an Owner, Admin or Approver
  approves it, the project's own GitHub Actions run Claude Code on the workspace's own Anthropic key
  and open a draft pull request. OpsCrew holds no AI key and opens no pull request itself.

## Using it

1. In OpsCrew's dashboard, an Owner or Admin opens **Modules** and switches DevSync on for the
   workspace, then for a project (also from the project's **Modules** button).
2. The project gains a **DevSync** tab: create tasks, move them to Ready, assign them, comment.
3. To let a coding agent work, register it under **Agents** on that tab and copy its token (shown
   once; valid 24 hours, rotate it from the same place). Then set `DEVSYNC_AGENT_TOKEN` in the
   agent's environment and add the server. For Claude Code:

   ```json
   {
     "mcpServers": {
       "devsync": {
         "type": "http",
         "url": "https://app.opscrew.dev/m/devsync/mcp",
         "headers": { "Authorization": "Bearer ${DEVSYNC_AGENT_TOKEN}" }
       }
     }
   }
   ```

   For Codex, in `config.toml`:

   ```toml
   [mcp_servers.devsync]
   url = "https://app.opscrew.dev/m/devsync/mcp"
   bearer_token_env_var = "DEVSYNC_AGENT_TOKEN"
   ```

Switching DevSync off hides it and keeps its data; removing the project or the workspace deletes it.

## How it fits into OpsCrew

The dashboard is DevSync's **host**. It already has what a standalone app would need, so DevSync
uses the host's instead of its own:

| The host provides | DevSync adds |
|---|---|
| sign-in (GitHub, email links, single sign-on) | tasks, revisions, comments, assignments |
| workspaces, projects (each a GitHub repository) and members with their roles (Owner, Admin, Approver, Developer) | which role may do what in DevSync |
| the audit log | its entries (`devsync.*`) |
| the GitHub App and its webhooks | the pull requests' state, and signals to agents |
| the job queue and its worker | the outbox and GitHub queues |
| the database | its tables, in their own `devsync` schema with their own migrations |
| the dashboard's look: styles, icons, dialogs | the DevSync tab and the workspace page |

The dashboard names no module: it has a module system, and DevSync plugs into it. DevSync never
imports the dashboard's code either. It follows the dashboard's module contract with its own copy of
the types, checked by type-level tests, and gives the dashboard its routes, MCP endpoint, queues,
migrations, removal hooks and pages through two entries, `serverModule` and `webModule`, named in
the `opscrewModule` manifest of its `package.json`. [docs/host.md](docs/host.md) is DevSync's side of
that contract: the interface, the mount points, the roles, the HTTP API, the MCP tools, the queues
and the page props. The dashboard switches DevSync on per workspace and per project and checks every
request against its session and the member's role before DevSync's code runs.

### Plugging it into the dashboard

DevSync runs only inside OpsCrew's dashboard. Its deployment lists it in `OPSCREW_MODULES`, pinned to
a full commit of this repository:

```bash
OPSCREW_MODULES="https://github.com/opscrew-hub/devsync#<40-character commit>"
```

The dashboard's build downloads that commit, checks the manifest, includes DevSync's server code
and pages (its pages load as their own chunk), and its release applies DevSync's migrations in the
`devsync` schema. To ship a new version of DevSync, push it to `main` here and build the dashboard
with the new commit.

## Development

Requires Node.js 22.9 or later and pnpm 10.29.1. No database or Docker: tests run PostgreSQL in
process with PGlite, and against a fake host.

```bash
pnpm install
pnpm check            # lint, typecheck and test
pnpm format           # Biome, writing fixes
pnpm db:generate      # a new migration after changing packages/server/src/db
```

| Package | What it holds |
|---|---|
| `packages/schemas` (`@devsync/schemas`) | zod shapes of the API and MCP tools, the statuses and their moves, the permission table: shared by the server and the browser |
| `packages/server` (`@devsync/server`) | the host interface, the `devsync` schema and migrations, the domain, the HTTP routes and MCP endpoint, the queues, the removal hooks, and `serverModule`; `@devsync/server/testing` has `createTestDb()`, `fakeHost()` and `fakeToken()` |
| `packages/web` (`@devsync/web`) | the DevSync tab and the workspace page, and `webModule` |

The code follows OpsCrew's conventions: TypeScript strict ESM, Biome, Vitest, zod for every input,
side effects (the database, the clock, the queue) injected through the host, plain-English errors
that say what to do next, and no token in any log, audit entry or fixture.

## Status

The port is done and verified inside the dashboard; managed runs in the project's own GitHub
Actions come next, then a first live project. [docs/implementation-status.md](docs/implementation-status.md)
has the details, and [docs/requirements.md](docs/requirements.md) what DevSync must do.
