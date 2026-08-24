import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApiKeyAuth, GenieClient, OAuthPkce } from "genie-api-sdk";
import { randomUUID } from "node:crypto";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = join(DIRECTORY, "public");
const CONTENT_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const VENDOR_FILES = new Map([
  ["/vendor/marked.js", join(DIRECTORY, "node_modules/marked/lib/marked.esm.js")],
  ["/vendor/dompurify.js", join(DIRECTORY, "node_modules/dompurify/dist/purify.es.mjs")]
]);

export function applyDotEnv(contents, environment) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(environment, match[1])) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    environment[match[1]] = value;
  }
  return environment;
}

export function loadEnvironmentFile(environment = process.env, file = join(DIRECTORY, ".env")) {
  if (existsSync(file)) applyDotEnv(readFileSync(file, "utf8"), environment);
  return environment;
}

export function configuration(environment = loadEnvironmentFile()) {
  const isOAuth = Boolean(environment.WORKATO_OAUTH_CLIENT_ID);
  const required = isOAuth
    ? ["WORKATO_OAUTH_CLIENT_ID", "WORKATO_OAUTH_REDIRECT_URI", "WORKATO_GENIE_HANDLE"]
    : ["WORKATO_API_KEY", "WORKATO_IDP_USER_ID", "WORKATO_GENIE_HANDLE"];
  const missing = required.filter((name) => !environment[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return {
    baseUrl: environment.WORKATO_BASE_URL ?? "https://genie-api.workato.com",
    genieHandle: environment.WORKATO_GENIE_HANDLE,
    mode: isOAuth ? "oauth" : "api-key",
    auth: isOAuth ? undefined : new ApiKeyAuth(environment.WORKATO_API_KEY, environment.WORKATO_IDP_USER_ID),
    oauth: isOAuth ? {
      clientId: environment.WORKATO_OAUTH_CLIENT_ID,
      redirectUri: environment.WORKATO_OAUTH_REDIRECT_URI,
      identityBaseUrl: environment.WORKATO_IDENTITY_BASE_URL
    } : undefined
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
  const pathname = new URL(request.url, "http://localhost").pathname;
  const vendorFile = VENDOR_FILES.get(pathname);
  if (vendorFile) {
    try {
      const contents = await readFile(vendorFile);
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return response.end(contents);
    } catch { return sendJson(response, 404, { error: "Not found" }); }
  }
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

function sessionId(request) {
  return request.headers.cookie?.match(/(?:^|;\s*)genie_session=([^;]+)/)?.[1];
}

export function createApp(environment = loadEnvironmentFile(), { oauthPkce } = {}) {
  const config = configuration(environment);
  const sessions = new Map();
  const pkce = config.mode === "oauth" ? (oauthPkce ?? new OAuthPkce(config.oauth)) : undefined;
  const expiredSessionMessage = "OAuth session is missing or expired. This example keeps sessions in memory; restart and sign in again.";
  const clientFor = (request) => {
    if (config.mode === "api-key") return new GenieClient({ auth: config.auth, baseUrl: config.baseUrl });
    const session = sessions.get(sessionId(request));
    if (!session?.tokens) {
      const error = new Error(expiredSessionMessage);
      error.status = 401;
      throw error;
    }
    if (!session.auth) session.auth = pkce.refreshableAuth(() => session.tokens, (tokens) => { session.tokens = tokens; });
    return new GenieClient({ baseUrl: config.baseUrl, auth: session.auth });
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (config.mode === "oauth" && request.method === "GET" && url.pathname === "/auth/login") {
        const login = await pkce.createAuthorizationRequest();
        const id = randomUUID();
        sessions.set(id, { login });
        response.writeHead(302, { Location: login.authorizationUrl, "Set-Cookie": `genie_session=${id}; HttpOnly; SameSite=Lax; Path=/` });
        return response.end();
      }
      if (config.mode === "oauth" && request.method === "GET" && url.pathname === new URL(config.oauth.redirectUri).pathname) {
        const session = sessions.get(sessionId(request));
        if (!session?.login) return sendJson(response, 401, { error: expiredSessionMessage });
        if (url.searchParams.get("state") !== session.login.state) return sendJson(response, 400, { error: "OAuth callback state does not match the login request" });
        // request.url is only a path; rebuild against the public redirect_uri so the token
        // exchange reports the same redirect_uri the identity server issued the code for.
        session.tokens = await pkce.exchangeCallback(new URL(request.url, config.oauth.redirectUri), session.login);
        delete session.login;
        response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        return response.end();
      }
      if (config.mode === "oauth" && request.method === "GET" && url.pathname === "/" && !sessions.get(sessionId(request))) {
        response.writeHead(302, { Location: "/auth/login", "Cache-Control": "no-store" });
        return response.end();
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(request, response);
      if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { status: "ok" });

      const client = clientFor(request);

      if (request.method === "POST" && url.pathname === "/api/conversations") {
        const conversation = await client.createConversation(config.genieHandle);
        return sendJson(response, 201, conversation);
      }

      if (request.method === "GET" && url.pathname === "/api/conversations") {
        return sendJson(response, 200, await client.listConversations(config.genieHandle));
      }

      const historyRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (request.method === "GET" && historyRoute) {
        return sendJson(response, 200, await client.listMessages(config.genieHandle, decodeURIComponent(historyRoute[1])));
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

export function startServer(environment = loadEnvironmentFile()) {
  const port = Number(environment.PORT ?? 3000);
  const server = createApp(environment);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`Genie chat is ready at http://127.0.0.1:${address.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
