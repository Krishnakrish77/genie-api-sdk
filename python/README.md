# workato-genie

Python client for the Workato Genie Headless API.

For installation, supported workflows, and testing, see the repository [developer guide](../docs/developer-guide.md).

```python
from workato_genie import GenieClient

client = GenieClient(api_key="…", idp_user_id="user-123")
conversation = client.create_conversation("my-genie")

for event in client.stream_message("my-genie", conversation.conversation_id, "Summarize my open deals"):
    if event.type == "agent.message":
        print(event.data["message"])
```

For OAuth access tokens, construct the client with `access_token` instead of `api_key` and `idp_user_id`.
