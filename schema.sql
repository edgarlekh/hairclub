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

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    price_min REAL,
    price_max REAL,
    currency TEXT DEFAULT 'PLN',
    duration_minutes INTEGER,
    description TEXT
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
    working_schedule TEXT,
    photo_url TEXT
);

CREATE TABLE IF NOT EXISTS employee_services (
    employee_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    PRIMARY KEY (employee_id, service_id)
);

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
    conversation_id INTEGER NOT NULL,
    service_id INTEGER,
    employee_id INTEGER,
    client_name TEXT,
    client_phone TEXT,
    requested_datetime TEXT,
    status TEXT DEFAULT 'pending',
    bumpix_sync_status TEXT DEFAULT 'not_synced',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    triggered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_by TEXT
);
