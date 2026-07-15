// netlify/functions/ai-proxy.js
//
// Единая серверная точка входа для всех AI-провайдеров.
// Фронтенд шлёт сюда POST { provider, apiKey, system, userText },
// функция сама делает запрос к нужному API с сервера (без CORS-ограничений
// браузера) и возвращает нормализованный ответ { ok, text, model } или { ok:false, error }.
//
// Ключ API передаётся от клиента (пользователь вводит свой ключ в Настройках)
// и НЕ сохраняется на сервере — только пробрасывается дальше в запросе.
//
// ВАЖНО: API-ключ провайдера НЕ привязан к конкретной модели/версии.
// Один ключ Anthropic работает со всеми моделями Claude, доступными аккаунту
// (Opus/Sonnet/Haiku, любое поколение), один ключ OpenAI — со всеми GPT,
// один ключ Google — со всеми Gemini, и т.д. Поэтому просить у пользователя
// "ключ именно от этой версии" не нужно и технически бессмысленно.
//
// Здесь для каждого провайдера задан СПИСОК моделей (от новых к старым).
// Функция пробует их по очереди с ОДНИМ И ТЕМ ЖЕ ключом, пока какая-то не
// ответит успешно. Если модель не найдена / недоступна аккаунту (404 или
// подобная ошибка) — пробуется следующая. Если ключ неверный (401/403) —
// смысла перебирать модели нет, сразу возвращаем ошибку "неверный ключ".

const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    kind: "anthropic",
    // Один и тот же sk-ant-... ключ подходит для любой из этих моделей.
    models: [
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],
  },
  openai: {
    label: "OpenAI (GPT)",
    kind: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-5", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    url: "https://api.deepseek.com/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  grok: {
    label: "Grok (xAI)",
    kind: "openai",
    url: "https://api.x.ai/v1/chat/completions",
    models: ["grok-4", "grok-3", "grok-2-latest", "grok-2-mini"],
  },
  gemini: {
    label: "Gemini",
    kind: "gemini",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  },
};

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Некорректный JSON в запросе" }) };
  }

  const { provider, apiKey, system, userText } = payload;
  const key = (apiKey || "").trim();

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Неизвестный провайдер: " + provider }) };
  }
  if (!key) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Не указан API-ключ для " + cfg.label + ".", needsKey: true }) };
  }

  try {
    const { text, model } = await callWithFallback(provider, cfg, key, system, userText);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, text, model }) };
  } catch (err) {
    return {
      statusCode: err.statusCode || 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message || "Внутренняя ошибка прокси", needsKey: !!err.needsKey }),
    };
  }
};

function apiError(message, statusCode, needsKey) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.needsKey = !!needsKey;
  return e;
}

// Пробует модели провайдера по очереди с одним и тем же ключом.
// Останавливается на первой успешной. Если ключ неверный — не перебирает
// модели зря, сразу бросает ошибку. Если ошибка "модель не найдена/нет
// доступа" — пробует следующую модель из списка.
async function callWithFallback(provider, cfg, key, system, userText) {
  let lastErr = null;

  for (const model of cfg.models) {
    try {
      let text;
      if (cfg.kind === "anthropic") {
        text = await callAnthropic(key, model, system, userText);
      } else if (cfg.kind === "gemini") {
        text = await callGemini(key, model, system, userText);
      } else {
        text = await callOpenAICompatible(cfg, key, model, system, userText);
      }
      return { text, model };
    } catch (err) {
      lastErr = err;
      // Неверный ключ / нет доступа к аккаунту вообще — перебирать
      // дальше бессмысленно, все модели упадут одинаково.
      if (err.statusCode === 401) throw err;
      // Иначе (404 модель не найдена, модель недоступна тарифу и т.п.) —
      // пробуем следующую версию модели с тем же ключом.
      continue;
    }
  }

  // Ни одна модель не сработала.
  throw lastErr || apiError(cfg.label + ": не удалось получить ответ ни от одной модели.", 502);
}

async function callAnthropic(key, model, system, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8000,
      system: system,
      messages: [{ role: "user", content: userText }],
    }),
  });

  const data = await safeJson(res);
  if (res.status === 401) throw apiError("Неверный Anthropic API-ключ.", 401, true);
  if (!res.ok) throw apiError("Anthropic (" + model + ") ошибка " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""), res.status);

  return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
}

async function callGemini(key, model, system, userText) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: 8000 },
    }),
  });

  const data = await safeJson(res);
  if (res.status === 401 || res.status === 403) {
    throw apiError("Неверный Gemini API-ключ" + (data && data.error && data.error.message ? ": " + data.error.message : "") + ".", res.status, true);
  }
  if (!res.ok) throw apiError("Gemini (" + model + ") ошибка " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""), res.status);

  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts.map((p) => p.text || "").join("\n").trim();
}

async function callOpenAICompatible(cfg, key, model, system, userText) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });

  const data = await safeJson(res);
  if (res.status === 401 || res.status === 403) throw apiError("Неверный API-ключ (" + cfg.label + ").", res.status, true);
  if (!res.ok) throw apiError(cfg.label + " (" + model + ") ошибка " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""), res.status);

  const choice = data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || "").trim();
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
      }
