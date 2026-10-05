#!/usr/bin/env bash
# Обновление ВСЕХ магазинов на этом сервере: забирает свежий код из git и
# раскладывает его по каждому установленному магазину — первому (/opt/tg-shop,
# сервис tg-shop) и всем, что добавлены через add-bot.sh (/opt/shops/<имя>,
# сервис tg-shop-<имя>). Новый бот попадает в обновление сам: список магазинов
# не ведётся вручную, а собирается по папкам с .env.
#
# Ничего не спрашивает и НЕ ТРОГАЕТ ни .env, ни data/, ни backups/ — токены,
# пароли, товары, фотографии и снимки остаются на месте (deploy-excludes.txt).
#
#   bash update.sh                все магазины
#   bash update.sh secondb main   только перечисленные (main — первый магазин)
#   bash update.sh --list         показать магазины и выйти
#
# Упавший магазин не останавливает остальные: в конце — сводка, а код
# возврата ненулевой, если хоть один не поднялся.
set -euo pipefail

# Всё тело — в фигурных скобках: bash разбирает блок целиком до запуска.
# Скрипт сам делает git pull и может подменить собственный файл посреди
# прогона — без скобок bash дочитывал бы уже новый файл со старого смещения.
{

FIRST_DIR="/opt/tg-shop"
SHOPS_ROOT="/opt/shops"
BACKUP_ROOT="/root/backups/tg-shop-update"
KEEP_BACKUPS=10           # сколько снимков данных хранить на магазин
HEALTH_WAIT=20            # секунд ждём /healthz после рестарта

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mX  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запусти от root:  sudo bash update.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXCLUDES="$SRC_DIR/deploy-excludes.txt"
[ -f "$EXCLUDES" ] || die "Нет $EXCLUDES — без него rsync снёс бы данные магазинов. Код в $SRC_DIR неполный"

# ---------- какие магазины есть ----------
# Строка на магазин: «имя|папка|сервис». Первый магазин зовётся main.
discover() {
  [ -f "$FIRST_DIR/.env" ] && echo "main|$FIRST_DIR|tg-shop"
  local d n
  for d in "$SHOPS_ROOT"/*/; do
    d="${d%/}"
    [ -f "$d/.env" ] || continue
    n="$(basename "$d")"
    echo "$n|$d|tg-shop-$n"
  done
}

mapfile -t ALL < <(discover)
[ "${#ALL[@]}" -gt 0 ] || die "Не нашёл ни одного магазина ($FIRST_DIR, $SHOPS_ROOT/*). Нужен install.sh"

if [ "${1:-}" = "--list" ]; then
  for row in "${ALL[@]}"; do IFS='|' read -r n d s <<<"$row"; printf '  %-14s %-28s %s\n' "$n" "$d" "$s"; done
  exit 0
fi

# Фильтр по именам из аргументов
TARGETS=()
if [ "$#" -gt 0 ]; then
  for want in "$@"; do
    found=""
    for row in "${ALL[@]}"; do [ "${row%%|*}" = "$want" ] && { TARGETS+=("$row"); found=1; }; done
    [ -n "$found" ] || die "Магазин «$want» не найден. Список: bash update.sh --list"
  done
else
  TARGETS=("${ALL[@]}")
fi

# ---------- забираем свежий код ----------
PREV_COMMIT=""
if [ -d "$SRC_DIR/.git" ]; then
  say "Забираю обновления из git"
  PREV_COMMIT="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
  # только origin: прочие remote (форки, зеркала) могут требовать логин, и
  # fetch --all ронял бы всё обновление ещё до первого магазина
  git -C "$SRC_DIR" fetch --quiet origin
  BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
  # локальные правки не даём потерять молча
  if ! git -C "$SRC_DIR" diff --quiet || ! git -C "$SRC_DIR" diff --cached --quiet; then
    warn "В $SRC_DIR есть незакоммиченные изменения — они будут сохранены в stash"
    git -C "$SRC_DIR" stash push -u -m "update.sh $(date +%F_%T)" >/dev/null
  fi
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
  echo "   ветка: $BRANCH, было: $PREV_COMMIT, стало: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
else
  warn "$SRC_DIR — не git-репозиторий. Обновляю из того, что лежит в папке."
fi

# ---------- юниты: запись в backups/ ----------
# Сервис изолирован (ProtectSystem=strict) и пишет только туда, куда
# разрешено. Старые юниты разрешали лишь data/, а снимки бэкапов ложатся в
# backups/ рядом — автобэкап из админки падал бы с «read-only file system».
# Дописываем путь один раз; минус в начале — не падать, если папки нет.
RELOAD=""
for row in "${TARGETS[@]}"; do
  IFS='|' read -r name dir svc <<<"$row"
  unit="/etc/systemd/system/${svc}.service"
  [ -f "$unit" ] || continue
  if ! grep -q "^ReadWritePaths=.*${dir}/backups" "$unit"; then
    sed -i "s|^ReadWritePaths=\(.*\)$|ReadWritePaths=\1 -${dir}/backups|" "$unit"
    echo "   ${svc}: разрешена запись в ${dir}/backups"
    RELOAD=1
  fi
done
[ -n "$RELOAD" ] && systemctl daemon-reload

# ---------- обновление одного магазина ----------
# Каждый шаг проверяется явно: функция вызывается в условии if, а там
# set -e не действует.
lock_hash() { sha256sum "$1/package-lock.json" 2>/dev/null | cut -d' ' -f1; }

update_one() {
  local name="$1" dir="$2" svc="$3"
  local backup="$BACKUP_ROOT/${name}-$(date +%F-%H%M%S).tgz"

  mkdir -p "$BACKUP_ROOT" || return 1
  tar czf "$backup" -C "$dir" data || { warn "$name: бэкап данных не снят — магазин не трогаю"; return 1; }
  LAST_BACKUP="$backup"
  # старые снимки этого магазина сверх KEEP_BACKUPS — прочь
  ls -1t "$BACKUP_ROOT/${name}-"*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

  local lock_before; lock_before="$(lock_hash "$dir")"
  rsync -a --delete --exclude-from="$EXCLUDES" "$SRC_DIR"/ "$dir"/ || { warn "$name: rsync не прошёл"; return 1; }
  mkdir -p "$dir/data/images" "$dir/backups"

  # зависимости ставим, только если поменялся lock-файл или их нет вовсе
  if [ ! -d "$dir/node_modules" ] || [ "$lock_before" != "$(lock_hash "$dir")" ]; then
    echo "   $name: ставлю зависимости"
    ( cd "$dir" && { npm ci --omit=dev --ignore-scripts --silent || npm install --omit=dev --ignore-scripts --silent; } ) \
      || { warn "$name: npm не поставил зависимости"; return 1; }
  fi
  chown -R tgshop:tgshop "$dir"
  chmod 600 "$dir/.env"

  systemctl restart "$svc" || { warn "$name: systemctl restart $svc не прошёл"; return 1; }

  local port; port="$(sed -n 's/^PORT=//p' "$dir/.env" | head -n1)"
  local i
  for i in $(seq 1 "$HEALTH_WAIT"); do
    if curl -fsS -m 2 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      echo "   $name: отвечает на :${port}/healthz"
      return 0
    fi
    sleep 1
  done
  warn "$name: сервис не ответил на /healthz за ${HEALTH_WAIT} с. Последние строки лога:"
  journalctl -u "$svc" -n 20 --no-pager | sed 's/^/     /'
  return 1
}

OK=()
FAILED=()
for row in "${TARGETS[@]}"; do
  IFS='|' read -r name dir svc <<<"$row"
  say "Обновляю ${name} (${dir}, ${svc})"
  LAST_BACKUP=""
  if update_one "$name" "$dir" "$svc"; then
    OK+=("$name")
  else
    FAILED+=("$name|$dir|$svc|$LAST_BACKUP")
  fi
done

# ---------- связь с Telegram ----------
say "Проверяю связь с Telegram"
if curl -sS -m 10 -o /dev/null https://api.telegram.org; then
  echo "   api.telegram.org отвечает"
else
  warn "api.telegram.org недоступен с этого сервера — боты работать не будут."
  warn "Проверь: curl -sS -m 10 https://api.telegram.org"
fi

# ---------- сводка ----------
echo
echo "════════════════════════════════════════════════"
echo "  Код: $(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo 'не git')"
for n in ${OK[@]+"${OK[@]}"}; do echo "  ✓ $n"; done
for row in ${FAILED[@]+"${FAILED[@]}"}; do
  IFS='|' read -r n d s b <<<"$row"
  echo "  ✗ $n — не поднялся"
  [ -n "$b" ] && echo "      данные:  tar xzf $b -C $d && systemctl restart $s"
  [ -n "$PREV_COMMIT" ] && echo "      код:     git -C $SRC_DIR checkout $PREV_COMMIT && bash update.sh $n"
done
echo
echo "  Снимки данных: $BACKUP_ROOT (по $KEEP_BACKUPS на магазин)"
echo "  Логи:          journalctl -u <сервис> -f"
echo "  В браузере обновите страницу с очисткой кэша: Ctrl+F5 / Cmd+Shift+R"
echo "════════════════════════════════════════════════"

[ "${#FAILED[@]}" -eq 0 ]
exit
}
