import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

import { configuration, createApp } from "../server.mjs";

const environment = { WORKATO_API_KEY: "key", WORKATO_IDP_USER_ID: "user", WORKATO_GENIE_HANDLE: "genie" };

test("requires server-side credentials", () => {
  assert.throws(() => configuration({}), /WORKATO_API_KEY/);
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
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/example/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: " " })
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});
