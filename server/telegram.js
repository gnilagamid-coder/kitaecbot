'use strict';
// Тонкая обёртка над Bot API + проверка подписи initData.
// Никаких зависимостей: fetch и crypto есть в Node 18+ из коробки.
//
// Фабрика, а не синглтон: токен раньше читался из окружения на уровне модуля,
// то есть процесс мог обслуживать ровно одного бота. Чистые функции (esc,
// разбор сетевой ошибки) остаются экспортами модуля — им состояние не нужно.

const crypto = require('node:crypto');
const dns = require('node:dns');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Node 18+ по умолчанию ходит «Happy Eyeballs» и может предпочесть IPv6.
// Если у VPS есть IPv6-адрес, но он никуда не маршрутизируется (типовая история
// у дешёвых хостеров), каждый запрос к Telegram падает с невнятным `fetch failed`.
// Форсируем IPv4 — это самая частая причина обрыва связи с api.telegram.org.
// Настройка процессная, поэтому живёт на уровне модуля, а не экземпляра.
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) { /* Node < 18.4 */ }

const DEFAULT_API_BASE = 'https://api.telegram.org';

// `fetch failed` сам по себе не говорит ничего — настоящая причина лежит в e.cause.
// Разворачиваем её в человеческий текст, иначе диагностировать блокировку невозможно.
function explainNetworkError(e) {
  const cause = e && e.cause ? e.cause : e;
  const code = cause && (cause.code || cause.errno);
  const hints = {
    ENOTFOUND: 'DNS не резолвит api.telegram.org — проверьте /etc/resolv.conf',
    EAI_AGAIN: 'DNS временно недоступен — проверьте /etc/resolv.conf',
    ECONNREFUSED: 'соединение отклонено — похоже на блокировку провайдером',
    ETIMEDOUT: 'таймаут соединения — трафик к Telegram режется, нужен прокси',
    ECONNRESET: 'соединение сброшено — типичный признак DPI-блокировки',
    UND_ERR_CONNECT_TIMEOUT: 'таймаут соединения — трафик к Telegram режется, нужен прокси',
    CERT_HAS_EXPIRED: 'просроченный корневой сертификат на сервере — обновите ca-certificates',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'подмена TLS-сертификата — трафик перехватывается',
  };
  const detail = hints[code] || (cause && cause.message) || 'причина неизвестна';
  return { code: code || 'UNKNOWN', message: `${detail}${code ? ` (${code})` : ''}` };
}

// Telegram ломается на «сыром» < и & в HTML-режиме, поэтому экранируем.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// botToken — токен конкретного магазина; apiBase позволяет увести трафик через
// свой прокси/зеркало Bot API, если провайдер режет api.telegram.org напрямую.
// Формат: https://хост (без /bot<token>).
function createTelegram({ botToken = '', apiBase = '' } = {}) {
  const BOT_TOKEN = String(botToken || '').trim();
  const API_BASE = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');

  async function tgApi(method, payload, opts = {}) {
    if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN не задан' };

    const attempts = opts.retries === undefined ? 2 : opts.retries;
    let lastErr = null;

    for (let i = 0; i <= attempts; i++) {
      try {
        const res = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {}),
          // без таймаута зависший коннект держал бы бота вечно
          signal: AbortSignal.timeout(opts.timeoutMs || 35000),
        });
        return await res.json();
      } catch (e) {
        lastErr = e;
        // сеть моргнула — пробуем ещё раз с нарастающей паузой
        if (i < attempts) await sleep(1000 * (i + 1));
      }
    }

    const { code, message } = explainNetworkError(lastErr);
    return { ok: false, description: `Нет связи с ${API_BASE}: ${message}`, network: true, code };
  }

  // Запрос с файлами (multipart/form-data): фото товара уходит в Telegram
  // прямо с диска. Ссылкой на /api/image отдать нельзя: у магазина на long
  // polling может вообще не быть публичного домена, а webp по URL Telegram
  // принимает через раз.
  // fields — обычные поля (объекты уходят JSON-строкой), files — { поле: путь }.
  //
  // Тело собираем вручную, а не через встроенный FormData: по спецификации он
  // переводит \n в \r\n во всех текстовых полях, и подпись к фото приезжала бы
  // в Telegram с лишними \r.
  async function tgUpload(method, fields, files, opts = {}) {
    if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN не задан' };
    const boundary = `----tgshop${crypto.randomBytes(12).toString('hex')}`;
    const parts = [];
    const head = (name, extra = '') =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`, 'utf8');
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null) continue;
      const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(head(k), Buffer.from(`\r\n${value}\r\n`, 'utf8'));
    }
    try {
      for (const [k, file] of Object.entries(files || {})) {
        const buf = await fsp.readFile(file);
        const type = UPLOAD_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const name = path.basename(file).replace(/["\r\n]/g, '_');
        parts.push(head(k, `; filename="${name}"`), Buffer.from(`Content-Type: ${type}\r\n\r\n`), buf, Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const res = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
        signal: AbortSignal.timeout(opts.timeoutMs || 60000),
      });
      return await res.json();
    } catch (e) {
      const { code, message } = explainNetworkError(e);
      return { ok: false, description: `Загрузка в ${API_BASE} не удалась: ${message}`, network: true, code };
    }
  }

  // Подпись initData — единственный способ доказать, что запрос действительно
  // пришёл из Telegram от конкретного пользователя, а не подделан из curl.
  function validateInitData(initData) {
    if (!BOT_TOKEN || !initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // Сортировка строго по алфавиту (по кодовым единицам), как в эталонных примерах
    // документации: localeCompare зависит от локали и может дать другой порядок.
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // timingSafeEqual требует одинаковой длины — иначе бросает
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = Number(params.get('auth_date')) * 1000;
    if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

    try { return JSON.parse(params.get('user')); } catch (e) { return null; }
  }

  return { BOT_TOKEN, API_BASE, tgApi, tgUpload, validateInitData };
}

const UPLOAD_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

module.exports = { createTelegram, esc, explainNetworkError, DEFAULT_API_BASE };
