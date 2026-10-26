# 雲小朵 Lumi 待辦 App — 部署步驟

打開 `index.html` 就可以直接用（離線功能全部正常：任務、子任務、提醒、農曆、日誌、搜尋、天氣、三地節日）。
想要 **AI 功能（雲小朵對話、自動標籤）** 才需要照下面步驟設定 Supabase。

---

## A. 本機直接使用（0 設定）

1. 下載整個資料夾，雙擊 `index.html`。
2. 所有資料存在你瀏覽器的 localStorage，關掉再打開都還在。
3. 建議用「設定 → 匯出 JSON」定期備份。

---

## B. 放到 GitHub Pages（免費託管）

1. 到 GitHub 開一個新 repo，例如 `lumi-todo`。
2. 上傳 `index.html`（其他圖檔已經嵌入 HTML，不用另外傳）。
3. repo → Settings → Pages → Source 選 `main`  branch / `(root)` → Save。
4. 等一分鐘，網址會是 `https://你的帳號.github.io/lumi-todo/`。

---

## C. 開啟 AI 功能（Supabase + 免費大模型）

### C1. 註冊 Supabase
1. 到 https://supabase.com → 用 GitHub 登入 → New project。
2. 選免費方案，設 database 密碼（記起來）。
3. 等 2 分鐘專案建好。

### C2. 建立資料表
1. 左邊選單 → SQL Editor → New query。
2. 把 `supabase/schema.sql` 全部貼進去 → Run。
3. 應該看到「Success. No rows returned」。

### C3. 拿 Supabase 金鑰
1. 左邊齒輪 → Project Settings → API。
2. 複製兩個值：
   - **Project URL**：`https://xxxx.supabase.co`
   - **anon public**：`eyJhbGciOi...`（很長一串）
3. 打開 App → 右上角 ⚙️ 設定 → 把這兩個貼進去 → 儲存設定。

### C4. 申請免費 AI API Key（選至少一個，建議都申請）

| 供應商 | 申請網址 | 免費額度 | 要信用卡？ |
|---|---|---|---|
| **OpenRouter（首選）** | https://openrouter.ai/keys | 50 次/天（儲值 $10 後變 1000/天） | 不用 |
| **Cloudflare Workers AI** | https://dash.cloudflare.com → Workers & Pages → AI | 10,000 neurons/天 | 不用 |
| **Google Gemini** | https://aistudio.google.com/apikey | 免費層（新模型每天次數少） | 不用 |

DeepSeek 沒有免費 API（只有付費，很便宜 $0.14/1M token），可跳過。

### C5. 把 Key 存進 Supabase Secrets（重要！不要放前端）

打開你的電腦終端機（需要裝 Node.js）：

```bash
# 第一次：登入 Supabase CLI
npx supabase login

# 切到你的專案
npx supabase link --project-ref xxxx  # xxxx 是你 Project URL 開頭那串

# 設定金鑰（一行一行跑，把你的 key 換掉）
npx supabase secrets set OPENROUTER_API_KEY=sk-or-xxxxxxxx
npx supabase secrets set CLOUDFLARE_ACCOUNT_ID=xxxxxxxx
npx supabase secrets set CLOUDFLARE_API_TOKEN=xxxxxxxx
npx supabase secrets set GEMINI_API_KEY=xxxxxxxx
```

> 沒有電腦？也可以在 Supabase Dashboard → Edge Functions → Secrets 介面直接貼。

### C6. 部署 Edge Function

```bash
npx supabase functions deploy ai-proxy
```

完成後，App 裡的雲小朵就能用了。順序會自動：**OpenRouter → Cloudflare → Gemini**，哪個失敗就跳下一個。
每天上限 60 次（Edge Function 那邊擋），前端自己再擋一次 30 次/天。

---

## D. Google Calendar 同步

目前內建的是「**匯出 .ics 檔**」模式（免費、不用 OAuth）：
- 打開 App → 設定 → 「把未來 30 天任務寫進 Google Calendar」→ 會下載一個 `lumi_tasks.ics`。
- 到 Google Calendar 網頁 → 左邊「+ 其他行事曆」→ 「從匯入」→ 上傳這個 .ics 即可。

真正雙向 OAuth 同步需要：
1. Google Cloud Console → 建立 OAuth Client ID（Web 應用程式）。
2. 授權你的 GitHub Pages 網址。
3. 這段程式我留了擴充點，之後要做再說（難度中等，需要改前端加 OAuth flow）。

---

## E. 三地節日與天氣

- **節日**：內建台灣、中國、阿根廷的主要假日，日曆上方三個複選框可以個別開關。
  （ lunar 節日如端午、中秋我標了 `*`，是近似日期，實際對應農曆日可再加精確對照表。）
- **天氣**：用 Open-Meteo（免費、不用 API key）。
  第一次打開設定 → 「使用現在位置」→ 瀏覽器會問定位權限 → 允許後，選日子時右邊會顯示氣溫。

---

## F. 功能清單（這次改了什麼）

✅ 修：新增任務後關掉再打開資料還在（所有變動都即時存 localStorage，關頁面前也會自動存）
✅ 修：搜尋功能（右上角 🔍 全域搜尋，同時找任務+日誌）
✅ 子任務：每個任務可加多個子任務，勾選完成
✅ 多提醒：每個任務可加多個提醒（準時 / 15分前 / 30分前 / 1小前 / 1天前 / 自訂時間）
✅ 日誌列表：「日誌」分頁依日期新到舊排列，可關鍵字過濾，點一下跳到該天
✅ AI 自動標籤：輸入標題後 AI 建議分類/標籤/備註，可採用或略過
✅ 雲小朵對話：自然語言問「上週跟旅行有關的日誌」「這個月咖啡花多少」，AI 會從你的資料找答案並附日期連結
✅ 免費額度保護：前端 30 次/天，Edge Function 60 次/天，用盡提示
✅ Lumi 畫面：大圖、雲小朵 Lumi 字樣、寫字動畫、沒有多餘歡迎文字、整個對話區只有一張 Lumi 圖
✅ 三地節日開關、Open-Meteo 天氣、.ics 匯出 Google Calendar

---

## G. 目錄結構

```
lumi-todo-app/
├── index.html                  ← 主程式，雙擊就能開
├── supabase/
│   ├── schema.sql              ← 在 Supabase SQL Editor 跑一次
│   └── functions/
│       └── ai-proxy/
│           └── index.ts        ← Edge Function 原始碼
└── SETUP.md                    ← 本檔
```
