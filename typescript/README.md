# genie-api-sdk

Unofficial TypeScript client for the Genie Headless API. It is community-maintained and not affiliated with or endorsed by Workato. Requires Node.js 18+.

For installation, supported workflows, and testing, see the repository [developer guide](../docs/developer-guide.md).

```ts
import { ApiKeyAuth, GenieClient } from "genie-api-sdk";

const client = new GenieClient({ auth: new ApiKeyAuth(process.env.WORKATO_API_KEY!, "user-123") });
const conversation = await client.createConversation("my-genie");

for await (const event of client.streamMessage("my-genie", conversation.conversation_id, "What needs attention?")) {
  if (event.type === "agent.message") console.log(event.data.message);
}
```

Use `new OAuthAuth(() => currentAccessToken())` as `auth` for OAuth-authenticated applications.

`streamMessage()` reconnects interrupted streams automatically; use its `maxReconnects` flag to tune recovery. Type guards such as `isAgentMessageEvent()` narrow common event payloads safely.
