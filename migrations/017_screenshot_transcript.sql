-- Скриншоты теперь не просто архив: при загрузке система читает картинку
-- (переписку или прайс) и сохраняет извлечённый текст. Этот текст идёт агенту —
-- так бот учится прямо со скринов, как и хотела владелица.
ALTER TABLE training_photos ADD COLUMN transcript TEXT;
ALTER TABLE survey_photos ADD COLUMN transcript TEXT;
