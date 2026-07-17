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

export interface Event {
  type: string;
  event_id?: string;
  conversation_id?: string;
  genie_handle?: string;
  genie_run_id?: string;
  seq_num?: number;
  created_at?: string;
  data: EventData;
}

export type SkillResolution = "approved" | "rejected";

export interface RuntimeConnectionLink {
  status: "auth_required" | "authorized";
  auth_link?: { url: string; expires_at: string; connector_name: string };
}
