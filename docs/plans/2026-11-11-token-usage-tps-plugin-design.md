# Orca Token 使用量、TPS 與費用統計外掛設計規格書

本文件定義 Orca 側邊欄 Token 統計外掛的系統架構、介面設計、資料解析流程、即時線上費率同步機制與驗證策略。

## 1. 外掛總覽與 Manifest 規範

本外掛於 Orca 右側邊欄與底部狀態列即時展示四大主力 Agent 的 Token 消耗明細、真實生成速率（TPS）與預估美金費用（USD）：

- **Claude Code**（`Anthropic`）
- **Codex**（`OpenAI`）
- **Gemini CLI**（`Google`）
- **Antigravity**（`Google`）

為符合 Orca 官方與社群外掛目錄（Catalog Format v2）規範，Manifest 省略已棄用的 `publisher` 欄位，並避免使用保留字前綴 `orca-`：

- **Manifest 版本**：`manifestVersion: 2`、`engines.orca: ">=1.4.248"`、`pluginApi: 1`
- **執行權限等級**：`trusted-worker`（背景獨立 Node 程序 `main: "src/worker.ts"`）
- **UI 呈現表面**：右側邊欄隔離網頁面板（`ui: "html"`，`entry: "src/panel/index.html"`），全面套用 `--orca-*` 主題 CSS 變數；搭配 1 個 `contributes.statusBarItems` 狀態列項目，使 Worker 在外掛啟用期間保持常駐運作
- **申請權限（Capabilities）**：`workspace:read`、`agent:read`、`storage:own`、`settings:own`

## 2. 側邊欄佈局、純圖示導覽列與多語系支援

面板介面自動適配 Orca 亮色／暗色及第三方主題，並自動跟隨 Orca 內部設定的介面語系。

### 頂部純 SVG 圖示切換列（5 大檢視維度）

頂部導覽列採用 **5 顆純向量 SVG Icon**（不使用文字按鈕或括號字樣），滑鼠懸停時顯示對應語系的 Tooltip 提示，並於導覽列下方顯示當前視圖標題：

1. **即時監控（Live，閃電脈衝圖示）**：
   - 上方 KPI 摘要卡顯示：即時總生成 TPS、峰值 TPS、活躍 Token 總量（含 Input / Cache / Output 三色比例條）與**即時累計費用（USD）**。
   - 下方列出目前在 Orca 中執行或待命的 Agent Session 卡片，每張卡片包含：
     - Agent 顏色標籤與即時狀態燈號（`working` / `waiting` / `blocked`）
     - **模型廠商與具體模型名稱**（例如 `Anthropic · claude-opus-5-5`、`OpenAI · gpt-6.1-sol`、`Google · gemini-3-pro`）
     - 所屬 Worktree 名稱、即時 TPS 數值與迷你 SVG Sparkline 波形、本輪 Token 明細與**即時對話費用（USD）**
2. **當前對話清單（Sessions，對話氣泡圖示）**：
   - 自動鎖定**當前聚焦的 Orca Worktree**，將該 Worktree 內的所有對話 Session 依**最後活躍時間由新到舊**排列。
   - 每張卡片顯示：**對話 Session 標題**、Agent 標籤、使用的**廠商與模型名稱**、相對時間、總 Token 數與 Input / Cache / Output 三色比例條、平均 TPS 以及**該對話累計費用（USD）**。
3. **今日統計（Day，日曆／時鐘圖示）**：
   - 右上角提供 **「全機（All Machine）／當前 Worktree」** 範圍切換開關。
   - 顯示今日總 Token、**今日總預估費用（USD）**、平均與峰值 TPS 摘要卡，搭配 **24 小時分色堆疊 SVG 長條圖**，以及下方四大 Agent 佔比排行、Token 明細、花費金額與 TPS 列表。
4. **本週統計（Week，週曆圖示）**：
   - 結構同「今日統計」，改以 **7 天分色堆疊 SVG 長條圖** 呈現當週趨勢與各 Agent 統計及費用。
5. **本月統計（Month，月曆圖示）**：
   - 結構同「今日統計」，改以 **30 天分色堆疊 SVG 長條圖** 呈現當月趨勢與各 Agent 統計及費用。

### 底部狀態列（Status Bar）與多語系（i18n）

- **狀態列常駐膠囊**：透過 `statusBar.update` 即時更新底部狀態列（例如執行中顯示 `⚡ 96.4 tok/s · 1.84M ($4.28)`，閒置時顯示今日總 Token、費用與平均 TPS）。
- **多語系跟隨 Orca 設定**：讀取 `window.orca.locale`（精準對應 Orca 設定語言而非作業系統語言），內建 `zh-TW`（繁體中文）、`zh-CN`（簡體中文）、`en`（英文）、`ja`（日文）、`ko`（韓文）語系字典，預設回退為 `en`。

