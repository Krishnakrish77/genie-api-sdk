# Changelog

All notable changes are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- TypeScript error handling no longer crashes with `TypeError: Body already used` on non-JSON error bodies (e.g. a plain-text 404 from an unknown route); the body is read once as text, then JSON-parsed if possible. Found by the nexus harness's regression test.

### Changed

- **Breaking (beta):** TypeScript `sendMessage` and `streamMessage` now take an options object (`{ fileId }` and `{ fileId, maxReconnects, signal }`) instead of trailing positional parameters, matching `streamRun` and the list methods. Python keyword-only arguments are unchanged.

## [0.1.0-beta.1] - 2026-07-17

### Added

- Python and TypeScript Genie Headless API SDKs.
- Async Python client, resilient streaming, typed events, and provider-based authentication.
