import assert from "node:assert/strict";
import test from "node:test";

import { GenieClient, OAuthAuth, RefreshableOAuthAuth } from "../dist/index.js";

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
    () => { refreshes += 1; return { accessToken: "fresh", refreshToken: "refresh-2", expiresAt: new Date(Date.now() + 3_600_000) }; },
    (updated) => { tokens = updated; }
  );

  assert.equal((await auth.headers()).Authorization, "Bearer fresh");
  assert.equal((await auth.headers()).Authorization, "Bearer fresh");
  assert.equal(refreshes, 1);
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
