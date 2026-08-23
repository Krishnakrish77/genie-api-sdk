import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApiKeyAuth, GenieClient } from "../../typescript/dist/index.js";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = join(DIRECTORY, "public");
const CONTENT_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export function configuration(environment = process.env) {
  const required = ["WORKATO_API_KEY", "WORKATO_IDP_USER_ID", "WORKATO_GENIE_HANDLE"];
  const missing = required.filter((name) => !environment[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return {
    auth: new ApiKeyAuth(environment.WORKATO_API_KEY, environment.WORKATO_IDP_USER_ID),
    baseUrl: environment.WORKATO_BASE_URL ?? "https://genie-api.workato.com",
    genieHandle: environment.WORKATO_GENIE_HANDLE
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function statusFor(error) {
  return typeof error?.status === "number" ? error.status : 500;
}

function publicPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(PUBLIC_DIRECTORY, requested));
  return file.startsWith(`${PUBLIC_DIRECTORY}/`) ? file : undefined;
}

async function serveStatic(request, response) {
  const file = publicPath(request.url);
  if (!file) return sendJson(response, 404, { error: "Not found" });
  try {
    const contents = await readFile(file);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function streamEvent(response, event) {
  response.write(`event: genie\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createApp(environment = process.env) {
  const config = configuration(environment);
  const client = new GenieClient({ auth: config.auth, baseUrl: config.baseUrl });
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(request, response);
      if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { status: "ok" });

      if (request.method === "POST" && url.pathname === "/api/conversations") {
        const conversation = await client.createConversation(config.genieHandle);
        return sendJson(response, 201, conversation);
      }

      const messageRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageRoute) {
        const { message } = await readJson(request);
        if (typeof message !== "string" || !message.trim()) return sendJson(response, 400, { error: "message is required" });
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        try {
          for await (const event of client.streamMessage(config.genieHandle, decodeURIComponent(messageRoute[1]), message.trim())) streamEvent(response, event);
        } catch (error) {
          streamEvent(response, { type: "error", data: { message: "The response stream failed. Please try again." }, status: statusFor(error) });
        }
        return response.end();
      }

      if (request.method === "POST" && url.pathname === "/api/skill-approvals") {
        const { conversationId, callId, resolution, rejectionReason } = await readJson(request);
        await client.resolveSkillApproval(config.genieHandle, conversationId, callId, resolution, rejectionReason);
        return sendJson(response, 204, {});
      }

      if (request.method === "POST" && url.pathname === "/api/runtime-connections/link") {
        const { attemptId } = await readJson(request);
        return sendJson(response, 200, await client.getRuntimeConnectionLink(config.genieHandle, attemptId));
      }

      if (request.method === "POST" && url.pathname === "/api/runtime-connections/reject") {
        const { attemptId, reason } = await readJson(request);
        await client.rejectRuntimeConnection(config.genieHandle, attemptId, reason);
        return sendJson(response, 204, {});
      }
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(response, statusFor(error), { error: error instanceof Error ? error.message : "Unexpected error" });
    }
  });
}

export function startServer(environment = process.env) {
  const port = Number(environment.PORT ?? 3000);
  const server = createApp(environment);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`Genie chat is ready at http://127.0.0.1:${address.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
