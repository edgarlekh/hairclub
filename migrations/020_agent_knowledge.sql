-- База знаний агента.
--   kb_raw          — сырые реплики из переписок (временное сырьё для очистки).
--   agent_knowledge — чистые общие факты после очистки через ИИ (source='distilled').
-- Чистые факты идут агенту целиком (их немного), сырьё после очистки можно удалить.
CREATE TABLE IF NOT EXISTS kb_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    source TEXT DEFAULT 'distilled',
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_salon ON agent_knowledge(salon_id);
