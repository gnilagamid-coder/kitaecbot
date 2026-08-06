'use strict';
// Приём онлайн-оплаты. Провайдеры подключаются как плагины: чтобы добавить нового,
// достаточно дописать объект в PROVIDERS с двумя методами — createPayment и
// verifyCallback. Остальной код магазина про конкретного мерчанта ничего не знает.

const crypto = require('node:crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postJson(url, headers, body, timeoutMs = 20000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* провайдер вернул не-JSON */ }
  return { ok: res.ok, status: res.status, data, raw: text };
}

const PROVIDERS = {
  // ---------------------------------------------------------------------------
  // Platega — https://docs.platega.io
  // POST https://app.platega.io/transaction/process
  // Заголовки: X-MerchantId, X-Secret
  // Ответ: { transactionId, redirect, status, expiresIn }
  // ---------------------------------------------------------------------------
  platega: {
    label: 'Platega',
    fields: [
      { key: 'merchantId', label: 'Merchant ID', hint: 'X-MerchantId из личного кабинета' },
      { key: 'secret', label: 'Secret key', hint: 'X-Secret из личного кабинета', secret: true },
      { key: 'paymentMethod', label: 'Код способа оплаты', hint: 'Число из документации Platega (например 2 — СБП)', type: 'number' },
    ],
    async createPayment(cfg, order, ctx) {
      // id транзакции генерируем сами — так повторный вызов не создаст дубль платежа
      const id = crypto.randomUUID();
      const res = await postJson('https://app.platega.io/transaction/process', {
        'X-MerchantId': cfg.merchantId,
        'X-Secret': cfg.secret,
      }, {
        paymentMethod: Number(cfg.paymentMethod) || 2,
        id,
        paymentDetails: { amount: Number(order.total), currency: ctx.currencyCode || 'RUB' },
        description: `Заказ №${order.id}`.slice(0, 120),
        // Ключ в адресе возврата нужен витрине, чтобы спросить у нас настоящий
        // статус оплаты. Сам по себе редирект ничего не доказывает: покупатель
        // может закрыть страницу мерчанта и всё равно попасть сюда.
        return: `${ctx.publicUrl}/?paid=${order.id}&t=${encodeURIComponent(ctx.returnToken || '')}`,
        failedUrl: `${ctx.publicUrl}/?failed=${order.id}&t=${encodeURIComponent(ctx.returnToken || '')}`,
        payload: String(order.id),
      });

      if (!res.ok || !res.data || !res.data.redirect) {
        const why = (res.data && (res.data.message || res.data.error)) || res.raw || `HTTP ${res.status}`;
        return { ok: false, error: `Platega отклонила платёж: ${String(why).slice(0, 200)}` };
      }
      return { ok: true, url: res.data.redirect, externalId: res.data.transactionId || id };
    },
    // Platega шлёт те же X-MerchantId/X-Secret в колбэке — по ним и опознаём.
    // Статусы: CONFIRMED — оплачено, CANCELED — отказ, CHARGEBACKED — возврат.
    verifyCallback(cfg, headers, body) {
      const okMerchant = String(headers['x-merchantid'] || '') === String(cfg.merchantId);
      const okSecret = safeEqual(String(headers['x-secret'] || ''), String(cfg.secret || ''));
      if (!okMerchant || !okSecret) return { ok: false };
      const status = String((body && body.status) || '').toUpperCase();
      return {
        ok: true,
        orderId: Number(body && (body.payload || body.orderId)) || null,
        externalId: (body && (body.transactionId || body.id)) || '',
        paid: status === 'CONFIRMED',
        status,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Своя платёжная ссылка — для мерчантов без API или для приёма по реквизитам.
  // Никаких запросов наружу: покупателя ведём на заранее заданный адрес,
  // подставляя сумму и номер заказа. Подтверждение — вручную продавцом.
  // ---------------------------------------------------------------------------
  custom: {
    label: 'Своя ссылка на оплату',
    fields: [
      { key: 'url', label: 'Ссылка на оплату', hint: 'Можно подставить {amount} и {order} — например https://pay.me/x?sum={amount}' },
    ],
    async createPayment(cfg, order) {
      if (!cfg.url) return { ok: false, error: 'Не задана ссылка на оплату' };
      const url = String(cfg.url)
        .replace(/\{amount\}/g, String(order.total))
        .replace(/\{order\}/g, String(order.id));
      return { ok: true, url, externalId: '', manual: true };
    },
    verifyCallback() { return { ok: false }; },
  },
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getProvider(name) {
  return PROVIDERS[name] || null;
}

// Описание провайдеров для админки — какие поля рисовать в форме.
function providerSchema() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key, label: p.label,
    fields: p.fields.map(f => ({ ...f })),
  }));
}

module.exports = { getProvider, providerSchema, PROVIDERS };
