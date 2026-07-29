/**
 * Роуты для админ-панели (PWA владельца).
 * Всё под префиксом /api/... — простые CRUD-операции поверх D1.
 */

import { DAY_NAMES } from "./booking-slots.js";
import { presentPhotos, toStoredPhoto, isStoredPhoto, storedKey } from "./photo-links.js";
import { hashPassword, verifyPassword, DEFAULT_PERMS, parsePerms } from "./auth.js";
import { getAgentResponse } from "./agent.js";

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

export async function handleApiRequest(request, env, path, auth = { role: "owner" }) {
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

  const owner = auth.role === "owner";
  const perms = auth.perms || {};
  const myEmp = auth.employeeId || null;
  const forbid = () => j({ error: "Недостаточно прав" }, 403);

  // --- Тест-чат агента (только владелица): поговорить с ботом на реальных данных ---
  const TEST_CHANNEL = "panel-test";
  if (path === "/api/agent/test" && method === "POST") {
    if (!owner) return forbid();
    const b = await request.json();
    const msg = String(b.message || "").trim();
    if (!msg) return j({ error: "Пустое сообщение" }, 400);

    let conv = await db
      .prepare("SELECT id FROM conversations WHERE salon_id = ? AND client_channel_id = ? AND status = 'active'")
      .bind(SALON_ID, TEST_CHANNEL)
      .first();
    if (!conv) {
      conv = await db
        .prepare("INSERT INTO conversations (salon_id, client_channel_id, status) VALUES (?, ?, 'active') RETURNING id")
        .bind(SALON_ID, TEST_CHANNEL)
        .first();
    }
    try {
      // Записи из теста помечаем source='test' — они выделяются в календаре и легко чистятся
      const result = await getAgentResponse(env, SALON_ID, conv.id, msg, { bookingSource: "test" });
      return j(result);
    } catch (e) {
      // Чаще всего — не задан секрет ANTHROPIC_API_KEY
      return j({ error: "Агент не ответил: " + String(e.message || e) }, 500);
    }
  }
  if (path === "/api/agent/test/reset" && method === "POST") {
    if (!owner) return forbid();
    // Закрываем текущий тестовый диалог, чтобы начать с чистого листа
    await db
      .prepare("UPDATE conversations SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE salon_id=? AND client_channel_id=? AND status='active'")
      .bind(SALON_ID, TEST_CHANNEL)
      .run();
    return j({ ok: true });
  }
  // Удалить всё, что натворил тестовый диалог: записи (по conversation_id тест-чата)
  // и фейковых клиентов, у которых после этого не осталось ни одной записи.
  if (path === "/api/agent/test/cleanup" && method === "POST") {
    if (!owner) return forbid();
    const { results: bookings } = await db
      .prepare(
        `SELECT id, client_id FROM bookings
         WHERE conversation_id IN (SELECT id FROM conversations WHERE salon_id=? AND client_channel_id=?)`
      )
      .bind(SALON_ID, TEST_CHANNEL)
      .all();

    const bookingIds = bookings.map((b) => b.id);
    const clientIds = [...new Set(bookings.map((b) => b.client_id).filter(Boolean))];

    for (const id of bookingIds) {
      await db.prepare("DELETE FROM visit_photos WHERE booking_id=?").bind(id).run();
      await db.prepare("DELETE FROM bookings WHERE id=?").bind(id).run();
    }
    // Клиента удаляем только если он остался совсем без записей (значит, был создан тестом)
    let clientsDeleted = 0;
    for (const cid of clientIds) {
      const left = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE client_id=?").bind(cid).first();
      if (left.n === 0) {
        await db.prepare("DELETE FROM clients WHERE id=?").bind(cid).run();
        clientsDeleted++;
      }
    }
    return j({ ok: true, bookings: bookingIds.length, clients: clientsDeleted });
  }

  // Кто вошёл — чтобы панель показала нужный набор вкладок
  if (path === "/api/auth/me" && method === "GET") {
    return j(owner
      ? { role: "owner" }
      : { role: "staff", employee_id: myEmp, permissions: perms });
  }

  // Смена собственного пароля сотрудницей
  if (path === "/api/auth/password" && method === "POST" && !owner) {
    const b = await request.json();
    const acc = await db.prepare("SELECT password_hash, password_salt FROM staff_accounts WHERE id = ?").bind(auth.accountId).first();
    const ok = acc && (await verifyPassword(String(b.old || ""), acc.password_salt, acc.password_hash));
    if (!ok) return j({ error: "Старый пароль неверный" }, 400);
    if (String(b.new || "").length < 4) return j({ error: "Новый пароль слишком короткий" }, 400);
    const { hash, salt } = await hashPassword(String(b.new));
    await db.prepare("UPDATE staff_accounts SET password_hash=?, password_salt=? WHERE id=?").bind(hash, salt, auth.accountId).run();
    return j({ ok: true });
  }

  // Всё, что доступно только владелице. Сотрудницам — 403 ещё до обработчика.
  if (!owner) {
    const isOwnerOnly =
      path === "/api/analytics" ||
      path === "/api/clients/dormant" ||
      path === "/api/clients/birthdays" ||
      path === "/api/calendar/summary" ||
      path.startsWith("/api/rules") ||
      path.startsWith("/api/knowledge") ||
      path.startsWith("/api/conversations") ||
      /^\/api\/employees\/\d+\/account/.test(path) ||
      (path === "/api/salon" && method !== "GET") ||
      (path === "/api/employees" && method !== "GET") ||
      (/^\/api\/employees\/\d+$/.test(path) && method !== "GET") ||
      (path.startsWith("/api/services") && method !== "GET") ||
      (path.startsWith("/api/service-categories") && method !== "GET");
    if (isOwnerOnly) return forbid();
  }

  // Личная выручка сотрудницы — только её данные и только если это ей разрешено
  if (path === "/api/my/summary" && method === "GET" && !owner) {
    if (!perms.revenue) return forbid();
    const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10) + "T23:59";
    const live = "status NOT IN ('cancelled','no_show') AND employee_id = ? AND requested_datetime >= ? AND requested_datetime <= ?";

    const totals = await db
      .prepare(`SELECT COUNT(*) AS visits, COALESCE(SUM(charged_amount),0) AS revenue, COUNT(DISTINCT client_id) AS clients FROM bookings WHERE ${live}`)
      .bind(myEmp, from, to).first();

    const { results: byDay } = await db
      .prepare(`SELECT substr(requested_datetime,1,10) AS day, COUNT(*) AS visits, COALESCE(SUM(charged_amount),0) AS revenue
                FROM bookings WHERE ${live} GROUP BY day ORDER BY day`)
      .bind(myEmp, from, to).all();

    return j({ from, totals, byDay });
  }

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
    await db.prepare("DELETE FROM staff_accounts WHERE employee_id=?").bind(id).run();
    await db.prepare("DELETE FROM employees WHERE id=?").bind(id).run();
    return j({ ok: true });
  }

  // --- Аккаунт сотрудницы (только владелица) ---
  const accountMatch = path.match(/^\/api\/employees\/(\d+)\/account$/);
  if (accountMatch && method === "GET") {
    const acc = await db
      .prepare("SELECT id, username, role, permissions, active FROM staff_accounts WHERE employee_id = ?")
      .bind(accountMatch[1])
      .first();
    // Пароль не отдаём никогда — только факт, что аккаунт есть.
    // Для нового аккаунта подставляем разумные значения по умолчанию.
    return j(acc
      ? { ...acc, permissions: parsePerms(acc.permissions), has_account: true }
      : { has_account: false, permissions: DEFAULT_PERMS });
  }
  if (accountMatch && method === "PUT") {
    const employeeId = accountMatch[1];
    const b = await request.json();
    const username = String(b.username || "").trim();
    if (!username) return j({ error: "Укажите логин" }, 400);

    // Логин не должен принадлежать другой сотруднице
    const clash = await db
      .prepare("SELECT id FROM staff_accounts WHERE lower(username) = lower(?) AND employee_id != ?")
      .bind(username, employeeId)
      .first();
    if (clash) return j({ error: "Такой логин уже занят" }, 400);

    const perms = JSON.stringify({ ...DEFAULT_PERMS, ...(b.permissions || {}) });
    const existing = await db.prepare("SELECT id FROM staff_accounts WHERE employee_id = ?").bind(employeeId).first();

    if (existing) {
      // Пароль меняем только если прислали новый
      if (b.password) {
        const { hash, salt } = await hashPassword(String(b.password));
        await db.prepare("UPDATE staff_accounts SET username=?, password_hash=?, password_salt=?, permissions=?, active=? WHERE employee_id=?")
          .bind(username, hash, salt, perms, b.active === false ? 0 : 1, employeeId).run();
      } else {
        await db.prepare("UPDATE staff_accounts SET username=?, permissions=?, active=? WHERE employee_id=?")
          .bind(username, perms, b.active === false ? 0 : 1, employeeId).run();
      }
      return j({ ok: true });
    }

    if (!b.password || String(b.password).length < 4) return j({ error: "Задайте пароль (минимум 4 символа)" }, 400);
    const { hash, salt } = await hashPassword(String(b.password));
    await db.prepare(
      "INSERT INTO staff_accounts (salon_id, employee_id, username, password_hash, password_salt, role, permissions, active) VALUES (?, ?, ?, ?, ?, 'staff', ?, 1)"
    ).bind(SALON_ID, employeeId, username, hash, salt, perms).run();
    return j({ ok: true });
  }
  if (accountMatch && method === "DELETE") {
    await db.prepare("DELETE FROM staff_accounts WHERE employee_id = ?").bind(accountMatch[1]).run();
    return j({ ok: true });
  }

  // --- Календарь: всё нужное для главного экрана за один запрос ---
  // Отдаём мастеров с их графиком на этот день, записи и отгулы — иначе панель
  // делала бы по три запроса на каждого мастера.
  if (path === "/api/calendar" && method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return j({ error: "Нужна дата" }, 400);
    // days=7 отдаёт сразу неделю — иначе недельный вид делал бы семь запросов
    const days = Math.min(31, Math.max(1, Number(url.searchParams.get("days") || 1)));
    const weekday = new Date(date + "T00:00:00").getDay();

    const last = new Date(date + "T00:00:00");
    last.setDate(last.getDate() + days - 1);
    const lastStr = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;

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

    // Полный график на все дни недели — нужен недельному виду
    const { results: schedules } = await db
      .prepare(
        `SELECT s.employee_id, s.weekday, s.start_minutes, s.end_minutes
         FROM employee_schedule s JOIN employees e ON e.id = s.employee_id
         WHERE e.salon_id = ?`
      )
      .bind(SALON_ID)
      .all();

    const { results: bookings } = await db
      .prepare(
        `SELECT b.id, b.employee_id, b.client_id, b.client_name, b.client_phone,
                b.requested_datetime, b.end_datetime, b.custom_service_label,
                b.charged_amount, b.comment, b.status, b.source, b.service_id,
                sv.name AS service_name, sv.price_min, sv.price_max,
                COALESCE(sv.duration_max, sv.duration_min, 60) AS duration_minutes,
                c.full_name AS client_full_name
         FROM bookings b
         LEFT JOIN services sv ON sv.id = b.service_id
         LEFT JOIN clients c ON c.id = b.client_id
         WHERE substr(b.requested_datetime,1,10) BETWEEN ? AND ?
         ORDER BY b.requested_datetime`
      )
      .bind(date, lastStr)
      .all();

    const { results: timeOff } = await db
      .prepare(
        `SELECT employee_id, date, date_end, start_minutes, end_minutes, reason
         FROM employee_time_off WHERE date <= ? AND COALESCE(date_end, date) >= ?`
      )
      .bind(lastStr, date)
      .all();

    // Сотрудница со «своими» записями видит только свою колонку, и без сумм,
    // если это ей не разрешено. Всё режем на сервере, не полагаясь на панель.
    if (!owner) {
      let emp = employees, sch = schedules, bk = bookings, off = timeOff;
      if (perms.scope !== "all") {
        emp = employees.filter((e) => e.id === myEmp);
        sch = schedules.filter((s) => s.employee_id === myEmp);
        bk = bookings.filter((b) => b.employee_id === myEmp);
        off = timeOff.filter((t) => t.employee_id === myEmp);
      }
      if (!perms.prices) bk = bk.map((b) => ({ ...b, charged_amount: null, price_min: null, price_max: null }));
      if (!perms.phone) bk = bk.map((b) => ({ ...b, client_phone: null }));
      return j({ date, days, lastDay: lastStr, weekday, employees: emp, schedules: sch, bookings: bk, timeOff: off });
    }

    return j({ date, days, lastDay: lastStr, weekday, employees, schedules, bookings, timeOff });
  }

  // Быстрая смена статуса визита — не трогаем остальные поля записи
  // Сотрудница правит только свои записи и только если ей это разрешено
  async function staffMayEditBooking(bookingId) {
    if (owner) return true;
    if (!perms.edit) return false;
    const row = await db.prepare("SELECT employee_id FROM bookings WHERE id = ?").bind(bookingId).first();
    return row && row.employee_id === myEmp;
  }

  const statusMatch = path.match(/^\/api\/bookings\/(\d+)\/status$/);
  if (statusMatch && method === "POST") {
    if (!(await staffMayEditBooking(statusMatch[1]))) return forbid();
    const b = await request.json();
    if (!b.status) return j({ error: "Нужен статус" }, 400);
    if (b.charged_amount === undefined || b.charged_amount === null) {
      await db.prepare("UPDATE bookings SET status=? WHERE id=?").bind(b.status, statusMatch[1]).run();
    } else {
      await db
        .prepare("UPDATE bookings SET status=?, charged_amount=? WHERE id=?")
        .bind(b.status, b.charged_amount, statusMatch[1])
        .run();
    }
    return j({ ok: true });
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
    // Сотрудница правит только свой график и только если разрешено
    if (!owner && (!perms.schedule || Number(id) !== myEmp)) return forbid();
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
    if (!owner && (!perms.schedule || Number(timeOffMatch[1]) !== myEmp)) return forbid();
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
    if (!owner && (!perms.schedule || Number(timeOffItemMatch[1]) !== myEmp)) return forbid();
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
    // Сотрудница видит только своих клиентов — тех, кого сама обслуживала.
    // Всю базу салона (чужие телефоны) ей не отдаём.
    const scope = owner
      ? "salon_id = ?"
      : "salon_id = ? AND id IN (SELECT DISTINCT client_id FROM bookings WHERE employee_id = ? AND client_id IS NOT NULL)";
    const binds = owner ? [SALON_ID] : [SALON_ID, myEmp];
    const query = q
      ? db.prepare(`SELECT id, full_name, phone, email FROM clients WHERE ${scope} AND (full_name LIKE ? OR phone LIKE ?) ORDER BY full_name LIMIT 200`)
          .bind(...binds, `%${q}%`, `%${q}%`)
      : db.prepare(`SELECT id, full_name, phone, email FROM clients WHERE ${scope} ORDER BY full_name LIMIT 200`)
          .bind(...binds);
    let { results } = await query.all();
    if (!owner && !perms.phone) results = results.map((c) => ({ ...c, phone: null }));
    return j(results);
  }

  // --- Сводка: выручка, retention, заработок мастеров ---
  // Период задаётся ?from=YYYY-MM-DD (по умолчанию — последние 30 дней).
  const NOT_CANCELLED = "status NOT IN ('cancelled','no_show')";
  if (path === "/api/analytics" && method === "GET") {
    const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    // Верхняя граница — конец сегодняшнего дня: будущие записи в отчёт «за период» не берём
    const to = (url.searchParams.get("to") || new Date().toISOString().slice(0, 10)) + "T23:59";
    const inPeriod = `${NOT_CANCELLED} AND requested_datetime >= ? AND requested_datetime <= ?`;

    // Итоги за период
    const totals = await db
      .prepare(
        `SELECT COUNT(*) AS visits,
                COALESCE(SUM(charged_amount),0) AS revenue,
                COUNT(DISTINCT client_id) AS active_clients
         FROM bookings WHERE ${inPeriod}`
      )
      .bind(from, to)
      .first();

    // Новые (первый визит в периоде) и вернувшиеся (первый визит раньше периода)
    const retention = await db
      .prepare(
        `WITH firsts AS (
           SELECT client_id, MIN(requested_datetime) AS fv
           FROM bookings WHERE ${NOT_CANCELLED} AND client_id IS NOT NULL GROUP BY client_id
         ),
         active AS (
           SELECT DISTINCT client_id FROM bookings
           WHERE ${NOT_CANCELLED} AND client_id IS NOT NULL AND requested_datetime >= ? AND requested_datetime <= ?
         )
         SELECT
           SUM(CASE WHEN f.fv >= ? THEN 1 ELSE 0 END) AS new_clients,
           SUM(CASE WHEN f.fv <  ? THEN 1 ELSE 0 END) AS returning_clients
         FROM active a JOIN firsts f ON f.client_id = a.client_id`
      )
      .bind(from, to, from, from)
      .first();

    // Заработок и число визитов по мастерам
    const { results: byMaster } = await db
      .prepare(
        `SELECT e.id, e.name, e.color,
                COUNT(b.id) AS visits,
                COALESCE(SUM(b.charged_amount),0) AS revenue
         FROM bookings b JOIN employees e ON e.id = b.employee_id
         WHERE b.${inPeriod}
         GROUP BY e.id ORDER BY revenue DESC`
      )
      .bind(from, to)
      .all();

    // Выручка по дням (для графика по дням/неделям)
    const { results: byDay } = await db
      .prepare(
        `SELECT substr(requested_datetime,1,10) AS day,
                COUNT(*) AS visits,
                COALESCE(SUM(charged_amount),0) AS revenue
         FROM bookings WHERE ${inPeriod}
         GROUP BY day ORDER BY day`
      )
      .bind(from, to)
      .all();

    // Что приносит деньги: у перенесённых визитов услуга записана текстом,
    // поэтому берём название из каталога, а если его нет — из подписи визита.
    const { results: byService } = await db
      .prepare(
        `SELECT COALESCE(sv.name, b.custom_service_label, 'Без названия') AS name,
                COUNT(*) AS visits,
                COALESCE(SUM(b.charged_amount),0) AS revenue
         FROM bookings b LEFT JOIN services sv ON sv.id = b.service_id
         WHERE b.${inPeriod}
         GROUP BY 1 ORDER BY revenue DESC LIMIT 15`
      )
      .bind(from, to)
      .all();

    // Загруженность: в какие часы и дни недели приходят
    const { results: byHour } = await db
      .prepare(
        `SELECT CAST(substr(requested_datetime,12,2) AS INTEGER) AS hour, COUNT(*) AS visits
         FROM bookings WHERE ${inPeriod} GROUP BY hour ORDER BY hour`
      )
      .bind(from, to)
      .all();

    // strftime('%w') даёт 0=воскресенье — совпадает с Date.getDay() в панели
    const { results: byWeekday } = await db
      .prepare(
        `SELECT CAST(strftime('%w', substr(requested_datetime,1,10)) AS INTEGER) AS weekday,
                COUNT(*) AS visits,
                COALESCE(SUM(charged_amount),0) AS revenue
         FROM bookings WHERE ${inPeriod} GROUP BY weekday ORDER BY weekday`
      )
      .bind(from, to)
      .all();

    return j({ from, totals, retention, byMaster, byDay, byService, byHour, byWeekday });
  }

  // Клиенты, которые давно не приходили — кандидаты на «вернитесь»
  if (path === "/api/clients/dormant" && method === "GET") {
    const months = Math.max(1, Number(url.searchParams.get("months") || 6));
    const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString().slice(0, 10);
    const { results } = await db
      .prepare(
        `SELECT c.id, c.full_name, c.phone,
                MAX(b.requested_datetime) AS last_visit,
                COUNT(b.id) AS visits
         FROM clients c JOIN bookings b ON b.client_id = c.id AND b.${NOT_CANCELLED}
         WHERE c.salon_id = ?
         GROUP BY c.id
         HAVING last_visit < ?
         ORDER BY last_visit DESC LIMIT 200`
      )
      .bind(SALON_ID, cutoff)
      .all();
    return j(results);
  }

  // Дни рождения в выбранном месяце (по умолчанию — текущий)
  if (path === "/api/clients/birthdays" && method === "GET") {
    const month = String(url.searchParams.get("month") || new Date().getMonth() + 1).padStart(2, "0");
    const { results } = await db
      .prepare(
        `SELECT id, full_name, phone, birthday
         FROM clients
         WHERE salon_id = ? AND birthday IS NOT NULL AND birthday != '' AND substr(birthday,6,2) = ?
         ORDER BY substr(birthday,9,2)`
      )
      .bind(SALON_ID, month)
      .all();
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
  // Сотрудница может открывать только своих клиентов
  async function staffMayTouchClient(clientId) {
    if (owner) return true;
    const row = await db
      .prepare("SELECT 1 FROM bookings WHERE client_id = ? AND employee_id = ? LIMIT 1")
      .bind(clientId, myEmp)
      .first();
    return !!row;
  }

  const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
  if (clientMatch && method === "GET") {
    if (!(await staffMayTouchClient(clientMatch[1]))) return forbid();
    const client = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(clientMatch[1]).first();
    if (!client) return j({ error: "Клиент не найден" }, 404);
    if (!owner && !perms.phone) { client.phone = null; client.email = null; }

    // Последняя формула — чтобы мастер видел её сразу, не листая историю визитов
    const lastFormula = await db
      .prepare(
        `SELECT b.formula, b.requested_datetime, e.name AS employee_name
         FROM bookings b LEFT JOIN employees e ON e.id = b.employee_id
         WHERE b.client_id = ? AND b.formula IS NOT NULL AND TRIM(b.formula) != ''
         ORDER BY b.requested_datetime DESC LIMIT 1`
      )
      .bind(clientMatch[1])
      .first();

    return j({ ...client, last_formula: lastFormula || null });
  }
  if (clientMatch && method === "PUT") {
    if (!(await staffMayTouchClient(clientMatch[1]))) return forbid();
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
    if (!owner) return forbid(); // удалять клиентов может только владелица
    await db.prepare("DELETE FROM clients WHERE id=?").bind(clientMatch[1]).run();
    return j({ ok: true });
  }

  const clientBookingsMatch = path.match(/^\/api\/clients\/(\d+)\/bookings$/);
  if (clientBookingsMatch && method === "GET") {
    if (!(await staffMayTouchClient(clientBookingsMatch[1]))) return forbid();
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

  // --- Записи (визиты) — ручное управление ---
  if (path === "/api/bookings" && method === "POST") {
    const b = await request.json();
    // Сотрудница может создавать записи, только если ей это разрешено, и только на себя
    if (!owner) {
      if (!perms.edit) return forbid();
      if (b.employee_id && b.employee_id !== myEmp) return forbid();
      b.employee_id = myEmp;
    }
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
        `INSERT INTO bookings (client_id, service_id, employee_id, client_name, client_phone, requested_datetime, end_datetime, custom_service_label, charged_amount, comment, formula, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual') RETURNING id`
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
        b.formula || null,
        b.status || "completed"
      )
      .first();
    return j({ id: result.id });
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch && method === "PUT") {
    if (!(await staffMayEditBooking(bookingMatch[1]))) return forbid();
    const b = await request.json();
    if (!owner) b.employee_id = myEmp; // не даём перекинуть запись на другого мастера
    await db
      .prepare(
        `UPDATE bookings SET service_id=?, employee_id=?, requested_datetime=?, end_datetime=?, custom_service_label=?, charged_amount=?, comment=?, formula=?, status=? WHERE id=?`
      )
      .bind(
        b.service_id || null,
        b.employee_id || null,
        b.requested_datetime,
        b.end_datetime || null,
        b.custom_service_label || null,
        b.charged_amount || null,
        b.comment || null,
        b.formula || null,
        b.status || "completed",
        bookingMatch[1]
      )
      .run();
    return j({ ok: true });
  }
  if (bookingMatch && method === "DELETE") {
    if (!(await staffMayEditBooking(bookingMatch[1]))) return forbid();
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
    // Фото визита добавляет владелица или сотрудница с правом на «формулу/фото»
    if (!owner && (!perms.visit || !(await staffMayEditBooking(bookingId)))) return forbid();
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
