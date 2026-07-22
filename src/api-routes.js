/**
 * Роуты для админ-панели (PWA владельца).
 * Всё под префиксом /api/... — простые CRUD-операции поверх D1.
 */

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    },
  });
}

const SALON_ID = 1; // пока один салон; при мультитенантности — брать из аутентификации

export async function handleApiRequest(request, env, path) {
  const db = env.DB;
  const method = request.method;

  // --- Профиль салона ---
  if (path === "/api/salon" && method === "GET") {
    const salon = await db.prepare("SELECT * FROM salons WHERE id = ?").bind(SALON_ID).first();
    return j(salon);
  }
  if (path === "/api/salon" && method === "PUT") {
    const body = await request.json();
    await db
      .prepare(
        `UPDATE salons SET name=?, address=?, working_hours=?, tone_of_voice=?, banned_words=?, emoji_usage=? WHERE id=?`
      )
      .bind(body.name, body.address, body.working_hours, body.tone_of_voice, body.banned_words || "", body.emoji_usage || "minimal", SALON_ID)
      .run();
    return j({ ok: true });
  }

  // --- Услуги ---
  if (path === "/api/services" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM services WHERE salon_id = ?")
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  if (path === "/api/services" && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare(
        `INSERT INTO services (salon_id, name, category, price_min, price_max, currency, duration_minutes, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .bind(SALON_ID, b.name, b.category || null, b.price_min, b.price_max, b.currency || "PLN", b.duration_minutes, b.description || "")
      .first();
    return j({ id: result.id });
  }
  const serviceMatch = path.match(/^\/api\/services\/(\d+)$/);
  if (serviceMatch && method === "PUT") {
    const id = serviceMatch[1];
    const b = await request.json();
    await db
      .prepare(
        `UPDATE services SET name=?, category=?, price_min=?, price_max=?, duration_minutes=?, description=? WHERE id=?`
      )
      .bind(b.name, b.category || null, b.price_min, b.price_max, b.duration_minutes, b.description || "", id)
      .run();
    return j({ ok: true });
  }
  if (serviceMatch && method === "DELETE") {
    await db.prepare("DELETE FROM services WHERE id=?").bind(serviceMatch[1]).run();
    return j({ ok: true });
  }

  // --- Фото к услугам ---
  const photosMatch = path.match(/^\/api\/services\/(\d+)\/photos$/);
  if (photosMatch && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM service_photos WHERE service_id = ?")
      .bind(photosMatch[1])
      .all();
    return j(results);
  }
  if (photosMatch && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare("INSERT INTO service_photos (service_id, photo_url, tag_description) VALUES (?, ?, ?) RETURNING id")
      .bind(photosMatch[1], b.photo_url, b.tag_description)
      .first();
    return j({ id: result.id });
  }
  const photoDeleteMatch = path.match(/^\/api\/services\/\d+\/photos\/(\d+)$/);
  if (photoDeleteMatch && method === "DELETE") {
    await db.prepare("DELETE FROM service_photos WHERE id=?").bind(photoDeleteMatch[1]).run();
    return j({ ok: true });
  }

  // --- Сотрудники ---
  if (path === "/api/employees" && method === "GET") {
    const { results: employees } = await db
      .prepare("SELECT * FROM employees WHERE salon_id = ?")
      .bind(SALON_ID)
      .all();
    const { results: links } = await db
      .prepare(
        `SELECT es.employee_id, es.service_id FROM employee_services es
         JOIN employees e ON e.id = es.employee_id WHERE e.salon_id = ?`
      )
      .bind(SALON_ID)
      .all();
    const serviceIdsByEmployee = {};
    for (const link of links) {
      (serviceIdsByEmployee[link.employee_id] ??= []).push(link.service_id);
    }
    return j(employees.map((e) => ({ ...e, service_ids: serviceIdsByEmployee[e.id] || [] })));
  }
  if (path === "/api/employees" && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare("INSERT INTO employees (salon_id, name, working_schedule, photo_url) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(SALON_ID, b.name, b.working_schedule || "", b.photo_url || "")
      .first();
    if (Array.isArray(b.service_ids) && b.service_ids.length) {
      for (const serviceId of b.service_ids) {
        await db
          .prepare("INSERT OR IGNORE INTO employee_services (employee_id, service_id) VALUES (?, ?)")
          .bind(result.id, serviceId)
          .run();
      }
    }
    return j({ id: result.id });
  }
  const employeeMatch = path.match(/^\/api\/employees\/(\d+)$/);
  if (employeeMatch && method === "PUT") {
    const id = employeeMatch[1];
    const b = await request.json();
    await db
      .prepare("UPDATE employees SET name=?, working_schedule=?, photo_url=? WHERE id=?")
      .bind(b.name, b.working_schedule || "", b.photo_url || "", id)
      .run();
    if (Array.isArray(b.service_ids)) {
      await db.prepare("DELETE FROM employee_services WHERE employee_id=?").bind(id).run();
      for (const serviceId of b.service_ids) {
        await db
          .prepare("INSERT OR IGNORE INTO employee_services (employee_id, service_id) VALUES (?, ?)")
          .bind(id, serviceId)
          .run();
      }
    }
    return j({ ok: true });
  }
  if (employeeMatch && method === "DELETE") {
    const id = employeeMatch[1];
    await db.prepare("DELETE FROM employee_services WHERE employee_id=?").bind(id).run();
    await db.prepare("DELETE FROM employees WHERE id=?").bind(id).run();
    return j({ ok: true });
  }

  // --- Правила/ограничения ---
  if (path === "/api/rules" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM rules_overrides WHERE salon_id = ? ORDER BY id DESC")
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  if (path === "/api/rules" && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare(
        `INSERT INTO rules_overrides (salon_id, rule_type, description, valid_from, valid_until, active)
         VALUES (?, ?, ?, ?, ?, 1) RETURNING id`
      )
      .bind(SALON_ID, b.rule_type, b.description, b.valid_from || null, b.valid_until || null)
      .first();
    return j({ id: result.id });
  }
  const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
  if (ruleMatch && method === "DELETE") {
    await db.prepare("UPDATE rules_overrides SET active=0 WHERE id=?").bind(ruleMatch[1]).run();
    return j({ ok: true });
  }

  // --- База знаний / FAQ ---
  if (path === "/api/knowledge" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM knowledge_base WHERE salon_id = ?")
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  if (path === "/api/knowledge" && method === "POST") {
    const b = await request.json();
    await db
      .prepare("INSERT INTO knowledge_base (salon_id, topic, content) VALUES (?, ?, ?)")
      .bind(SALON_ID, b.topic, b.content)
      .run();
    return j({ ok: true });
  }

  // --- Клиенты ---
  if (path === "/api/clients" && method === "GET") {
    const q = new URL(request.url).searchParams.get("q");
    const query = q
      ? db
          .prepare(
            "SELECT id, full_name, phone, email FROM clients WHERE salon_id = ? AND (full_name LIKE ? OR phone LIKE ?) ORDER BY full_name LIMIT 200"
          )
          .bind(SALON_ID, `%${q}%`, `%${q}%`)
      : db
          .prepare("SELECT id, full_name, phone, email FROM clients WHERE salon_id = ? ORDER BY full_name LIMIT 200")
          .bind(SALON_ID);
    const { results } = await query.all();
    return j(results);
  }
  if (path === "/api/clients" && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare(
        `INSERT INTO clients (salon_id, full_name, phone, email, address, birthday, balance, discount, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .bind(
        SALON_ID,
        b.full_name,
        b.phone || null,
        b.email || null,
        b.address || null,
        b.birthday || null,
        b.balance || 0,
        b.discount || 0,
        b.comment || ""
      )
      .first();
    return j({ id: result.id });
  }
  const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
  if (clientMatch && method === "GET") {
    const client = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(clientMatch[1]).first();
    if (!client) return j({ error: "Клиент не найден" }, 404);
    return j(client);
  }
  if (clientMatch && method === "PUT") {
    const b = await request.json();
    await db
      .prepare(
        `UPDATE clients SET full_name=?, phone=?, email=?, address=?, birthday=?, balance=?, discount=?, comment=? WHERE id=?`
      )
      .bind(
        b.full_name,
        b.phone || null,
        b.email || null,
        b.address || null,
        b.birthday || null,
        b.balance || 0,
        b.discount || 0,
        b.comment || "",
        clientMatch[1]
      )
      .run();
    return j({ ok: true });
  }
  if (clientMatch && method === "DELETE") {
    await db.prepare("DELETE FROM clients WHERE id=?").bind(clientMatch[1]).run();
    return j({ ok: true });
  }

  const clientBookingsMatch = path.match(/^\/api\/clients\/(\d+)\/bookings$/);
  if (clientBookingsMatch && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT b.*, s.name as service_name, e.name as employee_name
         FROM bookings b
         LEFT JOIN services s ON b.service_id = s.id
         LEFT JOIN employees e ON b.employee_id = e.id
         WHERE b.client_id = ? ORDER BY b.requested_datetime DESC`
      )
      .bind(clientBookingsMatch[1])
      .all();

    // Подтягиваем фото всех визитов одним запросом и раскладываем по визитам
    const ids = results.map((b) => b.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const { results: photos } = await db
        .prepare(`SELECT id, booking_id, photo_url, caption FROM visit_photos WHERE booking_id IN (${placeholders})`)
        .bind(...ids)
        .all();
      const byBooking = {};
      for (const p of photos) (byBooking[p.booking_id] ??= []).push(p);
      for (const b of results) b.photos = byBooking[b.id] || [];
    } else {
      for (const b of results) b.photos = [];
    }
    return j(results);
  }

  // --- Записи (визиты) — ручное управление владельцем ---
  if (path === "/api/bookings" && method === "POST") {
    const b = await request.json();
    let clientId = b.client_id || null;
    if (!clientId && b.client_name) {
      const result = await db
        .prepare("INSERT INTO clients (salon_id, full_name, phone) VALUES (?, ?, ?) RETURNING id")
        .bind(SALON_ID, b.client_name, b.client_phone || null)
        .first();
      clientId = result.id;
    }
    const result = await db
      .prepare(
        `INSERT INTO bookings (client_id, service_id, employee_id, client_name, client_phone, requested_datetime, end_datetime, custom_service_label, charged_amount, comment, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual') RETURNING id`
      )
      .bind(
        clientId,
        b.service_id || null,
        b.employee_id || null,
        b.client_name || null,
        b.client_phone || null,
        b.requested_datetime,
        b.end_datetime || null,
        b.custom_service_label || null,
        b.charged_amount || null,
        b.comment || null,
        b.status || "completed"
      )
      .first();
    return j({ id: result.id });
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch && method === "PUT") {
    const b = await request.json();
    await db
      .prepare(
        `UPDATE bookings SET service_id=?, employee_id=?, requested_datetime=?, end_datetime=?, custom_service_label=?, charged_amount=?, comment=?, status=? WHERE id=?`
      )
      .bind(
        b.service_id || null,
        b.employee_id || null,
        b.requested_datetime,
        b.end_datetime || null,
        b.custom_service_label || null,
        b.charged_amount || null,
        b.comment || null,
        b.status || "completed",
        bookingMatch[1]
      )
      .run();
    return j({ ok: true });
  }
  if (bookingMatch && method === "DELETE") {
    await db.prepare("DELETE FROM visit_photos WHERE booking_id=?").bind(bookingMatch[1]).run();
    await db.prepare("DELETE FROM bookings WHERE id=?").bind(bookingMatch[1]).run();
    return j({ ok: true });
  }

  // --- Фото визита ---
  const visitPhotosMatch = path.match(/^\/api\/bookings\/(\d+)\/photos$/);
  if (visitPhotosMatch && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM visit_photos WHERE booking_id = ?")
      .bind(visitPhotosMatch[1])
      .all();
    return j(results);
  }
  if (visitPhotosMatch && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare("INSERT INTO visit_photos (booking_id, photo_url, caption) VALUES (?, ?, ?) RETURNING id")
      .bind(visitPhotosMatch[1], b.photo_url, b.caption || "")
      .first();
    return j({ id: result.id });
  }
  const visitPhotoDeleteMatch = path.match(/^\/api\/bookings\/\d+\/photos\/(\d+)$/);
  if (visitPhotoDeleteMatch && method === "DELETE") {
    await db.prepare("DELETE FROM visit_photos WHERE id=?").bind(visitPhotoDeleteMatch[1]).run();
    return j({ ok: true });
  }

  // --- Диалоги (просмотр + вмешательство владельца) ---
  if (path === "/api/conversations" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT c.*, 
           (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_message
         FROM conversations c WHERE salon_id = ? ORDER BY started_at DESC LIMIT 50`
      )
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  const convMessagesMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (convMessagesMatch && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC")
      .bind(convMessagesMatch[1])
      .all();
    return j(results);
  }
  if (convMessagesMatch && method === "POST") {
    // владелец сам пишет сообщение в диалог — агент временно "отходит в сторону"
    const b = await request.json();
    await db
      .prepare("INSERT INTO messages (conversation_id, sender, content) VALUES (?, 'owner', ?)")
      .bind(convMessagesMatch[1], b.content)
      .run();
    await db
      .prepare("UPDATE conversations SET status='owner_active' WHERE id=?")
      .bind(convMessagesMatch[1])
      .run();
    return j({ ok: true });
  }
  const convResumeMatch = path.match(/^\/api\/conversations\/(\d+)\/resume-agent$/);
  if (convResumeMatch && method === "POST") {
    await db
      .prepare("UPDATE conversations SET status='active' WHERE id=?")
      .bind(convResumeMatch[1])
      .run();
    return j({ ok: true });
  }

  return j({ error: "Not found" }, 404);
}
