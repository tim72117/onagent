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
  /**
   * Images attached to `text`, in order. Accepted only by an app whose owner
   * has turned images on; otherwise the prompt is rejected with
   * ErrorCode.ImagesNotAllowed. Omitted for a text-only prompt.
   */
  images?: PromptImage[];
}

/** One image attached to a prompt. See `imageFromBlob` to build one from a File. */
export interface PromptImage {
  /** One of image/png, image/jpeg, image/gif, image/webp — and it must match the bytes. */
  mediaType: string;
  /** The image's base64, without a `data:` URL prefix. */
  data: string;
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
  /** The prompt's text is over the app's character limit. */
  PromptTooLong: "prompt_too_long",
  /** The prompt attached images, but this app doesn't accept them. */
  ImagesNotAllowed: "images_not_allowed",
  /** The prompt attached more images than this app allows. */
  TooManyImages: "too_many_images",
  /**
   * An attached image was rejected: unsupported type, bad base64, bytes that
   * don't match `mediaType`, or over the size limit.
   */
  InvalidImage: "invalid_image",
} as const;
