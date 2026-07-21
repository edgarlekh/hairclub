/**
 * Публичные роуты — БЕЗ токена (ими пользуются клиенты, не владелец).
 * Только чтение услуг/мастеров + создание брони. Никаких изменений цен и т.д.
 */
import { getAvailableSlots, createBookingSafe } from "./booking-slots.js";

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

const SALON_ID = 1;

export async function handlePublicRequest(request, env, path) {
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

  if (path === "/public/services" && method === "GET") {
    const { results } = await db
      .prepare("SELECT id, name, category, price_min, price_max, currency, duration_minutes, description FROM services WHERE salon_id = ?")
      .bind(SALON_ID)
      .all();
    return j(results);
  }

  if (path === "/public/employees" && method === "GET") {
    const serviceId = url.searchParams.get("service_id");
    let query = "SELECT e.id, e.name FROM employees e WHERE e.salon_id = ?";
    let params = [SALON_ID];
    if (serviceId) {
      query = `SELECT e.id, e.name FROM employees e
                JOIN employee_services es ON e.id = es.employee_id
                WHERE e.salon_id = ? AND es.service_id = ?`;
      params.push(serviceId);
    }
    const { results } = await db.prepare(query).bind(...params).all();
    return j(results);
  }

  if (path === "/public/slots" && method === "GET") {
    const employeeId = url.searchParams.get("employee_id");
    const serviceId = url.searchParams.get("service_id");
    const date = url.searchParams.get("date");
    if (!employeeId || !serviceId || !date) {
      return j({ error: "Нужны employee_id, service_id, date" }, 400);
    }
    const result = await getAvailableSlots(db, parseInt(employeeId), parseInt(serviceId), date);
    return j(result);
  }

  if (path === "/public/book" && method === "POST") {
    const b = await request.json();
    if (!b.service_id || !b.employee_id || !b.date || !b.time || !b.client_name || !b.client_phone) {
      return j({ error: "Не заполнены все обязательные поля" }, 400);
    }
    const result = await createBookingSafe(db, {
      serviceId: b.service_id,
      employeeId: b.employee_id,
      clientName: b.client_name,
      clientPhone: b.client_phone,
      dateStr: b.date,
      timeStr: b.time,
      conversationId: b.conversation_id || null,
    });
    return j(result, result.ok ? 200 : 409);
  }

  return j({ error: "Not found" }, 404);
}
