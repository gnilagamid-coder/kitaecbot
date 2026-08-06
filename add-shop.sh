#!/usr/bin/env bash
# Добавляет ЕЩЁ ОДИН магазин на тот же сервер. Каждый живёт в своей папке,
# со своим ботом, доменом, портом и данными — они друг о друге не знают.
#
#   bash add-shop.sh
#
# Почему отдельный процесс на магазин, а не один многоарендный сервер:
#   * бот на long polling может быть только один на токен — значит, процесс
#     на магазин нужен в любом случае;
#   * падение или обновление одного магазина не трогает соседей;
#   * данные физически разделены, случайно смешать их нельзя;
#   * 45-50 МБ памяти на экземпляр — на гигабайтном VPS помещается 8-10 штук.
set -euo pipefail

BASE_DIR="/opt/shops"
CODE_DIR="/opt/tg-shop-code"     # общий код, обновляется один раз для всех
NODE_MAJOR=20

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local p="$1" d="${2:-}" a; read -rp "$p${d:+ [$d]}: " a; echo "${a:-$d}"; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash add-shop.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || die "Node.js не установлен — сначала поставь первый магазин через install.sh"
command -v nginx >/dev/null 2>&1 || die "nginx не установлен — сначала поставь первый магазин через install.sh"

echo
echo "──────────── Новый магазин ────────────"
SLUG="$(ask 'Короткое имя латиницей (папка и имя сервиса), например vinty')"
[[ "$SLUG" =~ ^[a-z0-9-]{2,20}$ ]] || die "Только латиница в нижнем регистре, цифры и дефис, 2-20 символов"
APP_DIR="${BASE_DIR}/${SLUG}"
[ -e "$APP_DIR" ] && die "Магазин '$SLUG' уже существует ($APP_DIR)"

BOT_TOKEN="$(ask 'Токен бота от @BotFather (у каждого магазина СВОЙ бот)')"
[ -n "$BOT_TOKEN" ] || die "Без токена бот работать не будет"
DOMAIN="$(ask 'Домен этого магазина (например vinty.duckdns.org)')"
[ -n "$DOMAIN" ] || die "Для мини-аппа нужен домен с HTTPS"
ADMIN_TOKEN="$(ask 'Пароль в админку (Enter — сгенерирую)')"
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"

# Порт подбираем сами: первый свободный начиная с 3001, чтобы не столкнуться
# ни с уже поднятыми магазинами, ни с чем-то посторонним на машине.
PORT=3001
while ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN || grep -rqs "^PORT=${PORT}$" "$BASE_DIR" 2>/dev/null; do
  PORT=$((PORT+1))
  [ "$PORT" -gt 3100 ] && die "Не нашёл свободный порт в диапазоне 3001-3100"
done
say "Свободный порт: ${PORT}"

# ---------- общий код ----------
say "Обновляю общий код в ${CODE_DIR}"
mkdir -p "$CODE_DIR"
rsync -a --delete \
  --exclude 'data' --exclude '.env' --exclude '.git' --exclude 'node_modules' \
  "$SRC_DIR"/ "$CODE_DIR"/

# ---------- каталог магазина ----------
say "Создаю ${APP_DIR}"
mkdir -p "$APP_DIR/data/images"

id -u tgshop >/dev/null 2>&1 || useradd --system --home "$BASE_DIR" --shell /usr/sbin/nologin tgshop

cat > "$APP_DIR/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
ADMIN_CHAT_IDS=
PORT=${PORT}
HOST=127.0.0.1
PUBLIC_URL=https://${DOMAIN}
DATA_DIR=${APP_DIR}/data
EOF
chmod 600 "$APP_DIR/.env"
chown -R tgshop:tgshop "$APP_DIR" "$CODE_DIR"

# ---------- systemd-шаблон ----------
# Один unit-файл на все магазины: tg-shop@vinty, tg-shop@merch и т.д.
if [ ! -f /etc/systemd/system/tg-shop@.service ]; then
  say "Ставлю шаблон сервиса tg-shop@.service"
  cat > /etc/systemd/system/tg-shop@.service <<EOF
[Unit]
Description=Telegram Mini App Shop (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tgshop
WorkingDirectory=${BASE_DIR}/%i
EnvironmentFile=${BASE_DIR}/%i/.env
ExecStart=/usr/bin/node ${CODE_DIR}/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${BASE_DIR}/%i/data

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi

say "Запускаю tg-shop@${SLUG}"
systemctl enable --now "tg-shop@${SLUG}" >/dev/null
sleep 2
systemctl is-active --quiet "tg-shop@${SLUG}" || {
  journalctl -u "tg-shop@${SLUG}" -n 30 --no-pager
  die "Сервис не поднялся"
}

# ---------- nginx ----------
say "Настраиваю nginx для ${DOMAIN}"
cat > "/etc/nginx/sites-available/shop-${SLUG}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
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

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/shop-${SLUG}" "/etc/nginx/sites-enabled/shop-${SLUG}"
nginx -t >/dev/null && systemctl reload nginx

say "Выпускаю сертификат для ${DOMAIN}"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  echo "   сертификат выпущен"
else
  warn "Certbot не смог. Проверь A-запись ${DOMAIN} → $(hostname -I | awk '{print $1}') и повтори:"
  warn "   certbot --nginx -d ${DOMAIN}"
fi

cat <<EOF

════════════════════════════════════════════════
  Магазин «${SLUG}» поднят.

  Витрина:  https://${DOMAIN}/
  Админка:  в боте команда /admin (впишите свой chat_id в ${APP_DIR}/.env:
            ADMIN_CHAT_IDS=<id>, узнать: /id у бота, затем рестарт)
  Аварийный вход: https://${DOMAIN}/admin.html — токен вводится в поле
            формы, в URL он не пишется и в логи не попадает
  Пароль:   ${ADMIN_TOKEN}
  Порт:     ${PORT}
  Данные:   ${APP_DIR}/data

  Управление именно этим магазином:
    systemctl status tg-shop@${SLUG}
    systemctl restart tg-shop@${SLUG}
    journalctl -u tg-shop@${SLUG} -f

  Все магазины разом:
    systemctl restart 'tg-shop@*'
    systemctl list-units 'tg-shop@*'

  Обновить код для ВСЕХ магазинов сразу:
    bash update-all.sh
════════════════════════════════════════════════
EOF
