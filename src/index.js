/**
 * Главный Worker — точка входа.
 * Принимает POST-запрос от ManyChat (External Request) или Telegram webhook,
 * находит/создаёт диалог, вызывает агента, возвращает ответ.
 *
 * Ожидаемый входной JSON: { "channel_id": "уникальный id клиента", "message": "текст" }
 * salon_id пока жёстко = 1 (один салон); когда клиентов станет больше,
 * можно передавать salon_id в теле запроса или определять по URL.
 */
import { getAgentResponse } from "./agent.js";
import { handleApiRequest } from "./api-routes.js";
import { handlePublicRequest } from "./public-routes.js";

async function getOrCreateConversation(db, salonId, channelId) {
  let conv = await db
    .prepare(
      "SELECT * FROM conversations WHERE salon_id = ? AND client_channel_id = ? AND status = 'active'"
    )
    .bind(salonId, channelId)
    .first();

  if (!conv) {
    const result = await db
      .prepare(
        "INSERT INTO conversations (salon_id, client_channel_id, status) VALUES (?, ?, 'active') RETURNING id"
      )
      .bind(salonId, channelId)
      .first();
    conv = { id: result.id };
  }
  return conv.id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Публичные роуты — сайт бронирования для клиентов, без токена
    if (url.pathname.startsWith("/public/")) {
      return handlePublicRequest(request, env, url.pathname);
    }

    // Роуты для PWA-панели владельца — защищены токеном доступа
    if (url.pathname.startsWith("/api/")) {
      const providedToken = request.headers.get("X-Admin-Token");
      if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
        return json({ error: "Unauthorized" }, 401);
      }
      return handleApiRequest(request, env, url.pathname);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { channel_id, message } = body || {};
    if (!channel_id || !message) {
      return json({ error: "Missing 'channel_id' or 'message'" }, 400);
    }

    const SALON_ID = 1;

    try {
      const conversationId = await getOrCreateConversation(env.DB, SALON_ID, channel_id);

      // Если владелец сейчас сам ведёт диалог вручную — агент не встревает,
      // просто сохраняет сообщение клиента для истории.
      const conv = await env.DB
        .prepare("SELECT status FROM conversations WHERE id = ?")
        .bind(conversationId)
        .first();
      if (conv && conv.status === "owner_active") {
        await env.DB
          .prepare("INSERT INTO messages (conversation_id, sender, content) VALUES (?, 'client', ?)")
          .bind(conversationId, message)
          .run();
        return json({ reply: null, note: "owner_active" });
      }

      const responseText = await getAgentResponse(env, SALON_ID, conversationId, message);
      return json({ reply: responseText });
    } catch (err) {
      return json({ error: "Internal error", detail: String(err) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
