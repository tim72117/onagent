---
name: npm-ci-lockfile-check
description: 在 Docker build（或任何跑 `npm ci` 的環境）之前，本地先用 `npm ci` 驗證 package.json 與 package-lock.json 確實同步。適用於任何 Node/npm 專案，不限本專案。觸發語如「部署前檢查」「npm ci 失敗」「lockfile 不同步」「Dockerfile npm 錯誤」。
---

# npm-ci-lockfile-check

`npm ci` 在 Docker build 失敗，第一直覺常常是「跨平台環境不一致」（Windows 開發機 vs Linux 容器），但實際上**絕大多數情況是本地 `package.json` 跟 `package-lock.json` 單純沒同步**——`npm install` 在本地不會嚴格檢查這件事，`npm ci` 會。

## 根本原因

`npm install` 只確保「`node_modules` 現狀滿足 `package.json`」，如果本地 `node_modules` 已經有某個套件（例如你手動裝過、或之前某次 install 留下的），`npm install` 可能不會把它正確寫回 `package-lock.json`，即使 lockfile 實際上缺了一筆 resolved entry。這種情況下本地 `npm run build`/`npm test` 完全正常，因為 `node_modules` 是好的——問題只有在**重新從 lockfile 乾淨安裝**時才會浮現。

`npm ci` 的行為不同：它會先驗證 `package.json` 與 lockfile 是否精確對得上，對不上就直接報 `EUSAGE` 錯誤並拒絕安裝，不會嘗試修復。Docker build 裡幾乎一定用 `npm ci`（可重現、決定性安裝），所以這個落差只會在 build 當下才炸開。

跨平台問題（例如 `@rollup/rollup-*`、`esbuild` 這類有 optional 原生二進位套件的）也會造成類似的 build 失敗，但通常訊息會提到平台字串（`linux-x64-musl` 之類）；`EUSAGE`/`Missing: X from lock file` 這種訊息幾乎都是純粹的 lockfile 漂移，不是平台問題——先看清楚錯誤訊息類型再下結論，不要預設是平台問題。

## 檢查方式

在任何會被 Docker build（或 CI）用 `npm ci` 安裝的目錄，本地執行：

```bash
npm ci
```

而不是 `npm install`。如果報錯，訊息會直接列出哪些套件在 lockfile 裡缺失或版本不對，例如：

```
npm error `npm ci` can only install packages when your package.json and
package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: @floating-ui/dom@1.8.0 from lock file
```

## 修正方式

`npm install` 通常修不好（如上述原因），最可靠的做法是強制乾淨重建：

```bash
rm -rf node_modules package-lock.json
npm install
```

重建後再跑一次 `npm ci` 確認能通過，才視為修好。

## 何時要做這個檢查

- 任何一次 Dockerfile 改動、或 CI pipeline 改動涉及 `npm ci` 的專案，在 push/build 之前先本地跑一次 `npm ci`。
- 這個 session 曾在同一個目錄裡連續跑過多次 `npm install`（加裝不同套件），每次都「成功」且本地 build/test 都過，但 lockfile 實際上已經悄悄漂移——多次疊加安裝之後，正式 release 前務必用 `npm ci` 驗證一次，不要只信任 `npm install` 的成功訊息。
- `EUSAGE`/`Missing: X from lock file` 這類 lockfile 一致性檢查，跟平台/Node 版本無關，本地直接跑 `npm ci` 就能重現，不必真的進對應的容器。但若錯誤訊息本身就提到平台字串（例如某個 optional 原生二進位套件在特定平台找不到），才需要真的用對應 base image 的容器重現，不能只信任本地 `npm ci` 的結果。
