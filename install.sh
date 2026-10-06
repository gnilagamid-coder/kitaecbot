#!/usr/bin/env bash
# Установщик магазина на чистый Debian 11/12 или Ubuntu 22.04/24.04.
#
# Основной режим — webhook: Telegram сама приносит обновления на сервер по
# HTTPS. Бот регистрирует вебхук (setWebhook) при первом старте сервиса —
# вручную ничего вызывать не нужно. Домен и сертификат для этого обязательны;
# без домена установщик честно ставит long polling (бот стучится к Telegram сам).
#
# Запускать от root:  bash install.sh
set -euo pipefail

APP_DIR="/opt/tg-shop"
SERVICE="tg-shop"
NODE_MAJOR=24

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local p="$1" d="${2:-}" a; printf '%s%s: ' "$p" "${d:+ [$d]}" >&2; read -r a; echo "${a:-$d}"; }

# apt бывает занят автообновлениями (unattended-upgrades) — тогда ждём
# блокировку до 5 минут, а не падаем посреди установки. Уже стоящие пакеты
# не трогаем вовсе: на сервере с другими проектами nginx и certbot обычно есть.
APT=(apt-get -o DPkg::Lock::Timeout=300)
apt_ensure() {
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ "${#missing[@]}" -eq 0 ] || "${APT[@]}" install -y -qq "${missing[@]}" >/dev/null
}

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash install.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say "Обновляю пакеты"
export DEBIAN_FRONTEND=noninteractive
"${APT[@]}" update -qq
apt_ensure curl ca-certificates gnupg rsync

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  say "Ставлю Node.js ${NODE_MAJOR}"
  # На очень свежих релизах (Ubuntu 26.04) у NodeSource может ещё не быть
  # пакетов — тогда откатываемся на системный Node, он тоже >= 18.
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null \
     && "${APT[@]}" install -y -qq nodejs >/dev/null; then
    :
  else
    warn "NodeSource недоступен — ставлю системный Node.js"
    "${APT[@]}" install -y -qq nodejs >/dev/null
  fi
fi
# Дистрибутивный nodejs идёт без npm (отдельный пакет), NodeSource — с npm.
command -v npm >/dev/null 2>&1 || "${APT[@]}" install -y -qq npm >/dev/null
say "Node $(node -v), npm $(npm -v)"

