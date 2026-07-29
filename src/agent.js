/**
 * Ядро AI-агента для Cloudflare Worker.
 * Ключ ANTHROPIC_API_KEY хранится в Secrets Worker'а — никогда в коде.
 */
import { retrieveContext, getSalon } from "./retrieval.js";
import { getAvailableSlots, createBookingSafe } from "./booking-slots.js";

const MODEL = "claude-sonnet-5";

const TOOLS = [
  {
    name: "attach_photo",
    description:
      "Прикрепить клиенту фото примера работы, если он спрашивает как будет выглядеть результат",
    input_schema: {
      type: "object",
      properties: {
        photo_id: { type: "integer" },
        caption: { type: "string" },
      },
      required: ["photo_id"],
    },
  },
  {
    name: "get_available_slots",
    description: "Получить свободные слоты времени у мастера на конкретную дату для выбранной услуги",
    input_schema: {
      type: "object",
      properties: {
        employee_id: { type: "integer" },
        service_id: { type: "integer" },
        date: { type: "string", description: "Дата в формате YYYY-MM-DD" },
      },
      required: ["employee_id", "service_id", "date"],
    },
  },
  {
    name: "create_booking",
    description:
      "Создать запись клиента на подтверждённый свободный слот. Вызывай ТОЛЬКО после того как get_available_slots показал, что слот свободен, и клиент подтвердил все данные.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "integer" },
        employee_id: { type: "integer" },
        client_name: { type: "string" },
        client_phone: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM" },
      },
      required: ["service_id", "employee_id", "client_name", "client_phone", "date", "time"],
    },
  },
  {
    name: "escalate_to_owner",
    description:
      "Передать диалог владельцу/администратору, если ситуация конфликтная, нестандартная или агент не уверен",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

// Цена и длительность могут быть диапазоном (разные мастера / разная длина волос)
function formatRange(min, max, unit) {
  if (min == null && max == null) return "—";
  if (min == null || max == null || min === max) return `${min ?? max} ${unit}`;
  return `${min}–${max} ${unit}`;
}

function formatServices(services) {
  if (!services.length) return "(ничего не найдено по запросу)";
  return services
    .map(
      (s) =>
        `- id=${s.id} | ${s.name}` +
        (s.category_name ? ` | ${s.category_name}` : "") +
        ` | ${formatRange(s.price_min, s.price_max, s.currency || "PLN")}` +
        ` | ${formatRange(s.duration_min, s.duration_max, "мин")}` +
        (s.description ? ` | ${s.description}` : "")
    )
    .join("\n");
}

// Мастера со списком id услуг, которые они делают — агенту нужно для записи
function formatEmployees(employees, services) {
  if (!employees || !employees.length) return "(мастера не заданы)";
  const nameById = {};
  for (const s of services || []) nameById[s.id] = s.name;
  return employees
    .map((e) => {
      const does = (e.service_ids || []).map((id) => nameById[id]).filter(Boolean);
      return `- id=${e.id} | ${e.name}` + (does.length ? ` | делает: ${does.join(", ")}` : " | услуги не заданы");
    })
    .join("\n");
}

function todayInfo() {
  const days = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, "0"), d = String(now.getDate()).padStart(2, "0");
  return `Сегодня ${y}-${m}-${d} (${days[now.getDay()]}). Используй это, когда клиент говорит «сегодня», «завтра», «в субботу».`;
}

function formatPhotos(photos) {
  if (!photos.length) return "(нет подходящих фото)";
  return photos
    .map((p) => `- id=${p.id} | ${p.tag_description} (услуга: ${p.service_name})`)
    .join("\n");
}

function formatFaq(faq) {
  if (!faq.length) return "(нет релевантной информации в базе знаний)";
  return faq.map((f) => `- ${f.topic}: ${f.content}`).join("\n");
}

function formatRules(rules) {
  if (!rules.length) return "(особых ограничений сейчас нет)";
  return rules.map((r) => `- [${r.rule_type}] ${r.description}`).join("\n");
}

function formatBannedWords(bannedWords) {
  if (!bannedWords || !bannedWords.trim()) return "(особых запретов нет)";
  return bannedWords
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => `- никогда не используй слово/фразу: "${w}"`)
    .join("\n");
}

function formatEmojiInstruction(emojiUsage) {
  const rules = {
    none: "Никогда не используй эмодзи в сообщениях.",
    minimal: "Используй эмодзи очень редко, максимум один на несколько сообщений, и только если это уместно — не в каждом ответе. Живые люди не ставят смайлик в конце каждой фразы.",
    moderate: "Можешь использовать эмодзи умеренно, но не превращай это в привычку через каждое предложение.",
  };
  return rules[emojiUsage] || rules.minimal;
}

