/**
 * Wire types mirroring backend/internal/protocol/message.go. Keep these two
 * in sync manually until/unless we add a shared codegen step for them too.
 */

export type MessageType =
  | "hello"
  | "context"
  | "prompt"
  | "tool_result"
  | "ack"
  | "tool_call"
  | "tool_query"
  | "assistant_message"
  | "error";

export interface Envelope<T = unknown> {
  type: MessageType;
  requestId?: string;
  payload?: T;
}

export interface HelloPayload {
  appId: string;
  sdkVersion?: string;
  pageUrl?: string;
  initialData?: unknown;
}

export interface AckPayload {
  sessionId: string;
  toolNames: string[];
}

export interface ContextPayload {
  data: unknown;
}

export interface PromptPayload {
  text: string;
  context?: unknown;
}

export interface ToolCallPayload {
  toolName: string;
  args: unknown;
}

export interface ToolResultPayload {
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AssistantMessagePayload {
  text: string;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}
