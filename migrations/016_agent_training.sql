-- Уроки для агента: живые примеры и поправки от владелицы.
-- Именно на них бот становится умным — учится на реальных решениях, а не на догадках.
--   kind='good' — хороший пример: как классно ответить в такой ситуации.
--   kind='fix'  — поправка: как НЕ надо (wrong_reply) и как правильно (right_way).
-- source='testchat' — поправка прямо из тест-чата; 'manual' — добавлена вручную.
CREATE TABLE IF NOT EXISTS agent_training (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fix',
    situation TEXT,      -- что написал/спросил клиент, контекст
    wrong_reply TEXT,    -- как НЕ надо (ответ бота или старый ответ)
    right_way TEXT,      -- как правильно ответить
    note TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Скриншоты диалогов к урокам (для записи и контекста), файл в R2, тут ссылка
CREATE TABLE IF NOT EXISTS training_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    training_id INTEGER NOT NULL,
    photo_url TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_training_photos ON training_photos(training_id);
