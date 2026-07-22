/**
 * Роуты для админ-панели (PWA владельца).
 * Всё под префиксом /api/... — простые CRUD-операции поверх D1.
 */

import { DAY_NAMES } from "./booking-slots.js";
import { presentPhotos, toStoredPhoto, isStoredPhoto, storedKey } from "./photo-links.js";

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

// HEIC — формат съёмки айфонов, без него половина загрузок с телефона отвалится
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
];
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

function extForType(type) {
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
           "image/heic": ".heic", "image/heif": ".heif" }[type] || ".jpg";
}

export async function handleApiRequest(request, env, path) {
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

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

  // --- Категории услуг ---
  if (path === "/api/service-categories" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM service_categories WHERE salon_id = ? ORDER BY sort_order, name")
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  if (path === "/api/service-categories" && method === "POST") {
    const b = await request.json();
    if (!b.name || !String(b.name).trim()) return j({ error: "Нужно название категории" }, 400);
    const result = await db
      .prepare(
        `INSERT INTO service_categories (salon_id, name, color, sort_order) VALUES (?, ?, ?, ?) RETURNING id`
      )
      .bind(SALON_ID, String(b.name).trim(), b.color || null, b.sort_order ?? 99)
      .first();
    return j({ id: result.id });
  }
  const categoryMatch = path.match(/^\/api\/service-categories\/(\d+)$/);
  if (categoryMatch && method === "PUT") {
    const b = await request.json();
    await db
      .prepare("UPDATE service_categories SET name=?, color=?, sort_order=? WHERE id=? AND salon_id=?")
      .bind(String(b.name || "").trim(), b.color || null, b.sort_order ?? 99, categoryMatch[1], SALON_ID)
      .run();
    return j({ ok: true });
  }
  if (categoryMatch && method === "DELETE") {
    // Услуги не удаляем — они просто остаются без категории
    await db.prepare("UPDATE services SET category_id = NULL WHERE category_id = ?").bind(categoryMatch[1]).run();
    await db.prepare("DELETE FROM service_categories WHERE id=? AND salon_id=?").bind(categoryMatch[1], SALON_ID).run();
    return j({ ok: true });
  }

  // --- Услуги ---
  if (path === "/api/services" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT s.*, c.name AS category_name, c.color AS category_color
         FROM services s
         LEFT JOIN service_categories c ON c.id = s.category_id
         WHERE s.salon_id = ?
         ORDER BY c.sort_order, s.name`
      )
      .bind(SALON_ID)
      .all();
    return j(results);
  }
  if (path === "/api/services" && method === "POST") {
    const b = await request.json();
    const result = await db
      .prepare(
        `INSERT INTO services (salon_id, category_id, name, price_min, price_max, currency, duration_min, duration_max, description, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .bind(
        SALON_ID, b.category_id || null, b.name,
        b.price_min ?? null, b.price_max ?? null, b.currency || "PLN",
        b.duration_min ?? null, b.duration_max ?? null,
        b.description || "", b.active === 0 ? 0 : 1
      )
      .first();
    return j({ id: result.id });
  }
  const serviceMatch = path.match(/^\/api\/services\/(\d+)$/);
  if (serviceMatch && method === "PUT") {
    const id = serviceMatch[1];
    const b = await request.json();
    await db
      .prepare(
        `UPDATE services SET category_id=?, name=?, price_min=?, price_max=?, duration_min=?, duration_max=?, description=?, active=?
         WHERE id=?`
      )
      .bind(
        b.category_id || null, b.name,
        b.price_min ?? null, b.price_max ?? null,
        b.duration_min ?? null, b.duration_max ?? null,
        b.description || "", b.active === 0 ? 0 : 1, id
      )
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
      .prepare("INSERT INTO employees (salon_id, name, working_schedule, photo_url, color) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(SALON_ID, b.name, b.working_schedule || "", b.photo_url || "", b.color || null)
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
      .prepare("UPDATE employees SET name=?, working_schedule=?, photo_url=?, color=COALESCE(?, color) WHERE id=?")
      .bind(b.name, b.working_schedule || "", b.photo_url || "", b.color || null, id)
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
    await db.prepare("DELETE FROM employee_schedule WHERE employee_id=?").bind(id).run();
    await db.prepare("DELETE FROM employee_time_off WHERE employee_id=?").bind(id).run();
    await db.prepare("DELETE FROM employees WHERE id=?").bind(id).run();
    return j({ ok: true });
  }

  // --- Календарь: всё нужное для главного экрана за один запрос ---
  // Отдаём мастеров с их графиком на этот день, записи и отгулы — иначе панель
  // делала бы по три запроса на каждого мастера.
  if (path === "/api/calendar" && method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return j({ error: "Нужна дата" }, 400);
    const weekday = new Date(date + "T00:00:00").getDay();

    const { results: employees } = await db
      .prepare(
        `SELECT e.id, e.name, e.photo_url, e.color, s.start_minutes, s.end_minutes
         FROM employees e
         LEFT JOIN employee_schedule s ON s.employee_id = e.id AND s.weekday = ?
         WHERE e.salon_id = ?
         ORDER BY e.name`
      )
      .bind(weekday, SALON_ID)
      .all();

    const { results: bookings } = await db
      .prepare(
        `SELECT b.id, b.employee_id, b.client_id, b.client_name, b.client_phone,
                b.requested_datetime, b.end_datetime, b.custom_service_label,
                b.charged_amount, b.comment, b.status, b.source,
                sv.name AS service_name,
                COALESCE(sv.duration_max, sv.duration_min, 60) AS duration_minutes,
                c.full_name AS client_full_name
         FROM bookings b
         LEFT JOIN services sv ON sv.id = b.service_id
         LEFT JOIN clients c ON c.id = b.client_id
         WHERE b.requested_datetime LIKE ?
         ORDER BY b.requested_datetime`
      )
      .bind(`${date}%`)
      .all();

    const { results: timeOff } = await db
      .prepare("SELECT employee_id, start_minutes, end_minutes, reason FROM employee_time_off WHERE date <= ? AND COALESCE(date_end, date) >= ?")
      .bind(date, date)
      .all();

    return j({ date, weekday, employees, bookings, timeOff });
  }

  // Счётчики для верхней плашки главного экрана
  if (path === "/api/calendar/summary" && method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return j({ error: "Нужна дата" }, 400);
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS всего,
                SUM(CASE WHEN status IN ('cancelled','no_show') THEN 1 ELSE 0 END) AS отменённых,
                SUM(CASE WHEN status NOT IN ('cancelled','no_show') THEN COALESCE(charged_amount,0) ELSE 0 END) AS выручка
         FROM bookings WHERE requested_datetime LIKE ?`
      )
      .bind(`${date}%`)
      .first();
    return j(row);
  }

  // --- График работы мастера ---
  // Строка на каждый рабочий день недели; выходной = отсутствие строки.
  const scheduleMatch = path.match(/^\/api\/employees\/(\d+)\/schedule$/);
  if (scheduleMatch && method === "GET") {
    const { results } = await db
      .prepare("SELECT weekday, start_minutes, end_minutes FROM employee_schedule WHERE employee_id = ? ORDER BY weekday")
      .bind(scheduleMatch[1])
      .all();
    return j(results);
  }
  if (scheduleMatch && method === "PUT") {
    const id = scheduleMatch[1];
    const b = await request.json();
    const days = Array.isArray(b.days) ? b.days : [];
    for (const d of days) {
      if (d.start_minutes >= d.end_minutes) {
        return j({ error: `Начало рабочего дня должно быть раньше конца (${DAY_NAMES[d.weekday] || d.weekday})` }, 400);
      }
    }
    await db.prepare("DELETE FROM employee_schedule WHERE employee_id=?").bind(id).run();
    for (const d of days) {
      await db
        .prepare("INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes) VALUES (?, ?, ?, ?)")
        .bind(id, d.weekday, d.start_minutes, d.end_minutes)
        .run();
    }
    return j({ ok: true });
  }

  // --- Отгулы, отпуска, перерывы ---
  const timeOffMatch = path.match(/^\/api\/employees\/(\d+)\/time-off$/);
  if (timeOffMatch && method === "GET") {
    // Показываем то, что ещё не закончилось (учитываем дату окончания диапазона)
    const { results } = await db
      .prepare("SELECT * FROM employee_time_off WHERE employee_id = ? AND COALESCE(date_end, date) >= date('now','-1 day') ORDER BY date")
      .bind(timeOffMatch[1])
      .all();
    return j(results);
  }
  if (timeOffMatch && method === "POST") {
    const b = await request.json();
    if (!b.date) return j({ error: "Нужна дата" }, 400);
    // date_end пишем только для настоящего диапазона (последний день позже первого)
    const dateEnd = b.date_end && b.date_end > b.date ? b.date_end : null;
    const result = await db
      .prepare(
        "INSERT INTO employee_time_off (employee_id, date, date_end, start_minutes, end_minutes, reason) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .bind(timeOffMatch[1], b.date, dateEnd, b.start_minutes ?? null, b.end_minutes ?? null, b.reason || "")
      .first();
    return j({ id: result.id });
  }
  const timeOffItemMatch = path.match(/^\/api\/employees\/(\d+)\/time-off\/(\d+)$/);
  if (timeOffItemMatch && method === "DELETE") {
    await db
      .prepare("DELETE FROM employee_time_off WHERE id=? AND employee_id=?")
      .bind(timeOffItemMatch[2], timeOffItemMatch[1])
      .run();
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
      const signed = await presentPhotos(photos, request, env);
      const byBooking = {};
      for (const p of signed) (byBooking[p.booking_id] ??= []).push(p);
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
    return j(await presentPhotos(results, request, env));
  }
  if (visitPhotosMatch && method === "POST") {
    const bookingId = visitPhotosMatch[1];
    const contentType = request.headers.get("content-type") || "";

    // Файл с телефона или компьютера кладём в R2, в базе храним только ссылку
    if (contentType.includes("multipart/form-data")) {
      if (!env.PHOTOS) return j({ error: "Хранилище фото не подключено" }, 500);

      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return j({ error: "Файл не получен" }, 400);
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        return j({ error: "Можно загружать только фото: JPEG, PNG, WebP или HEIC" }, 400);
      }
      if (file.size > MAX_PHOTO_BYTES) {
        return j({ error: `Фото больше ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} МБ — сожми или выбери другое` }, 400);
      }

      const ext = (file.name || "").match(/\.[a-z0-9]+$/i)?.[0] || extForType(file.type);
      const key = `visits/${bookingId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
      await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

      const result = await db
        .prepare("INSERT INTO visit_photos (booking_id, photo_url, caption) VALUES (?, ?, ?) RETURNING id")
        .bind(bookingId, toStoredPhoto(key), form.get("caption") || "")
        .first();
      const [saved] = await presentPhotos(
        [{ id: result.id, photo_url: toStoredPhoto(key), caption: form.get("caption") || "" }], request, env
      );
      return j(saved);
    }

    // Старый путь: фото по внешней ссылке (так пришли снимки из Bumpix)
    const b = await request.json();
    const result = await db
      .prepare("INSERT INTO visit_photos (booking_id, photo_url, caption) VALUES (?, ?, ?) RETURNING id")
      .bind(bookingId, b.photo_url, b.caption || "")
      .first();
    return j({ id: result.id });
  }
  const visitPhotoDeleteMatch = path.match(/^\/api\/bookings\/\d+\/photos\/(\d+)$/);
  if (visitPhotoDeleteMatch && method === "DELETE") {
    // Файл из хранилища тоже убираем, иначе он останется занимать место навсегда
    const row = await db
      .prepare("SELECT photo_url FROM visit_photos WHERE id=?")
      .bind(visitPhotoDeleteMatch[1])
      .first();
    if (row && isStoredPhoto(row.photo_url) && env.PHOTOS) {
      await env.PHOTOS.delete(storedKey(row.photo_url));
    }
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
