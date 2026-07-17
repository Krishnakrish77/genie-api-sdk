# Workato Genie Headless API SDKs

Platform-neutral SDKs for the [Workato Genie Headless API](https://docs.workato.com/en/agentic/agent-studio/chat-interface/headless-api).

This repository contains independent Python and TypeScript packages. They provide conversation management, streaming events, approvals, runtime-connection authorization, and file uploads. Channel integrations (Telegram, web chat, Slack, and so on) belong in applications built on these clients.

## Packages

- [`python/`](python/README.md) — `workato-genie`
- [`typescript/`](typescript/README.md) — `@workato/genie-api`

See the [developer guide](docs/developer-guide.md) for setup, authentication, core workflows, event handling, and local testing.

> The Workato Headless API is currently in private beta. You need a configured custom chat interface and an attached Genie client before using either SDK.
