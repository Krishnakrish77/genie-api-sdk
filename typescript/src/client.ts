import type { ClientOptions, Conversation, Event, EventData, Message, Page, Run, RuntimeConnectionLink, SkillResolution } from "./types.js";
import type { Auth } from "./auth.js";

const DEFAULT_BASE_URL = "https://genie-api.workato.com";

export class GenieApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Genie API request failed with status ${status}`);
    this.name = "GenieApiError";
  }
}

export class GenieClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly auth: Auth;

  constructor(options: ClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.auth = options.auth;
  }

  async listConversations(genieHandle: string, options: { limit?: number; cursor?: string } = {}): Promise<Page<Conversation>> {
    const data = await this.json<{ list: Conversation[]; total_count: number; cursor?: string }>("GET", this.path(genieHandle, "/conversations"), options);
    return { items: data.list, totalCount: data.total_count, cursor: data.cursor };
  }

  createConversation(genieHandle: string): Promise<Conversation> {
    return this.json("POST", this.path(genieHandle, "/conversations"));
  }

  getConversation(genieHandle: string, conversationId: string): Promise<Conversation> {
    return this.json("GET", this.path(genieHandle, `/conversations/${conversationId}`));
  }

  async listMessages(genieHandle: string, conversationId: string, options: { limit?: number; cursor?: string } = {}): Promise<Page<Message>> {
    const data = await this.json<{ messages: Message[]; total_count: number; cursor?: string }>("GET", this.path(genieHandle, `/conversations/${conversationId}/messages`), options);
    return { items: data.messages, totalCount: data.total_count, cursor: data.cursor };
  }

  sendMessage(genieHandle: string, conversationId: string, message: string, fileId?: string): Promise<Run> {
    return this.json("POST", this.path(genieHandle, `/conversations/${conversationId}/messages`), undefined, { message, file_id: fileId, stream: false });
  }

  private streamMessageOnce(genieHandle: string, conversationId: string, message: string, fileId?: string): AsyncIterable<Event> {
    return this.stream("POST", this.path(genieHandle, `/conversations/${conversationId}/messages`), { message, file_id: fileId, stream: true });
  }

  /** Streams a message with automatic reconnection and persisted-event replay. */
  async *streamMessage(genieHandle: string, conversationId: string, message: string, fileId?: string, maxReconnects = 3): AsyncGenerator<Event> {
    if (maxReconnects < 0) throw new Error("maxReconnects must be non-negative");
    let stream = this.streamMessageOnce(genieHandle, conversationId, message, fileId);
    let runId: string | undefined;
    let lastEventId: string | undefined;
    let lastCreatedAt: string | undefined;
    const seenEventIds = new Set<string>();
    let reconnects = 0;
    for (;;) {
      let interrupted = false;
      try {
        for await (const event of stream) {
          if (event.event_id) { seenEventIds.add(event.event_id); lastEventId = event.event_id; }
          if (event.created_at) lastCreatedAt = event.created_at;
          runId = event.genie_run_id ?? runId;
          yield event;
          if (event.type === "system.stream_interrupted") { interrupted = true; break; }
        }
      } catch (error) {
        if (!runId) throw error;
        interrupted = true;
      }
      if (!interrupted) return;
      if (runId && reconnects < maxReconnects) {
        reconnects += 1;
        stream = this.reconnect(genieHandle, conversationId, runId, lastEventId);
        continue;
      }
      for await (const event of this.replayEvents(genieHandle, conversationId, lastCreatedAt, seenEventIds)) yield event;
      return;
    }
  }

  private reconnect(genieHandle: string, conversationId: string, genieRunId: string, lastEventId?: string): AsyncIterable<Event> {
    return this.stream("GET", this.path(genieHandle, `/conversations/${conversationId}/genie-runs/${genieRunId}`), undefined, lastEventId ? { "Last-Event-ID": lastEventId } : undefined);
  }

  async listEvents(genieHandle: string, options: { sinceCreatedAt?: string; conversationId?: string; limit?: number } = {}): Promise<Page<Event>> {
    const params = { since_created_at: options.sinceCreatedAt, conversation_id: options.conversationId, limit: options.limit };
    const data = await this.json<{ events: Record<string, unknown>[]; next_since_created_at?: string }>("GET", this.path(genieHandle, "/conversations/events"), params);
    return { items: data.events.map(toEvent), totalCount: data.events.length, nextSinceCreatedAt: data.next_since_created_at };
  }

  async resolveSkillApproval(genieHandle: string, conversationId: string, callId: string, resolution: SkillResolution, rejectionReason?: string): Promise<void> {
    await this.json("POST", this.path(genieHandle, `/conversations/${conversationId}/skill_approval/${callId}`), undefined, { resolution, rejection_reason: rejectionReason });
  }

  getRuntimeConnectionLink(genieHandle: string, attemptId: string): Promise<RuntimeConnectionLink> {
    return this.json("POST", this.path(genieHandle, `/runtime_connection/${attemptId}/link`));
  }

  async rejectRuntimeConnection(genieHandle: string, attemptId: string, reason?: string): Promise<void> {
    await this.json("POST", this.path(genieHandle, `/runtime_connection/${attemptId}/reject`), undefined, { reason });
  }

  async uploadFile(genieHandle: string, conversationId: string, file: Blob): Promise<string> {
    const form = new FormData(); form.append("file", file);
    const response = await this.request("POST", this.path(genieHandle, `/conversations/${conversationId}/upload`), undefined, form);
    return (await response.json() as { file_id: string }).file_id;
  }

  private path(genieHandle: string, suffix: string): string { return `/api/v1/genies/${encodeURIComponent(genieHandle)}/chat${suffix}`; }

  private async json<T>(method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<T> {
    const response = await this.request(method, path, params, body);
    return response.json() as Promise<T>;
  }

  private async request(method: string, path: string, params?: Record<string, unknown>, body?: unknown, extraHeaders?: HeadersInit): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const isForm = body instanceof FormData;
    const response = await this.fetchImpl(url, {
      method,
      headers: { Accept: "application/json", ...(await this.auth.headers()), ...(isForm ? {} : body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
    });
    if (!response.ok) {
      let errorBody: unknown; try { errorBody = await response.json(); } catch { errorBody = await response.text(); }
      throw new GenieApiError(response.status, errorBody);
    }
    return response;
  }

  private async *stream(method: string, path: string, body?: unknown, streamHeaders?: HeadersInit): AsyncGenerator<Event> {
    const response = await this.request(method, path, undefined, body, { Accept: "text/event-stream", ...streamHeaders });
    if (!response.body) throw new Error("The response did not include a readable SSE body");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseFrame(frame); if (event) yield event;
      }
    }
    if (buffer) { const event = parseSseFrame(buffer); if (event) yield event; }
  }

  private async *replayEvents(genieHandle: string, conversationId: string, sinceCreatedAt: string | undefined, seenEventIds: Set<string>): AsyncGenerator<Event> {
    for (;;) {
      const page = await this.listEvents(genieHandle, { conversationId, sinceCreatedAt });
      for (const event of page.items) {
        if (!event.event_id || !seenEventIds.has(event.event_id)) {
          if (event.event_id) seenEventIds.add(event.event_id);
          yield event;
        }
      }
      if (!page.nextSinceCreatedAt) return;
      sinceCreatedAt = page.nextSinceCreatedAt;
    }
  }
}

function parseSseFrame(frame: string): Event | undefined {
  let type: string | undefined; let id: string | undefined; const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  return toEvent(JSON.parse(data.join("\n")) as Record<string, unknown>, type, id);
}

function toEvent(value: Record<string, unknown>, type?: string, id?: string): Event {
  const keys = new Set(["type", "event_id", "conversation_id", "genie_handle", "genie_run_id", "seq_num", "created_at"]);
  const data = Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key))) as EventData;
  return { ...(value as Omit<Event, "data" | "type">), type: type ?? String(value.type ?? "message"), event_id: id ?? value.event_id as string | undefined, data };
}