# ---------- параметры ----------
# Если магазин уже стоит, подставляем прежние значения как ответы по умолчанию:
# повторный запуск не должен молча выдать новый пароль админки или стереть токен.
OLD_BOT_TOKEN=""; OLD_ADMIN_TOKEN=""; OLD_PORT=""; OLD_DOMAIN=""; OLD_ADMIN_CHAT_IDS=""
if [ -f "$APP_DIR/.env" ]; then
  # shellcheck disable=SC1090
  OLD_BOT_TOKEN="$(grep -E '^BOT_TOKEN=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  OLD_ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  OLD_ADMIN_CHAT_IDS="$(grep -E '^ADMIN_CHAT_IDS=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  OLD_PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  OLD_DOMAIN="$(grep -E '^PUBLIC_URL=' "$APP_DIR/.env" | sed -E 's|^PUBLIC_URL=https?://||; s|:[0-9]+$||' || true)"
  echo
  warn "Найдена прежняя установка — текущие настройки подставлены как значения по умолчанию."
  warn "Если нужно просто обновить код, не меняя ничего: bash update.sh"
fi

echo
echo "──────────── Настройка ────────────"
BOT_TOKEN="$(ask 'Токен бота от @BotFather' "$OLD_BOT_TOKEN")"
[ -n "$BOT_TOKEN" ] || die "Без токена бот и уведомления работать не будут"
DOMAIN="$(ask 'Домен (например shop.example.com)' "$OLD_DOMAIN")"
if [ -z "$DOMAIN" ]; then
  warn "Без домена невозможен HTTPS, а без HTTPS — вебхук: бот будет работать"
  warn "в режиме long polling. Для продакшена укажите домен и перезапустите установщик."
fi
ADMIN_TOKEN="$(ask 'Пароль в админку (Enter — оставить прежний или сгенерировать)' "$OLD_ADMIN_TOKEN")"
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
PORT="$(ask 'Внутренний порт' "${OLD_PORT:-3000}")"

# Токен проверяем сразу: с левым токеном сервис поднимется, но бот будет
# молча лежать (401 на getUpdates/setWebhook) — лучше упасть с ясной ошибкой.
say "Проверяю токен бота"
ME_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot${BOT_TOKEN}/getMe" || true)"
[ "$ME_CODE" = "200" ] || die "Telegram ответил «${ME_CODE}» на getMe — токен неверный или отозван. Проверьте в @BotFather и запустите установщик заново"

# ---------- файлы ----------
say "Копирую в ${APP_DIR}"
mkdir -p "$APP_DIR"
# Что не копируем (данные, секреты, архивы) — общий список для всех скриптов
[ -f "$SRC_DIR/deploy-excludes.txt" ] || die "Нет $SRC_DIR/deploy-excludes.txt — код скачан не полностью"
rsync -a --delete --exclude-from="$SRC_DIR/deploy-excludes.txt" "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data/images" "$APP_DIR/backups"

say "Ставлю зависимости"
# mysql2 нужен сервису даже в файловом режиме (server/db.js грузится всегда),
# а node_modules в копию не попадает — ставим из package-lock.
( cd "$APP_DIR" && { npm ci --omit=dev --silent || npm install --omit=dev --silent; } )

id -u tgshop >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tgshop
chown -R tgshop:tgshop "$APP_DIR"

# Список владельцев для входа в админку из бота. При установке его ещё нет
# (chat_id узнаётся командой /id у уже запущенного бота) — при повторном
# запуске просто сохраняем прежнее значение.
ADMIN_CHAT_IDS="$OLD_ADMIN_CHAT_IDS"

# ---------- nginx + TLS ----------
# До запуска сервиса: вебхук регистрируется при старте бота, и к этому моменту
# HTTPS уже должен отвечать. Telegram принимает вебхук только по HTTPS и только
# на портах 443/80/88/8443 — используем 443.
TLS_OK=0
if [ -n "$DOMAIN" ]; then
  say "Настраиваю nginx для ${DOMAIN}"
  apt_ensure nginx
  # На урезанных образах VPS каталогов nginx может не быть — без логов
  # nginx -t падает, а следом отказывается работать certbot.
  mkdir -p /var/log/nginx /var/lib/nginx
  systemctl enable --now nginx >/dev/null 2>&1 || true
  cat > "/etc/nginx/sites-available/${SERVICE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    # мини-апп открывается в мобильной сети: текст сжимаем. Кэш TLS-сессий
    # (повторный вход без полного рукопожатия) задаёт сам certbot в
    # options-ssl-nginx.conf — свой ssl_session_cache здесь давал дубль, и
    # certbot отказывался ставить сертификат.
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # админка отдаёт токен в заголовке, а картинки могут быть тяжёлыми
    client_max_body_size 12m;

    # Вход в админку: страница — лишь форма, но на всякий случай не пишем
    # этот путь в access-лог (защита от случайных секретов в query-строке).
    location = /admin.html {
        access_log off;
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Всё остальное, включая /api/webhook — сюда Telegram доставляет апдейты бота.
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null
  systemctl restart nginx >/dev/null

  say "Выпускаю сертификат Let's Encrypt"
  apt_ensure certbot python3-certbot-nginx
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
    echo "   сертификат выпущен"
    TLS_OK=1
  else
    warn "Certbot не смог выпустить сертификат. Проверь, что A-запись ${DOMAIN} указывает на этот сервер, и повтори:"
    warn "   certbot --nginx -d ${DOMAIN}"
    warn "Без сертификата вебхук не поднять — ставлю long polling; после выпуска"
    warn "сертификата перезапусти установщик (он подхватит прежние ответы)."
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 'Nginx Full' >/dev/null || true
  fi

  # http2 мультиплексирует картинки галереи в один поток; синтаксис зависит
  # от версии nginx (до 1.25.1 — флаг в listen, позже — директива http2 on).
  if [ "$TLS_OK" = "1" ]; then
    NGX_VER="$(nginx -v 2>&1 | sed -E 's|.*nginx/([0-9.]+).*|\1|')"
    if printf '%s\n%s\n' "1.25.1" "$NGX_VER" | sort -V | head -1 | grep -qx '1.25.1'; then
      sed -i 's|listen 443 ssl;|listen 443 ssl; http2 on;|' "/etc/nginx/sites-available/${SERVICE}"
    else
      sed -i 's|listen 443 ssl;|listen 443 ssl http2;|' "/etc/nginx/sites-available/${SERVICE}"
    fi
    nginx -t >/dev/null && systemctl restart nginx >/dev/null
  fi
fi

# ---------- .env ----------
# Режим бота. Вебхук включаем только при рабочем HTTPS: с BOT_STRICT_WEBHOOK=1
# бот не откатывается на опрос, а остаётся выключенным — на продакшене тихий
# откат хуже явной ошибки.
BOT_MODE="polling"
BOT_STRICT_LINE=""
PUBLIC_URL="http://$(hostname -I | awk '{print $1}'):${PORT}"
if [ "$TLS_OK" = "1" ]; then
  BOT_MODE="webhook"
  BOT_STRICT_LINE="BOT_STRICT_WEBHOOK=1"
  PUBLIC_URL="https://${DOMAIN}"
fi

cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
ADMIN_CHAT_IDS=${ADMIN_CHAT_IDS}
PORT=${PORT}
HOST=127.0.0.1
PUBLIC_URL=${PUBLIC_URL}
DATA_DIR=${APP_DIR}/data
BOT_MODE=${BOT_MODE}
${BOT_STRICT_LINE}
EOF
chown tgshop:tgshop "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------- systemd ----------
say "Ставлю сервис systemd"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Telegram Mini App Shop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tgshop
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server/index.js
Restart=always
RestartSec=3
# базовая изоляция: на запись сервису доступны только его data и backups
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data -${APP_DIR}/backups

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
# restart, а не enable --now: при повторном запуске установщика сервис уже
# крутится со старым .env — без рестарта новые настройки не применятся.
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Сервис не поднялся"; }

# ---------- проверка ----------
say "Проверяю"
curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null || die "Сервис не отвечает на http://127.0.0.1:${PORT}/"
echo "   витрина отвечает"

if [ "$BOT_MODE" = "webhook" ]; then
  # Регистрация вебхука происходит при старте бота (setWebhook на
  # PUBLIC_URL/api/webhook) — даём ей несколько секунд и смотрим журнал.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | grep -q 'режим: webhook' && break
    sleep 1
  done
  if journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | grep -q 'режим: webhook'; then
    echo "   вебхук зарегистрирован: Telegram сама доставляет апдейты на ${PUBLIC_URL}/api/webhook"
  else
    warn "В журнале не видно регистрации вебхука — смотри: journalctl -u ${SERVICE} -n 30"
    warn "Частые причины: неверный токен, домен ещё не резолвится наружу,"
    warn "или api.telegram.org недоступен с этого сервера (нужен TELEGRAM_API_BASE)."
  fi
fi

# ---------- итог ----------
cat <<EOF

════════════════════════════════════════════════
  Готово. Режим бота: ${BOT_MODE}

  Витрина:  ${PUBLIC_URL}/
  Админка:  в боте команда /admin (сначала впишите свой chat_id
            в ${APP_DIR}/.env: ADMIN_CHAT_IDS=<id>, узнать: /id у бота)
  Аварийный вход: ${PUBLIC_URL}/admin.html — токен вводится в поле формы,
            в URL он не пишется и в логи не попадает
  Пароль:   ${ADMIN_TOKEN}

  Осталось в @BotFather:
    /newapp  →  выбрать бота  →  URL: ${PUBLIC_URL}/
    /setmenubutton → ссылка на мини-апп

  Управление:
    systemctl status ${SERVICE}
    systemctl restart ${SERVICE}
    journalctl -u ${SERVICE} -f
  Бэкап:  tar czf backup.tgz -C ${APP_DIR} data
════════════════════════════════════════════════
EOF
