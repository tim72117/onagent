# `thought` 欄位 Markdown 編輯器規劃

> 狀態：**已實作，但方向與本文件原始規劃不同**——最終選用 Tiptap（WYSIWYG），不是本文件推薦的
> `@uiw/react-md-editor`（純文字+預覽）。方向轉變原因：後續需求明確要「直接在渲染畫面上編輯」，
> 這正是本文件「非目標」一節列為排除項目的 WYSIWYG 模式，因此重新評估後改採 Tiptap +
> `@tiptap/markdown`。實際實作見 `apps/console/src/ThoughtEditor.tsx`；本文件保留作為最初探索
> 過程的歷史記錄，套件選項比較表格本身仍然有效，僅「推薦」與「非目標」結論已被取代。

## 現況

`apps/console/src/ThoughtEditor.tsx` 是編輯一個 app 的 `thought`（`toolschema.App.Thought`，餵給 want agent 的自訂 system prompt）的元件。目前是一個純 `<textarea>`：

```tsx
<textarea
  className="thought-textarea"
  rows={12}
  value={value}
  onChange={(e) => onChange(e.target.value)}
  placeholder={defaultPreview}
/>
```

沒有任何 Markdown 語法高亮、即時預覽，或渲染。`value` 存的是純文字字串，直接透過 `PUT /console/apps/{appId}/thought` 存回後端（見 `App.tsx` 呼叫 `ThoughtEditor` 的地方），完全不涉及 HTML/Markdown 轉換。

實際內容範例（`examples/analysis/tools.yaml` 的 `thought` 欄位）已經大量使用 Markdown 語法（`**粗體**`、`# 標題`、清單、行內反引號）撰寫，但目前在 console 裡編輯時只看得到純文字原始碼，看不到排版後的樣子。

## 目標

讓開發者在 console 編輯 `thought` 時，能看到 Markdown 語法實際渲染後的樣子（至少是預覽，理想是即時預覽），比較容易確認格式有沒有寫對，而不用複製到別的地方才能看到渲染結果。

**非目標**：
- 不改變 `thought` 儲存的資料格式——後端 API、資料庫欄位都還是純文字字串，只是編輯器的**呈現方式**改變。
- 不影響 LLM 收到的內容——want agent 讀到的 `thought` 一樣是原始 Markdown 純文字，模型看到的東西完全不變。
- 不做 WYSIWYG（所見即所得直接編輯渲染後的內容）——只需要「編輯純文字、旁邊/切換看預覽」，不需要富文本編輯的複雜度。

## 套件選項

| 套件 | 定位 | 备註 |
|---|---|---|
| `react-markdown` | 純渲染 | 只做顯示，不含編輯 UI；shuttle 專案的 `ChatScreen.tsx` 已經在用這個渲染 LLM 回覆，生態成熟、MIT 授權 |
| `@uiw/react-md-editor` | 編輯 + 即時預覽 | React 專用、輕量、內建 dark mode、社群使用量大，設定成本低 |
| `@toast-ui/react-editor` | 編輯 + 即時預覽 | 功能更完整（WYSIWYG/Markdown 模式切換），但體積跟設定複雜度也更高，對這個單純的文字欄位是過度設計 |
| Tiptap（ProseMirror-based） | Headless 富文本編輯 | 高度可客製化，但屬於「所見即所得」路線，跟這裡「純文字 + 預覽」的需求方向不同，過度工程 |

**推薦：`@uiw/react-md-editor`**——輕量、React 專用、內建預覽跟 dark mode 切換，符合現在只是「一個文字欄位加預覽」的規模，不需要 Tiptap/Toast UI 那種富文本編輯器的複雜度。

## 實作規劃（草案）

1. `apps/console/package.json` 加 `@uiw/react-md-editor` 依賴。
2. `ThoughtEditor.tsx` 把 `<textarea>` 換成 `@uiw/react-md-editor` 的 `<MDEditor>` 元件：
   - `value`/`onChange` 簽章跟現有的 `<textarea>` 相容，改動應該很小。
   - 需要決定預設顯示模式：純編輯、編輯+預覽並排、還是只顯示預覽分頁——考量 `thought` 通常是一次寫完、之後偶爾微調，「編輯+預覽並排」可能是最實用的預設。
3. 樣式對齊：`@uiw/react-md-editor` 支援 CSS variable 客製化主題，需要對照 `apps/console/src/style.css` 現有的 `.thought-*` 相關樣式（`thought-header`/`thought-copy`/`thought-textarea`/`thought-default`），確保換掉 textarea 後排版跟顏色不會突兀地跳出 console 現有的視覺風格。
4. `defaultPreview`（目前平台預設 thought 的預覽文字，`value` 為空時顯示）那塊也可以考慮一併用 Markdown 渲染（用 `react-markdown` 顯示，不需要編輯功能），讓「這是平台預設值」那段文字也有正確排版。
5. Bundle size：`@uiw/react-md-editor` 內部依賴 CodeMirror，會讓 console 的 bundle 變大——建置後應該量測一下實際增加多少，評估是否要用動態 `import()` 延遲載入（只有真的打開 Thought 編輯畫面時才載入這個套件）。

## 風險 / 待確認

- **XSS**：`@uiw/react-md-editor` 的預覽渲染底層也是走 remark/rehype（跟 `react-markdown` 同一套生態），預設會逸出（escape）原始 HTML，不會執行使用者輸入的 script——但正式導入前應該實際測試一次，確認沒有意外開放 `dangerouslySetInnerHTML` 之類的逃生口。
- **`apps/admin`（系統管理員後台）需不需要同樣的體驗**：目前規劃只涵蓋 `apps/console`；如果 admin 那邊也有類似的長文字欄位（尚未確認），可以之後再評估是否套用同一個元件。
