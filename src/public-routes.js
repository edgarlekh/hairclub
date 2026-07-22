/**
 * Публичные роуты — БЕЗ токена (ими пользуются клиенты, не владелец).
 * Только чтение услуг/мастеров + создание брони. Никаких изменений цен и т.д.
 */
import { getAvailableSlots, getAvailabilityRange, createBookingSafe } from "./booking-slots.js";

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
      .prepare(
        `SELECT s.id, s.name, s.price_min, s.price_max, s.currency,
                s.duration_min, s.duration_max, s.description,
                s.category_id, c.name AS category_name
         FROM services s
         LEFT JOIN service_categories c ON c.id = s.category_id
         WHERE s.salon_id = ? AND s.active = 1
         ORDER BY c.sort_order, s.name`
      )
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

  // Свободные окна сразу на несколько дней — чтобы клиент видел, куда можно попасть,
  // а не перебирал даты вслепую.
  if (path === "/public/availability" && method === "GET") {
    const serviceId = url.searchParams.get("service_id");
    if (!serviceId) return j({ error: "Нужен service_id" }, 400);

    const employeeId = url.searchParams.get("employee_id");
    const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
    const days = Math.min(Number(url.searchParams.get("days")) || 14, 31);

    const result = await getAvailabilityRange(db, {
      serviceId: parseInt(serviceId),
      fromDate: from,
      days,
      employeeId: employeeId ? parseInt(employeeId) : null,
    });
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
      source: "site",
    });
    return j(result, result.ok ? 200 : 409);
  }

  return j({ error: "Not found" }, 404);
}
