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
import { resolveAuth, verifyPassword, randomToken, parsePerms } from "./auth.js";
import { handlePublicRequest } from "./public-routes.js";
import { isSignatureValid } from "./photo-links.js";

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

    // Сами файлы фотографий: <img> не может прислать заголовок с токеном,
    // поэтому пускаем по подписанной ссылке с ограниченным сроком.
    const photoMatch = url.pathname.match(/^\/api\/photos\/(.+)$/);
    if (photoMatch && request.method === "GET") {
      const key = decodeURIComponent(photoMatch[1]);
      const signed = await isSignatureValid(
        key, url.searchParams.get("exp"), url.searchParams.get("sig"), env
      );
      const byToken = env.ADMIN_TOKEN && request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
      if (!signed && !byToken) return json({ error: "Unauthorized" }, 401);
      if (!env.PHOTOS) return json({ error: "Хранилище фото не подключено" }, 500);

      const object = await env.PHOTOS.get(key);
      if (!object) return json({ error: "Фото не найдено" }, 404);

      const headers = new Headers(corsHeaders());
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "private, max-age=86400");
      return new Response(object.body, { headers });
    }

    // Вход сотрудницы по логину и паролю — без токена (токен ей ещё не выдан)
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    // Роуты для панели — владелица по мастер-ключу, сотрудница по токену сессии
    if (url.pathname.startsWith("/api/")) {
      const auth = await resolveAuth(request, env);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      return handleApiRequest(request, env, url.pathname, auth);
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

      const result = await getAgentResponse(env, SALON_ID, conversationId, message);
      return json({ reply: result.reply, photos: result.photos });
    } catch (err) {
      return json({ error: "Internal error", detail: String(err) }, 500);
    }
  },
};

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return json({ error: "Введите логин и пароль" }, 400);

  const acc = await env.DB
    .prepare("SELECT * FROM staff_accounts WHERE lower(username) = lower(?)")
    .bind(username)
    .first();
  // Одинаковый ответ на неверный логин и пароль — не подсказываем, что существует
  if (!acc || !acc.active) return json({ error: "Неверный логин или пароль" }, 401);

  const ok = await verifyPassword(password, acc.password_salt, acc.password_hash);
  if (!ok) return json({ error: "Неверный логин или пароль" }, 401);

  const token = randomToken();
  await env.DB.prepare("UPDATE staff_accounts SET token = ? WHERE id = ?").bind(token, acc.id).run();

  const employee = acc.employee_id
    ? await env.DB.prepare("SELECT name FROM employees WHERE id = ?").bind(acc.employee_id).first()
    : null;

  return json({
    token,
    role: acc.role || "staff",
    name: employee ? employee.name : acc.username,
    employee_id: acc.employee_id,
    permissions: parsePerms(acc.permissions),
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
