import { ErrorCode } from "./protocol.js";
import type {
  AckPayload,
  AssistantMessagePayload,
  Envelope,
  ErrorPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "./protocol.js";

const SDK_VERSION = "0.1.0";

/** A tool handler the developer registers to fulfill a named tool call. */
export type ToolHandler = (args: any) => Promise<unknown> | unknown;

/**
 * A named tool handler, for array-based registration — an alternative to
 * building the `Record<string, ToolHandler>` map by hand (see
 * `AgentBridgeOptions.tools` and `defineTool`). Two tools with the same
 * `name` in the same array is a configuration error: the constructor throws
 * rather than silently letting one shadow the other the way a later key in
 * an object literal (`{ ...a, ...b }`) silently wins over an earlier one —
 * that failure mode surfaces at runtime as a tool call mysteriously never
 * reaching its handler, which is a hard way to discover a typo'd name.
 */
export interface ToolEntry {
  name: string;
  handle: ToolHandler;
}

/**
 * Converts array-based tool registration into the `Record<string,
 * ToolHandler>` shape `AgentBridgeOptions.tools` ultimately needs. Exported
 * so it's independently usable (e.g. to merge tool arrays from multiple
 * sources before constructing `AgentBridge`), not just an internal helper.
 */
export function toToolRecord(tools: ToolEntry[]): Record<string, ToolHandler> {
  const result: Record<string, ToolHandler> = {};
  for (const tool of tools) {
    if (Object.prototype.hasOwnProperty.call(result, tool.name)) {
      throw new Error(`toToolRecord: duplicate tool name "${tool.name}"`);
    }
    result[tool.name] = tool.handle;
  }
  return result;
}

/**
 * Defines a tool with its own typed arguments, instead of every handler
 * having to carve `args: any` into shape by hand with no compile-time check
 * that it actually matches what's declared. `parseArgs` is the source of
 * truth for `Args` — its return type, not a bare `as Args` assertion the
 * type system would trust without anyone actually having verified it at
 * runtime. Deliberately zero-dependency: `parseArgs` can be a few lines of
 * hand-written validation, or wrap a schema library's `.parse` method — the
 * SDK doesn't decide that for you.
 *
 * A `parseArgs` that throws propagates out of the resulting handler
 * unchanged, so it's reported back as a normal `{ ok: false, error }`
 * tool_result the same way any other handler error is (see
 * `handleToolCall`) — no separate error-handling path to learn.
 */
export function defineTool<Args>(
  name: string,
  parseArgs: (raw: unknown) => Args,
  handle: (args: Args) => Promise<unknown> | unknown
): ToolEntry {
  return {
    name,
    handle: (raw: any) => handle(parseArgs(raw)),
  };
}

export interface AgentBridgeOptions {
  /** WebSocket endpoint, e.g. "wss://agent.example.com/ws". */
  url: string;
  /** The developer app ID whose tool set this session should load. */
  appId: string;
  /**
   * API key issued for this app (see backend's `genkey` command). Sent as a
   * `token` query parameter on the WebSocket handshake — browsers cannot
   * attach custom headers to a WebSocket upgrade request, so this is the
   * only place it can travel. The backend verifies it and resolves the
   * connection's appId from it server-side; when set, this always overrides
   * whatever `appId` is passed above for authorization purposes; unset
   * connects in the backend's dev/no-auth mode if it's configured to allow
   * that. Because the key rides in the URL, only ever connect over wss:// —
   * plain ws:// puts it on the wire (and often in server access logs) in
   * plaintext.
   */
  apiKey?: string;
  /**
   * Tool handlers, either as a `Record<string, ToolHandler>` map you build
   * yourself, or a `ToolEntry[]` array (see `defineTool`) — the constructor
   * normalizes either shape the same way `toToolRecord` does, including its
   * duplicate-name check. Only names the backend already knows about (from
   * the app's tool definitions) will ever be invoked, but the SDK also
   * refuses to call anything not present here — the front-end never
   * executes arbitrary/unregistered actions.
   */
  tools: Record<string, ToolHandler> | ToolEntry[];
  /** Called for natural-language messages meant for display to the user. */
  onAssistantMessage?: (text: string) => void;
  /** Called on protocol/inference errors not tied to a specific call. */
  onError?: (err: ErrorPayload) => void;
  /**
   * Called when a prompt is refused because the app owner has hit their
   * monthly quota (the backend sends an error with code
   * ErrorCode.QuotaExceeded). Use it to show an upgrade prompt. The
   * connection is NOT closed — once the plan is upgraded, further prompts on
   * the same connection work again. If this handler is set, onError is NOT
   * also called for a quota error; if it is unset, the quota error falls
   * through to onError like any other.
   */
  onQuotaExceeded?: (err: ErrorPayload) => void;
  /** Reconnect backoff bounds, in ms. Defaults: 500ms .. 10s. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Close the socket while the page is hidden (tab switched away, window
   * minimized), reopening it when the page is shown again. Defaults to
   * true.
   *
   * A WebSocket is an open request for as long as it lives, so a serverless
   * host bills an instance for the whole time one is held — a single
   * forgotten tab pins an instance indefinitely, and a host that caps
   * request duration turns that into a reconnect every time it cuts the
   * connection, not an idle period. A hidden page can't be showing tool
   * results to anyone, so the connection is worth nothing while it's away.
   *
   * Messages sent while hidden are queued and flushed on the reconnect, the
   * same as any other pre-connection send, so callers see no difference.
   */
  disconnectWhenHidden?: boolean;
  /**
   * Wait for the first send before opening the socket, rather than
   * connecting in the constructor. Defaults to false.
   *
   * Worth turning on wherever the bridge is mounted on a page most visitors
   * never interact with (a marketing demo, a docs widget): without it every
   * pageview opens a connection that exists only to be paid for. `prompt()`
   * and every other send already queue until the socket is ready, so the
   * only visible cost is connection latency on the first message.
   */
  lazyConnect?: boolean;
  /**
   * HTTP endpoint to fire a best-effort `sendBeacon` to when the page is
   * hidden/unloaded with unsent queued messages. The WebSocket connection
   * closes before a final in-flight send would complete, so this mirrors
   * the beacon fallback pattern analytics SDKs use for the same reason.
   * Omit to skip this fallback entirely.
   */
  beaconUrl?: string;
}

type QueuedSend = { type: string; requestId?: string; payload?: unknown };

/**
 * Browser-side bridge between a page and the onagent backend.
 *
 * Modeled after gtag.js's stub-function-plus-queue pattern: calls made
 * before the socket is open (or during a reconnect) are buffered and
 * flushed once the connection is ready, so callers never have to check a
 * "ready" flag themselves.
 */
export class AgentBridge {
  private ws: WebSocket | null = null;
  private queue: QueuedSend[] = [];
  private ready = false;
  private closedByUser = false;
  private backoffMs: number;
  /** True while the socket is deliberately down and must not reconnect on
   * its own: the page is hidden, or lazyConnect is on and nothing has been
   * sent yet. Distinct from closedByUser, which is permanent. */
  private suspended = false;
  /** Whether a socket has ever opened. Lets the visibility handler tell a
   * lazy bridge nobody has used yet (leave it closed) from one that has
   * been used and was closed only because the page went away (reopen). */
  private hasConnected = false;
  /** Removes the visibilitychange listener; set while one is installed. */
  private detachVisibility?: () => void;

  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly disconnectWhenHidden: boolean;
  /** opts.tools normalized to a Record once, regardless of which shape the
   * developer passed in — every other method reads this, never opts.tools
   * directly. */
  private readonly tools: Record<string, ToolHandler>;

  constructor(private readonly opts: AgentBridgeOptions) {
    this.minBackoffMs = opts.minBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.backoffMs = this.minBackoffMs;
    this.tools = Array.isArray(opts.tools) ? toToolRecord(opts.tools) : opts.tools;
    this.disconnectWhenHidden = opts.disconnectWhenHidden ?? true;
    this.installUnloadFallback();
    this.installVisibilityHandling();
    // lazyConnect starts suspended rather than not-connected, so the first
    // enqueue knows to wake the socket (see enqueue).
    if (opts.lazyConnect) {
      this.suspended = true;
    } else {
      this.connect();
    }
  }

  /** Ask the inference service to reason about a prompt. */
  prompt(text: string): void {
    const requestId = randomRequestId();
    this.enqueue({ type: "prompt", requestId, payload: { text } });
  }

  /** Tear down the connection. No further reconnect attempts will be made. */
  close(): void {
    this.closedByUser = true;
    // Detach the page-lifecycle listener too. Without this a closed bridge
    // stays subscribed to visibilitychange for the life of the document,
    // and every later hide/show would run its handler — which, for a
    // bridge that had been used, opens a fresh socket. A long-lived page
    // that creates and closes bridges (a SPA route that mounts a demo,
    // say) would accumulate one such listener per bridge, each reopening
    // a connection nobody is using.
    this.detachVisibility?.();
    this.detachVisibility = undefined;
    this.ws?.close();
  }

  private wsUrl(): string {
    if (!this.opts.apiKey) return this.opts.url;
    const url = new URL(this.opts.url);
    url.searchParams.set("token", this.opts.apiKey);
    return url.toString();
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = this.minBackoffMs;
      this.hasConnected = true;
      this.send("hello", undefined, {
        appId: this.opts.appId,
        sdkVersion: SDK_VERSION,
        pageUrl: typeof location !== "undefined" ? location.href : undefined,
      });
    });

    ws.addEventListener("message", (ev) => {
      this.handleMessage(String(ev.data));
    });

    ws.addEventListener("close", () => {
      this.ready = false;
      // suspended covers a close we asked for (page hidden, or a lazy
      // bridge that hasn't been used yet) — reconnecting here would undo
      // it immediately and reinstate the very connection we just dropped.
      if (this.closedByUser || this.suspended) return;
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The subsequent "close" event drives reconnect; nothing to do here
      // beyond letting it fire.
    });
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private handleMessage(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }

    switch (env.type) {
      case "ack": {
        const ack = env.payload as AckPayload;
        this.ready = true;
        this.flushQueue();
        this.validateHandlers(ack.toolNames);
        break;
      }
      case "tool_call":
      case "tool_query":
        // Mechanically identical from here: run the registered handler,
        // await it, send back a tool_result. The backend blocks the LLM's
        // reasoning on that tool_result either way (see backend's
        // internal/inference forwardingTool/queryTool via askPage). The two
        // only differ in what reaches the LLM afterward — for "tool_call"
        // only success/failure does; for "tool_query" the actual result
        // value does too (see toolschema.ToolKind). That distinction lives
        // entirely server-side; a tool handler here is written exactly the
        // same way regardless of which one invokes it.
        this.handleToolCall(env.requestId, env.payload as ToolCallPayload);
        break;
      case "assistant_message":
        this.opts.onAssistantMessage?.(
          (env.payload as AssistantMessagePayload).text
        );
        break;
      case "error": {
        const err = env.payload as ErrorPayload;
        // A quota rejection routes to its dedicated handler if the developer
        // set one, so they can show an upgrade UI without string-matching
        // the message. Falls through to onError when onQuotaExceeded is
        // unset, so a developer who doesn't care still sees it as an error.
        if (err.code === ErrorCode.QuotaExceeded && this.opts.onQuotaExceeded) {
          this.opts.onQuotaExceeded(err);
        } else {
          this.opts.onError?.(err);
        }
        break;
      }
    }
  }

  private validateHandlers(toolNames: string[]): void {
    const missing = toolNames.filter((name) => !(name in this.tools));
    if (missing.length > 0) {
      console.warn(
        `[agent-bridge] backend declares tools with no registered handler: ${missing.join(", ")}`
      );
    }
  }

  private async handleToolCall(
    requestId: string | undefined,
    payload: ToolCallPayload
  ): Promise<void> {
    const handler = this.tools[payload.toolName];
    if (!handler) {
      // Never fall back to eval/dynamic dispatch: an unregistered tool
      // name is rejected, not guessed at.
      this.send("tool_result", requestId, {
        toolName: payload.toolName,
        ok: false,
        error: `no handler registered for tool "${payload.toolName}"`,
      } satisfies ToolResultPayload);
      return;
    }

    try {
      const result = await handler(payload.args);
      this.send("tool_result", requestId, {
        toolName: payload.toolName,
        ok: true,
        result: result ?? null,
      } satisfies ToolResultPayload);
    } catch (err) {
      this.send("tool_result", requestId, {
        toolName: payload.toolName,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ToolResultPayload);
    }
  }

  private enqueue(msg: QueuedSend): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.write(msg);
      return;
    }
    this.queue.push(msg);
    // A suspended bridge has no reconnect pending, so something has to
    // start one — this is where a lazyConnect bridge opens its first
    // socket, and where a send made while hidden gets things moving rather
    // than waiting for the page to come back. Not done while the page is
    // actually hidden: the queue flushes on the visibilitychange instead.
    if (this.suspended && !this.closedByUser && !this.pageHidden()) {
      this.suspended = false;
      this.connect();
    }
  }

  private pageHidden(): boolean {
    return (
      this.disconnectWhenHidden &&
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    );
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) this.write(msg);
  }

  private send(type: string, requestId: string | undefined, payload: unknown): void {
    this.write({ type, requestId, payload });
  }

  private write(msg: QueuedSend): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queue.push(msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Drops the connection while the page is hidden and restores it when the
   * page comes back — see AgentBridgeOptions.disconnectWhenHidden for why
   * a held-open socket is worth dropping.
   *
   * Separate listener from installUnloadFallback's: that one flushes the
   * queue via sendBeacon and only when beaconUrl is set, which is a
   * different concern on the same event.
   */
  private installVisibilityHandling(): void {
    if (!this.disconnectWhenHidden) return;
    if (typeof document === "undefined") return;

    const onVisibilityChange = () => {
      if (this.closedByUser) return;

      if (document.visibilityState === "hidden") {
        // Set before close() so the close handler sees it and skips its
        // reconnect — the listener fires synchronously on the same tick.
        this.suspended = true;
        this.ws?.close();
        return;
      }

      // Visible again. A bridge that has never been used stays suspended:
      // showing a page is not a reason to open a connection lazyConnect
      // deliberately deferred. Anything queued means someone tried to send
      // while away, so that does warrant reconnecting.
      if (!this.suspended) return;
      if (this.opts.lazyConnect && this.queue.length === 0 && !this.hasConnected) return;
      this.suspended = false;
      this.connect();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    this.detachVisibility = () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  /**
   * Best-effort delivery of whatever's still queued on page unload, since
   * the WebSocket connection is torn down before an in-flight message can
   * be flushed. Mirrors the sendBeacon fallback pattern analytics SDKs use
   * for the same reason. Requires opts.beaconUrl to be set; a no-op
   * otherwise.
   */
  private installUnloadFallback(): void {
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    if (!navigator.sendBeacon) return;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      if (this.queue.length === 0) return;
      if (!this.opts.beaconUrl) return;
      navigator.sendBeacon(
        this.opts.beaconUrl,
        JSON.stringify({ appId: this.opts.appId, queued: this.queue })
      );
    });
  }
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
