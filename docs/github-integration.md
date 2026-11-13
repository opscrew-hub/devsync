# GitHub webhook intake

DevSync accepts signed GitHub App webhook deliveries at `/api/webhooks/github`. Configure a webhook secret in the app environment and use the same value in GitHub. Use HTTPS for the webhook URL. Keep the secret out of source control.

Set `GITHUB_WEBHOOK_REPOSITORIES` to comma-separated installation and repository ID pairs, such as `123:456,123:789`. Use the numeric installation and repository IDs from the GitHub App installation. Enable only repositories the deployment operator intends to receive. An empty list accepts signed pings and ignores unsupported event types while rejecting supported repository events.

Intake supports pushes, pull requests, pull request reviews, check runs, check suites, and workflow runs. Requests have a 2 MiB limit. A new delivery returns HTTP 202 and a duplicate returns HTTP 200. The verified JSON is persisted by delivery ID, installation ID, and repository ID. Limit database access to trusted operators because payloads may contain private repository content.

Run the DevSync worker alongside the web app. It processes stored deliveries for linked repositories and refreshes the dashboard activity feed. Unlinked deliveries remain pending. Branch, PR, and check state projections and GitHub-derived signals are pending.

[GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

## Link a repository

Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the web process environment. The private key may be PEM text with escaped newline characters. Install the app on the selected repository. Set `GITHUB_PROJECT_REPOSITORIES` to comma-separated `projectId:installationId:repositoryId` triples so an owner can link only an operator-authorized repository. Keep the webhook allowlist configured separately for intake.

In the project dashboard, sign in as the owner and submit the installation and repository IDs in the GitHub repository panel. DevSync requests a repository-scoped installation token with metadata read access, verifies the repository identity, and records the link. The app key and installation token are excluded from the database.

[GitHub installation token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

The dashboard shows up to ten observed branches, pull requests, and check runs per category. Pull request state uses the source update timestamp. Branch and check state follow delivery receipt order. The view is based on processed webhook history and requires GitHub API backfill for a complete inventory.

The worker also delivers branch-update, PR-opened, and PR-merged signals to existing agents in the linked project. A signal includes the GitHub delivery ID and available ref, SHA, or PR number.

Project writers can link a task to an observed pull request from the task detail page. Changes are audited. Replacing the linked repository clears existing task links.

Task details show the linked pull request title, observed state, and delivery timestamp. A GitHub merge does not mark the task complete.

Owners and admins can refresh a read-only API snapshot for the linked repository. It stores the first 30 branches, recently updated pull requests, and default-branch check runs separately from webhook history. Grant the GitHub App read access to Contents, Pull requests, and Checks to enable this action.

## Verify managed draft pull requests

Use a disposable DevSync project and a private test repository with a default branch. Install the GitHub App on that repository with Contents and Pull requests write access. Link it from the project dashboard. Apply the Prisma migrations to the test database.

Configure the dedicated worker with the same `DATABASE_URL`, GitHub App ID, private key, and project repository allowlist used by the test deployment. Set `DEVSYNC_CODEX_API_KEY` and `DEVSYNC_CODEX_DRAFT_PRS=true` in the worker environment. Start it from the repository root.

```sh
pnpm --filter @devsync/worker start:codex
```

1. Create a Ready task that asks Codex to edit an existing tracked text file in the test repository. Request a Codex run, then approve it from an owner or admin account.
2. Confirm that the run succeeds and the downloaded patch contains the expected edit. Check that its base commit matches the checkout revision.
3. Open **View draft pull request** from the task’s run panel. Confirm GitHub shows a draft against the repository’s default branch and the diff matches the saved patch.
4. Record the run ID and PR URL. Restart the worker and confirm the saved link remains visible and GitHub still shows a single PR for that run branch.

For a live retry test, use a separate run and initially grant Contents read access. Confirm the run saves its patch and publication fails. Grant Contents write access and accept the updated permission on the test installation. The job becomes eligible again five minutes after the previous claim. Confirm the same run gains a draft PR link and retains its original execution result.
