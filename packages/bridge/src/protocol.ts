/**
 * Wire types mirroring backend/internal/protocol/message.go. Keep these two
 * in sync manually until/unless we add a shared codegen step for them too.
 */

export type MessageType =
  | "hello"
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

export interface PromptPayload {
  text: string;
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
  /**
   * Machine-readable reason, set only when the SDK is expected to branch on
   * it rather than parse `message`. See ErrorCode. Most errors omit it.
   */
  code?: string;
}

/**
 * Known values for ErrorPayload.code. Mirrors the backend's
 * protocol.Code* constants (internal/protocol/message.go).
 */
export const ErrorCode = {
  /**
   * The app owner has used their whole prompt allowance for the current
   * billing period. The connection stays open (upgrade and keep going), so
   * this arrives once per rejected prompt, not as a socket close.
   */
  QuotaExceeded: "quota_exceeded",
} as const;
