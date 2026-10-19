# MailSlurp Preview Lab (.NET)

Веб-приложение для отправки HTML-письма в тестовый inbox и просмотра скриншотов Gmail, Outlook, Apple Mail и других клиентов, созданных через [MailSlurp Device Previews](https://www.mailslurp.com/docs/device-renders/).

**Стек:** ASP.NET Core / C# / .NET 10, статические HTML/CSS и браузерный JavaScript. **Node.js, npm и внешние NuGet-зависимости не нужны.** Вся обработка секретного API-ключа и вызовов MailSlurp выполняется серверным .NET.

## Быстрый запуск

Нужен **.NET 10 SDK** и действующий MailSlurp API-ключ.

PowerShell:

```powershell
git clone https://github.com/avsevolodov/mailslurp.git
cd mailslurp
git checkout feat/email-device-previews-ui
$env:MAILSLURP_API_KEY = "your-api-key"
dotnet run --project src/PreviewLab/PreviewLab.csproj
```

Открыть **http://127.0.0.1:3000**. По умолчанию слушается только loopback. Можно изменить `PREVIEWLAB_URL` (публикация вне localhost требует аутентификации и ограничения расходов).

## Что делает приложение

1. Пользователь вводит тему и HTML в редакторе и выбирает почтовые клиенты.
2. `POST /api/preview` создаёт временный MailSlurp inbox (5 минут), отправляет письмо на этот адрес и ждёт получения.
3. Запускает рендеринг `POST /emails/{emailId}/device-previews` по выбранным `targets`.
4. Возвращает `runId` из ответа `run.runId`; UI опрашивает `GET /api/runs/{runId}`.
5. Backend проксирует изображения из `GET /emails/device-previews/{runId}/screenshots/{screenshotId}/image` по пути `/api/runs/{runId}/screenshots/{screenshotId}`. Браузер **не знает** ключ MailSlurp.

Для ознакомления со списком target IDs смотрите [официальный каталог](https://www.mailslurp.com/docs/device-renders/#choose-native-device-targets). Текущая версия интерфейса предлагает шесть популярных целей.

## Проверка

```shell
dotnet build src/PreviewLab/PreviewLab.csproj -c Release
dotnet run --project tests/PreviewLab.Tests/PreviewLab.Tests.csproj -c Release
```

Тесты не требуют MailSlurp: используются фиктивные HTTP-ответы и проверяются контракт отправки, безопасность прокси, нормализация скриншотов и обработка ошибок. CI выполняет эти проверки на .NET 10. Real E2E не включены, потому что требуют реального ключа и списания кредитов.

## Ограничения безопасности MVP

- Приложение **локальное**, без пользователей и SSO. Не публикуйте его на доступном извне адресе.
- API-ключ хранится в переменной окружения `MAILSLURP_API_KEY`, не в JavaScript.
- Проверяется origin браузера, содержимое запроса, максимальное число клиентов (6) и число одновременных запусков (2).
- Сервер разрешает скачивать только скриншоты подтверждённых ему результатов. Идентификаторы прогонов хранятся в памяти до 12 часов; при перезапуске список обнуляется.
- Устройство может тратить платные кредиты MailSlurp. Запуски инициируются явным нажатием кнопки.

> Дополнение: браузерный `app.js` — обычный JavaScript. Его исполняет браузер; Node.js для запуска приложения не используется.
