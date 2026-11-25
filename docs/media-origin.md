# Отдельный домен для медиа

`MEDIA_URL` можно оставить пустым: тогда используется `PUBLIC_URL`. Для отдельного домена задайте в `.env`, например, `PUBLIC_URL=https://panel.example.com` (существующая панель) и `MEDIA_URL=https://media.example.com` (публичный адрес подписанных ссылок). Для `MEDIA_URL` нужен достижимый извне HTTPS origin с действительным TLS-сертификатом, без логина, пароля, пути, query или fragment. Приложение отклоняет явно локальные имена и частные IP-адреса, но не проверяет доступность домена извне. Вход через Telegram, Mini App и webhook по-прежнему используют `PUBLIC_URL`.

При обновлении до версии с новыми inline-медиа пересоберите **оба** сервиса: `docker compose up -d --build app thumb`. Новый `app` использует обработчик конвертации JPEG из нового `thumb`. Если код уже обновлён и меняется только `MEDIA_URL` в `.env`, достаточно пересоздать `app` без сборки: `docker compose up -d --no-deps --force-recreate app`.

В этом примере `media.example.com` — отдельный HTTPS virtual host nginx, а его upstream — существующая публичная панель `https://panel.example.com`. nginx обращается к ней напрямую по HTTPS, без туннеля и без публикации порта Bun. Укажите реальный домен панели (не домен медиа), который с хоста nginx доступен по DNS и HTTPS и обслуживает `/media/` без редиректа или интерактивного входа. Замените пути к сертификату медиа-домена и к доверенному набору CA на пути в вашей системе.

```nginx
server {
    listen 443 ssl;
    server_name media.example.com;
    ssl_certificate /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;
    access_log off;
    error_log /dev/null;

    location = /media { return 404; }
    location ^~ /media/ {
        if ($request_method !~ "^(GET|HEAD)$") { return 404; }
        # Match the original path and the exact query shape emitted by the app.
        if ($request_uri !~ "^/media/[A-Za-z0-9_-]{1,64}[.](?:(?:file[.](?:jpg|png|webp|heic|gif|mp4|mov|webm|mp3|m4a|ogg|opus|aac|wav|bin)|preview[.]jpg)[?]e=[1-9][0-9]{0,14}&s=[A-Za-z0-9_-]{43}|(?:(?:tg-photo|tg-thumb)[.]jpg|tg-motion[.](?:gif|mp4))[?]e=[1-9][0-9]{0,14}&s=[A-Za-z0-9_-]{43}&r=[A-Za-z0-9_-]{43})\z") {
            return 404;
        }
        proxy_pass https://panel.example.com/media/;
        proxy_pass_request_headers off;
        proxy_pass_request_body off;
        proxy_set_header Host panel.example.com;
        proxy_set_header Range $http_range;
        proxy_set_header Content-Length "";
        proxy_ssl_server_name on;
        proxy_ssl_name panel.example.com;
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 3;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_cache off;
    }
    location / {
        return 404;
    }
}
```

nginx выбирает `location` по нормализованному пути, а проверка `$request_uri` разрешает только исходные пути и формат query, которые генерирует приложение. Percent-encoding, лишние сегменты, повторные и дополнительные параметры отклоняются. `proxy_pass` с URI передаёт upstream нормализованный путь под `/media/` и неизменённую строку запроса. Из клиентских заголовков передаётся только `Range` для частичной загрузки. `Host` выбирает virtual host панели, а `proxy_ssl_name` задаёт то же имя для SNI и проверки сертификата панели по доверенным CA. Другие маршруты панели через медиа-домен недоступны.

Bun, а не nginx, проверяет срок `e`, подпись `s` и для `tg-photo`, `tg-thumb` и `tg-motion` актуальность ревизии `r`. GET и HEAD используют одну подпись. Подписанная ссылка — bearer-токен: любой, у кого она есть, может скачать файл до истечения срока, пока медиа доступно. Не публикуйте такие ссылки. Поэтому на медиа-vhost отключён access-лог, а error-лог направлен в `/dev/null`: при сбое upstream nginx может записать полную строку запроса вместе с query даже без access-лога. Проверьте также логи default vhost, который может обработать запрос до выбора медиа-vhost, HTTPS-панели и всех промежуточных proxy/CDN/WAF и систем мониторинга: не записывайте полные URL или query для `/media/`, в том числе в error/debug-логах.

На **каждом** proxy/CDN на пути к Bun, включая upstream HTTPS-панели и её CDN, настройте обход кэша для **всех** `/media/` — и при отдельном `MEDIA_URL`, и при общем `PUBLIC_URL`. Inline-медиа (`tg-photo`, `tg-thumb`, `tg-motion`) нельзя кэшировать: соблюдайте `Cache-Control: private, no-store`. Если всё же кэшируете оригиналы (`file.*`, `preview.jpg`), включайте в ключ полный путь и всю исходную строку запроса с подписью, ничего не удаляя и не нормализуя; перед попаданием ответа в кэш запрос должен пройти проверку Bun. Не отдавайте ответ после срока `e`: соблюдайте `Cache-Control`, ограничьте TTL оставшимся сроком подписи и отключите выдачу устаревших ответов (`stale`, в том числе при ошибке upstream или фоновой перепроверке). Если эти условия нельзя гарантировать на каждом звене, обходите кэш для всего `/media/`.

Перед применением проверьте конфигурацию через `nginx -t`. При сбое проверяйте DNS и TLS панели с хоста nginx на запросе без секретов; для проверки медиа используйте свежую ссылку и смотрите только HTTP-статус и тип ответа, не копируя URL в логи, историю команд или тикеты. `502` обычно указывает на соединение с upstream или проверку TLS; `404` может вернуть как nginx (не прошёл allowlist), так и приложение (истёкшая подпись, изменённая ревизия или недоступный файл). При `503` на inline-фото или миниатюре проверьте `docker compose ps app thumb` и локально просмотрите `docker compose logs --tail=100 app thumb`, удаляя возможные секреты перед публикацией. Для диагностики прокси используйте метрики статусов или отдельный тестовый запрос без действующей подписи, а не полный request log.
