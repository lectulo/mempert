# mempert / memesave-bot

Личная библиотека мемов: Telegram-бот, веб-интерфейс и Mini App, поиск и анализ через OpenRouter. Этот вариант рассчитан на **чистую self-hosted установку до 10 пользователей**, не на high-load и не на перенос существующих Cloudflare-данных.

## Архитектура и требования

- Docker Engine с Compose v2, доступ к registry и интернету для сборки/источников контента.
- Для получения сообщений ботом достаточно исходящего доступа к Telegram: по умолчанию используется long polling, публичный endpoint не нужен. Для веб-входа и внешнего скачивания signed media OpenRouter нужны достижимый публичный HTTPS-домен и reverse proxy. Встроенного обязательного TLS-сервиса нет.
- Telegram остаётся внешней интеграцией **и способом входа**. Нужен бот из @BotFather; для входа на сайт отдельно настройте Telegram Login.
- Кроме Telegram и самих источников контента, обязательный внешний backend только **OpenRouter**. Не нужны Cloudflare, Redis, Qdrant, MinIO, Vertex или captcha SaaS.
- Обычные AI-запросы к OpenRouter исходящие и не требуют входящих соединений; достижимый origin нужен для внешнего скачивания signed media (в том числе в batch), а публичный HTTPS и Telegram Login credentials — для входа на сайт.
- Bun app слушает `3000`, раздаёт собранный `app/dist`. В volume `app-data`: `/data/app.sqlite` (SQL, KV, vectors, очереди) и `/data/media` (файлы).
- `thumb` (Go/ffmpeg), `scraper` (Go/Chromium), локальный cobalt и Go workers доступны только внутри Compose. TLS заканчивается на вашем reverse proxy; наружу публикуется только app, по умолчанию `127.0.0.1:3000`.

Поиск vectors использует **линейный cosine по namespace**, без отдельного vector server. Это экономит фоновые сервисы, но время поиска зависит не только от числа пользователей, но и от размера их библиотек. Большие ZIP, видео, AI batch и Chromium могут давать пики CPU/RAM/диска. Измеренных обещаний по RAM нет: начните с небольшой библиотеки и наблюдайте `docker stats` и свободное место. По умолчанию запускаются один app, один worker каждого типа и один browser scraper; реплики app с общим SQLite не предусмотрены.

## Первый запуск

```sh
cp .env.example .env
chmod 600 .env
```

Заполните `PUBLIC_URL`, `BOT_TOKEN`, `ADMIN_ID`, `OPENROUTER_API_KEY`. По умолчанию `TELEGRAM_MODE=polling`: для локального получения сообщений допустим `PUBLIC_URL=http://localhost:3000`, а `WEBHOOK_SECRET` и `TG_CLIENT_SECRET` не нужны. Это не означает, что весь веб-интерфейс работает на localhost: Telegram web login требует публичный HTTPS URL и `TG_CLIENT_SECRET` из BotFather, а OpenRouter должен иметь доступ к signed media по настроенному `PUBLIC_URL`. Для `ENCRYPTION_KEY`, `WORKER_SECRET`, `SCRAPER_API_KEY` создайте **разные** случайные значения, например `openssl rand -hex 32`. Не публикуйте `.env`. `ENCRYPTION_KEY` шифрует пользовательские OpenRouter keys: его потеря делает сохранённые keys недоступными.

`SELF_HOSTED=true` в Compose отключает обязательность подписки/баланса для AI и billing-списания. Telegram auth, существующие роли и пользовательские OpenRouter keys сохраняются. Регистрация через Telegram остаётся открытой: «до 10 пользователей» — целевой размер, не встроенная квота или allowlist. OpenRouter всё равно платный: установите лимит расходов на стороне провайдера. `STORAGE_CHAT_ID` необязателен: при использовании укажите частный канал и сделайте бота администратором.

Проверьте подстановки и запустите:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

