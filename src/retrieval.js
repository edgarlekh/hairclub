/**
 * Слой поиска (retrieval) для Cloudflare Workers.
 *
 * В Workers нет sklearn, поэтому используем простой, но эффективный
 * подход: подсчёт пересечения слов (Jaccard-подобная схожесть) +
 * буст за точное вхождение фразы. Для базы из десятков записей
 * одного салона этого достаточно, и это работает без внешних
 * зависимостей и без задержек на холодном старте Worker'а.
 *
 * Если база сильно вырастет — можно заменить на Vectorize
 * (встроенная векторная база Cloudflare) без изменения интерфейса
 * функций ниже.
 */

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\wа-яё\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function similarityScore(query, text) {
  const queryWords = new Set(normalize(query));
  const textWords = normalize(text);
  if (queryWords.size === 0 || textWords.length === 0) return 0;

  let overlap = 0;
  for (const w of textWords) {
    if (queryWords.has(w)) overlap++;
  }
  // буст, если весь запрос встречается как подстрока
  const phraseBoost = text.toLowerCase().includes(query.toLowerCase()) ? 2 : 0;
  return overlap / Math.sqrt(textWords.length) + phraseBoost;
}

function rankBySimilarity(query, candidates, textFn, topK) {
  return candidates
    .map((c) => ({ item: c, score: similarityScore(query, textFn(c)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.item);
}

export async function retrieveServices(db, salonId, query, topK = 3) {
  const { results } = await db
    .prepare(
      `SELECT s.*, c.name AS category_name
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       WHERE s.salon_id = ? AND s.active = 1`
    )
    .bind(salonId)
    .all();
  // Категорию тоже учитываем при поиске: «хочу что-то для ресниц» должно находить нужную группу
  return rankBySimilarity(query, results, (s) => `${s.name} ${s.category_name || ""} ${s.description || ""}`, topK);
}

export async function retrievePhotos(db, salonId, query, topK = 2) {
  const { results } = await db
    .prepare(
      `SELECT sp.*, s.name as service_name FROM service_photos sp
       JOIN services s ON sp.service_id = s.id
       WHERE s.salon_id = ?`
    )
    .bind(salonId)
    .all();
  return rankBySimilarity(query, results, (p) => p.tag_description, topK);
}

export async function retrieveFaq(db, salonId, query, topK = 2) {
  const { results } = await db
    .prepare("SELECT * FROM knowledge_base WHERE salon_id = ?")
    .bind(salonId)
    .all();
  return rankBySimilarity(query, results, (f) => `${f.topic} ${f.content}`, topK);
}

export async function getActiveRules(db, salonId) {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT * FROM rules_overrides
       WHERE salon_id = ? AND active = 1
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_until IS NULL OR valid_until >= ?)`
    )
    .bind(salonId, today, today)
    .all();
  return results;
}

export async function getSalon(db, salonId) {
  return await db.prepare("SELECT * FROM salons WHERE id = ?").bind(salonId).first();
}

export async function retrieveContext(db, salonId, clientMessage) {
  const [services, photos, faq, rules] = await Promise.all([
    retrieveServices(db, salonId, clientMessage),
    retrievePhotos(db, salonId, clientMessage),
    retrieveFaq(db, salonId, clientMessage),
    getActiveRules(db, salonId),
  ]);
  return { services, photos, faq, rules };
}
