// ============================================================
// Supabase Edge Function: ai-proxy
// Deploy: supabase functions deploy ai-proxy
// Secrets to set:
//   supabase secrets set OPENROUTER_API_KEY=sk-or-...
//   supabase secrets set CLOUDFLARE_ACCOUNT_ID=...
//   supabase secrets set CLOUDFLARE_API_TOKEN=...
//   supabase secrets set GEMINI_API_KEY=...
//   (optional) DEEPSEEK_API_KEY=...   (paid, very cheap)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DAILY_LIMIT = 60; // per day, across all users (single-user app)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  // Authenticate the caller with the project's anon key (same as front-end)
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "缺少 Authorization" }, 401);
  }
  const anonKey = authHeader.replace("Bearer ", "");
  if (anonKey !== Deno.env.get("SUPABASE_ANON_KEY")) {
    return json({ error: "anon key 不匹配" }, 401);
  }

  // Rate limit check (per day, stored in DB table ai_usage_log)
  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(sbUrl, serviceKey);
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await sb
    .from("ai_usage_log")
    .select("count")
    .eq("date", today)
    .maybeSingle();
  const used = usage?.count || 0;
  if (used >= DAILY_LIMIT) {
    return json({ error: `今日 AI 額度已用完（${used}/${DAILY_LIMIT}），請明天再來` }, 429);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    let result;
    if (body.action === "autotag") {
      result = await autotag(body.content || "");
    } else if (body.action === "chat") {
      result = await chat(body.message || "", body.context || {});
    } else {
      return json({ error: "未知 action" }, 400);
    }
    // bump usage
    await sb.from("ai_usage_log").upsert({ date: today, count: used + 1 }, { onConflict: "date" });
    return json(result, 200);
  } catch (e) {
    const code = (e as any).code || "provider";
    const status = code === "quota" ? 429 : (code === "credit" ? 402 : 500);
    return json({ error: String(e.message || e), code }, status);
  }
});

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

class ProviderError extends Error {
  code: string;
  constructor(message: string, code = "provider") {
    super(message);
    this.code = code;
  }
}

// ---------- Provider chain: OpenRouter -> Cloudflare -> Gemini ----------
async function callOpenRouter(messages, model = "openrouter/free") {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("no openrouter key");
  const candidates = model === "openrouter/free"
    ? [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-31b-it:free",
        "cohere/north-mini-code:free",
        "poolside/laguna-s-2.1:free",
        "recursive/flint-v1.0:free",
      ]
    : [model];
  let lastErr;
  for (const m of candidates) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://localhost",
          "X-Title": "LumiTodo",
        },
        body: JSON.stringify({ model: m, messages, temperature: 0.4 }),
      });
      if (!r.ok) {
        const code = r.status === 429 ? "rate_limit" : (r.status === 402 ? "credit" : "provider");
        lastErr = new ProviderError("openrouter " + r.status + " " + m, code);
        continue;
      }
      const d = await r.json();
      const out = d.choices?.[0]?.message?.content;
      if (out && out.trim()) return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("openrouter all models failed");
}

async function callCloudflare(messages) {
  const acct = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  if (!acct || !token) throw new ProviderError("no cloudflare creds", "unavailable");
  // Small open model, fits free neuron allocation
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: 512,
      }),
    }
  );
  if (!r.ok) throw new Error("cloudflare " + r.status);
  const d = await r.json();
  return d.result.response;
}

async function callGemini(messages) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new ProviderError("no gemini key", "unavailable");
  const sys = messages.find(m => m.role === "system")?.content || "";
  const convo = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: sys }] },
        contents: convo,
      }),
    }
  );
  if (!r.ok) throw new Error("gemini " + r.status);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function withFailover(messages) {
  const errors = [];
  const codes = [];
  for (const fn of [callOpenRouter, callCloudflare, callGemini]) {
    try {
      const out = await fn(messages);
      if (out && out.trim()) return { text: out, provider: fn.name };
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
      codes.push((e as any).code || "provider");
    }
  }
  // 未設定憑證的供應商不算失敗；只要有實際可用卻被限流，就明確告知額度問題
  const effective = codes.filter(c => c !== "unavailable");
  if (effective.length && effective.every(c => c === "rate_limit" || c === "credit")) {
    throw new ProviderError(
      "AI 免費額度今日已用完，明天會自動恢復。現在可以先直接在 App 手動新增任務。",
      "quota"
    );
  }
  throw new ProviderError("所有 AI 供應商都失敗：" + errors.join(" | "), "provider");
}

// ---------- Actions ----------
async function autotag(content) {
  const sys = `你是任務分類助手。只回傳 JSON，不要多說話。
分類只能是以下之一：payment, housework, shopping, work, health, other。
回傳格式：{"category":"...","tags":["..."],"note":"一句話備註"}
備註用繁體中文，30 字以內。`;
  const { text } = await withFailover([
    { role: "system", content: sys },
    { role: "user", content: "任務內容：" + content },
  ]);
  // extract JSON
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { tags: [], category: "other", note: text.slice(0, 80), raw: text };
  try { return JSON.parse(m[0]); } catch { return { tags: [], category: "other", note: text.slice(0, 80) }; }
}

async function chat(userMsg, context) {
  const sys = `你是雲小朵 Lumi，使用者的中文待辦與日誌執行助手。

你必須直接幫使用者執行動作，不要只問問題。永遠只回傳一個 JSON 物件，不要有任何其他文字。

格式：
{
  "reply": "繁體中文自然語言回覆，簡潔",
  "actions": [
    {"op":"create_task","data":{"title":"...","date":"YYYY-MM-DD","time":"HH:MM","categoryId":"work|payment|housework|shopping|health|other","tags":["..."],"amount":0}},
    {"op":"update_task","id":"既有任務id","data":{"completed":true,"title":"..."}},
    {"op":"delete_task","id":"既有任務id"},
    {"op":"create_journal","date":"YYYY-MM-DD","content":"..."},
    {"op":"append_journal","date":"YYYY-MM-DD","content":"要加在既有日誌後面的文字"}
  ]
}

規則：
1. 使用者說「明天買麵包」就直接 create_task，date 用明天的 YYYY-MM-DD。
2. 使用者說「把買麵包刪掉」就從 context.tasks 找標題最像的，delete_task。
3. 使用者說「在今天日誌寫下：吃了拉麵」就 create_journal 或 append_journal。
4. 統計/心情/飲食回顧這類問題，actions 留空陣列，在 reply 裡直接總結。
5. 如果使用者只是聊天或問問題，actions 是空陣列 []。
6. 日期不確定時用今天日期（${new Date().toISOString().slice(0,10)}）當參考。
7. 不要在 reply 裡說「我會幫你...」那種客套話，直接講結果。`;
  const { text, provider } = await withFailover([
    { role: "system", content: sys },
    { role: "user", content: `我的資料：\n${JSON.stringify(context)}\n\n我的指令：${userMsg}\n\n只回 JSON。` },
  ]);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { reply: text, actions: [], provider };
  try {
    const j = JSON.parse(m[0]);
    return { reply: j.reply || text, actions: j.actions || [], provider };
  } catch {
    return { reply: text, actions: [], provider };
  }
}
