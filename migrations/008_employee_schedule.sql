-- График работы мастеров: вместо строки «Пн-Сб 9:00-18:00», которую приходилось
-- разбирать регуляркой, храним по строке на рабочий день недели.
-- Время — минуты от полуночи (540 = 09:00), как это устроено в Bumpix.
--
-- Выходной = отсутствие строки за этот день. Отпуска, обеды и разовые отгулы
-- лежат отдельно в employee_time_off, чтобы не ломать постоянный график.

CREATE TABLE IF NOT EXISTS employee_schedule (
    employee_id INTEGER NOT NULL,
    weekday INTEGER NOT NULL,          -- 0=Вс, 1=Пн ... 6=Сб (как Date.getDay)
    start_minutes INTEGER NOT NULL,
    end_minutes INTEGER NOT NULL,
    PRIMARY KEY (employee_id, weekday)
);

CREATE TABLE IF NOT EXISTS employee_time_off (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,                -- YYYY-MM-DD
    start_minutes INTEGER,             -- NULL = весь день
    end_minutes INTEGER,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_time_off_lookup ON employee_time_off(employee_id, date);

-- Начальный график из кабинета Bumpix: салон работает Пн–Сб, воскресенье выходной.
DELETE FROM employee_schedule;

-- По одной вставке на день недели: D1 не переваривает длинные UNION-цепочки.
-- Время конца берём из графика Bumpix: Anastasia до 21:00, Aliona до 20:00, остальные до 18:00.
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 1, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 2, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 3, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 4, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 5, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
INSERT INTO employee_schedule (employee_id, weekday, start_minutes, end_minutes)
SELECT id, 6, 540, CASE name WHEN 'Anastasia' THEN 1260 WHEN 'Aliona' THEN 1200 ELSE 1080 END FROM employees;
