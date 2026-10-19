# MailSlurp Preview Lab

Небольшой UI для проверки HTML-писем в реальных почтовых клиентах через **MailSlurp Device Previews**.

## Возможности

- Редактирование темы и HTML-письма в браузере.
- Выбор Gmail Web, Outlook Classic/Web/New, iOS Mail, Gmail Android.
- Создание временного inbox, отправка тестового письма **самому себе** и ожидание входящего сообщения.
- Запуск асинхронного рендеринга в MailSlurp, опрос статусов по клиентам, галерея скриншотов и увеличение изображения.
- Серверный прокси скриншотов: секретный API-ключ никогда не передаётся в браузер.
- Минимальное количество зависимостей: Node.js 22+, встроенные `fetch`, HTTP-сервер и test runner.

## Быстрый старт

1. Установите **Node.js 22+** и получите API-ключ на [MailSlurp](https://www.mailslurp.com/).
2. Задайте ключ через переменную окружения. Не записывайте его в код или git.
   - Linux/macOS: `export MAILSLURP_API_KEY="..."`
   - PowerShell: `$env:MAILSLURP_API_KEY="..."`
3. Запустите `npm start`.
4. Откройте **http://127.0.0.1:3000**.
5. Выберите клиенты и нажмите **«Отправить и получить скриншоты»**.

Для разработки: `npm run dev`. Для проверки: `npm test`. Установка пакетов не требуется.

## Как работает

```text
Browser → POST /api/preview (subject, HTML, targets)
        → server: MailSlurp createInboxWithOptions
        → server: sendEmail → waitForLatestEmail
        → server: POST /emails/{emailId}/device-previews
Browser ← runId
Browser → GET /api/runs/{runId} (every 3.5 s)
        → server: GET /emails/device-previews/{runId}/results
Browser → GET /api/runs/{runId}/screenshots/{screenshotId}
        → server: authenticated MailSlurp image endpoint
```

**Важно:** Device Previews может расходовать кредиты/лимиты аккаунта MailSlurp. Никакая отправка не выполняется без нажатия кнопки. Приложение создаёт временный inbox, письмо отправляет только на него. Список доступных целей может меняться у MailSlurp — при необходимости обновите `TARGETS` в `src/server.js`.

**Безопасность MVP:** сервер по умолчанию доступен **только локально** (127.0.0.1), без учётных записей пользователей. Не выставляйте его наружу без аутентификации, rate-limiting, CSRF-защиты и контроля расходов. Тестовые прогоны и списки разрешённых скриншотов хранятся **в памяти процесса 12 часов** и сбрасываются при рестарте. Скриншоты хранятся у MailSlurp, а не на локальном сервере.

**Проверки:** `npm test` использует моки HTTP MailSlurp. Live E2E требуют действительного `MAILSLURP_API_KEY` и расходов на рендеринг, поэтому не выполняются автоматически в CI.

Документация MailSlurp: [Device Previews](https://www.mailslurp.com/docs/device-renders/) · [API reference](https://www.mailslurp.com/docs/api/).
