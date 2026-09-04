import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, GenieClient, NotFoundError, OAuthAuth, OAuthPkce, RefreshableOAuthAuth } from "../dist/index.js";

test("OAuth PKCE builds a public-client authorization request and exchanges rotating tokens", async () => {
  const requests = [];
  const oauth = new OAuthPkce({
    // Mirrors Workato's real deployments: the issuer claim (id.workato.com) can differ from
    // the identityBaseUrl a Preview/on-prem environment is queried at.
    clientId: "client-id", redirectUri: "https://app.example/callback", identityBaseUrl: "https://identity.example",
    fetch: async (url, init) => {
      const href = String(url);
      if (href.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({
          issuer: "https://issuer.example/",
          authorization_endpoint: "https://identity.example/oauth/authorize",
          token_endpoint: "https://identity.example/oauth/token",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }), { headers: { "content-type": "application/json" } });
      }
      requests.push({ url: href, body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ access_token: requests.length === 1 ? "access" : "fresh", refresh_token: requests.length === 1 ? "refresh-1" : "refresh-2", expires_in: 3600, token_type: "Bearer" }), { headers: { "content-type": "application/json" } });
    }
  });
  const login = await oauth.createAuthorizationRequest();
  const authorization = new URL(login.authorizationUrl);
  assert.equal(authorization.origin, "https://identity.example");
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://app.example/callback");
  assert.equal(authorization.searchParams.get("scope"), "openid profile email");
  assert.equal(authorization.searchParams.get("state"), login.state);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(() => oauth.exchangeCallback("https://app.example/callback?code=code&state=wrong", login), /state/);
  const tokens = await oauth.exchangeCallback(`https://app.example/callback?code=code&state=${login.state}`, login);
  assert.equal(tokens.refreshToken, "refresh-1");
  const refreshed = await oauth.refresh(tokens);
  assert.equal(refreshed.refreshToken, "refresh-2");
  assert.match(requests[0].body, /grant_type=authorization_code/);
  assert.match(requests[0].body, /client_id=client-id/);
  assert.match(requests[1].body, /grant_type=refresh_token/);
  assert.doesNotMatch(requests.map((request) => `${request.body} ${request.authorization}`).join(" "), /client_secret|Basic /);
});

test("OAuth PKCE retries discovery after a transient failure instead of failing forever", async () => {
  let discoveryAttempts = 0;
  const oauth = new OAuthPkce({
    clientId: "client-id", redirectUri: "https://app.example/callback", identityBaseUrl: "https://identity.example",
    fetch: async (url) => {
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        discoveryAttempts += 1;
        if (discoveryAttempts === 1) throw new Error("network blip");
        return new Response(JSON.stringify({
          issuer: "https://identity.example",
          authorization_endpoint: "https://identity.example/oauth/authorize",
          token_endpoint: "https://identity.example/oauth/token",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }), { headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected request: " + url);
    }
  });
  await assert.rejects(() => oauth.createAuthorizationRequest());
  const login = await oauth.createAuthorizationRequest();
  assert.equal(new URL(login.authorizationUrl).origin, "https://identity.example");
  assert.equal(discoveryAttempts, 2);
});

test("parses CRLF SSE frames split at arbitrary chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: agent.message\r",
    "\nid: one\r\ndata: {\"conversation_id\":\"c1\",\"message\":\"first\"}\r\n\r",
    "\nevent: processing.finished\r\ndata: {\"conversation_id\":\"c1\"}\r\n\r\n"
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => new Response(stream, { status: 200 })
  });

  const events = [];
  for await (const event of client.streamMessage("genie", "conversation", "hello")) events.push(event);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "agent.message");
  assert.equal(events[0].data.message, "first");
  assert.equal(events[1].type, "processing.finished");
});

