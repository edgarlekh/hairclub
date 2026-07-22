-- Цвет мастера для календаря: чтобы записи каждого выделялись своим цветом,
-- а не были все одинаково-серыми. Цвет виден в шапке колонки и на блоках записей.
ALTER TABLE employees ADD COLUMN color TEXT;

-- Стартовая палитра — приглушённые тона в тон бренду, разные, но не кричащие.
UPDATE employees SET color = CASE (
  SELECT COUNT(*) FROM employees e2 WHERE e2.id < employees.id
) % 6
  WHEN 0 THEN '#b8824f'  -- бронза
  WHEN 1 THEN '#7c9473'  -- шалфей
  WHEN 2 THEN '#9c6b8e'  -- пыльная сирень
  WHEN 3 THEN '#6b8ea4'  -- пыльно-голубой
  WHEN 4 THEN '#c08552'  -- терракота
  ELSE '#8a7a9c'          -- лавандово-серый
END
WHERE color IS NULL;
