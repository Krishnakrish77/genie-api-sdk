import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { applyDotEnv, configuration, createApp } from "../server.mjs";

const environment = { WORKATO_API_KEY: "key", WORKATO_IDP_USER_ID: "user", WORKATO_GENIE_HANDLE: "genie" };

test("requires server-side credentials", () => {
  assert.throws(() => configuration({}), /WORKATO_API_KEY/);
});

test("OAuth configuration uses the SDK helper inputs instead of API-key credentials", () => {
  const config = configuration({ WORKATO_OAUTH_CLIENT_ID: "client", WORKATO_OAUTH_REDIRECT_URI: "https://app.example/auth/callback", WORKATO_GENIE_HANDLE: "genie", WORKATO_IDENTITY_BASE_URL: "https://identity.preview.example" });
  assert.equal(config.mode, "oauth");
  assert.equal(config.oauth.identityBaseUrl, "https://identity.preview.example");
});

test("loads .env values without overriding deployment environment variables", () => {
  const environment = { PORT: "9090" };
  applyDotEnv("WORKATO_API_KEY='key with spaces'\nPORT=3000 # ignored\nWORKATO_IDP_USER_ID=user\nWORKATO_GENIE_HANDLE=genie", environment);
  assert.deepEqual(environment, { WORKATO_API_KEY: "key with spaces", WORKATO_IDP_USER_ID: "user", WORKATO_GENIE_HANDLE: "genie", PORT: "9090" });
});

test("composer sends on Enter and preserves Shift+Enter for a new line", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing/);
  assert.match(script, /composer\.requestSubmit\(\)/);
  assert.match(script, /let conversationId = null/);
  assert.match(script, /function scrollToLatest/);
  assert.match(script, /scrollToLatest\(true\)/);
  assert.match(script, /const resolvedActionIds = new Set\(\)/);
  assert.match(script, /const visibleActionCards = new Map\(\)/);
  assert.match(script, /const completedRunIds = new Set\(\)/);
  assert.match(script, /dismissCompletedRunActions\(event\.genie_run_id\)/);
  assert.doesNotMatch(script, /resumeRunAfterApproval/);
  assert.match(script, /skill:\$\{pendingConversationId\}:\$\{event\.data\.skill_name\}/);
  assert.match(script, /\["skill\.completed", "skill\.stopped", "skill\.failed"\]/);
});

test("renders Genie Markdown with a maintained parser and sanitizer", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /import \{ marked \} from "\/vendor\/marked\.js"/);
  assert.match(script, /import DOMPurify from "\/vendor\/dompurify\.js"/);
  assert.match(script, /function renderMarkdown/);
  assert.match(script, /renderMarkdown\(assistant, event\.data\.message/);
  assert.match(script, /marked\.parse\(/);
  assert.match(script, /DOMPurify\.sanitize/);
  assert.doesNotMatch(script, /function appendInlineMarkdown/);
});

test("serves the chat UI and rejects an empty message before calling the API", async () => {
  const server = createApp(environment);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /What can we make easier today/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/vendor/marked.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/vendor/dompurify.js`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/example/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: " " })
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("exposes server-side conversation history routes", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /client\.listConversations\(config\.genieHandle\)/);
  assert.match(source, /client\.listMessages\(config\.genieHandle, decodeURIComponent\(historyRoute\[1\]\)\)/);
  assert.doesNotMatch(source, /\/resume\$/);
});

test("OAuth login stores the PKCE request, accepts its callback, and rejects a callback after a restart", async () => {
  let exchanged = false;
  let scopedAuth = false;
  const oauthPkce = {
    async createAuthorizationRequest() { return { authorizationUrl: "https://identity.example/oauth/authorize?state=state", state: "state", codeVerifier: "verifier" }; },
    async exchangeCallback(_url, login) { exchanged = login.state === "state"; return { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 60_000) }; },
    refreshableAuth() { scopedAuth = true; return { headers() { throw new Error("request-scoped auth was used"); } }; }
  };
  const server = createApp({ WORKATO_OAUTH_CLIENT_ID: "client", WORKATO_OAUTH_REDIRECT_URI: "https://app.example/auth/callback", WORKATO_GENIE_HANDLE: "genie" }, { oauthPkce });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/auth/login");
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "https://identity.example/oauth/authorize?state=state");
    assert.match(login.headers.get("set-cookie"), /genie_session=/);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const invalid = await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=wrong`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(invalid.status, 400);
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=state`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/");
    assert.equal(exchanged, true);
    const scopedRequest = await fetch(`http://127.0.0.1:${port}/api/conversations`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(scopedRequest.status, 500);
    assert.equal(scopedAuth, true);
    const expired = await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=state`, { redirect: "manual" });
    assert.equal(expired.status, 401);
    assert.match((await expired.json()).error, /restart and sign in again/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("exchanges the callback against the public redirect_uri, not the internal request origin", async () => {
  let exchangedUrl;
  const oauthPkce = {
    async createAuthorizationRequest() { return { authorizationUrl: "https://identity.example/oauth/authorize?state=state", state: "state", codeVerifier: "verifier" }; },
    async exchangeCallback(url) { exchangedUrl = String(url); return { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 60_000) }; },
    refreshableAuth() { return { headers: async () => ({}) }; }
  };
  const server = createApp({ WORKATO_OAUTH_CLIENT_ID: "client", WORKATO_OAUTH_REDIRECT_URI: "https://app.example/auth/callback", WORKATO_GENIE_HANDLE: "genie" }, { oauthPkce });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=state`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(exchangedUrl, "https://app.example/auth/callback?code=code&state=state");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("reuses one refreshable OAuth auth per session instead of rebuilding it per request", async () => {
  let refreshableAuthCalls = 0;
  const oauthPkce = {
    async createAuthorizationRequest() { return { authorizationUrl: "https://identity.example/oauth/authorize?state=state", state: "state", codeVerifier: "verifier" }; },
    async exchangeCallback() { return { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 60_000) }; },
    refreshableAuth() {
      refreshableAuthCalls += 1;
      return { headers() { throw new Error("request-scoped auth was used"); } };
    }
  };
  const server = createApp({ WORKATO_OAUTH_CLIENT_ID: "client", WORKATO_OAUTH_REDIRECT_URI: "https://app.example/auth/callback", WORKATO_GENIE_HANDLE: "genie" }, { oauthPkce });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=state`, { headers: { Cookie: cookie }, redirect: "manual" });
    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/conversations`, { method: "POST", headers: { Cookie: cookie } }),
      fetch(`http://127.0.0.1:${port}/api/conversations`, { method: "POST", headers: { Cookie: cookie } })
    ]);
    assert.equal(first.status, 500);
    assert.equal(second.status, 500);
    assert.equal(refreshableAuthCalls, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
