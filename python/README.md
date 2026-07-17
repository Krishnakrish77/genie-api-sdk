# genie-api-sdk

Unofficial Python client for the Genie Headless API. It is community-maintained and not affiliated with or endorsed by Workato.

For installation, supported workflows, and testing, see the repository [developer guide](../docs/developer-guide.md).

```python
from genie_api_sdk import ApiKeyAuth, GenieClient

client = GenieClient(auth=ApiKeyAuth("…", "user-123"))
conversation = client.create_conversation("my-genie")

for event in client.stream_message("my-genie", conversation.conversation_id, "Summarize my open deals"):
    if event.type == "agent.message":
        print(event.data["message"])
```

For OAuth, pass `OAuthAuth(lambda: current_access_token())` as `auth`.

For rotating OAuth credentials, use `RefreshableOAuthAuth`. Its `refresh_and_persist` callback must atomically refresh and save the winning token set (for example, with a database transaction or distributed lock).

Use `AsyncGenieClient` with `async with` for ASGI applications and other asynchronous services. `stream_message()` automatically reconnects interrupted streams; use its `max_reconnects` flag to tune recovery.
