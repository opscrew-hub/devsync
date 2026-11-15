# Research: managed runs paid through OpenRouter

2026-11-16. Can a managed run's Claude Code use an OpenRouter API key instead of an Anthropic one?
Official sources only, plus one local check.

## What the sources say

- **OpenRouter supports Claude Code**
  ([Claude Code integration](https://openrouter.ai/docs/guides/guides/claude-code-integration)):
  - `ANTHROPIC_BASE_URL=https://openrouter.ai/api`.
  - `ANTHROPIC_AUTH_TOKEN` set to the OpenRouter key, sent as `Authorization: Bearer`.
  - `ANTHROPIC_API_KEY` set explicitly empty, or Claude Code may go to Anthropic directly.
  - Optional model overrides (`ANTHROPIC_DEFAULT_*_MODEL`).
  - Claude Code is "only guaranteed to work with the Anthropic first-party provider". OpenRouter
    recommends putting Anthropic first in the account's provider routing; requests may fail over
    between providers of the same model.
- **Claude Code's side**
  ([LLM gateways](https://code.claude.com/docs/en/llm-gateway-connect)):
  `ANTHROPIC_AUTH_TOKEN` goes in `Authorization: Bearer`, `ANTHROPIC_API_KEY` in `x-api-key`.
  [LLM gateway](https://code.claude.com/docs/en/llm-gateway): Claude Code is not supported with
  non-Claude models through any gateway.
- **`--bare`** ([headless](https://code.claude.com/docs/en/headless)): bare mode never reads OAuth
  credentials or the keychain; for the Anthropic API it takes `ANTHROPIC_API_KEY` or an
  `apiKeyHelper`. The page says nothing about `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.
- **Cost** ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)):
  `total_cost_usd` is "a client-side estimate, not authoritative billing data", computed from a
  bundled Anthropic price table. Through OpenRouter it doesn't show what OpenRouter bills.

## Checked locally

Claude Code 2.1.316, `claude --bare -p --output-format json --settings <file>`, with
`ANTHROPIC_BASE_URL` set to a local HTTP server, `ANTHROPIC_AUTH_TOKEN` set to a dummy value and
`ANTHROPIC_API_KEY` empty, in a clean environment. Every request went to the local server
(`POST /v1/messages`) with `Authorization: Bearer <token>` and no `x-api-key`. So bare mode honours
both variables; with OpenRouter's base URL the requests go to `https://openrouter.ai/api/v1/messages`.

## Decision

A managed run takes either key: `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` (both repository or
organization Actions secrets). With both, the Anthropic key is used. Through OpenRouter, the agent
step sets the three variables above and nothing else; models stay Claude's (Claude Code's
defaults). The run reports which provider it used, and its cost is shown as Claude Code's estimate.
Design and task: [managed-runs.md](../managed-runs.md), "Paying through OpenRouter".

Left to the live test: a real run through OpenRouter (the draft pull request, the reported tokens).