App при запуске применяет SQL-миграции к локальной SQLite. Пустой volume — новая установка; автоматического импорта старой БД/файлов нет. CSS и шрифты собираются локально из npm design-system и `analyze/fonts`, runtime font/CSS CDN не требуется. Telegram Mini App SDK остаётся интеграцией Telegram.

В polling приложение само снимает ранее установленный webhook (`deleteWebhook` с `drop_pending_updates:false`), синхронизирует команды и запускает цикл `getUpdates`. Отдельный setup не требуется; отправьте боту `/start`. Запускайте только один app/poller на bot token. `bun scripts/setup.ts --dry-run` в polling только локально проверяет конфигурацию; обычный setup не обращается к Telegram и сообщает, что polling управляется приложением. `--drop-pending-updates` в этом режиме запрещён.

Сборка image выполняет `bun run build`, включая `scripts/build-server.ts` с Bun-совместимым OAuth shim; runtime запускает `bun dist/server.js`, не исходный Worker entrypoint. OG PNG рендерится локально native `@resvg/resvg-js`, без Workers WASM. Внешние Cloudflare ID/keys от прежней установки не переносите; `MEDIA_URL` в Compose равен `PUBLIC_URL`.

## Публичный HTTPS и Telegram

1. Направьте домен `PUBLIC_URL` на ваш reverse proxy, выпустите TLS-сертификат.
2. Проксируйте **все пути** на `http://127.0.0.1:3000`, сохраняя Host/forwarded headers и WebSocket upgrade. Разрешите request body хотя бы 64 MiB (части ZIP — 50 MiB), начните с read/send timeout 300 секунд для загрузок и не буферизуйте live streams. Настройте idle timeout WebSocket под свою инфраструктуру. Если proxy в другом контейнере, подключите его к сети Compose и направьте на `app:3000`; не используйте его собственный `127.0.0.1`.
3. Запретите внешние `/internal/*` на proxy: это служебный dispatcher workers, дополнительно защищённый `WORKER_SECRET`. Не публикуйте порты scraper/thumb/cobalt и не давайте недоверенным контейнерам доступ к их сети.
4. В @BotFather настройте Telegram Login для вашего HTTPS origin и callback `${PUBLIC_URL}/auth/telegram/callback`, скопируйте отдельный Client Secret в `TG_CLIENT_SECRET`. Включите inline mode (`/setinline`) и при необходимости Main Mini App/menu button на `PUBLIC_URL`.

### Необязательно: общий исходящий proxy для Telegram и OpenRouter

`OUTBOUND_PROXY_URL=` (пустое значение) отключает proxy для обеих интеграций. Один proxy используется для серверных запросов к **Telegram Bot API** в polling и webhook, **Telegram Login** (token/JWKS) и **OpenRouter API** (AI, batch, обмен кода на API key и другие API-запросы). Задайте его в `.env`, например:

```dotenv
OUTBOUND_PROXY_URL=socks5://proxy.example:1080
# Или HTTP proxy с CONNECT для HTTPS-запросов:
# OUTBOUND_PROXY_URL=http://proxy.example:3128
```

Поддерживаются `http://`, `https://` (TLS-соединение с proxy) и `socks5://`. Необязательные логин/пароль указываются как `scheme://user:password@host:port`; специальные символы в логине и пароле нужно percent-encode (например, `@` → `%40`). Не публикуйте URL с credentials. После изменения пересоздайте app (`docker compose up -d app`); реальный POST из `scripts/setup.ts` использует тот же исходящий transport. Polling-информация и `--dry-run` не делают запросов и не проверяют доступность proxy.

Это **не reverse proxy**: входящий webhook по-прежнему требует публичного HTTPS endpoint. Внутренние сервисы и произвольные сайты-источники остаются direct. Браузерные переходы на Telegram/OpenRouter используют сеть браузера, а не proxy сервера. Скачивание signed media провайдером по `PUBLIC_URL` также не перенаправляется: origin должен оставаться доступным извне. В контейнере `127.0.0.1`/`localhost` означает сам контейнер app: укажите доступный из него адрес proxy, например DNS-имя сервиса в общей Docker-сети.

