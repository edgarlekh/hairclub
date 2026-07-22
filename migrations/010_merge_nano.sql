-- То же, что с Keratyna: «Nano 900 / 1000 / 1100 / 1200» — это одна процедура,
-- у которой цена зависит от волос. Услуга редкая: 13 визитов и 7 клиентов за три года
-- (у Keratyna для сравнения 1754 визита), а Nano 1200 не заказывали ни разу.
--
-- Сводим в одну «Nano» с диапазоном 900–1200 PLN и длительностью 240–300 минут.
-- Бронь займёт максимум, мастер потом поставит фактическое время.
--
-- История сохраняется: название процедуры лежит в самой записи текстом,
-- в карточках клиентов по-прежнему будет «Nano 1000».

CREATE TABLE IF NOT EXISTS _nano_keep AS
SELECT MIN(id) AS id FROM services WHERE name GLOB 'Nano [0-9]*';

UPDATE services
SET name = 'Nano',
    description = 'Нанопластика волос. Цена зависит от длины и густоты — мастер уточнит на месте.',
    price_min = 900,
    price_max = 1200,
    duration_min = 240,
    duration_max = 300
WHERE id IN (SELECT id FROM _nano_keep);

INSERT OR IGNORE INTO employee_services (employee_id, service_id)
SELECT DISTINCT es.employee_id, (SELECT id FROM _nano_keep)
FROM employee_services es
JOIN services s ON s.id = es.service_id
WHERE s.name GLOB 'Nano [0-9]*';

DELETE FROM employee_services
WHERE service_id IN (SELECT id FROM services WHERE name GLOB 'Nano [0-9]*');

DELETE FROM service_photos
WHERE service_id IN (SELECT id FROM services WHERE name GLOB 'Nano [0-9]*');

DELETE FROM services WHERE name GLOB 'Nano [0-9]*';

DROP TABLE _nano_keep;
