# Developer guide

This repository supplies two independent, platform-neutral clients for the Workato Genie Headless API:

- Python: `genie-api-sdk` (imported as `genie_api_sdk`)
- TypeScript: `genie-api-sdk`

Use them in a server, web application backend, CLI, or channel adapter. The SDKs do not include Telegram, Slack, or any UI dependency.

These are unofficial, community-maintained SDKs and are not affiliated with or endorsed by Workato.

## Prerequisites

The Workato Headless API is in private beta. Before calling it, create a Genie, configure its custom chat interface, attach a Genie client, and obtain access to the feature. See [Workato's Headless API documentation](https://docs.workato.com/en/agentic/agent-studio/chat-interface/headless-api).

Set the following environment variables for API-key authentication:

```sh
export WORKATO_API_KEY='your-genie-client-api-key'
export WORKATO_IDP_USER_ID='your-workato-idp-user-id'
export WORKATO_GENIE_HANDLE='your-genie-handle'
```

Never commit API keys, access tokens, or end-user IDs.

## Install

### Python

Python 3.10 or later is required.

```sh
python -m pip install genie-api-sdk
```

### TypeScript

Node.js 20.19 or later is required.

```sh
npm install genie-api-sdk
```

To install the npm beta channel, use `npm install genie-api-sdk@beta`. Python prereleases require `python -m pip install --pre genie-api-sdk` when no stable release is selected.

## Authentication

API-key authentication is appropriate for backend integrations. It requires both the static API key and the Workato IdP user ID. OAuth applications provide an end user's Workato access token instead.

```python
from genie_api_sdk import ApiKeyAuth, GenieClient, OAuthAuth

client = GenieClient(auth=ApiKeyAuth("...", "user-123"))
# or
client = GenieClient(auth=OAuthAuth(lambda: current_access_token()))
```

```ts
import { ApiKeyAuth, GenieClient, OAuthAuth } from "genie-api-sdk";

const apiKeyClient = new GenieClient({ auth: new ApiKeyAuth("...", "user-123") });
const oauthClient = new GenieClient({ auth: new OAuthAuth(() => currentAccessToken()) });
```

Use `base_url` (Python) or `baseUrl` (TypeScript) only when targeting a different Workato data center or a test server.

### OAuth PKCE

For an OAuth browser flow, use `OAuthPkce` rather than implementing the protocol in your application. It is a public-client helper: it generates a state and S256 verifier, validates state before exchanging the callback, and never sends a client secret. Store the returned login request and tokens in your own protected session or database.

```ts
import { OAuthPkce } from "genie-api-sdk";

const oauth = new OAuthPkce({ clientId, redirectUri }); // Production US identity by default
const login = await oauth.createAuthorizationRequest(); // persist login; redirect to login.authorizationUrl
const tokens = await oauth.exchangeCallback(callbackUrl, login); // persist tokens
const auth = oauth.refreshableAuth(loadTokens, persistTokens);
```

```python
from genie_api_sdk import OAuthPkce

oauth = OAuthPkce(client_id=client_id, redirect_uri=redirect_uri)  # Production US identity by default
login = oauth.create_authorization_request()  # persist login; redirect to login.authorization_url
tokens = oauth.exchange_callback(callback_url, login)  # persist tokens
auth = oauth.refreshable_auth(load_tokens=load_tokens, persist_tokens=persist_tokens)
```

For Preview or a custom identity environment, pass `identityBaseUrl` / `identity_base_url` (for example, `https://id.preview.workato.com`). The redirect URI must exactly match the OAuth Genie client configuration.

For rotating OAuth refresh tokens, use `RefreshableOAuthAuth` (or `AsyncRefreshableOAuthAuth`). Your application supplies `load_tokens` and a single `refresh_and_persist` transaction; the latter must use a distributed lock or compare-and-swap when multiple processes share token storage. It must return the persisted winning token set. The SDK serializes refreshes within one client instance but never stores credentials itself. The token provider is consulted for every request and stream reconnection.

When a safe read receives an authentication failure, a refreshable strategy is forced to refresh once and the read is retried once. Message submission, uploads, approvals, and other writes are never retried automatically.

## Errors

All API failures expose a status code, parsed response body, and request ID when the service sends `X-Request-Id`. Catch typed errors such as `AuthenticationError` (401), `RateLimitError` (429), and `InternalServerError` (5xx) to make recovery decisions without matching error text. This mirrors the typed status-error approach used by mature API SDKs. [OpenAI Python error handling](https://github.com/openai/openai-python/blob/main/README.md)

## Core workflow

Create a conversation once, persist its ID against your application's user/channel identifier, then use that ID for every turn.

### Python

```python
from genie_api_sdk import ApiKeyAuth, GenieClient

handle = "my-genie"
with GenieClient(auth=ApiKeyAuth("...", "user-123")) as client:
    conversation = client.create_conversation(handle)
    for event in client.stream_message(handle, conversation.conversation_id, "Show my open deals"):
        if event.type == "agent.message":
            print(event.data["message"])
```

### TypeScript

```ts
import { ApiKeyAuth, GenieClient } from "genie-api-sdk";

const handle = "my-genie";
const client = new GenieClient({ auth: new ApiKeyAuth("...", "user-123") });
const conversation = await client.createConversation(handle);

for await (const event of client.streamMessage(handle, conversation.conversation_id, "Show my open deals")) {
  if (event.type === "agent.message") console.log(event.data.message);
}
```

Call `send_message` / `sendMessage` when you want the asynchronous `Run` response instead of holding an SSE connection. Persist its `genie_run_id`; it lets you reconnect after a disconnect.

The SDK accepts both the documented response body and the `{ "result": ... }` envelope emitted by some beta gateway deployments, including the beta gateway's `conversations` collection name for conversation lists.

## SSE event handling and recovery

Streams end normally with `processing.finished`. Ignore `system.ping`. Treat `system.stream_interrupted` as a recovery signal, not a failed turn.

`stream_message` / `streamMessage` starts a new streamed turn. It reconnects with the most recent event ID and replays persisted events after repeated interruption:

```python
from genie_api_sdk import AgentMessageEvent

for event in client.stream_message(handle, conversation_id, "Show my open deals"):
    if isinstance(event, AgentMessageEvent):
        print(event.message)
```

```ts
for await (const event of client.streamMessage(handle, conversationId, "Show my open deals")) {
  if (isAgentMessageEvent(event)) console.log(event.data.message);
}
```

The SDK retries three interrupted streams by default, honoring the server's `retry_after_ms` delay. Set `max_reconnects` / `maxReconnects` on `stream_message` / `streamMessage` when your application needs a different limit. After that limit, it replays persisted events automatically. Workato retains events for 24 hours. TypeScript callers can pass an `AbortSignal` as the final `streamMessage` argument to cancel an active stream or recovery wait.

### Resume a persisted stream

Persist the conversation ID, Genie run ID, and most recent SSE event ID while a turn is in progress. If your application restarts or the browser reconnects, call `stream_run` / `streamRun` rather than posting the message again. The SDK sends `Last-Event-ID` when one is supplied, automatically reconnects further interruptions, and falls back to the persisted-events endpoint after its reconnect limit.

```python
for event in client.stream_run(handle, conversation_id, genie_run_id, last_event_id=last_event_id):
    handle_event(event)
```

```ts
for await (const event of client.streamRun(handle, conversationId, genieRunId, { lastEventId })) {
  handleEvent(event);
}
```

## Paused turns

When receiving `skill.confirmation_required`, show the user enough context to decide and submit the supplied `call_id`:

```python
client.resolve_skill_approval(handle, conversation_id, call_id, "approved")
# client.resolve_skill_approval(handle, conversation_id, call_id, "rejected", rejection_reason="Not authorized")
```

```ts
await client.resolveSkillApproval(handle, conversationId, callId, "approved");
```

When receiving `runtime_connection.auth_required`, call `get_runtime_connection_link` / `getRuntimeConnectionLink` with the event's `runtime_connection_attempt_id`; present the returned authentication link to the user. If they decline, call `reject_runtime_connection` / `rejectRuntimeConnection`.

Use `resolve_business_approval` / `resolveBusinessApproval` for a business-approval `call_id`, with the same `approved` or `rejected` resolution. After a completed run, submit an optional rating with `submit_feedback` / `submitFeedback` using `positive` or `negative` and, optionally, a comment.

The original SSE stream remains open and resumes after the resolution. Keep rendering that stream; do not poll or start a second stream for the paused turn.

## Files and history

Upload a file first, then pass its returned `file_id` / `fileId` to `stream_message` / `streamMessage` or `send_message` / `sendMessage`. File size is limited by Workato (currently 20 MB).

Use `list_conversations` / `listConversations`, `get_conversation` / `getConversation`, and `list_messages` / `listMessages` to build history views. List endpoints return a `cursor` when another page is available.

## Local development

Run checks from the repository root:

```sh
env PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=python/src python -m pytest -q python/tests
python -m compileall -q python/src
cd typescript && npm run check && npm test
```

The test suite must not call the live Workato service. Use `httpx.MockTransport` in Python and injected `fetch` implementations in TypeScript.

## Example application and real API smoke test

The [web chat example](../examples/web-chat/README.md) is a responsive,
end-user-facing interface built on the TypeScript SDK. Its Node.js server holds
the API key and streams SDK events to the browser. It makes skill confirmation
and runtime-connection authorization explicit user actions instead of
automatically accepting either.

`examples/web-chat/test/e2e-smoke.mjs` is deliberately excluded from CI. It starts
the sample server and only contacts a workspace when `GENIE_E2E=1` and the
`WORKATO_API_KEY`, `WORKATO_IDP_USER_ID`, and `WORKATO_GENIE_HANDLE`
environment variables are set. Run it only against a non-production workspace.

## Async Python

`AsyncGenieClient` mirrors the synchronous Python API and owns an `httpx.AsyncClient` by default:

```python
from genie_api_sdk import ApiKeyAuth, AsyncGenieClient

async with AsyncGenieClient(auth=ApiKeyAuth("...", "user-123")) as client:
    async for event in client.stream_message("my-genie", "conversation-id", "Hello"):
        process(event)
```