function buildSystemPrompt(salon, context) {
  return `Ты администратор салона красоты "${salon.name}" в Варшаве.
Тон общения: ${salon.tone_of_voice}.
Общайся как живой человек, естественно, без канцелярита и не как бот. Пиши так, как писал бы уставший, но приветливый администратор в переписке — короткими сообщениями, без официоза.

ВАЖНО — стиль речи:
${formatEmojiInstruction(salon.emoji_usage)}
Обращайся к клиенту на «вы» — уважительно, без фамильярности.
Если клиент здоровается — поздоровайся в ответ вежливо: «Здравствуйте» или «Добрый день/вечер» по времени суток. Никогда не пиши «Привет» — это слишком фамильярно для салона.
Не пиши пустых вводных фраз без смысла и не комментируй сам себя: под запретом «Расскажу что знаю», «Классно, что решили попробовать», «С радостью помогу», «Отличный выбор!», «Хороший вопрос». Сразу давай по делу — но тепло и по-человечески, а не сухо.
Не повторяй одни и те же вводные фразы в каждом ответе подряд — это первое, что выдаёт бота.
Не ставь скобку-смайлик ")" в конце фраз — это выглядит несерьёзно.

ЕЩЁ ВАЖНЕЕ — как НЕ звучать как AI (соблюдай всегда, без исключений):
- Никаких канцелярских вводных конструкций: "Хочу отметить, что...", "Стоит упомянуть...", "Важно понимать, что...".
- Не используй пустые усилительные слова без содержания: "невероятно", "исключительно", "непревзойдённый", "уникальный", "идеальный вариант".
- Не строй одинаковые списки-триады из трёх прилагательных подряд ("быстро, качественно, надёжно") — это классический AI-паттерн.
- Не используй тире для искусственного драматического эффекта в середине фразы.
- Не заканчивай сообщения "продающими" призывами вроде "Не упустите возможность!" — ты администратор, а не рекламный баннер.
- Не будь избыточно восторженным без повода — живой человек не в восторге от каждого сообщения клиента.
- Пиши короче, чем кажется уместным. Живой администратор в переписке редко пишет длинные абзацы — чаще 1-3 коротких предложения.
- Можно писать с лёгкими бытовыми неровностями — не обязательно идеально гладкий текст, как у диктора.

ЗАПРЕЩЁННЫЕ СЛОВА И ФРАЗЫ (никогда не используй, даже если клиент сам их употребит):
${formatBannedWords(salon.banned_words)}

${todayInfo()}

РЕЛЕВАНТНЫЕ УСЛУГИ (используй только эти данные о ценах, не выдумывай):
${formatServices(context.services)}

МАСТЕРА (для записи бери employee_id отсюда; предлагай только мастера, который делает нужную услугу):
${formatEmployees(context.employees, context.services)}

ПОДХОДЯЩИЕ ФОТО ПРИМЕРОВ РАБОТ:
${formatPhotos(context.photos)}

БАЗА ЗНАНИЙ (используй только если клиент явно спрашивает по теме):
${formatFaq(context.faq)}

АКТУАЛЬНЫЕ ОГРАНИЧЕНИЯ И ИНСТРУКЦИИ ВЛАДЕЛЬЦА (приоритет выше всего остального):
${formatRules(context.rules)}

КАК ВЕСТИ ДИАЛОГ (очень важно, клиенты жалуются на навязчивость):
- Не вываливай цену, длительность и предложение записаться сразу, если клиент просто размышляет или задал общий вопрос ("думаю о кератине", "расскажите про кератин"). Ответь именно на то, что спросили, по-человечески, и можно задать один встречный вопрос. Цену называй, когда клиент про неё спросил или когда это правда уместно.
- Не поднимай сам темы, о которых не спрашивали. Особенно НИКОГДА не заговаривай про скидки, акции и их отсутствие, если клиент прямо о них не спросил.
- Не предлагай записаться в каждом сообщении. Предложи запись мягко и только один раз, когда клиент уже проявил интерес. Не дави.
- Цена на кератин зависит от волос — упомяни, что мастер сориентирует по цене на месте, но скажи это ОДИН раз за диалог, не повторяй в каждом ответе.
- Про длительность говори как ориентир ("сориентирую по времени: обычно занимает 3–5 часов"), а не как жёсткое обязательство.
- Пиши короче. Не превращай ответ в лекцию — 1–3 коротких предложения обычно достаточно.

Правила поведения:
1. Если клиент спрашивает "как будет выглядеть" — используй attach_photo с подходящим id.
2. Если клиент готов записаться — сначала уточни услугу, желаемую дату и мастера, вызови get_available_slots и предложи клиенту реально свободное время. Только после того как клиент выбрал конкретный слот и назвал имя+телефон — вызывай create_booking.
3. Если клиент недоволен, ситуация конфликтная, или ты не уверен — вызови escalate_to_owner и мягко сообщи клиенту, что уточнишь и вернёшься.
4. Никогда не выдумывай цены и услуги, которых нет в списке выше.
5. Если по запросу ничего не найдено — честно скажи, что уточнишь, и вызови escalate_to_owner.`;
}