test("a non-JSON error body surfaces as a typed error instead of a body-already-used crash", async () => {
  const textClient = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => new Response("Not found", { status: 404 })
  });
  await assert.rejects(
    () => textClient.listConversations("genie"),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.body, "Not found");
      return true;
    }
  );

  const jsonClient = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => Response.json({ error: "missing" }, { status: 404 })
  });
  await assert.rejects(
    () => jsonClient.listConversations("genie"),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.deepEqual(error.body, { error: "missing" });
      return true;
    }
  );
});

test("tolerates empty success bodies (feedback returns 202 with no content)", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => new Response("", { status: 202 })
  });
  // Must resolve — a JSON.parse crash here masked the feedback call's success on the live API.
  await client.submitFeedback("genie", "conversation", "run", "positive");
});

test("getConversation fills conversation_id from the request when the API omits it", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => Response.json({ result: { state: "idle" } })
  });
  const conversation = await client.getConversation("genie", "conversation-1");
  assert.equal(conversation.conversation_id, "conversation-1");
  assert.equal(conversation.state, "idle");
});

test("serializes file attachment through the options object", async () => {
  const bodies = [];
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ conversation_id: "c", genie_run_id: "run" });
    }
  });

  await client.sendMessage("genie", "c", "hello");
  await client.sendMessage("genie", "c", "hello", { fileId: "file-1" });

  assert.deepEqual(bodies, [
    { message: "hello", stream: false },
    { message: "hello", file_id: "file-1", stream: false }
  ]);
});

test("refreshes and persists expired OAuth credentials once", async () => {
  let tokens = { accessToken: "expired", refreshToken: "refresh-1", expiresAt: new Date(0) };
  let refreshes = 0;
  const auth = new RefreshableOAuthAuth(
    () => tokens,
    (current) => { refreshes += 1; tokens = { accessToken: "fresh", refreshToken: `${current.refreshToken}-2`, expiresAt: new Date(Date.now() + 3_600_000) }; return tokens; }
  );

  assert.equal((await auth.headers()).Authorization, "Bearer fresh");
  assert.equal((await auth.headers()).Authorization, "Bearer fresh");
  assert.equal(refreshes, 1);
  await auth.forceRefresh();
  assert.equal(refreshes, 2);
});

test("OAuth sends only a bearer token and concurrent refreshes are coalesced", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "access-token"),
    fetch: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer access-token");
      assert.equal(init.headers["X-IDP-User-Id"], undefined);
      return Response.json({ conversation_id: "conversation" });
    }
  });
  await client.createConversation("genie");

  let refreshes = 0;
  const auth = new RefreshableOAuthAuth(
    () => ({ accessToken: "expired", refreshToken: "refresh", expiresAt: new Date(0) }),
    async () => { refreshes += 1; return { accessToken: "fresh", refreshToken: "next", expiresAt: new Date(Date.now() + 3_600_000) }; }
  );
  const headers = await Promise.all([auth.headers(), auth.headers(), auth.headers()]);
  assert.deepEqual(headers.map((value) => value.Authorization), ["Bearer fresh", "Bearer fresh", "Bearer fresh"]);
  assert.equal(refreshes, 1);
});

test("retries safe reads once after forced refresh but never retries message posts", async () => {
  const auth = {
    token: "old",
    forceRefreshCalls: 0,
    headers() { return { Authorization: `Bearer ${this.token}` }; },
    forceRefresh() { this.token = "new"; this.forceRefreshCalls += 1; }
  };
  const requests = [];
  const client = new GenieClient({
    auth,
    fetch: async (url, init) => {
      requests.push({ url: String(url), auth: init.headers.Authorization });
      if (init.headers.Authorization === "Bearer old") return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ conversation_id: "conversation" }), { status: 200 });
    }
  });

  await client.getConversation("genie", "conversation");
  assert.equal(requests.length, 2);
  assert.equal(auth.forceRefreshCalls, 1);

  auth.token = "old";
  await assert.rejects(() => client.sendMessage("genie", "conversation", "hello"));
  assert.equal(requests.length, 3);
  assert.equal(auth.forceRefreshCalls, 1);
});