## 3. 資料來源、TPS 計算公式與線上即時費率同步

背景 Worker 採用增量追蹤與分日快取架構，確保不阻塞介面且不重複掃描龐大的歷史紀錄檔。

### 四大 Agent 紀錄解析與對話標題對齊

- **Claude Code**：增量讀取 `~/.claude/projects/**/*.jsonl` 中的 `message.usage`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`）、`message.model`、`cwd` 與每輪時間戳。
- **Codex**：增量讀取 `~/.codex/sessions/**/*.jsonl` 中的 `session_meta`（`cwd`）、`turn_context`（`model`）與 `token_count` 事件（`input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、`reasoning_output_tokens`）。
- **Antigravity**：增量讀取 `~/Library/Application Support/orca/antigravity-chat/**/transcript.jsonl`（及 `~/.gemini/antigravity-cli` 紀錄）中的 `PLANNER_RESPONSE` Token 統計、模型資訊與步驟時間戳。
- **Gemini CLI**：解析 `~/.gemini/tmp/**/chats/session-*.json`（及相關 JSONL 紀錄）中的訊息 Token 用量、模型名稱與工作區目錄映射。
- **對話標題對齊**：以唯讀模式（`mode=ro`）查詢 Orca 本機 `agent-session-journal.db` 中的 `agent_session_records.conversationName` 與 `workspaceId`；若無對應紀錄，則依序回退取用 Session 自訂標題或首句使用者 Prompt 摘要。

### 真實生成速率（True Generation TPS）公式

針對每一輪模型回覆，僅計算模型實際推理與吐字區間，排除使用者閱讀與思考停頓時間：

- `單輪 TPS = (Output Tokens + Reasoning Tokens) / 模型單輪推理秒數`
- 自動過濾 `< 0.2 秒` 的純中繼事件雜訊，避免極端假性峰值。
- 各維度同步彙總產出：**即時 TPS（Live TPS）**、**區間加權平均 TPS（Avg TPS）** 與 **峰值 TPS（Peak TPS）**。

### 定時線上模型費率同步機制（Online Pricing Sync）

不設手動費率 JSON 覆寫欄位，改由 Worker 內建全自動線上費率同步引擎：

- **自動更新排程**：Worker 啟動時立即同步一次，之後依設定週期（預設每 `6` 小時，請求逾時上限 `5` 秒）自動從公開即時模型費率庫（如 `https://models.dev/api.json` 與 `https://openrouter.ai/api/v1/models`）抓取 Anthropic、OpenAI 與 Google 最新模型清單及每百萬 Token 的 `input`、`output`、`cache_read`、`cache_write` 官方單價。
- **模型代號映射**：針對 CLI 特有內部模型代號（如 `gpt-6.1-sol`、`gpt-6.1-terra`、`claude-opus-5-5`、`claude-fable-5-1`、`gemini-3-*`）自動映射至對應的官方模型家族費率；若原始紀錄已帶官方 `costUSD` 欄位則優先採用。
- **快取與離線保底**：同步完成的費率表與最後更新時間寫入外掛私有的 `storage:own`；若遇網路離線或逾時，自動無縫沿用上次同步成功的快取費率或內建保底費率。

## 4. 外掛設定、異常容錯與測試驗證

### 外掛設定項（`contributes.settings`）

於 Orca 的 `Settings → Plugins` 提供兩項精簡數值設定：

1. `pricingSyncHours`（整數，預設 `6`，範圍 `1–24`）：線上模型與官方費率自動更新間隔（小時）。
2. `livePollSeconds`（整數，預設 `2`，範圍 `1–10`）：活躍 Session 即時增量刷新頻率（秒）。

### 異常容錯與驗證流程

- **併發寫入安全**：JSONL 增量讀取器僅將 Byte Offset 推進至最後一個完整換行符號（`\n`），防止 Agent 高速串流寫入時讀到半截 JSON 導致報錯或漏算；若某款 Agent 尚未安裝、目錄不存在則靜默略過。
- **歷史天級快取**：已跨日封存的歷史檔案依檔案路徑、大小與 `mtimeMs` 將彙總數據存入 `storage:own`，確保切換 7 天／30 天視圖毫秒級秒開。
- **測試與視覺驗收**：透過 `orca plugin test`（`orca/testing` `mountWorker`）撰寫四大 Agent 解析器、半截行容錯、TPS 計算、Session 新舊排序與線上費率計價單元測試；並以 `orca plugin validate .`、`orca plugin dev load` 與 `orca plugin shot` 完成真機畫面驗收。
