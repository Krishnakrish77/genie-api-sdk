import { spawn } from "node:child_process";
import { once } from "node:events";

const required = ["WORKATO_API_KEY", "WORKATO_IDP_USER_ID", "WORKATO_GENIE_HANDLE"];
const missing = required.filter((name) => !process.env[name]);
if (process.env.GENIE_E2E !== "1" || missing.length) {
  console.error(`Refusing to contact a workspace. Set GENIE_E2E=1 and: ${missing.join(", ") || "none missing"}`);
  process.exit(2);
}

const child = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
let serverUrl;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (line) => {
  const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) serverUrl = `http://127.0.0.1:${match[1]}`;
});

try {
  for (let attempt = 0; !serverUrl && attempt < 50; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!serverUrl) throw new Error("The web example did not start")
  const health = await fetch(`${serverUrl}/api/health`);
  if (!health.ok) throw new Error("The web example health check failed");
  const conversation = await fetch(`${serverUrl}/api/conversations`, { method: "POST" }).then((response) => response.json());
  const stream = await fetch(`${serverUrl}/api/conversations/${encodeURIComponent(conversation.conversation_id)}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: process.env.GENIE_E2E_MESSAGE ?? "Reply with exactly: SDK_E2E_OK" })
  });
  const contents = await stream.text();
  if (!stream.ok || !contents.includes("processing.finished")) throw new Error("The example did not receive a completed Genie response")
  console.log(`Web example E2E passed (conversation ${conversation.conversation_id})`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}