test("preserves the gateway 401 when an OAuth refresh fails", async () => {
  const client = new GenieClient({
    auth: { headers: () => ({ Authorization: "Bearer rejected" }), forceRefresh: () => { throw new Error("refresh rejected"); } },
    fetch: async () => new Response(JSON.stringify({ error: "OAuth client is not attached to this genie" }), { status: 401, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(
    () => client.getConversation("genie", "conversation"),
    (error) => error instanceof AuthenticationError && error.body.error === "OAuth client is not attached to this genie"
  );
});

test("surfaces the retried request's own failure instead of the stale 401 when refresh succeeds", async () => {
  let attempts = 0;
  const client = new GenieClient({
    auth: { headers: () => ({ Authorization: "Bearer old" }), forceRefresh: async () => {} },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("unauthorized", { status: 401 });
      throw new Error("network dropped");
    }
  });
  await assert.rejects(() => client.getConversation("genie", "conversation"), /network dropped/);
  assert.equal(attempts, 2);
});

test("throws a typed authentication error with the request ID", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: { "x-request-id": "request-123" } })
  });

  await assert.rejects(
    () => client.sendMessage("genie", "conversation", "hello"),
    (error) => error instanceof AuthenticationError && error.requestId === "request-123"
  );
});

test("accepts the beta gateway result envelope", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => Response.json({ result: { conversation_id: "conversation" } })
  });

  assert.equal((await client.createConversation("genie")).conversation_id, "conversation");
});

test("accepts the beta gateway conversations collection name", async () => {
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => Response.json({ result: { conversations: [{ conversation_id: "conversation" }], total_count: 1 } })
  });

  assert.equal((await client.listConversations("genie")).items[0].conversation_id, "conversation");
});

test("reconnects after an interrupted stream", async () => {
  const encoder = new TextEncoder();
  const requests = [];
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async (url) => {
      requests.push(String(url));
      const reconnect = String(url).includes("genie-runs/run");
      const payload = reconnect
        ? "event: agent.message\nid: reply\ndata: {\"genie_run_id\":\"run\",\"message\":\"Recovered\"}\n\n"
        : "event: processing.started\nid: started\ndata: {\"genie_run_id\":\"run\"}\n\nevent: system.stream_interrupted\ndata: {\"genie_run_id\":\"run\"}\n\n";
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); } }));
    }
  });

  const events = [];
  for await (const event of client.streamMessage("genie", "conversation", "hello")) events.push(event);

  assert.equal(events[2].data.message, "Recovered");
  assert.equal(requests.length, 2);
});

test("streamRun reconnects a persisted run after the supplied event ID", async () => {
  const requests = [];
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async (url, init) => {
      requests.push({ url: new URL(String(url)), headers: init.headers });
      return new Response("event: agent.message\nid: next\ndata: {\"message\":\"Recovered\"}\n\n");
    }
  });

  const events = [];
  for await (const event of client.streamRun("genie/handle", "conversation/id", "run/id", { lastEventId: "previous/id" })) events.push(event);

  assert.equal(events[0].data.message, "Recovered");
  assert.equal(requests[0].url.pathname, "/api/v1/genies/genie%2Fhandle/chat/conversations/conversation%2Fid/genie-runs/run%2Fid");
  assert.equal(requests[0].headers["Last-Event-ID"], "previous/id");
});

test("streamRun surfaces an API failure without retrying or replaying", async () => {
  const requests = [];
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: { "content-type": "application/json" } });
    }
  });

  await assert.rejects(async () => {
    for await (const _event of client.streamRun("genie", "conversation", "run")) { /* no events */ }
  }, AuthenticationError);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/genie-runs\/run$/);
});

