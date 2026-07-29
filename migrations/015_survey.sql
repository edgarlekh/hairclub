-- Анкета владелицы: ответы на вопросы об услугах, ценах, правилах и т.д.
-- По ним настраивается AI-агент — он говорит фактами и словами салона, а не выдумкой.
-- Вопросы (их текст и разделы) заданы в панели; сюда пишем ответ по ключу вопроса.
CREATE TABLE IF NOT EXISTS survey_answers (
    salon_id INTEGER NOT NULL,
    question_key TEXT NOT NULL,
    section TEXT,
    label TEXT,           -- сам вопрос, чтобы агент читал ответы без знания структуры панели
    answer TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (salon_id, question_key)
);

-- Фото/скрины к вопросам (прайс, примеры работ) — файл лежит в R2, тут ссылка
CREATE TABLE IF NOT EXISTS survey_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    question_key TEXT NOT NULL,
    photo_url TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_survey_photos_key ON survey_photos(salon_id, question_key);
