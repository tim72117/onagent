# TODO：修正 want 的 tool registry append-only bug

## 現況

`onagent save-tools`（或 console 網頁存檔）改一個既有 tool 的 `parameters`/`returns` schema
後，**同一個後端 process 生命週期內不會生效**——vLLM 實際收到的 tool 宣告，永遠是
這個 process 第一次註冊該 tool 名稱時的那一版，不管之後改幾次、推幾次都沒用。

`Thought`（系統提示詞）跟其他 app-level 設定不受影響，會正常立即生效——只有 tool
的 schema 內容本身卡住。

完整根因寫在 `want` repo：`/Users/caitingyu/Documents/want/doc/tool-registry-append-only-bug.md`。
簡述：`types.RegisterTool`（`want/types/registry.go:29-32`）把每次註冊 append 進
`GlobalRegistry.Declarations`，從不移除舊項目；查詢時 `GetTools` 取**第一筆**符合
名稱的就採用，新註冊的永遠排在後面、讀不到。

2026-07-15 debug `get_current_selection` 這個 query tool 時撞到，花了不少時間才
確認：一開始以為是 schema 內容（`properties`/`required`）沒送對，後來才發現是
這個 append-only 問題讓後端一直吐舊版 schema 給 vLLM，跟 schema 內容本身無關。

## 目前的 workaround

**改完 tool schema 後，重啟後端 process。** 沒有更輕量的繞法——這個 bug 在 want
內部，onagent 這邊的程式碼碰不到那層。

## 待辦

- [ ] 修 `want`：`RegisterTool` 改成依名稱去重/替換 `Declarations`，而不是無條件
      `append`（見 tool-registry-append-only-bug.md 的「修法方向」，方案 1 較根本）
- [ ] 修完後，反過來驗證 onagent 這邊「edit tool 立即生效」的承諾
      （`internal/inference/agent_roles.go` 的 `RegisterAppRole` 文件註解）是否
      真的兌現——目前那段註解描述的行為，因為這個 bug，實際上從來沒有被驗證過
- [ ] 修完後，回頭確認今天（2026-07-15）對 `get_current_selection` 做的
      workaround（把 `limit` 設成必填參數，繞開 vLLM 對零參數 tool call 的
      streaming 格式缺陷——見下面「附帶發現」）在乾淨重啟的後端上是否依然必要，
      或者其實跟 append-only bug 無關、要永久保留
- [ ] 考慮要不要在 `console` 存檔成功的回應裡加一個明確提示／警告，告知使用者
      「tool schema 的修改需要重啟後端才會生效」，在 want 真正修好之前，至少
      別讓人繼續在這個坑裡摸索

## 附帶發現：vLLM 對零參數 tool call 的 streaming 回應缺陷（獨立問題，不是 want 的 bug）

同一次 debug 過程中確認的另一個、完全獨立的問題：`google/gemma-4-12b-it`（透過
`https://vllm.e-gps.tw`）在模型決定呼叫一個「這輪 arguments 組出來是空字串
（`"{}"`）」的 function 時，streaming 回應的第一個（也是唯一一個）tool_call
chunk 會漏掉 `id`/`type`/`name`，只剩 `{"index":0,"function":{"arguments":"{}"}}`。
跟 tool 的 `parameters.properties` 有沒有宣告、是不是空物件完全無關——只要模型
最終沒有填任何非空的 `arguments`，就會觸發。加了選填參數、模型選擇不填一樣會
觸發；只有把該參數設成 `required`、逼模型每次都填值，才會避開。

這是上游 vLLM 服務本身的 bug，不是 want 或這個平台的程式碼問題。已知的 workaround：
`kind: query` 的 tool 如果天生不需要任何參數，加一個必填的參數（例如
`get_current_selection` 加的 `limit: integer, required`），逼模型一定要填值。
