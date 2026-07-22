-- Справочник категорий услуг + услуги с диапазонами цены и длительности.
-- Каталог услуг пересоздаётся: записи (bookings) на услуги по id не ссылаются,
-- у них своё текстовое название визита (custom_service_label), поэтому история не пострадает.

DROP TABLE IF EXISTS service_categories;
CREATE TABLE service_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER DEFAULT 0
);

DROP TABLE IF EXISTS services;
CREATE TABLE services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    category_id INTEGER REFERENCES service_categories(id),
    name TEXT NOT NULL,
    price_min REAL,
    price_max REAL,
    currency TEXT DEFAULT 'PLN',
    duration_min INTEGER,
    duration_max INTEGER,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_services_category ON services(category_id);
CREATE INDEX idx_services_active ON services(active);

-- Связка «мастер делает эту услугу» заполняется заново из выгрузки
DELETE FROM employee_services;
