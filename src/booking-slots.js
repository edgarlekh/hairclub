/**
 * Вычисление свободных слотов для записи.
 * Берём график работы мастера, вычитаем уже существующие брони,
 * нарезаем оставшееся время на слоты по длительности услуги.
 */

const DAY_NAMES = {
  0: "Вс", 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб",
};

// Разбор строки графика вида "Пн-Сб 9:00-18:00" в структуру { days: [...], start: "09:00", end: "18:00" }
function parseSchedule(scheduleStr) {
  if (!scheduleStr) return null;
  const match = scheduleStr.match(/(\S+)-(\S+)\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, dayFrom, dayTo, h1, m1, h2, m2] = match;
  const dayOrder = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const fromIdx = dayOrder.indexOf(dayFrom);
  const toIdx = dayOrder.indexOf(dayTo);
  const activeDays = [];
  if (fromIdx !== -1 && toIdx !== -1) {
    for (let i = fromIdx; i <= toIdx; i++) activeDays.push(dayOrder[i]);
  }
  return {
    activeDays,
    startMinutes: parseInt(h1) * 60 + parseInt(m1),
    endMinutes: parseInt(h2) * 60 + parseInt(m2),
  };
}

function isDayActive(schedule, date) {
  const dayName = DAY_NAMES[date.getDay()];
  return schedule.activeDays.includes(dayName);
}

export async function getAvailableSlots(db, employeeId, serviceId, dateStr) {
  const employee = await db.prepare("SELECT * FROM employees WHERE id = ?").bind(employeeId).first();
  const service = await db.prepare("SELECT * FROM services WHERE id = ?").bind(serviceId).first();
  if (!employee || !service) return { error: "Мастер или услуга не найдены" };

  const schedule = parseSchedule(employee.working_schedule);
  if (!schedule) return { error: "У мастера не указан график работы" };

  const date = new Date(dateStr + "T00:00:00");
  if (!isDayActive(schedule, date)) {
    return { slots: [], note: "В этот день мастер не работает" };
  }

  // Существующие подтверждённые/ожидающие брони этого мастера на эту дату
  const { results: existingBookings } = await db
    .prepare(
      `SELECT b.requested_datetime, s.duration_minutes FROM bookings b
       JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = ? AND b.requested_datetime LIKE ? AND b.status != 'cancelled'`
    )
    .bind(employeeId, `${dateStr}%`)
    .all();

  const busyRanges = existingBookings.map((b) => {
    const t = new Date(b.requested_datetime);
    const startMin = t.getHours() * 60 + t.getMinutes();
    return { start: startMin, end: startMin + (b.duration_minutes || 60) };
  });

  const duration = service.duration_minutes || 60;
  const stepMinutes = 30; // шаг сетки слотов
  const slots = [];

  for (let m = schedule.startMinutes; m + duration <= schedule.endMinutes; m += stepMinutes) {
    const slotEnd = m + duration;
    const overlaps = busyRanges.some((b) => m < b.end && slotEnd > b.start);
    if (!overlaps) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
  }

  return { slots };
}

export async function createBookingSafe(db, { serviceId, employeeId, clientName, clientPhone, dateStr, timeStr, conversationId }) {
  const requestedDatetime = `${dateStr}T${timeStr}:00`;

  // Повторная проверка перед записью — защита от двойного бронирования
  const service = await db.prepare("SELECT duration_minutes FROM services WHERE id = ?").bind(serviceId).first();
  const duration = service?.duration_minutes || 60;
  const [h, m] = timeStr.split(":").map(Number);
  const startMin = h * 60 + m;
  const endMin = startMin + duration;

  const { results: conflicts } = await db
    .prepare(
      `SELECT b.requested_datetime, s.duration_minutes FROM bookings b
       JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = ? AND b.requested_datetime LIKE ? AND b.status != 'cancelled'`
    )
    .bind(employeeId, `${dateStr}%`)
    .all();

  for (const c of conflicts) {
    const t = new Date(c.requested_datetime);
    const cStart = t.getHours() * 60 + t.getMinutes();
    const cEnd = cStart + (c.duration_minutes || 60);
    if (startMin < cEnd && endMin > cStart) {
      return { ok: false, error: "Этот слот уже занят, выбери другое время" };
    }
  }

  const result = await db
    .prepare(
      `INSERT INTO bookings (conversation_id, service_id, employee_id, client_name, client_phone, requested_datetime, status)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed') RETURNING id`
    )
    .bind(conversationId || null, serviceId, employeeId, clientName, clientPhone, requestedDatetime)
    .first();

  return { ok: true, bookingId: result.id };
}
