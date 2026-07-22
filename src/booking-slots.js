/**
 * Вычисление свободных слотов для записи.
 * Берём график работы мастера, вычитаем уже существующие брони,
 * нарезаем оставшееся время на слоты по длительности услуги.
 */

export const DAY_NAMES = {
  0: "Вс", 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб",
};

export function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Время визита в минутах от полуночи. Разбираем строку сами: у "2026-06-02T12:30"
// без часового пояса new Date() в разных средах даёт разное время.
function minutesOfDay(datetimeStr) {
  const m = String(datetimeStr || "").match(/[T ](\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Занятые интервалы мастера на дату: существующие визиты + отгулы/обеды. */
async function getBusyRanges(db, employeeId, dateStr) {
  // LEFT JOIN обязателен: у перенесённых из Bumpix визитов service_id пустой,
  // при INNER JOIN они выпадали из расчёта и время считалось свободным.
  const { results: bookings } = await db
    .prepare(
      `SELECT b.requested_datetime, b.end_datetime,
              COALESCE(s.duration_max, s.duration_min, 60) AS duration_minutes
       FROM bookings b
       LEFT JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = ? AND b.requested_datetime LIKE ?
         AND b.status NOT IN ('cancelled', 'no_show')`
    )
    .bind(employeeId, `${dateStr}%`)
    .all();

  const busy = [];
  for (const b of bookings) {
    const start = minutesOfDay(b.requested_datetime);
    if (start === null) continue;
    const end = minutesOfDay(b.end_datetime) ?? start + (b.duration_minutes || 60);
    busy.push({ start, end: Math.max(end, start + 1) });
  }

  const { results: timeOff } = await db
    .prepare("SELECT start_minutes, end_minutes FROM employee_time_off WHERE employee_id = ? AND date = ?")
    .bind(employeeId, dateStr)
    .all();

  for (const t of timeOff) {
    // Пустое время = выходной на весь день
    busy.push({ start: t.start_minutes ?? 0, end: t.end_minutes ?? 24 * 60 });
  }
  return busy;
}

export async function getAvailableSlots(db, employeeId, serviceId, dateStr) {
  const employee = await db.prepare("SELECT * FROM employees WHERE id = ?").bind(employeeId).first();
  const service = await db.prepare("SELECT * FROM services WHERE id = ?").bind(serviceId).first();
  if (!employee || !service) return { error: "Мастер или услуга не найдены" };

  const weekday = new Date(dateStr + "T00:00:00").getDay();
  const workday = await db
    .prepare("SELECT start_minutes, end_minutes FROM employee_schedule WHERE employee_id = ? AND weekday = ?")
    .bind(employeeId, weekday)
    .first();

  if (!workday) return { slots: [], note: "В этот день мастер не работает" };

  const busyRanges = await getBusyRanges(db, employeeId, dateStr);

  // Резервируем по максимальной длительности услуги — иначе долгий вариант наложится на следующего клиента
  const duration = service.duration_max || service.duration_min || 60;
  const stepMinutes = 30; // шаг сетки слотов
  const slots = [];

  // Сегодняшние слоты, которые уже прошли, предлагать нельзя
  const now = new Date();
  const isToday = dateStr === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (let m = workday.start_minutes; m + duration <= workday.end_minutes; m += stepMinutes) {
    if (isToday && m <= nowMinutes) continue;
    const slotEnd = m + duration;
    const overlaps = busyRanges.some((b) => m < b.end && slotEnd > b.start);
    if (!overlaps) slots.push(minutesToTime(m));
  }

  return { slots };
}

const SALON_ID = 1;

async function upsertClient(db, { clientName, clientPhone }) {
  if (clientPhone) {
    const existing = await db
      .prepare("SELECT id FROM clients WHERE salon_id = ? AND phone = ?")
      .bind(SALON_ID, clientPhone)
      .first();
    if (existing) return existing.id;
  }
  const result = await db
    .prepare("INSERT INTO clients (salon_id, full_name, phone) VALUES (?, ?, ?) RETURNING id")
    .bind(SALON_ID, clientName || "Без имени", clientPhone || null)
    .first();
  return result.id;
}

export async function createBookingSafe(db, { serviceId, employeeId, clientName, clientPhone, dateStr, timeStr, conversationId, source = "agent" }) {
  const requestedDatetime = `${dateStr}T${timeStr}:00`;

  // Повторная проверка перед записью — защита от двойного бронирования
  const service = await db.prepare("SELECT duration_min, duration_max FROM services WHERE id = ?").bind(serviceId).first();
  const duration = service?.duration_max || service?.duration_min || 60;
  const [h, m] = timeStr.split(":").map(Number);
  const startMin = h * 60 + m;
  const endMin = startMin + duration;

  // Записываться можно только в рабочие часы мастера
  const weekday = new Date(dateStr + "T00:00:00").getDay();
  const workday = await db
    .prepare("SELECT start_minutes, end_minutes FROM employee_schedule WHERE employee_id = ? AND weekday = ?")
    .bind(employeeId, weekday)
    .first();
  if (!workday) {
    return { ok: false, error: "В этот день мастер не работает, выбери другой день" };
  }
  if (startMin < workday.start_minutes || endMin > workday.end_minutes) {
    return {
      ok: false,
      error: `Мастер работает с ${minutesToTime(workday.start_minutes)} до ${minutesToTime(workday.end_minutes)}, услуга в это время не поместится`,
    };
  }

  for (const c of await getBusyRanges(db, employeeId, dateStr)) {
    if (startMin < c.end && endMin > c.start) {
      return { ok: false, error: "Этот слот уже занят, выбери другое время" };
    }
  }

  const clientId = await upsertClient(db, { clientName, clientPhone });

  const result = await db
    .prepare(
      `INSERT INTO bookings (conversation_id, client_id, service_id, employee_id, client_name, client_phone, requested_datetime, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?) RETURNING id`
    )
    .bind(conversationId || null, clientId, serviceId, employeeId, clientName, clientPhone, requestedDatetime, source)
    .first();

  return { ok: true, bookingId: result.id };
}
