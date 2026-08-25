# genie-api-sdk

Unofficial TypeScript client for the Genie Headless API. It is community-maintained and not affiliated with or endorsed by Workato. Requires Node.js 20.19+.

For installation, supported workflows, and testing, see the repository [developer guide](../docs/developer-guide.md).

```ts
import { ApiKeyAuth, GenieClient } from "genie-api-sdk";

const client = new GenieClient({ auth: new ApiKeyAuth(process.env.WORKATO_API_KEY!, "user-123") });
const conversation = await client.createConversation("my-genie");

for await (const event of client.streamMessage("my-genie", conversation.conversation_id, "What needs attention?")) {
  if (event.type === "agent.message") console.log(event.data.message);
}
```

For browser OAuth, use the SDK PKCE helper. Store `state`, `codeVerifier`, and tokens in your application's protected session; the SDK deliberately does not choose storage. The helper defaults to Production US. Set `identityBaseUrl` for Preview or a custom environment.

```ts
import { GenieClient, OAuthPkce } from "genie-api-sdk";

const oauth = new OAuthPkce({ clientId: process.env.WORKATO_OAUTH_CLIENT_ID!, redirectUri: "https://app.example/auth/callback", identityBaseUrl: "https://id.preview.workato.com" });
const login = await oauth.createAuthorizationRequest(); // save login, then redirect to login.authorizationUrl
const tokens = await oauth.exchangeCallback(callbackUrl, login); // save tokens
const client = new GenieClient({ auth: oauth.refreshableAuth(() => loadTokens(), (next) => persistTokens(next)) });
```

For rotating OAuth credentials, use `RefreshableOAuthAuth`. Its `refreshAndPersist` callback must atomically refresh and persist the winning token set (for example, with a database transaction or distributed lock).

`streamMessage()` reconnects interrupted streams automatically; use its `maxReconnects` flag to tune recovery. To resume a persisted run after an application restart, call `streamRun(handle, conversationId, genieRunId, { lastEventId })`. Type guards such as `isAgentMessageEvent()` narrow common event payloads safely.
