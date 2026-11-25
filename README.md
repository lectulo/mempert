# mempert / memesave-bot

Личная библиотека мемов на своём сервере. Сохраняйте мемы через Telegram-бота и находите их по описанию в веб-интерфейсе или Telegram Mini App. Описания составляет ИИ.

## Быстрый запуск

Нужны Docker и Docker Compose v2. В каталоге проекта скопируйте [шаблон настроек](.env.example):

```sh
cp .env.example .env
chmod 600 .env
```

Укажите в `.env`:

- `BOT_TOKEN` — токен бота из @BotFather; `ADMIN_ID` — ваш числовой ID в Telegram.
- `PUBLIC_URL` — адрес приложения без пути. Если нужен только бот, оставьте `http://localhost:3000`: по умолчанию бот работает в режиме polling и не требует публичного адреса.
- `ENCRYPTION_KEY`, `WORKER_SECRET`, `SCRAPER_API_KEY` — три разных секрета. Для каждого отдельно выполните `openssl rand -hex 32`. Не публикуйте `.env`; сохраните `ENCRYPTION_KEY` вместе с резервной копией.

Для входа на сайт задайте публичный HTTPS-адрес в `PUBLIC_URL`. Настройте обратный прокси с поддержкой WebSocket на `http://127.0.0.1:3000` и закройте внешний доступ к `/internal/`. В @BotFather настройте Telegram Login с адресом возврата `${PUBLIC_URL}/auth/telegram/callback` и запишите Client Secret в `TG_CLIENT_SECRET`.

```sh
docker compose up -d --build
```

Отправьте боту `/start`. Для работы ИИ войдите на сайт под аккаунтом с `ADMIN_ID` и сохраните ключ OpenRouter в **Аккаунт → Админ → Настройки ИИ → Провайдеры и ключи API**, не в `.env`.

Для подписанных ссылок на отдельном домене см. [настройку медиа-прокси в nginx](docs/media-origin.md).

## Управление

- Статус: `docker compose ps`.
- Логи: `docker compose logs --tail=100 -f app`.
- Остановка без удаления данных: `docker compose stop`.
- Обновление: сохраните резервную копию, получите новую версию кода и снова выполните `docker compose up -d --build`. Для обновления образа [cobalt](https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml) перед сборкой выполните `docker compose pull cobalt`.

[Лицензия](LICENSE)