### Необязательно: описание фото у OpenAI-совместимого провайдера

Для обычных фото и фотоальбомов можно задать отдельную vision-модель. В `.env`:

```dotenv
PHOTO_API_BASE_URL=https://provider.example/v1
PHOTO_API_KEY=ключ_этого_провайдера
PHOTO_MODEL=gpt-6.2-sol
```

Задайте все три значения вместе. Используйте базовый URL из документации провайдера (без `/chat/completions`) и точный ID модели из его каталога. Нужна поддержка Chat Completions, `image_url` с data URL и `response_format: json_schema`. Приложение обращается к этому API отдельно от `OUTBOUND_PROXY_URL`, без инструментов веб-поиска OpenRouter. Если API не возвращает `usage.cost`, приложение сохраняет число токенов, но не знает цену вызова.

Для аккаунтов без личного OpenRouter-ключа эта модель заменяет оба уровня описания фото (`medium` и `max`); `/about` показывает активную модель. Личный OpenRouter-ключ сохраняет прежний выбор провайдера. Эмбеддинги, поиск, видео и запросы к OpenRouter Batch API по-прежнему используют OpenRouter: `OPENROUTER_API_KEY` всё ещё нужен для общего доступа. Чтобы вернуться к настройкам по умолчанию, очистите все три `PHOTO_*` значения. После обновления кода запустите `docker compose up -d --build app`; при дальнейших изменениях только `.env` достаточно `docker compose up -d app`.

#### Замер одиночных описаний: `low` и `high`

На одних и тех же 5 мемах через OpenRouter сделали 20 одиночных запросов: две модели, два явно заданных значения `reasoning.effort`, одинаковый промпт. Ниже средние **на фото**, по ответам API, без веб-поиска и эмбеддингов. Это замер конкретной выборки, не тариф или гарантия скорости.

| Модель | Effort | Всего токенов | Стоимость, USD | Время, с |
|---|---|---:|---:|---:|
| GPT-6.2 Sol | low | 3088 | 0,00944 | 9,2 |
| GPT-6.2 Sol | high | 3328 | 0,01177 | 13,6 |
| Gemini 4 Argon | low | 3278 | 0,01219 | 17,9 |
| Gemini 4 Argon | high | 4469 | 0,02410 | 36,6 |

`medium`/`max` в настройках аккаунта — выбор модели OpenRouter, а не reasoning effort. Для обычных описаний через `PHOTO_API_BASE_URL` можно отдельно задать `PHOTO_REASONING_EFFORT=low` (или `medium`, `high`, если модель поддерживает). Значение передаётся в `reasoning_effort` Chat Completions; если оно пустое, поле не отправляется и уровень выбирает провайдер. При отключении стороннего провайдера также очистите `PHOTO_REASONING_EFFORT`.

### Необязательно: параллельная обработка обычных фото

`PHOTO_WORKERS` задаёт число воркеров для независимых задач с одним фото на весь инстанс `app`. Альбомы и видео обрабатываются последовательно. Значение — целое число не меньше `1` (по умолчанию `1`). Пример для `.env`:

```dotenv
PHOTO_WORKERS=4
```

Примените настройку: `docker compose up -d app` (при обновлении кода — `docker compose up -d --build app`). При большей параллельности расходы могут расти быстрее, а лимиты запросов провайдера — достигаться чаще.

Распаковка ZIP выполняется отдельно: `PHOTO_WORKERS` не меняет её параллельность и не управляет OpenRouter Batch API. Фото из ZIP, которые направлены на обычную обработку, используют тот же общий пул воркеров.

### Отключение OpenRouter Batch API

По умолчанию пакетный режим включён. Чтобы приложение не отправляло новые запросы на пакетную обработку в OpenRouter Batch API, задайте в `.env`:

```dotenv
BATCH_ENABLED=false
```