test("covers conversation, event, approval, runtime connection, and upload operations", async () => {
  const requests = [];
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async (url, init) => {
      const requestUrl = new URL(String(url));
      requests.push({ path: requestUrl.pathname, query: requestUrl.searchParams, init });
      if (requestUrl.pathname.endsWith("/conversations") && init.method === "GET") return Response.json({ list: [{ conversation_id: "c" }], total_count: 1, cursor: "next" });
      if (requestUrl.pathname.endsWith("/conversations")) return Response.json({ conversation_id: "c" });
      if (requestUrl.pathname.endsWith("/messages") && init.method === "GET") return Response.json({ messages: [{ message_id: "m", source: "user", content: "hi" }], total_count: 1 });
      if (requestUrl.pathname.endsWith("/events")) return Response.json({ events: [{ type: "agent.message", event_id: "e", message: "hi" }], next_since_created_at: "next-event" });
      if (requestUrl.pathname.endsWith("/link")) return Response.json({ status: "authorized" });
      if (/\/(skill_approval|business_approval)\/|\/feedback$|\/reject$/.test(requestUrl.pathname)) return new Response(null, { status: 204 });
      if (requestUrl.pathname.endsWith("/upload")) { assert.ok(init.body instanceof FormData); return Response.json({ file_id: "f" }); }
      if (requestUrl.pathname.endsWith("/c")) return Response.json({ conversation_id: "c", state: "idle" });
      return Response.json({});
    }
  });

  assert.equal((await client.listConversations("genie", { limit: 1, cursor: "before" })).cursor, "next");
  assert.equal((await client.createConversation("genie")).conversation_id, "c");
  assert.equal((await client.getConversation("genie", "c")).state, "idle");
  assert.equal((await client.listMessages("genie", "c", { limit: 1 })).items[0].message_id, "m");
  assert.equal((await client.listEvents("genie", { conversationId: "c", sinceCreatedAt: "start", limit: 1 })).nextSinceCreatedAt, "next-event");
  await client.resolveSkillApproval("genie", "c", "call", "rejected", "no");
  await client.resolveBusinessApproval("genie", "c", "business-call", "approved");
  await client.submitFeedback("genie", "c", "run", "positive", "Useful");
  assert.equal((await client.getRuntimeConnectionLink("genie", "attempt")).status, "authorized");
  await client.rejectRuntimeConnection("genie", "attempt", "no");
  assert.equal(await client.uploadFile("genie", "c", new Blob(["hello"])), "f");

  const approval = requests.find((request) => request.path.includes("/skill_approval/"));
  assert.deepEqual(JSON.parse(approval.init.body), { resolution: "rejected", rejection_reason: "no" });
  const businessApproval = requests.find((request) => request.path.includes("/business_approval/"));
  assert.deepEqual(JSON.parse(businessApproval.init.body), { resolution: "approved" });
  const feedback = requests.find((request) => request.path.endsWith("/feedback"));
  assert.deepEqual(JSON.parse(feedback.init.body), { reaction: "positive", comment: "Useful" });
  const events = requests.find((request) => request.path.endsWith("/events"));
  assert.equal(events.query.get("conversation_id"), "c");
  assert.equal(events.query.get("since_created_at"), "start");
});

test("honors stream retry delay and supports aborting the wait", async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const abort = new AbortController();
  const client = new GenieClient({
    auth: new OAuthAuth(() => "token"),
    fetch: async () => {
      calls += 1;
      const payload = calls === 1
        ? "event: processing.started\ndata: {\"genie_run_id\":\"run\"}\n\nevent: system.stream_interrupted\ndata: {\"genie_run_id\":\"run\",\"retry_after_ms\":1}\n\n"
        : "event: processing.finished\ndata: {\"genie_run_id\":\"run\"}\n\n";
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); } }));
    }
  });
  await assert.rejects(async () => {
    for await (const event of client.streamMessage("genie", "conversation", "hello", { signal: abort.signal })) {
      if (event.type === "system.stream_interrupted") abort.abort(new Error("cancelled"));
    }
  }, /cancelled/);
  assert.equal(calls, 1);
});
