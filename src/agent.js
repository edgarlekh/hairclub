/**
 * Ядро AI-агента для Cloudflare Worker.
 * Ключ ANTHROPIC_API_KEY хранится в Secrets Worker'а — никогда в коде.
 */
import { retrieveContext, getSalon } from "./retrieval.js";
import { getAvailableSlots, createBookingSafe } from "./booking-slots.js";

// Клиентский диалог — на флагманском Opus (максимум качества, «премиум-админ»).
const MODEL = "claude-opus-5";
// Чтение скриншотов — фоновая задача, разницы клиент не видит: держим на дешёвом Sonnet.
const VISION_MODEL = "claude-sonnet-5";

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
      "Передать диалог владельцу/администратору, если ситуация конфликтная или нестандартная (жалоба, спор, особый случай)",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "ask_owner",
    description:
      "ОБЯЗАТЕЛЬНО вызывай, если не знаешь точный ответ на вопрос клиента и его нет в данных салона (услуги, анкета, уроки, скриншоты). Не выдумывай и не пиши клиенту «уточню у мастера» — просто задай вопрос владелице через этот инструмент. Клиенту в этот момент по сути не отвечай, ответ придёт от владелицы.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "Что именно нужно узнать у владелицы, чтобы ответить клиенту" } },
      required: ["question"],
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
  // Салон в Варшаве. Worker живёт в UTC, поэтому местные дату/час берём для Europe/Warsaw,
  // иначе бот здоровается «добрый день» вечером и путает «сегодня/завтра».
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const wd = { Monday: "понедельник", Tuesday: "вторник", Wednesday: "среда", Thursday: "четверг", Friday: "пятница", Saturday: "суббота", Sunday: "воскресенье" }[parts.weekday] || "";

  let partOfDay;
  if (hour >= 5 && hour < 12) partOfDay = "«Доброе утро»";
  else if (hour >= 12 && hour < 17) partOfDay = "«Добрый день»";
  else if (hour >= 17 && hour < 23) partOfDay = "«Добрый вечер»";
  else partOfDay = "«Добрый вечер»/«Здравствуйте»";

  return `Сейчас в Варшаве ${date} (${wd}), время ${parts.hour}:${parts.minute}. Используй это для «сегодня/завтра/в субботу». Если здороваешься — можно просто «Здравствуйте», оно уместно в любое время. Если хочешь по времени суток — сейчас это ${partOfDay}; главное не перепутать (не «добрый день» вечером). Безопаснее всего «Здравствуйте».`;
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

function formatSurvey(survey) {
  if (!survey || !survey.length) return "(анкета салона пока не заполнена)";
  return survey.map((s) => `• ${s.label}\n  ${String(s.answer).replace(/\n/g, "\n  ")}`).join("\n");
}

function formatScreenshots(shots) {
  if (!shots || !shots.length) return "(скриншотов пока нет)";
  return shots.map((t, i) => `— Скриншот ${i + 1}:\n${t}`).join("\n\n");
}

function formatKnowledge(items) {
  if (!items || !items.length) return "(пока пусто)";
  return items.map((t) => `• ${t}`).join("\n");
}

