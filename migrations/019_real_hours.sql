-- Реальные часы салона из анкеты владелицы: Пн–Пт 10:00–20:00, Сб 10:00–18:00,
-- воскресенье выходной. Старые часы (из Bumpix, 9:00–21:00) заставляли онлайн-запись
-- предлагать время, когда салон ещё/уже закрыт.
-- Ставим одинаковые часы всем мастерам; личные отличия владелица подправит в панели.
DELETE FROM employee_schedule;

-- Пн–Пт (1–5): 10:00–20:00  → 600–1200 минут
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 1, 600, 1200 FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 2, 600, 1200 FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 3, 600, 1200 FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 4, 600, 1200 FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 5, 600, 1200 FROM employees;

-- Сб (6): 10:00–18:00  → 600–1080 минут
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 6, 600, 1080 FROM employees;
-- Воскресенье (0) не добавляем — выходной.
