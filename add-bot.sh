#!/usr/bin/env bash
# Второй и следующие боты-магазины на том же VPS.
#
# nginx спокойно держит много доменов (server-блоки + SNI), systemd — много
# сервисов, поэтому каждый бот живёт изолированно: своя папка /opt/shops/<имя>,
# свой сервис tg-shop-<имя>, свой nginx-сайт и сертификат. Первую установку
# (/opt/tg-shop, сервис tg-shop) скрипт не трогает вовсе.
#
# Запускать от root:  bash add-bot.sh
set -euo pipefail

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local p="$1" d="${2:-}" a; printf '%s%s: ' "$p" "${d:+ [$d]}" >&2; read -r a; echo "${a:-$d}"; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash add-bot.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || die "Нет Node.js — сначала поставь первый магазин: bash install.sh"

echo
echo "──────────── Новый магазин ────────────"
NAME="$(ask 'Имя экземпляра (латиницей: например second)' '')"
echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]*$' || die "Имя — строчные латинские буквы/цифры/дефис, без пробелов"
APP_DIR="/opt/shops/${NAME}"
SERVICE="tg-shop-${NAME}"
[ -e "$APP_DIR" ] && die "Папка $APP_DIR уже есть — имя занято"

BOT_TOKEN="$(ask 'Токен СВОЕГО бота от @BotFather' '')"
[ -n "$BOT_TOKEN" ] || die "Без токена бот работать не будет"
# Один токен на два процесса = вечный 409/polling-конфликт или перехват вебхука.
if grep -qs "^BOT_TOKEN=${BOT_TOKEN}$" /opt/tg-shop/.env /opt/shops/*/.env 2>/dev/null; then
  die "Этот токен уже используется другим экземпляром на сервере — нужен отдельный бот"
fi
DOMAIN="$(ask 'Домен (например shop2.example.com)' '')"
[ -n "$DOMAIN" ] || die "Без домена вебхук не поднять; укажите домен с A-записью на этот сервер"
ADMIN_TOKEN="$(ask 'Пароль в админку (Enter — сгенерировать)' '')"
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"

# Порт подбираем сами: первый свободный начиная с 3001.
PORT=3001
while ss -tln | awk '{print $4}' | grep -qE ":${PORT}$"; do PORT=$((PORT + 1)); done

say "Проверяю токен бота"
ME_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot${BOT_TOKEN}/getMe" || true)"
[ "$ME_CODE" = "200" ] || die "Telegram ответил «${ME_CODE}» на getMe — токен неверный или отозван"

say "Копирую код в ${APP_DIR}"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' \
  "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data/images"

say "Ставлю зависимости"
( cd "$APP_DIR" && { npm ci --omit=dev --silent || npm install --omit=dev --silent; } )

id -u tgshop >/dev/null 2>&1 || useradd --system --home /opt/shops --shell /usr/sbin/nologin tgshop
chown -R tgshop:tgshop "$APP_DIR"

# ---------- nginx + TLS ----------
say "Настраиваю nginx для ${DOMAIN}"
apt-get install -y -qq nginx >/dev/null
mkdir -p /var/log/nginx /var/lib/nginx
systemctl enable --now nginx >/dev/null 2>&1 || true
cat > "/etc/nginx/sites-available/${SERVICE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_types text/css application/javascript application/json image/svg+xml;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 12m;

    location = /admin.html {
        access_log off;
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

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
nginx -t >/dev/null
systemctl restart nginx >/dev/null

say "Выпускаю сертификат Let's Encrypt"
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
TLS_OK=0
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  echo "   сертификат выпущен"
  TLS_OK=1
else
  warn "Certbot не смог выпустить сертификат для ${DOMAIN}. Проверьте A-запись и повторите:"
  warn "   certbot --nginx -d ${DOMAIN}"
  warn "Затем поправьте ${APP_DIR}/.env: PUBLIC_URL=https://${DOMAIN}, BOT_MODE=webhook,"
  warn "BOT_STRICT_WEBHOOK=1 и systemctl restart ${SERVICE}"
  exit 1
fi

NGX_VER="$(nginx -v 2>&1 | sed -E 's|.*nginx/([0-9.]+).*|\1|')"
if printf '%s\n%s\n' "1.25.1" "$NGX_VER" | sort -V | head -1 | grep -qx '1.25.1'; then
  sed -i 's|listen 443 ssl;|listen 443 ssl; http2 on;|' "/etc/nginx/sites-available/${SERVICE}"
else
  sed -i 's|listen 443 ssl;|listen 443 ssl http2;|' "/etc/nginx/sites-available/${SERVICE}"
fi
nginx -t >/dev/null && systemctl restart nginx >/dev/null

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null || true
fi

# ---------- .env ----------
cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
ADMIN_CHAT_IDS=
PORT=${PORT}
HOST=127.0.0.1
PUBLIC_URL=https://${DOMAIN}
DATA_DIR=${APP_DIR}/data
BOT_MODE=webhook
BOT_STRICT_WEBHOOK=1
EOF
chown tgshop:tgshop "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------- systemd ----------
say "Ставлю сервис ${SERVICE}"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Telegram Mini App Shop (${NAME})
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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Сервис не поднялся"; }

say "Проверяю"
curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null || die "Сервис не отвечает на http://127.0.0.1:${PORT}/"
echo "   витрина отвечает"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | grep -q 'режим: webhook' && break
  sleep 1
done
journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | grep -q 'режим: webhook' \
  && echo "   вебхук зарегистрирован" \
  || warn "В журнале не видно вебхука: journalctl -u ${SERVICE} -n 30"

cat <<EOF

════════════════════════════════════════════════
  Готово. Магазин «${NAME}» работает отдельно от первого.

  Витрина:  https://${DOMAIN}/
  Пароль:   ${ADMIN_TOKEN}
  Порт:     ${PORT}

  В @BotFather для ЭТОГО бота:
    /newapp → URL: https://${DOMAIN}/
    /setmenubutton → ссылка на мини-апп

  Управление:
    systemctl status ${SERVICE}
    systemctl restart ${SERVICE}
    journalctl -u ${SERVICE} -f
  Первый магазин не тронут: сервис tg-shop, папка /opt/tg-shop.
  Ещё один бот:  bash add-bot.sh
════════════════════════════════════════════════
EOF
