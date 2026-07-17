import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, GenieClient, OAuthAuth, RefreshableOAuthAuth } from "../dist/index.js";

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
  assert.equal((await client.getRuntimeConnectionLink("genie", "attempt")).status, "authorized");
  await client.rejectRuntimeConnection("genie", "attempt", "no");
  assert.equal(await client.uploadFile("genie", "c", new Blob(["hello"])), "f");

  const approval = requests.find((request) => request.path.includes("/skill_approval/"));
  assert.deepEqual(JSON.parse(approval.init.body), { resolution: "rejected", rejection_reason: "no" });
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
    for await (const event of client.streamMessage("genie", "conversation", "hello", undefined, 3, abort.signal)) {
      if (event.type === "system.stream_interrupted") abort.abort(new Error("cancelled"));
    }
  }, /cancelled/);
  assert.equal(calls, 1);
});
