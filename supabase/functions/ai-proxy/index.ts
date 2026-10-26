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
    return json({ error: String(e.message || e) }, 500);
  }
});

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------- Provider chain: OpenRouter -> Cloudflare -> Gemini ----------
async function callOpenRouter(messages, model = "openrouter/free") {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("no openrouter key");
  const candidates = model === "openrouter/free"
    ? ["nvidia/nemotron-3-ultra-550b-a55b:free", "poolside/laguna-s-2.1:free", "cohere/north-mini-code:free", "recursive/flint-v1.0:free"]
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
      if (!r.ok) { lastErr = new Error("openrouter " + r.status + " " + m); continue; }
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
  if (!acct || !token) throw new Error("no cloudflare creds");
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
  if (!key) throw new Error("no gemini key");
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
  for (const fn of [callOpenRouter, callCloudflare, callGemini]) {
    try {
      const out = await fn(messages);
      if (out && out.trim()) return { text: out, provider: fn.name };
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
    }
  }
  throw new Error("所有 AI 供應商都失敗：" + errors.join(" | "));
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
  const sys = `你是雲小朵 Lumi，使用者的中文待辦與日誌助手。
規則：
1. 用繁體中文回答，簡潔。
2. 只根據我提供的 tasks 和 journals 資料回答，不要編造。
3. 找日誌時，若找到符合的日期，一定要在回答裡寫出 YYYY-MM-DD 格式的日期，讓使用者可以點擊。
4. 統計數字要明確，不要含糊。
5. 如果我要求新增/修改/刪除資料，先回覆「請確認是否要我執行這件事」，不要直接假設已執行。
6. 不要輸出 markdown 表格，用條列即可。`;
  const { text, provider } = await withFailover([
    { role: "system", content: sys },
    { role: "user", content: `我的資料：\n${JSON.stringify(context)}\n\n我的問題：${userMsg}` },
  ]);
  return { reply: text, provider };
}
