-- Схема для Cloudflare D1 (SQLite-совместимый диалект, почти без изменений от исходной)

CREATE TABLE IF NOT EXISTS salons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    logo_url TEXT,
    address TEXT,
    working_hours TEXT,
    tone_of_voice TEXT DEFAULT 'дружелюбный, тёплый, как живой администратор',
    banned_words TEXT DEFAULT '',
    emoji_usage TEXT DEFAULT 'minimal',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER DEFAULT 0
);

-- Цена и длительность — диапазоны: разные мастера и разная длина волос дают разную цифру
CREATE TABLE IF NOT EXISTS services (
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

CREATE TABLE IF NOT EXISTS service_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    photo_url TEXT NOT NULL,
    tag_description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    working_schedule TEXT,   -- устарело, график лежит в employee_schedule
    photo_url TEXT
);

-- Постоянный график: строка на каждый рабочий день, выходной = отсутствие строки.
-- Время в минутах от полуночи (540 = 09:00).
CREATE TABLE IF NOT EXISTS employee_schedule (
    employee_id INTEGER NOT NULL,
    weekday INTEGER NOT NULL,          -- 0=Вс, 1=Пн ... 6=Сб (как Date.getDay)
    start_minutes INTEGER NOT NULL,
    end_minutes INTEGER NOT NULL,
    PRIMARY KEY (employee_id, weekday)
);

-- Разовые исключения: отпуск, отгул, обед. Пустое время = весь день.
CREATE TABLE IF NOT EXISTS employee_time_off (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_minutes INTEGER,
    end_minutes INTEGER,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS employee_services (
    employee_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    PRIMARY KEY (employee_id, service_id)
);

CREATE TABLE IF NOT EXISTS clients (
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

CREATE INDEX IF NOT EXISTS idx_clients_salon ON clients(salon_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_bumpix ON clients(bumpix_id);

CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    rule_type TEXT NOT NULL,
    description TEXT NOT NULL,
    valid_from TEXT,
    valid_until TEXT,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    client_channel_id TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
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

CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_employee_date ON bookings(employee_id, requested_datetime);
CREATE INDEX IF NOT EXISTS idx_bookings_bumpix_event ON bookings(bumpix_event_id);

CREATE TABLE IF NOT EXISTS visit_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    photo_url TEXT NOT NULL,
    caption TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    triggered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_by TEXT
);
