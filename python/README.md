# genie-api-sdk

Unofficial Python client for the Genie Headless API. It is community-maintained and not affiliated with or endorsed by Workato. Requires Python 3.10+.

For installation, supported workflows, and testing, see the repository [developer guide](../docs/developer-guide.md).

```python
from genie_api_sdk import ApiKeyAuth, GenieClient

client = GenieClient(auth=ApiKeyAuth("…", "user-123"))
conversation = client.create_conversation("my-genie")

for event in client.stream_message("my-genie", conversation.conversation_id, "Summarize my open deals"):
    if event.type == "agent.message":
        print(event.data["message"])
```

For browser OAuth, use `OAuthPkce`. Save its returned state, verifier, and tokens in your application's protected session; the SDK deliberately does not choose storage. It defaults to Production US; set `identity_base_url` for Preview or a custom environment.

```python
from genie_api_sdk import GenieClient, OAuthPkce

oauth = OAuthPkce(client_id="client-id", redirect_uri="https://app.example/auth/callback", identity_base_url="https://id.preview.workato.com")
login = oauth.create_authorization_request()  # save login, then redirect to login.authorization_url
tokens = oauth.exchange_callback(callback_url, login)  # save tokens
client = GenieClient(auth=oauth.refreshable_auth(load_tokens=load_tokens, persist_tokens=persist_tokens))
```

For rotating OAuth credentials, use `RefreshableOAuthAuth`. Its `refresh_and_persist` callback must atomically refresh and save the winning token set (for example, with a database transaction or distributed lock).

Use `AsyncGenieClient` with `async with` for ASGI applications and other asynchronous services. `stream_message()` automatically reconnects interrupted streams; use its `max_reconnects` flag to tune recovery.
