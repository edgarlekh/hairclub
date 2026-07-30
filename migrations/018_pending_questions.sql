-- Режим «спроси у владельца»: когда бот не знает ответ, он не выдумывает и не
-- отписывается «уточню у мастера», а кладёт вопрос сюда. Владелица отвечает →
-- ответ уходит клиенту и сохраняется как урок, чтобы дальше бот отвечал сам.
CREATE TABLE IF NOT EXISTS pending_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    conversation_id INTEGER,
    client_channel_id TEXT,
    client_question TEXT,   -- что спросил клиент
    bot_question TEXT,      -- что именно бот не знает (его вопрос владелице)
    status TEXT DEFAULT 'pending',   -- pending | answered
    answer TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_questions(salon_id, status);