function formatLessons(lessons) {
  if (!lessons || !lessons.length) return "(пока нет)";
  return lessons
    .map((l) => {
      if (l.kind === "good") {
        return `✓ ХОРОШИЙ ПРИМЕР.${l.situation ? ` Клиент: ${l.situation}.` : ""} Так и отвечай: ${l.right_way || l.note || ""}`.trim();
      }
      // поправка: как НЕ надо и как правильно
      let t = `⚠ ПОПРАВКА.${l.situation ? ` Ситуация: ${l.situation}.` : ""}`;
      if (l.wrong_reply) t += ` НЕ отвечай так: «${l.wrong_reply}».`;
      if (l.right_way) t += ` Правильно: ${l.right_way}`;
      if (l.note) t += ` (${l.note})`;
      return t.trim();
    })
    .join("\n");
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
  // Промпт разбит на две части ради prompt-caching: STABLE — большой неизменный
  // блок (правила, анкета, уроки, база знаний), он кэшируется и повторный вход
  // дешевеет ~в 10 раз; DYNAMIC — то, что меняется от сообщения к сообщению
  // (сегодняшняя дата, услуги/фото/FAQ по запросу) — идёт ПОСЛЕ точки кэша.
  const stable = `Ты администратор салона красоты "${salon.name}" в Варшаве.
Тон общения: ${salon.tone_of_voice}.
Общайся как живой человек, естественно, без канцелярита и не как бот. Пиши так, как писал бы уставший, но приветливый администратор в переписке — короткими сообщениями, без официоза.

ЯЗЫК И ПЕРЕВОД — критически важно для качества:
- Отвечай на том языке, на котором написал клиент: польский, русский, украинский, английский — на каком написал, на таком и отвечай. Сам язык не меняй.
- Твои знания, примеры переписок и ответы из анкеты часто на польском. НИКОГДА не переводи их дословно, слово в слово — это звучит как плохой машинный перевод. Пойми СМЫСЛ и передай его естественно, живым языком клиента, как говорил бы носитель.
- Примеры правильного перевода на русский: польское «koszt założenia / założenie» — это «работа мастера по наращиванию» или просто «работа», а НЕ «установка» и не «стоимость установки»; «zabieg» — «процедура»; «przedłużanie włosów» — «наращивание волос».
- Если не уверен(а), как естественно сказать по-русски или по-украински — скажи проще, короче, своими словами, сохранив смысл. Лучше просто и понятно, чем дословно и коряво.

ВАЖНО — стиль речи:
${formatEmojiInstruction(salon.emoji_usage)}
Обращайся к клиенту на «вы» — уважительно, без фамильярности.
ПРИВЕТСТВИЕ — в САМОМ ПЕРВОМ своём ответе в переписке здоровайся ВСЕГДА, даже если клиент сам не поздоровался (мог просто сразу задать вопрос — это нормально, но салон вежливый и здоровается первым). Здоровайся на ЯЗЫКЕ КЛИЕНТА и уважительно: русский — «Здравствуйте» (никогда не «Привет» — фамильярно), польский — «Dzień dobry», украинский — «Доброго дня», английский — «Hello». НИКОГДА не смешивай языки в одном сообщении (не «Здравствуйте. Yes, we do…»). В этом же первом ответе и поздоровайся, и ответь по сути. НО дальше — если ты в этом диалоге уже писал(а) хоть раз, больше НЕ здоровайся, даже если клиент снова написал «привет». Повторное «Здравствуйте» посреди переписки сразу выдаёт бота.
Не комментируй сам себя и не проговаривай, что ты сейчас сделаешь. Под запретом любые обороты вида «расскажу», «подскажу», «поясню», «сейчас объясню», «вижу ваше сообщение», «вижу ваш вопрос», «Расскажу что знаю» — особенно нелепо в конце фразы («Что вас интересует — расскажу»). Просто задай вопрос или дай ответ напрямую.
НИКОГДА не отписывайся в духе «я уточню и напишу вам», «как только уточню — сразу напишу», «уточню у мастера и вернусь» — это звучит так, будто ты бросаешь клиента и заканчиваешь разговор. Если не знаешь точную цену или деталь — не убегай: либо ответь тем, что знаешь, либо задай уточняющий вопрос (например про длину/густоту волос), либо честно скажи, что окончательную цену мастер назовёт на месте, глядя на волосы — но продолжай разговор, а не сворачивай его.
Так же под запретом пустые вводные без смысла: «Классно, что решили попробовать», «С радостью помогу», «Отличный выбор!», «Хороший вопрос». Сразу по делу — но тепло, а не сухо.
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

МАСТЕРА (для записи бери employee_id отсюда; предлагай только мастера, который делает нужную услугу):
${formatEmployees(context.employees, context.services)}

АКТУАЛЬНЫЕ ОГРАНИЧЕНИЯ И ИНСТРУКЦИИ ВЛАДЕЛЬЦА (приоритет выше всего остального):
${formatRules(context.rules)}

ЧТО РАССКАЗАЛА ВЛАДЕЛИЦА О САЛОНЕ (её ответы из анкеты — опирайся на них как на правду; если тут есть ответ, отвечай так, а не выдумывай):
${formatSurvey(context.survey)}

УРОКИ ОТ ВЛАДЕЛИЦЫ (живые примеры и поправки — это важнее общих правил, соблюдай их точно):
${formatLessons(context.lessons)}

ПРИМЕРЫ ПЕРЕПИСОК СО СКРИНШОТОВ (владелица приложила реальные переписки; учись у них ТОЛЬКО стилю — как она общается, как отвечает, как мягко ведёт к записи. Цены и конкретные суммы отсюда клиенту НЕ называй — они устарели):
${formatScreenshots(context.screenshots)}

БАЗА ЗНАНИЙ САЛОНА (проверенные общие факты, извлечённые из реальных переписок — опирайся на них как на правду; здесь намеренно нет цен, цену всегда уточняй у владелицы через ask_owner):
${formatKnowledge(context.knowledge)}

КАК ВЕСТИ ДИАЛОГ (очень важно, клиенты жалуются на навязчивость):
- Реагируй на то, что человек реально написал, а не на то, что он «наверное хочет». Веди живой диалог, как администратор в переписке, а не выдавай справку.
- Если клиент только обмолвился ("первый раз задумалась о кератине", "думаю про наращивание") — НЕ объясняй, что это за услуга, НЕ рассказывай про эффект и НЕ предлагай "сориентировать" по цене. Он об этом не просил. Ответь коротко и тепло и задай открытый вопрос: что именно ему интересно или что хочет узнать. Пусть клиент ведёт.
- Когда задаёшь такой открытый вопрос — не навязывай варианты, а если приводишь, то уместные для новичка. Человеку, который только задумался, интересны эффект, как проходит процедура, сколько держится — но НЕ уход после и НЕ противопоказания (про это рано, он ещё даже не решился). Лучше просто спроси «что именно интересно?» без списка.
- Ничего не объясняй и не рассказывай, пока не спросили. Про эффект, длительность, цену, уход — говори только когда клиент задал такой вопрос.
- Не предлагай "сориентировать по цене", если клиент не спрашивал про цену. Не придумывай клиенту потребность.
- Цену, длительность и предложение записаться не вываливай на общий/размышляющий вопрос. Отвечай ровно на то, что спросили.
- Не поднимай сам темы, о которых не спрашивали. Особенно НИКОГДА не заговаривай про скидки, акции и их отсутствие, если клиент прямо о них не спросил.
- Не предлагай записаться в каждом сообщении. Предложи запись мягко и только один раз, когда клиент уже проявил интерес. Не дави.
- ЦЕНЫ — КРИТИЧЕСКИ ВАЖНО. Называй клиенту конкретную сумму ТОЛЬКО если она явно указана в данных от владелицы выше (анкета / одобренный прайс). Есть там цена на нужную услугу — назови её спокойно и по делу. Если цены в анкете НЕТ — НЕ выдумывай и НЕ бери числа из списка услуг, скриншотов или старых переписок (они устарели, брать оттуда нельзя): ответь коротко, что цена зависит от длины и густоты волос (для наращивания — ещё и от количества волос), и спроси, какие у клиента волосы. Точную сумму тогда назовёт мастер. Если клиент настаивает на цифре, а её нет в анкете — вызови ask_owner.
- Про то, что точную цену назовёт мастер, упоминай ОДИН раз за диалог, не повторяй в каждом ответе.
- ТЕРМИНОЛОГИЯ. Услуга называется «наращивание волос» / «наращивание». Работу мастера называй «работа по наращиванию» или «работа мастера». НИКОГДА не пиши «установка», «установить волосы», «стоимость установки» — по-русски это звучит абсурдно (волосы не устанавливают). Польское «założenie/zakładanie» переводи как «наращивание»/«работа мастера», а не «установка».
- Про длительность говори как ориентир ("сориентирую по времени: обычно занимает 3–5 часов"), а не как жёсткое обязательство.
- Пиши короче. Не превращай ответ в лекцию — 1–3 коротких предложения обычно достаточно.

ОСНОВА ХОРОШЕГО АДМИНИСТРАТОРА (соблюдай всегда):
- Сначала диагностика, потом ответ. Прежде чем что-то советовать или ориентировать — пойми, о чём речь: спроси про волосы (длина, густота, состояние, желаемый результат). Не отвечай вслепую.
- Консультация — твой главный инструмент. Для наращивания и сложных случаев (блонд, сильно повреждённые волосы) мягко предложи бесплатную консультацию: онлайн по фото (попроси фото волос при дневном свете — сзади, сбоку, спереди — и фото желаемого результата) или очно в салоне. Так подберём точнее.
- Приватность — строго. НИКОГДА не рассказывай про других клиентов: кто и на когда записан, чужие имена, телефоны, историю. На вопросы вроде «а кто у вас записан», «дайте телефон мастера» — вежливо не раскрывай. Также не давай клиенту внутренние контакты салона (личный телеграм или номер владелицы, даже если они встречаются в данных выше) — для передачи диалога человеку используй инструмент escalate_to_owner, а не отправляй клиента писать куда-то. На вопрос «как связаться напрямую / есть ли телеграм» — просто ответь, что удобнее всего писать сюда, в директ салона (не эскалируй это и личных контактов не давай).
- Услуги, которых нет. Если спрашивают про услугу, которой нет в списке услуг салона — честно и коротко скажи, что её не делаем. Не выдумывай и не обещай того, чего салон не оказывает.
- Никаких обещаний-гарантий. Не обещай «стопроцентный результат» или что клиент точно останется доволен — результат зависит от исходного состояния волос. Про скидки и акции сам не заговаривай (их нет).
- Обучение и курсы (szkolenia, обучение наращиванию) — НЕ рассказывай про них сам и не отвечай по сути. Скажи коротко, что по обучению с клиентом свяжутся отдельно, и вызови escalate_to_owner: это ведёт владелица лично.
- Факты о салоне (адрес, часы работы, способы оплаты, правила отмены и предоплаты) бери ТОЛЬКО из анкеты владелицы выше. Не выдумывай. Адрес у салона ОДИН. Если нужного факта нет — вызови ask_owner, не сочиняй.
- Подтверждение записи. Когда запись создана — коротко и ясно подтверди клиенту: услуга, дата и время, мастер, адрес салона. Если по услуге есть памятка перед процедурой (в анкете/уроках) — приложи её.
- Держи единую картину и не противоречь себе внутри диалога: не переспрашивай то, что клиент уже сказал, и не давай двух разных ответов на один вопрос.

ГЛАВНОЕ ПРАВИЛО ТОЧНОСТИ (важнее всего): никогда не выдумывай факты, цены, детали, которых нет в данных выше (услуги, анкета, уроки, база знаний, скриншоты). СНАЧАЛА посмотри, есть ли ответ в этих данных — если есть (например про беременность, уход, сколько держится, как проходит процедура), отвечай сам, это твоя работа. ask_owner нужен ТОЛЬКО когда ответа реально нигде нет в данных, и это не общий вопрос, а именно то, чего салон тебе не сообщал. Не эскалируй по мелочам и по тому, что уже есть в базе. Если ты чего-то НЕ знаешь точно и в данных этого нет — НЕ придумывай и НЕ пиши клиенту «уточню у мастера» / «я уточню и напишу», а вызови ask_owner. Клиенту в этот момент по сути не отвечай — просто вызови инструмент. Владелица ответит, её ответ уйдёт клиенту, и ты запомнишь его на будущее. Лучше спросить, чем ошибиться.

Правила поведения:
1. Если клиент спрашивает "как будет выглядеть" — используй attach_photo с подходящим id.
2. Если клиент готов записаться — сначала уточни услугу, желаемую дату и мастера, вызови get_available_slots и предложи клиенту реально свободное время. Только после того как клиент выбрал конкретный слот и назвал имя+телефон — вызывай create_booking.
3. Если ситуация конфликтная (жалоба, спор, недовольство) — вызови escalate_to_owner.
4. Никогда не выдумывай цены и услуги, которых нет в списке выше.
5. Если не знаешь ответа на вопрос клиента — вызови ask_owner (не выдумывай и не пиши «уточню»).`;

  // Изменчивая часть — идёт ПОСЛЕ точки кэша, кэш из-за неё не сбрасывается.
  const dynamic = `${todayInfo()}

УСЛУГИ САЛОНА (это список того, что салон делает — чтобы понимать услуги и подобрать нужную. Цены из этого списка клиенту НЕ называй, они могут быть неактуальны — по цене действуй по правилу «ЦЕНЫ» выше):
${formatServices(context.services)}

ПОДХОДЯЩИЕ ФОТО ПРИМЕРОВ РАБОТ:
${formatPhotos(context.photos)}

БАЗА ЗНАНИЙ ПО ЗАПРОСУ (используй только если клиент явно спрашивает по теме):
${formatFaq(context.faq)}`;

  return { stable, dynamic };
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

async function handleToolCall(db, toolName, toolInput, conversationId, bookingSource = "agent", clientMessage = "") {
  if (toolName === "ask_owner") {
    // Не знает ответ — кладём вопрос владелице; клиенту сейчас не отвечаем
    const conv = await db.prepare("SELECT client_channel_id FROM conversations WHERE id=?").bind(conversationId).first();
    await db
      .prepare("INSERT INTO pending_questions (salon_id, conversation_id, client_channel_id, client_question, bot_question) VALUES (1, ?, ?, ?, ?)")
      .bind(conversationId, conv?.client_channel_id || null, clientMessage || null, toolInput.question || null)
      .run();
    return "__ASK_OWNER__";
  }
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

// Читаем скриншот (переписку или прайс) и вытаскиваем текст — им учится бот.
// Vision понимает jpeg/png/webp/gif; HEIC не поддерживается, такие пропускаем.
export async function transcribeImage(env, bytes, mediaType) {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mediaType)) return null;

  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const base64 = btoa(binary);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 900,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Это скриншот из работы салона красоты — переписка с клиентом или прайс. Выпиши всё содержимое текстом: если переписка — реплики клиента и администратора по порядку, помечая кто есть кто; если прайс — услуги и цены. Только извлечённый текст, без своих комментариев. Сохрани исходный язык." },
        ],
      }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.content?.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || null;
}

async function callAnthropic(env, systemPrompt, messages) {
  // systemPrompt = { stable, dynamic }. Кэшируем большой неизменный блок:
  // cache_control на нём — повторные запросы читают его из кэша (~0.1× цены),
  // а изменчивый блок (дата/услуги/фото) идёт после и обрабатывается заново.
  const system = [
    { type: "text", text: systemPrompt.stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: systemPrompt.dynamic },
  ];
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
      system,
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
  let waitingForOwner = false;

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
      const result = await handleToolCall(db, tu.name, tu.input, conversationId, bookingSource, clientMessage);
      if (result === "__ASK_OWNER__") waitingForOwner = true;
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Бот не знает — спросил владелицу. Клиенту сейчас ничего не отправляем,
  // ответ придёт, когда владелица напишет его в разделе «Бот спрашивает».
  if (waitingForOwner) {
    return { reply: null, pending: true, photos: attachedPhotos };
  }

  if (!finalText) finalText = "Секунду, я на связи.";
  await saveMessage(db, conversationId, "agent", finalText);
  return { reply: finalText, photos: attachedPhotos };
}
