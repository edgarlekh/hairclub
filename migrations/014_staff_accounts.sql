-- Аккаунты сотрудниц: владелица заводит девочкам логин и пароль и настраивает,
-- что каждой видно. Пароль в базе не хранится — только его PBKDF2-отпечаток с солью,
-- по которому нельзя восстановить исходный пароль.
--
-- permissions — JSON с переключателями (см. src/auth.js DEFAULT_PERMS):
--   scope 'own'|'all' — чьи записи; edit — записывать/менять; phone — телефон клиента;
--   prices — суммы в записях; revenue — своя выручка; schedule — свой график;
--   visit — формула/фото/материалы. Отчёты салона сотрудницам недоступны всегда.
CREATE TABLE IF NOT EXISTS staff_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    employee_id INTEGER,           -- какому мастеру принадлежит вход
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    token TEXT,                    -- текущая сессия (выдаётся при входе)
    role TEXT NOT NULL DEFAULT 'staff',
    permissions TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Логин уникален без учёта регистра
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_username ON staff_accounts (lower(username));
CREATE INDEX IF NOT EXISTS idx_staff_token ON staff_accounts (token);
CREATE INDEX IF NOT EXISTS idx_staff_employee ON staff_accounts (employee_id);
