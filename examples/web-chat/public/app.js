const thread = document.querySelector("#thread");
const emptyState = document.querySelector("#empty-state");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const connection = document.querySelector("#connection");
const newChat = document.querySelector("#new-chat");
let conversationId = localStorage.getItem("genie-conversation-id") ?? null;

function setStatus(text, state = "ready") {
  connection.textContent = text;
  connection.dataset.state = state;
}

function messageCard(role, text = "") {
  emptyState?.remove();
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
  card.scrollIntoView({ behavior: "smooth", block: "end" });
  return content;
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
  card.scrollIntoView({ behavior: "smooth", block: "end" });
}

async function json(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Request failed");
  return response.status === 204 ? undefined : response.json();
}

async function ensureConversation() {
  if (conversationId) return conversationId;
  const conversation = await json("/api/conversations");
  conversationId = conversation.conversation_id;
  localStorage.setItem("genie-conversation-id", conversationId);
  return conversationId;
}

function processEvent(event, assistant) {
  if (event.type === "agent.message") assistant.textContent = event.data.message ?? "";
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
  thread.replaceChildren(Object.assign(document.createElement("div"), { id: "empty-state", className: "empty-state", innerHTML: "<div class=\"sparkle\">✦</div><h2>Start a focused conversation</h2><p>Genie will keep the context while you work together.</p>" }));
  setStatus("Ready");
  input.focus();
});

input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });
input.focus();