async function getConversationHistory(db, conversationId, limit = 20) {
  const { results } = await db
    .prepare(
      "SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?"
    )
    .bind(conversationId, limit)
    .all();
  return results.map((r) => ({
    role: r.sender === "agent" ? "assistant" : "user",
    content: r.content,
  }));
}

async function saveMessage(db, conversationId, sender, content) {
  await db
    .prepare("INSERT INTO messages (conversation_id, sender, content) VALUES (?, ?, ?)")
    .bind(conversationId, sender, content)
    .run();
}

async function handleToolCall(db, toolName, toolInput, conversationId, bookingSource = "agent") {
  if (toolName === "get_available_slots") {
    const result = await getAvailableSlots(
      db,
      toolInput.employee_id,
      toolInput.service_id,
      toolInput.date
    );
    return JSON.stringify(result);
  }
  if (toolName === "create_booking") {
    const result = await createBookingSafe(db, {
      serviceId: toolInput.service_id,
      employeeId: toolInput.employee_id,
      clientName: toolInput.client_name,
      clientPhone: toolInput.client_phone,
      dateStr: toolInput.date,
      timeStr: toolInput.time,
      conversationId,
      source: bookingSource,
    });
    return result.ok
      ? `Запись успешно создана (id=${result.bookingId}).`
      : `Не удалось создать запись: ${result.error}`;
  }
  if (toolName === "escalate_to_owner") {
    await db
      .prepare("INSERT INTO escalations (conversation_id, reason) VALUES (?, ?)")
      .bind(conversationId, toolInput.reason || "не указана")
      .run();
    await db
      .prepare("UPDATE conversations SET status='escalated' WHERE id=?")
      .bind(conversationId)
      .run();
    return "Диалог отмечен для внимания владельца.";
  }
  if (toolName === "attach_photo") {
    return `[Фото id=${toolInput.photo_id} отправлено клиенту]`;
  }
  return "Неизвестный инструмент.";
}

async function callAnthropic(env, systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (status ${res.status}): ${errText}`);
  }
  return res.json();
}

export async function getAgentResponse(env, salonId, conversationId, clientMessage, opts = {}) {
  const db = env.DB;
  const bookingSource = opts.bookingSource || "agent"; // тест-чат помечает записи 'test'
  const salon = await getSalon(db, salonId);
  const context = await retrieveContext(db, salonId, clientMessage);
  const systemPrompt = buildSystemPrompt(salon, context);

  await saveMessage(db, conversationId, "client", clientMessage);
  // История — рабочий контекст модели. Инструменты и их результаты живут только здесь,
  // клиенту уходит финальный текст, а не сырой JSON, как было раньше.
  const messages = await getConversationHistory(db, conversationId);

  const attachedPhotos = [];
  let finalText = "";

  // Агентский цикл: пока модель просит инструмент — выполняем и отдаём результат обратно.
  for (let step = 0; step < 5; step++) {
    const data = await callAnthropic(env, systemPrompt, messages);

    // Собираем текст этого хода
    const stepText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (stepText) finalText = stepText;

    const toolUses = data.content.filter((b) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || !toolUses.length) break;

    // Ответ модели (с запросом инструментов) кладём в историю как есть
    messages.push({ role: "assistant", content: data.content });

    // Выполняем инструменты и возвращаем результаты одним пользовательским сообщением
    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === "attach_photo") attachedPhotos.push(tu.input.photo_id);
      const result = await handleToolCall(db, tu.name, tu.input, conversationId, bookingSource);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) finalText = "Секунду, уточню и вернусь к вам.";
  await saveMessage(db, conversationId, "agent", finalText);
  return { reply: finalText, photos: attachedPhotos };
}
