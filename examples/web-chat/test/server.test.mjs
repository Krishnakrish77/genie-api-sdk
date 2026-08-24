import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { applyDotEnv, configuration, createApp } from "../server.mjs";

const environment = { WORKATO_API_KEY: "key", WORKATO_IDP_USER_ID: "user", WORKATO_GENIE_HANDLE: "genie" };

test("requires server-side credentials", () => {
  assert.throws(() => configuration({}), /WORKATO_API_KEY/);
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
});
