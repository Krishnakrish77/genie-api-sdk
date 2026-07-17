# Genie Headless API SDKs

Platform-neutral SDKs for the [Workato Genie Headless API](https://docs.workato.com/en/agentic/agent-studio/chat-interface/headless-api).

> Unofficial, community-maintained SDKs. They are not affiliated with or endorsed by Workato.

This repository contains independent Python and TypeScript packages. They provide conversation management, streaming events, approvals, runtime-connection authorization, and file uploads. Channel integrations (Telegram, web chat, Slack, and so on) belong in applications built on these clients.

## Packages

- [`python/`](python/README.md) — `genie-api-sdk` / `genie_api_sdk`
- [`typescript/`](typescript/README.md) — `genie-api-sdk`

See the [developer guide](docs/developer-guide.md) for setup, authentication, core workflows, event handling, and local testing.

## Beta releases

Python beta releases use PEP 440 versions such as `0.1.0b1`; npm uses the equivalent SemVer version such as `0.1.0-beta.1`. Install npm beta releases explicitly with the `beta` dist-tag.

> The Workato Headless API is currently in private beta. You need a configured custom chat interface and an attached Genie client before using either SDK.
