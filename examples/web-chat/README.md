# Genie web chat example

A polished, responsive chat interface for end users. The browser never receives
the API key: `server.mjs` holds the credentials, calls the TypeScript SDK, and
streams normalized events to the page.

It intentionally requires people to approve skill actions and runtime
connections; it never auto-approves either one.

## Run locally

Use Node.js 18 or later, then configure a Genie client in a non-production
workspace:

```sh
cd examples/web-chat
cp .env.example .env
# Edit .env with your non-production values, then load it into this shell.
set -a && source .env && set +a
npm start
```

Open the printed localhost URL in your browser. `npm start` first builds the
local TypeScript SDK, then starts the example server.

Set `WORKATO_BASE_URL` only for another Workato data center or a test server.
The server does not load `.env` automatically, so the explicit shell command
keeps the example dependency-free. Do not expose the API key to browser code or
commit `.env`.

## Tests

```sh
npm test
```

## Opt-in end-to-end smoke test

This starts the sample app on a temporary local port, creates one real
conversation, and streams one benign prompt through the app's own HTTP routes.
It is excluded from CI and refuses to run unless explicitly enabled:

```sh
GENIE_E2E=1 npm run e2e
```

Run it only against a non-production workspace. Override the default prompt
with `GENIE_E2E_MESSAGE` if required.

## Production notes

This is a UI example, not a complete production deployment. Before exposing it
to users, put the server behind your application's authentication and
authorization layer, persist conversations per authenticated user, validate
request origins, and add rate limiting and observability.
