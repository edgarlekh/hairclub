-- Салон больше не занимается ресницами и бровями: убираем это направление целиком.
--
-- Что удаляется:
--   * услуги категории «Rzęsy i brwi» (и всё, что по названию относится к ресницам/бровям);
--   * визиты на эти услуги — 301 шт., все сделаны Anastasia;
--   * клиенты, у которых ВСЕ визиты были ресничные — 101 чел.
--
-- Что НЕ трогаем:
--   * 11 клиентов, ходивших и на ресницы, и на волосы — человек остаётся, уходят только его ресничные визиты;
--   * 64 клиента без визитов — по ним нельзя определить направление;
--   * мастеров — ресницы делала Anastasia, но она же ведёт волосы (1656 визитов).
--
-- ВАЖНО: перед запуском сделай резервную копию:
--   wrangler d1 export salon-agent-db --remote --output=backup-before-lashes.sql

-- Список «чисто ресничных» клиентов считаем ДО удаления визитов, иначе они смешаются
-- с теми 64, у кого визитов не было изначально.
DROP TABLE IF EXISTS _lash_only_clients;
CREATE TABLE _lash_only_clients (id INTEGER PRIMARY KEY);

INSERT INTO _lash_only_clients (id)
SELECT client_id FROM bookings
WHERE client_id IS NOT NULL
GROUP BY client_id
HAVING SUM(CASE WHEN lower(custom_service_label) LIKE '%rzęs%'
                  OR lower(custom_service_label) LIKE '%rzes%'
                  OR lower(custom_service_label) LIKE '%brwi%'
                  OR lower(custom_service_label) LIKE '%lami%'
                  OR lower(custom_service_label) LIKE '%henn%'
             THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN lower(custom_service_label) LIKE '%rzęs%'
                  OR lower(custom_service_label) LIKE '%rzes%'
                  OR lower(custom_service_label) LIKE '%brwi%'
                  OR lower(custom_service_label) LIKE '%lami%'
                  OR lower(custom_service_label) LIKE '%henn%'
             THEN 0 ELSE 1 END) = 0;

-- Фото удаляемых визитов (внешние ключи не каскадные — чистим руками)
DELETE FROM visit_photos WHERE booking_id IN (
  SELECT id FROM bookings
  WHERE lower(custom_service_label) LIKE '%rzęs%'
     OR lower(custom_service_label) LIKE '%rzes%'
     OR lower(custom_service_label) LIKE '%brwi%'
     OR lower(custom_service_label) LIKE '%lami%'
     OR lower(custom_service_label) LIKE '%henn%'
     OR client_id IN (SELECT id FROM _lash_only_clients)
);

DELETE FROM bookings
WHERE lower(custom_service_label) LIKE '%rzęs%'
   OR lower(custom_service_label) LIKE '%rzes%'
   OR lower(custom_service_label) LIKE '%brwi%'
   OR lower(custom_service_label) LIKE '%lami%'
   OR lower(custom_service_label) LIKE '%henn%'
   OR client_id IN (SELECT id FROM _lash_only_clients);

DELETE FROM clients WHERE id IN (SELECT id FROM _lash_only_clients);

DROP TABLE _lash_only_clients;

-- Услуги направления: и по категории, и по названию (на случай, если что-то мимо категории)
DELETE FROM service_photos WHERE service_id IN (
  SELECT id FROM services
  WHERE category_id IN (SELECT id FROM service_categories WHERE name = 'Rzęsy i brwi')
     OR lower(name) LIKE '%rzęs%' OR lower(name) LIKE '%rzes%'
     OR lower(name) LIKE '%brwi%' OR lower(name) LIKE '%lami%' OR lower(name) LIKE '%henn%'
);

DELETE FROM employee_services WHERE service_id IN (
  SELECT id FROM services
  WHERE category_id IN (SELECT id FROM service_categories WHERE name = 'Rzęsy i brwi')
     OR lower(name) LIKE '%rzęs%' OR lower(name) LIKE '%rzes%'
     OR lower(name) LIKE '%brwi%' OR lower(name) LIKE '%lami%' OR lower(name) LIKE '%henn%'
);

DELETE FROM services
WHERE category_id IN (SELECT id FROM service_categories WHERE name = 'Rzęsy i brwi')
   OR lower(name) LIKE '%rzęs%' OR lower(name) LIKE '%rzes%'
   OR lower(name) LIKE '%brwi%' OR lower(name) LIKE '%lami%' OR lower(name) LIKE '%henn%';

DELETE FROM service_categories WHERE name = 'Rzęsy i brwi';
