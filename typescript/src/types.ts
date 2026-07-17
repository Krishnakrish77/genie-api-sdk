export interface ClientOptions {
  /** OAuth access token. Mutually exclusive with apiKey. */
  accessToken?: string;
  /** Static Genie client API key. Requires idpUserId. */
  apiKey?: string;
  /** Workato IdP user ID asserted with an API key. */
  idpUserId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface Conversation {
  conversation_id: string;
  topic?: string;
  last_updated_at?: string;
  created_at?: string;
  updated_at?: string;
  state?: "idle" | "ai_running" | "skill_processing" | "awaiting_approval" | string;
  last_event?: Record<string, unknown>;
}

export interface Message {
  message_id: string;
  source: "user" | "genie" | string;
  content: string;
  genie_run_id?: string;
  created_at?: string;
}

export interface Run { conversation_id: string; genie_run_id: string; }

export interface Page<T> {
  items: T[];
  totalCount: number;
  cursor?: string;
  nextSinceCreatedAt?: string;
}

export type EventData = Record<string, unknown> & {
  message?: string;
  call_id?: string;
  runtime_connection_attempt_id?: string;
};

export interface EventBase {
  type: string;
  event_id?: string;
  conversation_id?: string;
  genie_handle?: string;
  genie_run_id?: string;
  seq_num?: number;
  created_at?: string;
  data: EventData;
}

export interface AgentMessageEvent extends EventBase {
  type: "agent.message";
  data: EventData & { message: string };
}

export interface SkillConfirmationRequiredEvent extends EventBase {
  type: "skill.confirmation_required";
  data: EventData & { call_id: string; skill_name: string; skill_id: string };
}

export interface RuntimeConnectionAuthRequiredEvent extends EventBase {
  type: "runtime_connection.auth_required";
  data: EventData & { runtime_connection_attempt_id: string };
}

export interface StreamInterruptedEvent extends EventBase {
  type: "system.stream_interrupted";
  data: EventData & { last_seq_num?: number; reason?: string; retry_after_ms?: number };
}

/** Unknown future event type. Its original payload is preserved in ``data``. */
export interface Event extends EventBase {}

export function isAgentMessageEvent(event: Event): event is AgentMessageEvent {
  return event.type === "agent.message" && typeof event.data.message === "string";
}

export function isSkillConfirmationRequiredEvent(event: Event): event is SkillConfirmationRequiredEvent {
  return event.type === "skill.confirmation_required" && typeof event.data.call_id === "string";
}

export function isRuntimeConnectionAuthRequiredEvent(event: Event): event is RuntimeConnectionAuthRequiredEvent {
  return event.type === "runtime_connection.auth_required" && typeof event.data.runtime_connection_attempt_id === "string";
}

export function isStreamInterruptedEvent(event: Event): event is StreamInterruptedEvent {
  return event.type === "system.stream_interrupted";
}

export type SkillResolution = "approved" | "rejected";

export interface RuntimeConnectionLink {
  status: "auth_required" | "authorized";
  auth_link?: { url: string; expires_at: string; connector_name: string };
}
