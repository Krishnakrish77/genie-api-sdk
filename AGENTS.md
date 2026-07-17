# Repository instructions

## Scope

This repository contains two separate SDKs for the Workato Genie Headless API:

- `python/`: synchronous Python package, `workato_genie`
- `typescript/`: Node.js 18+ ESM package, `@workato/genie-api`

Keep the packages platform-neutral. Do not add Telegram, Slack, web-framework, or UI dependencies to either SDK. Put any channel integration in a separate application or example package.

## API design

- Keep the Python and TypeScript surfaces conceptually equivalent; use idiomatic snake_case in Python and camelCase methods/options in TypeScript.
- Support API-key authentication with an IdP user ID and OAuth access tokens. Never log credentials or mutate a caller-provided HTTP client's authentication state.
- Preserve the Headless API's SSE event payloads. New event types must be safely pass-through compatible.
- Treat stream interruption as recoverable: retain support for `Last-Event-ID`, `genie_run_id`, and event replay.
- URL-encode caller-supplied path identifiers.

## Quality checks

Before finishing an SDK change, run the relevant checks:

```sh
env PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=python/src python -m pytest -q python/tests
python -m compileall -q python/src
cd typescript && npm run check && npm test
```

Add regression tests for authentication, HTTP serialization, and SSE parsing changes. Tests must use mocks or injected transports; never require a real Workato workspace or credentials.

## Documentation

Update `docs/developer-guide.md` and the relevant package README when changing public behavior, installation, configuration, or supported API operations.
