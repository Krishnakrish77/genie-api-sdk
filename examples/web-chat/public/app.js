import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const thread = document.querySelector("#thread");
const emptyState = document.querySelector("#empty-state");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const connection = document.querySelector("#connection");
const newChat = document.querySelector("#new-chat");
let suggestions = document.querySelector("#suggestions");
const conversationList = document.querySelector("#conversation-list");
const historyStatus = document.querySelector("#history-status");
// Opening the app always starts a new canvas. People opt into resuming a
// server-side conversation from the sidebar, just as they do in chat apps.
let conversationId = null;

function setStatus(text, state = "ready") {
  connection.textContent = text;
  connection.dataset.state = state;
}

function scrollToLatest(force = false) {
  const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 180;
  if (!force && !nearBottom) return;
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
}

function messageCard(role, text = "") {
  emptyState?.remove();
  suggestions?.remove();
  const card = document.createElement("article");
  card.className = `message ${role}`;
  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "Genie";
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  card.append(label, content);
  thread.append(card);
  scrollToLatest(true);
  return content;
}

function renderMarkdown(container, markdown) {
  const html = marked.parse(String(markdown), { async: false, gfm: true, breaks: true });
  container.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  for (const table of container.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.before(wrapper);
    wrapper.append(table);
  }
  for (const link of container.querySelectorAll("a[href]")) {
    link.target = "_blank";
    link.rel = "noreferrer";
  }
}

function actionCard(title, description, actions) {
  const card = document.createElement("section");
  card.className = "action-card";
  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = "ACTION NEEDED";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  card.append(label, heading, copy);
  const controls = document.createElement("div");
  controls.className = "action-controls";
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = action.secondary ? "secondary-action" : "primary-action";
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action.run(); card.remove(); setStatus("Ready"); }
      catch { button.disabled = false; setStatus("Couldn’t complete that action", "error"); }
    });
    controls.append(button);
  }
  card.append(controls);
  thread.append(card);
  scrollToLatest();
}

async function request(url, { method = "GET", body } = {}) {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Request failed");
  return response.status === 204 ? undefined : response.json();
}

function json(url, body) { return request(url, { method: "POST", body }); }

function titleFor(conversation) {
  return conversation.topic?.trim() || "Untitled conversation";
}

function renderConversationList(conversations) {
  conversationList.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No previous chats yet.";
    conversationList.append(empty);
    return;
  }
  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.dataset.active = String(conversation.conversation_id === conversationId);
    const title = document.createElement("span");
    title.textContent = titleFor(conversation);
    const time = document.createElement("small");
    time.textContent = conversation.last_updated_at ? new Date(conversation.last_updated_at).toLocaleDateString() : "";
    button.append(title, time);
    button.addEventListener("click", () => selectConversation(conversation.conversation_id));
    conversationList.append(button);
  }
}

async function refreshConversations() {
  try {
    const page = await request("/api/conversations");
    renderConversationList(page.items ?? []);
  } catch {
    historyStatus.textContent = "Couldn’t load recent chats";
  }
}

async function selectConversation(id) {
  conversationId = id;
  localStorage.setItem("genie-conversation-id", id);
  setStatus("Loading chat…", "working");
  try {
    const page = await request(`/api/conversations/${encodeURIComponent(id)}/messages`);
    thread.replaceChildren();
    suggestions?.remove();
    for (const message of (page.items ?? []).slice().reverse()) {
      const content = messageCard(message.source === "genie" ? "assistant" : "user", message.content ?? "");
      if (message.source === "genie") renderMarkdown(content, message.content ?? "");
    }
    if (!(page.items ?? []).length) thread.append(Object.assign(document.createElement("p"), { className: "history-empty", textContent: "This conversation has no messages yet." }));
    scrollToLatest(true);
    setStatus("Ready");
    await refreshConversations();
  } catch {
    setStatus("Couldn’t load that chat", "error");
  }
}

async function ensureConversation() {
  if (conversationId) return conversationId;
  const conversation = await json("/api/conversations");
  conversationId = conversation.conversation_id;
  localStorage.setItem("genie-conversation-id", conversationId);
  await refreshConversations();
  return conversationId;
}

function processEvent(event, assistant) {
  if (event.type === "agent.message") {
    renderMarkdown(assistant, event.data.message ?? "");
    scrollToLatest();
  }
  if (event.type === "processing.started") setStatus("Thinking…", "working");
  if (event.type === "processing.finished") setStatus("Ready");
  if (event.type === "system.stream_interrupted") setStatus("Reconnecting…", "working");
  if (event.type === "skill.confirmation_required") {
    actionCard("Approve this action?", event.data.skill_name ? `Genie wants to use ${event.data.skill_name}.` : "Genie needs your confirmation to continue.", [
      { label: "Approve", run: () => json("/api/skill-approvals", { conversationId, callId: event.data.call_id, resolution: "approved" }) },
      { label: "Decline", secondary: true, run: () => json("/api/skill-approvals", { conversationId, callId: event.data.call_id, resolution: "rejected", rejectionReason: "Declined by user" }) }
    ]);
  }
  if (event.type === "runtime_connection.auth_required") {
    const attemptId = event.data.runtime_connection_attempt_id;
    actionCard("Connect an account", "Genie needs you to authorize a connected app before it can continue.", [
      { label: "Continue to connection", run: async () => { const result = await json("/api/runtime-connections/link", { attemptId }); if (result.auth_link?.url) window.open(result.auth_link.url, "_blank", "noopener"); } },
      { label: "Not now", secondary: true, run: () => json("/api/runtime-connections/reject", { attemptId, reason: "Declined by user" }) }
    ]);
  }
  if (event.type === "error") { assistant.textContent = event.data.message; setStatus("Couldn’t finish that response", "error"); }
}

async function streamMessage(message) {
  const id = await ensureConversation();
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
  if (!response.ok || !response.body) throw new Error("Couldn’t start the response");
  const assistant = messageCard("assistant", "Thinking…");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const line = frame.split(/\r?\n/).find((entry) => entry.startsWith("data:"));
      if (line) processEvent(JSON.parse(line.slice(5).trim()), assistant);
    }
  }
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  messageCard("user", message);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  setStatus("Connecting…", "working");
  try { await streamMessage(message); }
  catch { messageCard("assistant", "I couldn’t send that message. Please try again."); setStatus("Couldn’t connect", "error"); }
  finally { sendButton.disabled = false; input.focus(); }
});

newChat.addEventListener("click", () => {
  localStorage.removeItem("genie-conversation-id");
  conversationId = null;
  window.location.reload();
});

input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  input.value = button.dataset.prompt;
  composer.requestSubmit();
}));
refreshConversations();
input.focus();
