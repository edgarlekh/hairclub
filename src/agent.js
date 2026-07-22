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

function formatServices(services) {
  if (!services.length) return "(ничего не найдено по запросу)";
  return services
    .map(
      (s) =>
        `- id=${s.id} | ${s.name} | ${s.price_min}-${s.price_max} ${s.currency || "PLN"} | ${s.duration_minutes} мин | ${s.description}`
    )
    .join("\n");
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
Не начинай каждое сообщение с приветствия, если это продолжение диалога, а не первое сообщение.
Не повторяй одни и те же вводные фразы ("Конечно!", "Отлично!", "С радостью!") в каждом ответе подряд — это первое, что выдаёт бота.

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

РЕЛЕВАНТНЫЕ УСЛУГИ (используй только эти данные о ценах, не выдумывай):
${formatServices(context.services)}

ПОДХОДЯЩИЕ ФОТО ПРИМЕРОВ РАБОТ:
${formatPhotos(context.photos)}

БАЗА ЗНАНИЙ (используй только если клиент явно спрашивает по теме):
${formatFaq(context.faq)}

АКТУАЛЬНЫЕ ОГРАНИЧЕНИЯ И ИНСТРУКЦИИ ВЛАДЕЛЬЦА (приоритет выше всего остального):
${formatRules(context.rules)}

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

async function handleToolCall(db, toolName, toolInput, conversationId) {
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

export async function getAgentResponse(env, salonId, conversationId, clientMessage) {
  const db = env.DB;
  const salon = await getSalon(db, salonId);
  const context = await retrieveContext(db, salonId, clientMessage);
  const systemPrompt = buildSystemPrompt(salon, context);

  await saveMessage(db, conversationId, "client", clientMessage);
  const history = await getConversationHistory(db, conversationId);

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
      messages: history,
      tools: TOOLS,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (status ${res.status}): ${errText}`);
  }

  const data = await res.json();
  let finalText = "";
  for (const block of data.content) {
    if (block.type === "text") {
      finalText += block.text;
    } else if (block.type === "tool_use") {
      const toolResult = await handleToolCall(db, block.name, block.input, conversationId);
      finalText += `\n\n[Действие выполнено: ${toolResult}]`;
    }
  }

  await saveMessage(db, conversationId, "agent", finalText);
  return finalText;
}
