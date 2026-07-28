# Console：YAML 直接編輯 tool 定義（2026-07-28）

> 狀態：prototype 完成（顯示 + 語法高亮 + 編輯），未接 Save，未做驗證。這份文件記錄現況、技術決策依據，以及尚未實作的「即時驗證」功能的可行性查證結果。

## 背景

Console 目前透過 `ToolForm`/`SchemaEditor` 兩個元件，用逐欄位的表單編輯 app 的 tool 定義（name、description、parameters 結構）。使用者提出：改成直接編輯一份 YAML 文字（帶語法高亮），取代表單，並詢問這個改動的複雜度。

決定先做一個純 UI prototype（只做顯示 + 編輯，不接 Save、不做反向解析驗證），評估體驗後再決定是否要往下做完整實作、以及是否要真的移除表單介面。

## 現況：`YamlEditor.tsx`（prototype）

- 路徑：`apps/console/src/YamlEditor.tsx`
- 尚未掛載到 `App.tsx` 畫面上——是獨立可用但還沒接進主流程的元件。
- 功能：純顯示 + 編輯 + YAML 語法高亮 + 行號。**不**做：Save、YAML → `App` 反向解析、schema/格式驗證。
- 表單編輯介面（`ToolForm.tsx`/`SchemaEditor.tsx`）維持不動、未刪除，兩者暫時並存。

## 技術決策：套件選擇與依賴精簡

依序做了三次查證與精簡，過程記錄如下（供之後類似的依賴選型參考）：

1. **初次選型**：`@uiw/react-codemirror` + `codemirror` + `@codemirror/lang-yaml`，用套件的 `basicSetup` 選項一次啟用行號/fold/highlight。
   - 查證：MIT 授權、`codemirror` 核心每月下載約 3,880 萬次、`@uiw/react-codemirror` 近期（2026-07-08）仍有發版——熱門度與活躍度均無警訊。
   - 磁碟大小：約 4.5MB，15 個子套件。

2. **移除 `basicSetup` 懶人包**：`basicSetup` 底層透過 `@uiw/codemirror-extensions-basic-setup` 一次拉入 7 個模組（`autocomplete`/`commands`/`language`/`lint`/`search`/`state`/`view`），但這個 prototype 只需要行號跟語法高亮。改成手動列出 `[yamlLang(), lineNumbers(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle)]`，不透過 `basicSetup`。

3. **移除 React 封裝層**：`@uiw/react-codemirror` 本身只是把 `EditorView` 的掛載/卸載/`value` 同步邏輯包成 React hook（`useCodeMirror`），這是 CodeMirror 官方「Using with React」文件的標準範例，約 20 行程式碼即可自寫（見 `YamlEditor.tsx` 內的 `useEffect` 綁定邏輯）。改成直接綁定 `@codemirror/view`/`@codemirror/state`，移除 `@uiw/react-codemirror` 這個 916K 的封裝層依賴。

**最終依賴**（`apps/console/package.json`）：

```json
"@codemirror/lang-yaml": "^6.1.3",
"@codemirror/state": "^6.7.1",
"@codemirror/view": "^6.43.7",
"codemirror": "^6.0.2",
```

磁碟大小約 2.76MB（`@codemirror` 2.0M + `@lezer` 712K，後者是 `lang-yaml` 的語法解析器依賴，無法再省 + `codemirror` meta 套件 44K）。production bundle 實際大小會遠小於此（tree-shaking 後估 100-200KB），且建議用 `React.lazy()` 延遲載入這個元件，讓沒有切換到 YAML 檢視的使用者完全不受影響。

**注意**：`npm uninstall` 不會自動清除已變成孤兒的間接依賴（例如移除 `@uiw/react-codemirror` 後，它拉入的 `autocomplete`/`commands`/`lint`/`search` 仍留在 `node_modules` 裡），需要手動 `rm -rf` 對應目錄或重新乾淨安裝才會真正反映到磁碟大小上。`package.json` 本身是準確的依賴清單。

## 未來可能功能：即時語法/schema 驗證（尚未實作）

已查證可行，尚未動手，僅記錄設計方向：

**機制**：`@codemirror/lint` 提供 `linter(source)` extension，`source` 是一個回傳 `Diagnostic[]` 的函式，會在使用者輸入時（debounce 後）被呼叫。`Diagnostic` 型別：

```ts
interface Diagnostic {
  from: number       // 錯誤起始字元位置
  to: number         // 錯誤結束字元位置
  severity: Severity // 'error' | 'warning' | 'info'
  message: string
  // ...
}
```

**串接既有驗證邏輯**：這個專案已有 `apps/console/src/validate.ts` 的 `validateApp(app): ValidationIssue[]`（檢查 appId、tool name 格式、重複名稱、缺 description 等），但 `ValidationIssue` 目前只有 `{ toolIndex, message }`，沒有文字位置資訊。要接上 CodeMirror 的 lint，需要：

1. 用 `yaml` 套件（已是既有依賴）的 `parseDocument()`（不是 `yaml.parse()`）把 YAML 文字解析成 `App` 物件——`parseDocument` 會保留每個節點在原始文字裡的位置（`range`/`node.range`），是後續反查位置的關鍵。
2. 把解析出的 `App` 餵給既有的 `validateApp()`，拿到 `ValidationIssue[]`。
3. 依 `ValidationIssue.toolIndex` 反查該 tool 節點在 `parseDocument` 結果裡的位置，組成 `Diagnostic[]`。
4. YAML 本身的語法錯誤（縮排、格式錯誤）由 `parseDocument` 過程直接拋出的錯誤/警告清單提供，同樣可轉成 `Diagnostic`。

**額外依賴成本**：`@codemirror/lint` 一個模組（已查證存在、API 穩定，磁碟增量約數百 KB，屬於已在用的 `@codemirror/*` 系列延伸）。

## 待決定事項（如果要繼續往下做）

- 是否接 Save：YAML 編輯完成後要能反向解析、通過驗證、呼叫既有的 `api.saveTools`（透過 `useAppMutations` hook）。
- 是否移除表單介面（`ToolForm`/`SchemaEditor`）：使用者先前傾向「完全取代」，但目前仍維持兩者並存，等 prototype 體驗確認後再決定。
- 是否接上面所述的即時驗證（`@codemirror/lint`）。
- `React.lazy()` 延遲載入的實際接線（目前 `YamlEditor.tsx` 存在但未掛載進 `App.tsx`）。
