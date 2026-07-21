# Salon AI Agent — деплой на Cloudflare

## Шаг 1 — установить Wrangler (CLI Cloudflare)
```
npm install -g wrangler
wrangler login
```

## Шаг 2 — создать базу D1
```
wrangler d1 create salon-agent-db
```
Скопируй `database_id` из вывода команды и вставь в `wrangler.toml` вместо `PASTE_YOUR_D1_DATABASE_ID_HERE`.

## Шаг 3 — залить схему и тестовые данные
```
wrangler d1 execute salon-agent-db --file=./schema.sql
wrangler d1 execute salon-agent-db --file=./seed.sql
```

## Шаг 4 — добавить секретный ключ Anthropic и токен доступа к панели
```
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_TOKEN
```
`ADMIN_TOKEN` придумай сам (любая длинная случайная строка) — этим же значением заполни `ADMIN_TOKEN` в `pwa/index.html`. Это защищает панель управления и API от посторонних — без токена никто не сможет менять твои услуги/цены/правила, даже зная адрес Worker'а.

## Шаг 5 — деплой
```
wrangler deploy
```
Получишь URL вида `https://salon-agent.<твой-акк>.workers.dev` — это и есть точка входа для ManyChat/Telegram.

## Как проверить, что работает
```
curl -X POST https://salon-agent.<твой-акк>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "test123", "message": "Сколько стоит наращивание?"}'
```

## Шаг 6 — подключить ManyChat (Instagram)

Отдельного кода-адаптера не нужно: в ManyChat блок **External Request** сам
позволяет задать тело запроса вручную — просто настрой его так, чтобы оно
совпадало с форматом, который ждёт наш Worker (`{ "channel_id": ..., "message": ... }`).

1. В ManyChat перейди в Automation → добавь блок **External Request** на flow,
   который срабатывает на входящее сообщение в Instagram Direct.
2. Настройки блока:
   - **Method**: `POST`
   - **URL**: `https://salon-agent.<твой-акк>.workers.dev` (без `/api` и `/public`)
   - **Headers**: `Content-Type: application/json`
   - **Body** (raw JSON) — используй системные переменные ManyChat:
     ```json
     {
       "channel_id": "{{ig_username}}",
       "message": "{{last_input_text}}"
     }
     ```
     Если `{{ig_username}}` недоступен в твоём плане — подойдёт `{{user_id}}` или
     `{{ig_id}}`, главное чтобы это был стабильный уникальный идентификатор
     клиента (одно и то же значение при каждом его сообщении).
3. Ответ Worker'а придёт как `{ "reply": "текст ответа агента" }`. Добавь после
   External Request блок **Set User Field** или сразу **Send Message**,
   подставив туда `{{external_request.reply}}` (имя переменной зависит от того,
   как ты назвал шаг External Request в ManyChat).
4. Проверь на живом Instagram-аккаунте, привязанном к ManyChat, прежде чем
   оплачивать Pro-план — на Free-плане External Request тоже доступен для теста
   с ограничениями.

## Шаг 7 — задеплоить фронтенды (PWA и сайт бронирования)

`pwa/` и `booking-site/` — статические файлы, деплой через **Cloudflare Pages**:
```
wrangler pages deploy pwa --project-name=hairclub-admin
wrangler pages deploy booking-site --project-name=hairclub-booking
```
После первого деплоя пропиши в `pwa/index.html` и `booking-site/index.html`
реальные `API_BASE`/`ADMIN_TOKEN` (сейчас там заглушки `YOUR-SUBDOMAIN` и
`PASTE_YOUR_ADMIN_TOKEN_HERE`) и передеплой.

## Альтернатива на старте — Telegram вместо Instagram

Пока Instagram/ManyChat не подключены, можно проверить агента через
Telegram-бота (создаётся бесплатно за минуту через @BotFather) — воркер уже
принимает тот же формат `{channel_id, message}`, нужен только тонкий Telegram
webhook-переходник (Telegram присылает свой формат `{message: {chat: {id}, text}}`,
его придётся привести к нашему на входе) — если понадобится, это отдельная
небольшая задача.
