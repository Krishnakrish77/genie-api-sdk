import assert from "node:assert/strict";
import test from "node:test";

import { ApiKeyAuth, GenieClient } from "../dist/index.js";

// End-to-end checks against a real Genie workspace — the SDK's pre-release gate. NOT part of
// `npm test` (that suite must stay hermetic, see AGENTS.md); run explicitly via
// `npm run test:e2e`. Same gating convention as examples/web-chat's e2e-smoke: tests only run
// when GENIE_E2E=1 and WORKATO_API_KEY, WORKATO_IDP_USER_ID, and WORKATO_GENIE_HANDLE are set
// (plus WORKATO_BASE_URL for Preview/on-prem gateways); otherwise every test skips with a reason.
//
// Tests run sequentially and share one conversation — later tests depend on earlier ones, which
// is deliberate: a failure stops the chain at the operation that actually broke. Each execution
// spends two genie runs (one plain message, one with an attachment); conversations accumulate in
// the target workspace, so point this at non-production.

const { GENIE_E2E, WORKATO_GENIE_HANDLE: handle, WORKATO_API_KEY: apiKey, WORKATO_IDP_USER_ID: idpUserId, WORKATO_BASE_URL: baseUrl } = process.env;
const missing = [GENIE_E2E !== "1" && "GENIE_E2E=1", !handle && "WORKATO_GENIE_HANDLE", !apiKey && "WORKATO_API_KEY", !idpUserId && "WORKATO_IDP_USER_ID"].filter(Boolean);
const skip = missing.length ? `missing env: ${missing.join(", ")}` : false;

const client = skip ? undefined : new GenieClient({ auth: new ApiKeyAuth(apiKey, idpUserId), baseUrl });
let conversationId;
let runId;

test("creates a conversation", { skip }, async () => {
  const conversation = await client.createConversation(handle);
  assert.ok(conversation.conversation_id, "response should include a conversation_id");
  conversationId = conversation.conversation_id;
});

test("streams a message end to end", { skip }, async () => {
  assert.ok(conversationId, "depends on the createConversation test");
  const types = [];
  for await (const event of client.streamMessage(handle, conversationId, "Reply with exactly: e2e-ok")) {
    types.push(event.type);
    runId = event.genie_run_id ?? runId;
  }
  assert.ok(types.includes("agent.message"), `expected an agent.message event, got: ${types.join(", ")}`);
  assert.ok(types.includes("processing.finished"), `expected processing.finished, got: ${types.join(", ")}`);
  assert.ok(runId, "expected a genie_run_id on the stream");
});

test("conversation is listable and fetchable", { skip }, async () => {
  assert.ok(conversationId, "depends on the createConversation test");
  const page = await client.listConversations(handle, { limit: 50 });
  assert.ok(page.items.some((c) => c.conversation_id === conversationId), "created conversation should appear in the list");
  const fetched = await client.getConversation(handle, conversationId);
  assert.equal(fetched.conversation_id, conversationId);
});

test("messages are persisted", { skip }, async () => {
  assert.ok(conversationId, "depends on the createConversation test");
  const page = await client.listMessages(handle, conversationId);
  assert.ok(page.items.some((m) => m.source === "user" && m.content.includes("e2e-ok")), "the user message should be persisted");
  assert.ok(page.items.some((m) => m.source === "genie"), "the genie reply should be persisted");
});

test("uploads a file and attaches it to a message", { skip }, async () => {
  assert.ok(conversationId, "depends on the createConversation test");
  const fileId = await client.uploadFile(handle, conversationId, new Blob(["name,score\nalpha,1\n"], { type: "text/csv" }));
  assert.ok(fileId, "upload should return a file_id");
  const types = [];
  for await (const event of client.streamMessage(handle, conversationId, "Briefly: what is in the attached file?", { fileId })) types.push(event.type);
  // An empty `message` is rejected by the gateway (400), so this also guards the documented
  // contract that text + file_id streams normally.
  assert.ok(types.includes("agent.message"), `expected an agent.message event, got: ${types.join(", ")}`);
  assert.ok(types.includes("processing.finished"), `expected processing.finished, got: ${types.join(", ")}`);
});

test("accepts feedback for the run", { skip }, async () => {
  assert.ok(runId, "depends on the streaming test");
  await client.submitFeedback(handle, conversationId, runId, "positive", "sdk e2e");
});

test("lists events for the conversation", { skip }, async () => {
  assert.ok(conversationId, "depends on the createConversation test");
  const page = await client.listEvents(handle, { conversationId });
  assert.ok(page.items.length > 0, "expected persisted events for the conversation");
});
