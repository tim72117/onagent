import { ErrorCode } from "./protocol.js";
import type {
  AckPayload,
  AssistantMessagePayload,
  Envelope,
  ErrorPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "./protocol.js";

const SDK_VERSION = "0.2.0";

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
  /**
   * How to reach the backend. Defaults to "ws".
   *
   * - "ws": a WebSocket to `url`.
   * - "sse": Server-Sent Events down + HTTP POST up, for networks where a
   *   WebSocket can't get through (proxies that strip the Upgrade). Same
   *   messages, same handlers, same reconnect/queue behavior — only the
   *   wire differs. Needs `EventSource` and `fetch`.
   * - "auto": start with a WebSocket; if one closes without ever having
   *   opened, switch to SSE for the rest of this bridge's life.
   */
  transport?: "ws" | "sse" | "auto";
  /**
   * SSE endpoint, e.g. "https://agent.example.com/sse". Only used when
   * `transport` is "sse" or "auto". Defaults to `url` with ws(s):// →
   * http(s):// and a trailing "/ws" → "/sse".
   */
  sseUrl?: string;
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
  private transport: Transport | null = null;
  /** Which wire connect() uses next. Fixed unless transport is "auto" —
   * see onTransportClose for how "auto" moves between the two. */
  private activeMode: "ws" | "sse";
  /** Resolved SSE endpoint, or null when SSE is never used. */
  private readonly sseBase: string | null;
  /** "auto" mode: consecutive WebSocket attempts that closed without ever
   * opening. Reset by any successful open. See AUTO_FALLBACK_AFTER. */
  private wsNeverOpenedStreak = 0;
  /** "auto" mode, while on SSE: "trial" until an SSE connection has
   * actually opened, "committed" after. See onTransportClose. */
  private autoSse: "trial" | "committed" | null = null;
  /** When "auto" last committed to SSE — see AUTO_WS_REPROBE_MS. */
  private sseCommittedAt = 0;
  private queue: QueuedSend[] = [];
  /** Prompts whose SSE POST definitely didn't land. Kept apart from queue
   * and flushed ahead of it: they were sent before anything that has been
   * queued since, and must still arrive first. */
  private retry: QueuedSend[] = [];
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
    const mode = opts.transport ?? "ws";
    // Resolved up front so a bad URL or a missing EventSource fails here,
    // at construction, rather than silently on some later fallback.
    this.sseBase = mode === "ws" ? null : opts.sseUrl ?? deriveSseUrl(opts.url);
    if (mode === "sse" && typeof EventSource === "undefined") {
      throw new Error('AgentBridge: transport "sse" needs EventSource, which this environment lacks');
    }
    this.activeMode = mode === "sse" ? "sse" : "ws";
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
    this.transport?.close();
  }

  /** Appends the api key as a `token` query parameter — the only place it
   * can travel on either wire (neither a WebSocket upgrade nor an
   * EventSource request can carry custom headers). */
  private withToken(base: string): string {
    if (!this.opts.apiKey) return base;
    const url = new URL(base);
    url.searchParams.set("token", this.opts.apiKey);
    return url.toString();
  }

  private connect(): void {
    // Committed to SSE long enough that the WebSocket may work again (the
    // first switch may have been wrong, or the network may have changed):
    // give it one attempt. Failing that one sends us straight back to SSE —
    // the streak is primed so a single failure crosses the threshold.
    if (
      this.opts.transport === "auto" &&
      this.activeMode === "sse" &&
      this.autoSse === "committed" &&
      Date.now() - this.sseCommittedAt >= AUTO_WS_REPROBE_MS
    ) {
      this.activeMode = "ws";
      this.autoSse = null;
      this.wsNeverOpenedStreak = AUTO_FALLBACK_AFTER - 1;
    }

    // Every callback is tied to the transport it came from. A transport we
    // already replaced can still fire — a WebSocket's close event arrives
    // asynchronously, after a quick hide/show may already have connected a
    // new one — and acting on it would mark the live connection not ready
    // and schedule yet another connect, orphaning the live one.
    let t: Transport;
    const current = () => this.transport === t;
    const handlers: TransportHandlers = {
      onOpen: () => current() && this.onTransportOpen(),
      onMessage: (raw) => current() && this.handleMessage(raw),
      onClose: (opened) => current() && this.onTransportClose(opened),
    };
    t =
      this.activeMode === "sse"
        ? new SseTransport(this.withToken(this.sseBase!), this.sseBase!, handlers, (msg, failure) =>
            // Not gated on current(): a prompt lost by an old transport
            // still has to be resent on the new one.
            this.onSendFailed(msg, failure)
          )
        : new WsTransport(this.withToken(this.opts.url), handlers);
    this.transport = t;
  }

  private onTransportOpen(): void {
    this.backoffMs = this.minBackoffMs;
    this.hasConnected = true;
    if (this.activeMode === "ws") {
      this.wsNeverOpenedStreak = 0;
    } else if (this.opts.transport === "auto" && this.autoSse !== "committed") {
      this.autoSse = "committed";
      this.sseCommittedAt = Date.now();
    }
    this.send("hello", undefined, {
      appId: this.opts.appId,
      sdkVersion: SDK_VERSION,
      pageUrl: typeof location !== "undefined" ? location.href : undefined,
    });
  }

  private onTransportClose(opened: boolean): void {
    this.ready = false;
    // suspended covers a close we asked for (page hidden, or a lazy
    // bridge that hasn't been used yet) — reconnecting here would undo
    // it immediately and reinstate the very connection we just dropped.
    // Returning before the fallback logic below matters too: a close we
    // caused says nothing about whether either wire can get through.
    if (this.closedByUser || this.suspended) return;
    if (this.opts.transport === "auto") this.updateAutoMode(opened);
    this.scheduleReconnect();
  }

  /**
   * "auto" mode's choice of wire, after a connection closed on its own.
   *
   * The WebSocket API hides why a handshake failed, so a WebSocket that never
   * opens could mean a network that blocks it — or a backend that's down
   * (mid-deploy, say) or refusing this app (403 disabled, 429 over quota).
   * Only the first is a reason to switch, and the only way to tell them apart
   * is to try SSE: SSE can only get through where the server is up and
   * accepting us. So after AUTO_FALLBACK_AFTER failed WebSocket attempts,
   * SSE is tried as a "trial", and the bridge commits to SSE only once an
   * SSE connection actually opens. If SSE fails to open too, the problem
   * was never the wire: back to WebSocket, count reset.
   */
  private updateAutoMode(opened: boolean): void {
    if (this.activeMode === "ws") {
      if (opened || isOffline()) return;
      this.wsNeverOpenedStreak++;
      if (this.wsNeverOpenedStreak >= AUTO_FALLBACK_AFTER && typeof EventSource !== "undefined") {
        this.activeMode = "sse";
        this.autoSse = "trial";
      }
      return;
    }
    if (this.autoSse === "trial" && !opened) {
      this.activeMode = "ws";
      this.autoSse = null;
      this.wsNeverOpenedStreak = 0;
    }
  }

  /**
   * An SSE upstream POST that didn't succeed, sorted by what's known about
   * whether the server acted on it — resending is only safe when it
   * definitely didn't:
   *
   * - "not-delivered": the session was already gone (a 404, which the
   *   server returns before dispatching anything, or the transport closed
   *   before the POST went out). A prompt is resent on the next session —
   *   it's the user's intent, and that session can still answer it. hello
   *   is re-sent by every connection anyway, and a tool_result answers a
   *   question from the session that died, so neither is.
   * - "rejected": the server refused this message itself (e.g. 413 over the
   *   size limit). Resending would be refused identically, forever.
   * - "network": no response at all. The server may already have received
   *   it and started inference, so resending risks running a prompt — and
   *   its tools — twice.
   *
   * The last two are reported through onError instead of retried.
   */
  private onSendFailed(msg: QueuedSend, failure: SendFailure): void {
    if (failure.kind === "not-delivered") {
      if (msg.type !== "prompt") return;
      this.retry.push(msg);
      // The failure can report in after the next session is already up
      // (a slow POST from the old session outliving a fast reconnect) —
      // past the ack that would have flushed it. Send it now rather than
      // leave it waiting for some future reconnect.
      if (this.ready && this.transport?.isOpen) this.flushQueue();
      return;
    }
    this.opts.onError?.({
      message:
        failure.kind === "rejected"
          ? `server rejected a ${msg.type} message (HTTP ${failure.status})`
          : `a ${msg.type} message may not have reached the server (network error); not resent, to avoid running it twice`,
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
    if (this.ready && this.transport?.isOpen) {
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
    const pending = this.pending();
    this.queue = [];
    this.retry = [];
    for (const msg of pending) this.write(msg);
  }

  /** Everything waiting to be sent, in send order — see retry. */
  private pending(): QueuedSend[] {
    return [...this.retry, ...this.queue];
  }

  private send(type: string, requestId: string | undefined, payload: unknown): void {
    this.write({ type, requestId, payload });
  }

  private write(msg: QueuedSend): void {
    if (!this.transport?.isOpen) {
      this.queue.push(msg);
      return;
    }
    this.transport.send(msg);
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
        this.transport?.close();
        return;
      }

      // Visible again. A bridge that has never been used stays suspended:
      // showing a page is not a reason to open a connection lazyConnect
      // deliberately deferred. Anything queued means someone tried to send
      // while away, so that does warrant reconnecting.
      if (!this.suspended) return;
      if (this.opts.lazyConnect && this.pending().length === 0 && !this.hasConnected) return;
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
      const pending = this.pending();
      if (pending.length === 0) return;
      if (!this.opts.beaconUrl) return;
      navigator.sendBeacon(
        this.opts.beaconUrl,
        JSON.stringify({ appId: this.opts.appId, queued: pending })
      );
    });
  }
}

