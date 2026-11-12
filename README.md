# DevSync

DevSync coordinates development work across projects. The foundation includes a GitHub sign-in flow, PostgreSQL-backed projects and tasks, project-scoped API authorization, and requirements revision history.

## Local setup

Install Node 24, pnpm 11.25.0, and Docker Compose.

1. Copy `.env.example` to `.env` and to `apps/web/.env.local`.
2. Create a GitHub OAuth App with homepage `http://localhost:3000` and callback `http://localhost:3000/api/auth/callback/github`. Fill in `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in the app environment. Generate a random `AUTH_SECRET` using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
3. Run `docker compose -f infra/docker-compose.yml up -d --wait`.
4. Run `pnpm install --no-frozen-lockfile`, `pnpm db:generate`, and `pnpm db:migrate`.
5. Run `pnpm dev` and open [localhost:3000](http://localhost:3000). Readiness is available at `/api/health`.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before publishing.

See [implementation status](docs/implementation-status.md) for remaining work.
