# Changelog

All notable changes are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `npm run test:e2e` (TypeScript): opt-in live end-to-end suite (`test/e2e.live.mjs`) covering conversation creation, streaming, history reads, file upload + attachment, feedback, and event listing against a real workspace. Gated on `GENIE_E2E=1` plus the usual `WORKATO_*` credentials (same convention as the web-chat e2e smoke); skips cleanly without them. Use a non-production workspace.

### Fixed

- TypeScript error handling no longer crashes with `TypeError: Body already used` on non-JSON error bodies (e.g. a plain-text 404 from an unknown route); the body is read once as text, then JSON-parsed if possible. Found by the nexus harness's regression test.
- TypeScript `submitFeedback` (and any other JSON-expecting call) no longer crashes on success responses with empty bodies — the feedback endpoint returns `202 Accepted` with no content. Found by the new live e2e suite.
- TypeScript `getConversation` now includes `conversation_id`: the API omits it from the single-conversation response (it's in the request URL), so the SDK fills it in for the `Conversation` type to hold at runtime. Found by the new live e2e suite.
- Python streaming endpoints (`stream_message`, `stream_run`) raised `httpx.ResponseNotRead` instead of typed errors like `AuthenticationError` when the server rejected a stream request; the response body is now read before status handling. Both SDKs now request the documented `openid profile email` OAuth scope instead of `openid profile`.

### Changed

- **Breaking (beta):** TypeScript `sendMessage` and `streamMessage` now take an options object (`{ fileId }` and `{ fileId, maxReconnects, signal }`) instead of trailing positional parameters, matching `streamRun` and the list methods. Python keyword-only arguments are unchanged.

## [0.1.0-beta.1] - 2026-07-17

### Added

- Python and TypeScript Genie Headless API SDKs.
- Async Python client, resilient streaming, typed events, and provider-based authentication.
