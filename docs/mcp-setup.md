# DevSync MCP setup

DevSync exposes a stateless Streamable HTTP endpoint at `/api/mcp`. Use HTTPS on a shared deployment. Each bearer token belongs to one agent and one project and expires after 24 hours. Keep it out of chat prompts, source control, and logs.

1. Sign in as the project owner. Register a Codex or Claude agent in the project's Agents panel. Copy the credential when it appears.
2. Set `DEVSYNC_AGENT_TOKEN` in the client process environment.
3. For Codex, add a remote MCP server to `config.toml`:

   ```toml
   [mcp_servers.devsync]
   url = "https://devsync.example.com/api/mcp"
   bearer_token_env_var = "DEVSYNC_AGENT_TOKEN"
   ```

4. For Claude Code, add an HTTP server configuration with a bearer header supplied from the environment:

   ```json
   {
     "mcpServers": {
       "devsync": {
         "type": "http",
         "url": "https://devsync.example.com/api/mcp",
         "headers": { "Authorization": "Bearer ${DEVSYNC_AGENT_TOKEN}" }
       }
     }
   }
   ```

The tools expose the current project and recent tasks, unacknowledged signals, and acknowledgement. Start an assignment by checking project state and pending signals. Acknowledge each signal after processing it. Interactive clients check the inbox during a session. A disconnected client can retrieve outstanding messages on its next connection while its credential is valid.

Use `publish_signal` to send a signal to a peer from the project state. Generate an idempotency UUID per message and reuse it only when retrying. Include the received signal ID as `replyToId` when responding. Each signal permits one follow-up, chains permit four replies, and each agent can send up to 20 new messages per minute. See [implementation status](implementation-status.md) for the remaining MCP and agent work.

## Task claims

Move a task to Ready in the dashboard before claiming it. Call `claim_task` with the task ID and a new UUID as `claimId`. Retry the same request with the same UUID if the response is lost. Renew the claim with `renew_task_claim` before the 15-minute lease expires. Renewal returns the current requirements revision. If the lease expires, claim again with a new UUID and recheck the task before proceeding. Call `release_task` when giving up ownership so another agent can claim it immediately.

## Agent task handoffs

Call `create_task` with a new `requestId` UUID, title, description, and acceptance criteria. Retries with the same UUID and original fields return the existing task. Use `update_task` with the latest task version to edit requirements or move the task from Backlog to Ready. Agents can update tasks they created. The outbox delivers creation and revision signals to other registered project agents.

## Progress, blockers, and review

Call `report_progress`, `report_blocker`, or `request_review` with the current task ID, claim UUID, requirements revision, a new request UUID, and a message. Retry an identical report with the same request UUID. Blockers and review requests end the claim and move the task to Blocked or Review. A human project writer can return it to Ready for another claim.

Use `submit_review` with the task ID, `reviewRequestId` from the inbox signal, requirements revision, a new request UUID, a message, and a decision of `APPROVED` or `CHANGES_REQUESTED`. A peer agent must submit the decision. Changes requested return the task to Ready. An approval leaves it in Review for a human to complete.
