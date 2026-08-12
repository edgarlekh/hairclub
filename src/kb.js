/**
 * Очистка базы знаний из переписок: сырые реплики администратора → компактные общие
 * факты о салоне. Делает это Claude (тот же ANTHROPIC_API_KEY). Факты потом всегда
 * целиком идут агенту — их немного, поиск не нужен, ничего не теряется.
 *
 * Жёсткие правила очистки: без цен и любых сумм/граммов, без деталей под конкретного
 * клиента, без приветствий/встречных вопросов/маркетинга, без старого адреса и обучения.
 */

const DISTILL_MODEL = "claude-sonnet-5";

const DISTILL_SYSTEM = `Ты — редактор базы знаний салона красоты HAIR CLUB (Варшава: наращивание, кератин, ботокс, нанопластия, окрашивание).
Тебе дают реальные реплики администратора клиентам. Твоя задача — выписать из них ТОЛЬКО общие, повторно применимые ФАКТЫ о салоне и услугах.

СТРОГО НЕЛЬЗЯ включать:
- любые цены, суммы, числа денег, граммы, «zł», конкретные цифры стоимости;
- детали под конкретного клиента («для вас нужно…», «в вашем случае»);
- приветствия, прощания, встречные вопросы администратора, благодарности;
- маркетинг, рилзы, репосты, посты, упоминания блогеров;
- адрес и телефоны;
- обучение/курсы (szkolenia) — это отдельно, не включай.

Включай (как общие факты): как проходят процедуры, уход до/после, противопоказания, беременность, сколько держится эффект, отличия услуг (кератин/ботокс/нанопластия), окрашивание до/после процедуры, консультация (как устроена), совмещение услуг, коррекция, снятие, качество волос — общими словами, без цифр.

Формат ответа: каждый факт — ОДНА короткая строка на русском, начинается с «- ». Без нумерации, без заголовков, без вступлений. Только строки-факты. Убирай дубли. Если в куске нет полезных общих фактов — верни пустой ответ.`;

async function callClaude(env, system, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: DISTILL_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function normFact(s) {
  return s.toLowerCase().replace(/[^a-zа-яё ]/gi, " ").replace(/\s+/g, " ").trim();
}

// Обработать партию сырых фрагментов: очистить через Claude и записать факты.
export async function distillBatch(env, offset = 0, limit = 40, debug = false) {
  const { results: raw } = await env.DB
    .prepare("SELECT content FROM kb_raw WHERE salon_id = 1 ORDER BY id LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all();
  if (!raw.length) return { done: true, added: 0, next: null };

  const chunk = raw.map((r, i) => `${i + 1}) ${r.content}`).join("\n");
  const out = await callClaude(env, DISTILL_SYSTEM, "Реплики администратора:\n\n" + chunk);

  const facts = out.split("\n").map((l) => l.replace(/^[-•*\d.\s]+/, "").trim()).filter((l) => l.length > 12);
  if (debug) return { debug: true, rawLen: out.length, sample: out.slice(0, 600), factsFound: facts.length };

  // Дедуп против уже сохранённых
  const { results: existing } = await env.DB.prepare("SELECT content FROM agent_knowledge WHERE salon_id = 1").all();
  const seen = new Set(existing.map((e) => normFact(e.content)));

  let added = 0;
  for (const f of facts) {
    const k = normFact(f);
    if (k.split(" ").length < 3 || seen.has(k)) continue;
    seen.add(k);
    await env.DB.prepare("INSERT INTO agent_knowledge (salon_id, source, content) VALUES (1, 'distilled', ?)").bind(f).run();
    added++;
  }

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_raw WHERE salon_id = 1").first();
  const next = offset + raw.length;
  return { done: next >= n, added, processed: raw.length, next: next >= n ? null : next, total: n };
}

// Все чистые факты — для вставки в промпт агента (их немного, помещаются целиком)
export async function getAllKnowledge(db, salonId) {
  try {
    const { results } = await db
      .prepare("SELECT content FROM agent_knowledge WHERE salon_id = ? AND source = 'distilled' ORDER BY id")
      .bind(salonId)
      .all();
    return results.map((r) => r.content);
  } catch {
    return [];
  }
}