/** "auto" mode tries SSE after this many consecutive WebSocket attempts
 * that never opened — see AgentBridge.updateAutoMode. */
const AUTO_FALLBACK_AFTER = 3;

/** How long "auto" stays committed to SSE before its next reconnect tries
 * the WebSocket again — see AgentBridge.connect. */
const AUTO_WS_REPROBE_MS = 10 * 60_000;

/** SSE: how long to wait for the stream's session event and then the first
 * reply (normally the ack). A proxy that buffers event streams can leave an
 * EventSource connected but silent forever; this turns that into a
 * reconnect instead of a bridge that quietly never becomes ready. */
const SSE_HANDSHAKE_TIMEOUT_MS = 15_000;

/** SSE: how long one upstream POST may take. Sends are serialized, so a
 * single stalled POST would otherwise hold up every message after it —
 * including tool_results the server stops waiting for after 20s. */
const SSE_POST_TIMEOUT_MS = 10_000;

/** A browser that reports itself offline can't tell us anything about
 * whether a WebSocket would get through. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Why an SSE POST didn't succeed — see AgentBridge.onSendFailed. */
type SendFailure =
  | { kind: "not-delivered" }
  | { kind: "rejected"; status: number }
  | { kind: "network" };

/** What a Transport reports back to AgentBridge. */
interface TransportHandlers {
  /** The connection can take messages; AgentBridge sends hello next. */
  onOpen(): void;
  /** One server→client envelope, as raw JSON. */
  onMessage(raw: string): void;
  /** The connection is gone. `opened` is whether onOpen ever fired —
   * "auto" mode's signal that this wire can't get through at all. */
  onClose(opened: boolean): void;
}

