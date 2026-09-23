# 提案：`@onagent/bridge` 新增 tool call 開始/結束事件

- 提出日期：2026-09-23
- 提出者：tripace 專案（`/plan-ai` AI 行程規劃時間軸原型）
- 現況：待評估，尚未實作
- 影響套件：`@onagent/bridge`（目前版本 0.1.0）

## 問題描述

tripace 的 `/plan-ai` 頁面（`AIPlanTimelinePage.tsx`）用 `AgentBridge` 串接 onagent，讓使用者在對話框輸入指令，LLM 呼叫 `search_attraction`/`add_attraction` 兩個前端工具，把景點卡片即時寫進時間軸畫面。

畫面上需要一組「AI 正在做事」的思考動畫（呼吸點 + 骨架佔位卡），讓使用者知道現在還在處理、不是卡住了。但目前 `AgentBridgeOptions` 只暴露三個回呼：

```ts
onAssistantMessage?: (text: string) => void   // LLM 最終文字回覆
onError?: (err: ErrorPayload) => void         // 協定/推論錯誤
onQuotaExceeded?: (err: ErrorPayload) => void // 配額超限
```

沒有任何「工具呼叫開始」「工具呼叫結束」的事件。這導致目前只能用 `isThinking` 這個粗粒度狀態（從 `prompt()` 呼叫那一刻到 `onAssistantMessage`/`onError` 觸發為止）去驅動思考動畫——但 LLM 的實際流程通常是「呼叫一個或多個工具 → 组一段文字回覆」，工具呼叫完成、畫面上的景點卡片已經真的出現之後，`isThinking` 仍然是 `true`（因為 LLM 還在組文字回覆），使用者會看到「景點卡片已經生成，但下面還跟著一張骨架佔位卡」這種時序上略顯奇怪的畫面——即使這是目前唯一可行的近似值，也無法做到「卡片對應到哪一次工具呼叫」這種更精確的呈現。

## 現有協定行為（已確認）

檢查 `@onagent/bridge@0.1.0` 原始碼（`dist/client.js`）確認：伺服器**確實有**送出對應的協定訊息，只是 SDK 沒有把它們轉發成公開事件：

```js
handleMessage(raw) {
  ...
  switch (env.type) {
    case "tool_call":
    case "tool_query":
      // 內部直接呼叫 handleToolCall(requestId, payload),
      // 執行完 handler 後自動送出 tool_result,全程私有、不對外暴露
      this.handleToolCall(env.requestId, env.payload);
      break;
    ...
  }
}
```

`handleToolCall` 是 class 的私有方法，執行完開發者註冊的 `handle(args)` 之後自動送出 `tool_result`——這整段「收到呼叫 → 執行 → 回送結果」對應用層完全不可見。目前應用層唯一能感知「工具正在跑」的方式，是**工具的 `handle` 函式自己在執行當下同步呼叫某個 setState**（tripace 這裡是 `ctx.setSteps(...)`），這是應用層自己的副作用，跟 SDK 的事件系統完全脫鉤——沒辦法在「工具即將被呼叫、但還沒執行」的那個時間點顯示任何狀態。

## 建議的 API 設計

在 `AgentBridgeOptions` 新增兩個 optional 回呼，比照現有 `onAssistantMessage`/`onError` 的命名與簽章風格：

```ts
export interface AgentBridgeOptions {
  ...
  /**
   * Called right before a registered tool handler runs, for the LLM's
   * tool_call/tool_query. Fires once per call, before await handler(args).
   */
  onToolCallStart?: (info: { toolName: string; requestId: string; args: unknown }) => void

  /**
   * Called right after a tool handler settles (success or failure), before
   * tool_result is sent back over the wire. `result` is only present when
   * `ok` is true; `error` mirrors what tool_result.error would carry.
   */
  onToolCallEnd?: (info: {
    toolName: string
    requestId: string
    ok: boolean
    result?: unknown
    error?: string
  }) => void
}
```

實作只需要在 `handleToolCall` 內部各插入一行呼叫：

```js
async handleToolCall(requestId, payload) {
    const handler = this.tools[payload.toolName];
    if (!handler) { ... }

    this.opts.onToolCallStart?.({ toolName: payload.toolName, requestId, args: payload.args });

    try {
        const result = await handler(payload.args);
        this.opts.onToolCallEnd?.({ toolName: payload.toolName, requestId, ok: true, result: result ?? null });
        this.send("tool_result", requestId, { toolName: payload.toolName, ok: true, result: result ?? null });
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.opts.onToolCallEnd?.({ toolName: payload.toolName, requestId, ok: false, error });
        this.send("tool_result", requestId, { toolName: payload.toolName, ok: false, error });
    }
}
```

不影響任何既有行為——兩個回呼都是 optional，未設定時完全零成本（`?.()` 短路）；`tool_call`/`tool_query` 現有的「阻塞 LLM 推理直到 tool_result 送達」語意不變，這只是額外對外廣播兩個時間點的事件，不介入既有的執行/回送流程。

## 使用情境（呼叫端範例）

有了這兩個事件，`/plan-ai` 這類頁面就能把思考動畫精準綁在「工具真的在跑」這個窗口，而不是整個 `isThinking` 大區間：

```ts
const [activeToolCalls, setActiveToolCalls] = useState<Set<string>>(new Set())

new AgentBridge({
  ...
  onToolCallStart: ({ requestId }) => {
    setActiveToolCalls((prev) => new Set(prev).add(requestId))
  },
  onToolCallEnd: ({ requestId }) => {
    setActiveToolCalls((prev) => {
      const next = new Set(prev)
      next.delete(requestId)
      return next
    })
  },
})

const isCallingTool = activeToolCalls.size > 0
```

這也讓「哪一個工具正在執行」「這次呼叫傳了什麼參數」這類除錯/可觀測性資訊變得可見，目前完全無法從應用層取得。

## 影響範圍評估

- **破壞性變更**：無。純新增 optional 欄位。
- **SDK 版本建議**：patch 或 minor 皆可（新增能力，非修正 bug），依專案既有版號慣例決定。
- **需要更新的文件**：`AgentBridgeOptions` 的型別註解／README 範例（若有）。

## 待確認事項

- `args`/`result` 的型別目前 SDK 內部就是 `unknown`/`any`（`ToolHandler` 定義如此），這裡沿用一致的寬鬆型別，是否要收斂由 SDK 維護者決定。
- 是否也要對 `tool_call` 跟 `tool_query` 兩種 kind 提供區分（目前建議的 `info` 不含 kind 欄位，因為協定文件本身說明兩者「從這裡看是機制上相同」，只在伺服器端決定回傳值是否餵回 LLM）——若呼叫端有分開處理的需求，可以再加一個 `kind: 'tool_call' | 'tool_query'` 欄位。
