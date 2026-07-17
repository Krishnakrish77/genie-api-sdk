import assert from "node:assert/strict";
import test from "node:test";

import { GenieClient } from "../dist/index.js";

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
    accessToken: "token",
    fetch: async () => new Response(stream, { status: 200 })
  });

  const events = [];
  for await (const event of client.streamMessage("genie", "conversation", "hello")) events.push(event);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "agent.message");
  assert.equal(events[0].data.message, "first");
  assert.equal(events[1].type, "processing.finished");
});