Пересоздайте приложение: `docker compose up -d app` (при обновлении кода — `docker compose up -d --build app`). Импорт ZIP остаётся доступен на сайте и через `/batch_zip` в боте: команда выдаёт подписанную ссылку на форму загрузки в браузере. Файлы из ZIP обрабатываются и тарифицируются как обычные загрузки, без пакетной скидки. Обычная загрузка фото также продолжает работать, в том числе с `PHOTO_MODEL`. Чтобы вернуть пакетный режим, задайте `BATCH_ENABLED=true` и снова пересоздайте `app`.

**Если OpenRouter уже принял пакет:** приложение получит его результаты и завершит обработку успешно описанных фото. Новые пакеты, в том числе повторные попытки для ошибок, не отправляются.

### Необязательно: webhook вместо polling

Когда публичный HTTPS уже работает, задайте `TELEGRAM_MODE=webhook` и отдельный случайный `WEBHOOK_SECRET` в `.env`, пересоздайте app (`docker compose up -d app`), затем зарегистрируйте webhook:

```sh
docker compose exec app bun scripts/setup.ts --dry-run
docker compose exec app bun scripts/setup.ts
```

В webhook-режиме setup использует `PUBLIC_URL` (`WORKER_URL` — legacy fallback). `--dry-run` показывает план без сети; обычный запуск регистрирует webhook в Telegram, а команды синхронизирует приложение через `syncCommands` при обработке webhook. Ожидающие updates сохраняются; только явный `--drop-pending-updates` отбрасывает их. Проверить webhook можно через Telegram `getWebhookInfo` (не публикуйте URL с bot token). Одного localhost для webhook недостаточно. Для возврата к polling задайте `TELEGRAM_MODE=polling` и пересоздайте app: webhook снимется автоматически без потери ожидающих updates.

## Проверка установки

```sh
curl --fail http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --tail=100 app scraper cobalt
```

Дополнительно вручную проверьте: `/start`, Telegram web login, загрузку картинки и видео (preview), AI-анализ и поиск, импорт поддерживаемой ссылки через cobalt, экспорт/импорт ZIP, публичную share-страницу и её `og.png`. Проверьте, что CSS/fonts грузятся с вашего origin, а очереди после завершения обработки пустеют. Эта инструкция — checklist, **не утверждение о пройденном end-to-end тесте** в вашей среде.

Проверка сохранённых окончательно неуспешных задач (DLQ) без установки sqlite CLI:

```sh
docker compose exec app bun -e 'import { Database } from "bun:sqlite"; const db=new Database(process.env.DB_PATH,{readonly:true}); console.log("queue DLQ",db.query("SELECT id,queue,attempts,error FROM _runtime_queue WHERE dead=1").all()); console.log("worker failures",db.query("SELECT kind,name,state,error FROM worker_jobs WHERE state IN (?,?)").all("failed","failing"));'
```

Неуспешные записи сохраняются для диагностики; изучите `error` и логи перед повтором операции. Тяжёлые ZIP/export/analysis-задачи выполняются по одной на весь инстанс; очередь обычных фото настраивается отдельно через `PHOTO_WORKERS`.

Контракт установки — один процесс app и доставка задач **at-least-once**: при падении непосредственно после внешнего AI-запроса возможен повторный платный запрос. Неопределённый результат отправки batch помечается `failed` для ручного повтора, а не остаётся висеть; тяжёлая задача выполняется последовательно с общим лимитом четыре часа от первого claim, без продления при повторных попытках.

Cobalt использует официальный [`ghcr.io/imputnet/cobalt:11`](https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml), `API_URL=http://cobalt:9000/` и один процесс. Tunnel URL скачивает app, не браузер пользователя, поэтому DNS `cobalt` здесь корректен и публичный hostname не нужен. Порт не публикуется, API key/Turnstile по умолчанию не включены. Для воспроизводимости задайте `COBALT_IMAGE` с проверенным digest; автоматического watchtower обновления нет. Публичного fallback `api.cobalt.tools` нет: без `COBALT_URL` импорт ссылки выдаёт ошибку.