/** One connection to the backend. AgentBridge owns everything above the
 * wire — hello, queueing, reconnect/backoff, tool dispatch — so a Transport
 * only moves envelopes. */
interface Transport {
  readonly isOpen: boolean;
  send(msg: QueuedSend): void;
  close(): void;
}

class WsTransport implements Transport {
  private readonly ws: WebSocket;
  private opened = false;

  constructor(url: string, h: TransportHandlers) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.opened = true;
      h.onOpen();
    });
    this.ws.addEventListener("message", (ev) => h.onMessage(String(ev.data)));
    this.ws.addEventListener("close", () => h.onClose(this.opened));
    this.ws.addEventListener("error", () => {
      // The subsequent "close" event drives reconnect; nothing to do here
      // beyond letting it fire.
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: QueuedSend): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * SSE down, HTTP POST up (backend: internal/ws/sse.go). The stream's first
 * event is a named "session" event carrying the sessionId every POST is
 * addressed to; after that it carries the same envelopes a WebSocket would.
 */
class SseTransport implements Transport {
  private readonly es: EventSource;
  private sessionId: string | null = null;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  /** Pending until the first envelope arrives — see SSE_HANDSHAKE_TIMEOUT_MS. */
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    streamUrl: string,
    private readonly base: string,
    private readonly h: TransportHandlers,
    private readonly onSendFailed: (msg: QueuedSend, failure: SendFailure) => void
  ) {
    this.es = new EventSource(streamUrl);
    this.handshakeTimer = setTimeout(() => this.shutdown(), SSE_HANDSHAKE_TIMEOUT_MS);
    this.es.addEventListener("session", (ev) => {
      try {
        this.sessionId = JSON.parse((ev as MessageEvent).data).sessionId ?? null;
      } catch {
        this.sessionId = null;
      }
      if (!this.sessionId) {
        this.shutdown();
        return;
      }
      h.onOpen();
    });
    this.es.addEventListener("message", (ev) => {
      // The first envelope (normally the ack to hello) ends the handshake.
      clearTimeout(this.handshakeTimer);
      h.onMessage(String((ev as MessageEvent).data));
    });
    // EventSource would retry on its own, but each retry is a brand-new
    // server session nobody has said hello on. Stop it and let AgentBridge's
    // own backoff + reconnect (which does say hello) take over, exactly as
    // a WebSocket close does.
    this.es.addEventListener("error", () => this.shutdown());
  }

  get isOpen(): boolean {
    return this.sessionId !== null && !this.closed;
  }

  send(msg: QueuedSend): void {
    const url = this.messageUrl();
    // Chained, not fired independently: separate fetches can overtake each
    // other on the wire, and a WebSocket never reorders — a prompt must
    // never land before the hello sent ahead of it.
    this.chain = this.chain.then(async () => {
      if (this.closed) {
        this.onSendFailed(msg, { kind: "not-delivered" });
        return;
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SSE_POST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          // text/plain, not application/json: it keeps this a CORS
          // "simple" request, so the browser sends it straight away instead
          // of preflighting every new session's URL first. The server reads
          // the raw body and ignores the content type.
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(msg),
          signal: abort.signal,
        });
      } catch {
        // No response, so this message's fate is unknown — onSendFailed
        // must not resend it. Only a timeout also ends the session: a POST
        // that hangs points at a broken connection, and keeping the
        // session would leave every later message queued behind it. A
        // plain network error is left to the stream's own error event.
        if (msg.type === "hello") return this.shutdown();
        this.onSendFailed(msg, { kind: "network" });
        if (abort.signal.aborted) this.shutdown();
        return;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) {
        // The session is gone (its stream closed, or this POST reached an
        // instance that doesn't hold it). The server answers this before
        // dispatching anything, so the message definitely wasn't acted on.
        this.onSendFailed(msg, { kind: "not-delivered" });
        this.shutdown();
        return;
      }
      if (!res.ok) {
        // A session whose hello didn't land never gets an ack, so nothing
        // queued behind it would ever be sent. Start over instead of
        // reporting it.
        if (msg.type === "hello") return this.shutdown();
        this.onSendFailed(msg, { kind: "rejected", status: res.status });
      }
    });
  }

  /** base + "/{sessionId}", via URL so a query string or hash already on
   * base stays where it belongs instead of swallowing the path segment. */
  private messageUrl(): string {
    const u = new URL(this.base);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/${encodeURIComponent(this.sessionId!)}`;
    return u.toString();
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.es.close();
    this.h.onClose(this.sessionId !== null);
  }
}

/** ws(s)://host/path/ws?q → http(s)://host/path/sse?q. The query string is
 * kept: anything the developer put on `url` (a token passed there rather
 * than via apiKey, say) must reach the SSE endpoint too. */
function deriveSseUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") u.protocol = "https:";
  else if (u.protocol === "ws:") u.protocol = "http:";
  if (!u.pathname.endsWith("/ws")) {
    throw new Error(
      `AgentBridge: can't derive an SSE URL from "${wsUrl}" (expected a path ending in /ws) — pass sseUrl explicitly`
    );
  }
  u.pathname = u.pathname.slice(0, -"/ws".length) + "/sse";
  u.hash = "";
  return u.toString();
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
