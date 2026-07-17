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

Python 3.9 or later is required.

```sh
cd python
python -m pip install -e '.[dev]'
```

### TypeScript

Node.js 18 or later is required.

```sh
cd typescript
npm install
npm run build
```

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

For rotating OAuth refresh tokens, use `RefreshableOAuthAuth` (or `AsyncRefreshableOAuthAuth`). Your application supplies `load_tokens` and a single `refresh_and_persist` transaction; the latter must use a distributed lock or compare-and-swap when multiple processes share token storage. It must return the persisted winning token set. The SDK serializes refreshes within one client instance but never stores credentials itself. The token provider is consulted for every request and stream reconnection.

When a safe read receives an authentication failure, a refreshable strategy is forced to refresh once and the read is retried once. Message submission, uploads, approvals, and other writes are never retried automatically.

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

## SSE event handling and recovery

Streams end normally with `processing.finished`. Ignore `system.ping`. Treat `system.stream_interrupted` as a recovery signal, not a failed turn.

`stream_message` / `streamMessage` is the single streaming API. It reconnects with the most recent event ID and replays persisted events after repeated interruption:

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

The SDK retries three interrupted streams by default. Set `max_reconnects` / `maxReconnects` on `stream_message` / `streamMessage` when your application needs a different limit. After that limit, it replays persisted events automatically. Workato retains events for 24 hours.

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

## Async Python

`AsyncGenieClient` mirrors the synchronous Python API and owns an `httpx.AsyncClient` by default:

```python
from genie_api_sdk import ApiKeyAuth, AsyncGenieClient

async with AsyncGenieClient(auth=ApiKeyAuth("...", "user-123")) as client:
    async for event in client.stream_message("my-genie", "conversation-id", "Hello"):
        process(event)
```
