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