Cobalt — вспомогательная интеграция импорта ссылок: Compose запускает его вместе со stack, но app не ждёт его readiness. Если cobalt запущен, но ещё не готов или перестал отвечать, импорт ссылок может завершаться ошибкой; библиотека, Telegram-вход и работа с OpenRouter не блокируются его healthcheck.

Scraper запускает Chromium **лениво, только на challenge**, ограничивает `MAX_BROWSERS=1` и закрывает browser после обработки. NoCaptchaAI не подключён: некоторые защищённые источники могут быть недоступны. Сервисы-источники меняют API/защиту, требуют cookies или блокируют IP; отсутствие captcha SaaS не гарантирует импорт с любого сайта.

## Остановка, backup и обновления

```sh
docker compose stop
docker compose start
```

`docker compose down` также сохраняет named volumes; **не добавляйте `-v`**, если не хотите удалить библиотеку. Для согласованного backup остановите **весь stack**, включая workers и включённый TikTok, и скопируйте volume целиком вместе с SQLite WAL/SHM и media. Не копируйте только активный `app.sqlite`.

Пример offline backup в каталог внутри репозитория:

```sh
mkdir -p backups
docker compose stop
docker compose run --rm --no-deps --user root --entrypoint tar -v ./backups:/backup app -czf /backup/app-data.tar.gz -C /data .
docker compose start
```

Храните backup и `.env` (особенно `ENCRYPTION_KEY`) безопасно, с копией вне сервера. `app-data.tar.gz` содержит личные данные/медиа/токены. При TikTok отдельно сохраните `tiktok-data` с сессией и state. Перед обновлением сделайте backup, затем `docker compose pull cobalt` и `docker compose up -d --build`. Откат бинарника не откатывает миграции: для полного rollback восстановите весь согласованный backup и прежнюю версию приложения. Проверяйте восстановление на отдельной тестовой установке.

## TikTok: необязательный тяжёлый профиль

По умолчанию `tiktok` **не запускается**. После входа создайте write API token в Account → Settings и задайте `TIKTOK_API_TOKEN` в `.env`. Затем выполните интерактивный QR login:

```sh
docker compose --profile tiktok run --rm tiktok login
docker compose --profile tiktok up -d tiktok
```

Профиль хранит browser session в отдельном `tiktok-data`. Chromium работает постоянно только при включении этого профиля; без него нет отдельного фонового browser TikTok. Интервал по умолчанию 1800 секунд, downloader — один поток. CAPTCHA SaaS key не задаётся; если TikTok требует неразрешимый challenge, вход/импорт может не сработать. Для отключения: `docker compose --profile tiktok stop tiktok`. При backup/полной остановке включённого профиля используйте `docker compose --profile tiktok stop`.

## API

HTTP API: `<PUBLIC_URL>/app/api/*`, `Authorization: Bearer <token>` (Account → Settings → API tokens); описание `<PUBLIC_URL>/openapi.json`. MCP: `<PUBLIC_URL>/mcp`, OAuth через Telegram, подключения управляются в Account → Settings.

MCP OAuth поддерживает Dynamic Client Registration (DCR). Client ID Metadata Documents (CIMD) в этой установке не поддерживаются: используйте клиент с DCR.

## Локальные проверки разработки

```sh
bun install --frozen-lockfile
bun deployment/prepare-assets.ts
bun run build
bun run test:runtime
bun run test:oauth
bun run typecheck
```

`test:runtime` — проверки текущего Bun server/SQLite runtime. `test:cloudflare` — отдельные legacy Cloudflare-тесты, не проверка Compose/Bun deployment. Для проверок нативного OG renderer используйте `deployment/check-og.ts` с тем же OAuth shim при bundle, что и `scripts/build-server.ts`; `deployment/check-http.ts` проверяет уже запущенный изолированный инстанс (`SMOKE_ORIGIN`, по умолчанию `http://127.0.0.1:13971`). Не запускайте smoke fixtures на пользовательской библиотеке.
