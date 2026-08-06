'use strict';
// Шифрование секретов арендаторов (сегодня — токены ботов в shops.bot_token_enc).
// AES-256-GCM: ключ выводим из SECRET_KEY через sha256, чтобы в .env можно было
// держать произвольную строку. Формат полезной нагрузки: 'v1.' + base64url(iv|tag|data).
// IV случайный на каждое шифрование — одинаковые токены дают разные шифртексты.

const crypto = require('node:crypto');

const PREFIX = 'v1.';

function deriveKey(secretKey) {
  const s = String(secretKey || '');
  if (s.length < 12) throw new Error('SECRET_KEY слишком короткий: нужно минимум 12 символов');
  return crypto.createHash('sha256').update(s).digest();
}

function encryptSecret(plain, secretKey) {
  const key = deriveKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 байт
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64url');
}

// Бросает исключение при неверном ключе или порченых данных — вызывающий
// решает, глушить магазин или падать (см. buildTenantFromRow в index.js).
function decryptSecret(payload, secretKey) {
  const s = String(payload || '');
  if (!s.startsWith(PREFIX)) throw new Error('неизвестный формат секрета (нет префикса v1.)');
  const buf = Buffer.from(s.slice(PREFIX.length), 'base64url');
  if (buf.length < 12 + 16 + 1) throw new Error('повреждённый секрет: слишком короткий');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = deriveKey(secretKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
