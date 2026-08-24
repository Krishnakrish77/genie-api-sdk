# Genie web chat example

A polished, responsive chat interface for end users. The browser never receives
the API key or OAuth tokens: `server.mjs` holds credentials, calls the TypeScript SDK, and
streams normalized events to the page.

It intentionally requires people to approve skill actions and runtime
connections; it never auto-approves either one. After an approval, it refreshes
the current conversation briefly so a completed paused turn appears without a
browser reload. Replayed approval events are de-duplicated by call ID.

## Run locally

Use Node.js 20.19 or later, then configure a Genie client in a non-production
workspace:

```sh
cd examples/web-chat
npm install
cp .env.example .env
# Edit .env with your non-production values.
npm start
```

Open the printed localhost URL in your browser. The application automatically
loads its local `.env` file at startup, while real deployment environment
variables take precedence.

Press Enter to send a message; use Shift+Enter for a new line. Genie responses
render sanitized GitHub-flavored Markdown, including headings, lists, links,
code blocks, and tables. The app also loads the authenticated user's recent
conversations and lets them resume a chat with its message history.

Set `WORKATO_BASE_URL` only for another Workato data center or a test server.
Do not expose the API key or tokens to browser code or commit `.env`.

The default API-key mode uses `WORKATO_API_KEY` and `WORKATO_IDP_USER_ID`. For browser OAuth validation, omit those and set `WORKATO_OAUTH_CLIENT_ID` and `WORKATO_OAUTH_REDIRECT_URI`. Visit `/auth/login`; the sample uses the SDK's PKCE helper and creates a request-scoped OAuth client from the signed-in session. Set `WORKATO_IDENTITY_BASE_URL` for Preview/custom identity environments.

The sample session map is intentionally in-memory. Restarting the server during login or later loses the session and shows a login-again message. Production applications need durable, protected session and token storage.

Until the beta package is published, run this copy from the repository by
building and installing the local SDK once:

```sh
(cd ../../typescript && npm ci && npm run build)
npm install --no-save --no-package-lock ../../typescript
```

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
