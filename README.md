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

## Дальше
- Подключить ManyChat External Request к этому URL (когда будет оплачен Pro-план)
- Или подключить Telegram-бота через webhook на этот же URL (бесплатно, для тестов на живых людях)
- PWA-панель для владельца будет читать/писать в ту же базу D1 через отдельные эндпоинты (добавим следующим шагом)
