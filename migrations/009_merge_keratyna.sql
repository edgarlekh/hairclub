-- Каталог вместо прайса: 54 позиции «Keratyna 200, 210, 220 … 950» — это одна услуга,
-- у которой цена зависит от длины и густоты волос. Клиент всё равно не может выбрать
-- её сам, цену определяет мастер на месте.
--
-- Сводим в одну услугу с диапазоном 200–950 PLN и длительностью 180–300 минут.
-- Бронь занимает максимум (5 часов), а мастер после визита ставит фактическое время —
-- освободившиеся часы сразу возвращаются в свободные окна на сайте.
--
-- История визитов не пострадает: ни один визит не ссылается на услугу по номеру,
-- название процедуры хранится в самой записи текстом (custom_service_label).

-- Оставляем самую раннюю запись группы, чтобы не плодить новые id
CREATE TABLE IF NOT EXISTS _keratyna_keep AS
SELECT MIN(id) AS id FROM services WHERE name GLOB 'Keratyna [0-9]*';

UPDATE services
SET name = 'Keratyna',
    description = 'Кератиновое выпрямление. Цена зависит от длины и густоты волос — мастер уточнит на месте.',
    price_min = 200,
    price_max = 950,
    duration_min = 180,
    duration_max = 300
WHERE id IN (SELECT id FROM _keratyna_keep);

-- Переносим на оставшуюся услугу всех мастеров, кто делал любой из вариантов
INSERT OR IGNORE INTO employee_services (employee_id, service_id)
SELECT DISTINCT es.employee_id, (SELECT id FROM _keratyna_keep)
FROM employee_services es
JOIN services s ON s.id = es.service_id
WHERE s.name GLOB 'Keratyna [0-9]*';

DELETE FROM employee_services
WHERE service_id IN (SELECT id FROM services WHERE name GLOB 'Keratyna [0-9]*');

DELETE FROM service_photos
WHERE service_id IN (SELECT id FROM services WHERE name GLOB 'Keratyna [0-9]*');

DELETE FROM services WHERE name GLOB 'Keratyna [0-9]*';

DROP TABLE _keratyna_keep;

-- Демо-мастер из первоначальных данных: ноль услуг, ноль визитов, в Bumpix её нет
DELETE FROM employee_schedule WHERE employee_id IN (SELECT id FROM employees WHERE name = 'Karolina');
DELETE FROM employee_time_off  WHERE employee_id IN (SELECT id FROM employees WHERE name = 'Karolina');
DELETE FROM employee_services  WHERE employee_id IN (SELECT id FROM employees WHERE name = 'Karolina');
DELETE FROM employees
WHERE name = 'Karolina'
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.employee_id = employees.id);
