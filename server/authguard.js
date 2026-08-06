'use strict';
// Тормоз на подбор пароля админки.
//
// До этого модуля единственной защитой был общий лимит в 60 запросов в минуту
// на IP: неудачный пароль ничего не стоил, и с одного адреса можно было
// перебирать 60 вариантов в минуту круглосуточно — 86 тысяч попыток в сутки,
// бесконечно. Пароль, сгенерированный install.sh, такое переживёт, а
// придуманный руками («магазин2024») — нет.
//
// Схема простая и без состояния на диске: первые FREE_TRIES ошибок бесплатны
// (человек ошибается раскладкой и регистром), дальше пауза удваивается от
// BASE_MS до MAX_MS. Успешный вход обнуляет счётчик.

const FREE_TRIES = 5;
const BASE_MS = 30 * 1000;
const MAX_MS = 15 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000; // через час тишины про адрес забываем

const attempts = new Map();

function lockFor(fails) {
  const over = fails - FREE_TRIES;
  if (over <= 0) return 0;
  return Math.min(MAX_MS, BASE_MS * Math.pow(2, over - 1));
}

// Можно ли этому адресу вообще пробовать прямо сейчас.
function check(ip, now = Date.now()) {
  const rec = attempts.get(ip);
  if (!rec || !rec.until || rec.until <= now) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: rec.until - now, fails: rec.fails };
}

// Неверный токен. Возвращаем, сколько теперь ждать, — чтобы вызывающий код
// мог написать это в лог и в заголовок Retry-After.
function fail(ip, now = Date.now()) {
  const rec = attempts.get(ip) || { fails: 0, until: 0, seen: now };
  rec.fails += 1;
  rec.seen = now;
  const wait = lockFor(rec.fails);
  rec.until = wait ? now + wait : 0;
  attempts.set(ip, rec);
  return { fails: rec.fails, retryAfterMs: wait };
}

function succeed(ip) {
  attempts.delete(ip);
}

// Периодическая уборка, чтобы карта не росла бесконечно от сканеров.
// unref, иначе таймер держал бы процесс живым при остановке сервера.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (now - rec.seen > FORGET_MS) attempts.delete(ip);
  }
}, FORGET_MS);
if (sweeper.unref) sweeper.unref();

function reset() { attempts.clear(); }

module.exports = { check, fail, succeed, reset, FREE_TRIES, BASE_MS, MAX_MS, _internal: { lockFor, attempts } };
