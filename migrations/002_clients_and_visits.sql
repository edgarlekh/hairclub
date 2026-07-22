-- Миграция: клиенты + расширенные записи (визиты) + фото визитов.
-- bookings на момент написания миграции пуста в проде (seed.sql туда ничего
-- не вставлял) — пересоздаём таблицу целиком без риска потери данных.

DROP TABLE IF EXISTS bookings;

CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    birthday TEXT,
    balance REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    comment TEXT,
    photo_url TEXT,
    bumpix_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clients_salon ON clients(salon_id);
CREATE INDEX idx_clients_phone ON clients(phone);
CREATE INDEX idx_clients_bumpix ON clients(bumpix_id);

CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,
    client_id INTEGER,
    service_id INTEGER,
    employee_id INTEGER,
    client_name TEXT,
    client_phone TEXT,
    requested_datetime TEXT,
    end_datetime TEXT,
    custom_service_label TEXT,
    charged_amount REAL,
    comment TEXT,
    status TEXT DEFAULT 'pending',
    source TEXT DEFAULT 'agent',
    bumpix_event_id TEXT,
    bumpix_sync_status TEXT DEFAULT 'not_synced',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bookings_client ON bookings(client_id);
CREATE INDEX idx_bookings_employee_date ON bookings(employee_id, requested_datetime);
CREATE INDEX idx_bookings_bumpix_event ON bookings(bumpix_event_id);

CREATE TABLE visit_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    photo_url TEXT NOT NULL,
    caption TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
