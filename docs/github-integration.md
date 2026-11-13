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
