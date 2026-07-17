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
client = GenieClient(api_key="...", idp_user_id="user-123")
# or
client = GenieClient(access_token="oauth-access-token")
```

```ts
const apiKeyClient = new GenieClient({ apiKey: "...", idpUserId: "user-123" });
const oauthClient = new GenieClient({ accessToken: "oauth-access-token" });
```

Use `base_url` (Python) or `baseUrl` (TypeScript) only when targeting a different Workato data center or a test server.

## Core workflow

Create a conversation once, persist its ID against your application's user/channel identifier, then use that ID for every turn.

### Python

```python
from genie_api_sdk import GenieClient

handle = "my-genie"
with GenieClient(api_key="...", idp_user_id="user-123") as client:
    conversation = client.create_conversation(handle)
    for event in client.stream_message(handle, conversation.conversation_id, "Show my open deals"):
        if event.type == "agent.message":
            print(event.data["message"])
```

### TypeScript

```ts
import { GenieClient } from "genie-api-sdk";

const handle = "my-genie";
const client = new GenieClient({ apiKey: "...", idpUserId: "user-123" });
const conversation = await client.createConversation(handle);

for await (const event of client.streamMessage(handle, conversation.conversation_id, "Show my open deals")) {
  if (event.type === "agent.message") console.log(event.data.message);
}
```

Call `send_message` / `sendMessage` when you want the asynchronous `Run` response instead of holding an SSE connection. Persist its `genie_run_id`; it lets you reconnect after a disconnect.

## SSE event handling and recovery

Streams end normally with `processing.finished`. Ignore `system.ping`. Treat `system.stream_interrupted` as a recovery signal, not a failed turn.

Reconnect from the last successfully persisted event ID:

```python
for event in client.reconnect(handle, conversation_id, genie_run_id, last_event_id=last_event_id):
    process(event)
```

```ts
for await (const event of client.reconnect(handle, conversationId, genieRunId, lastEventId)) {
  process(event);
}
```

For longer outages, use `list_events` / `listEvents`, store `next_since_created_at`, and replay the returned events. Workato retains events for 24 hours.

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
