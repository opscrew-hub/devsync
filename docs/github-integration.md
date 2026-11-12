# GitHub webhook intake

DevSync accepts signed GitHub App webhook deliveries at `/api/webhooks/github`. Configure a webhook secret in the app environment and use the same value in GitHub. Use HTTPS for the webhook URL. Keep the secret out of source control.

Set `GITHUB_WEBHOOK_REPOSITORIES` to comma-separated installation and repository ID pairs, such as `123:456,123:789`. Use the numeric installation and repository IDs from the GitHub App installation. Enable only repositories the deployment operator intends to receive. An empty list accepts signed pings and ignores unsupported event types while rejecting supported repository events.

Intake supports pushes, pull requests, pull request reviews, check runs, check suites, and workflow runs. Requests have a 2 MiB limit. A new delivery returns HTTP 202 and a duplicate returns HTTP 200. The verified JSON is persisted by delivery ID, installation ID, and repository ID. Limit database access to trusted operators because payloads may contain private repository content.

This slice persists webhook deliveries. Project linking, GitHub App token management, event processing, and dashboard synchronization are pending.

[GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
