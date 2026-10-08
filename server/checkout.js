'use strict';
// Оформление заказа — общее ядро для мини-аппа (/api/checkout) и кнопочного
// магазина в чате бота (shopbot.js).
//
// Раньше вся логика жила прямо в HTTP-обработчике, и второй вход в магазин
// пришлось бы писать копипастой: проверка остатков, пересчёт промокода,
// списание, уведомление менеджеру. Две копии таких правил неизбежно
// разъезжаются — и одна из витрин начинает принимать заказ на раскупленный
// товар. Поэтому правила живут здесь, а входы только собирают данные.
//
// Всё работает от явно переданного арендатора t ({ store, orders, bot, publicUrl }),
// а не от прокси текущего запроса: бот в режиме опроса крутится вне контекста
// HTTP-запроса, и «текущего арендатора» у него просто нет.

const crypto = require('node:crypto');
const { esc } = require('./telegram');
const payments = require('./payments');

const money = (n, s) => {
  const v = Number(n).toLocaleString(s.advanced.locale || 'ru-RU');
  return s.commerce.currencyPosition === 'before' ? `${s.commerce.currency}${v}` : `${v} ${s.commerce.currency}`;
};

// Проверка промокода и расчёт скидки. Живёт на сервере и вызывается ДВАЖДЫ:
// при вводе кода покупателем (показать сумму) и при оформлении заказа (посчитать
// по-настоящему). Клиенту доверять нельзя — он мог бы прислать любую скидку.
function applyPromo(s, rawCode, total) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Введите промокод' };
  if (!s.promo.enabled) return { ok: false, error: 'Промокоды сейчас не принимаются' };

  const p = s.promo.codes.find(c => c.code === code);
  // Один и тот же ответ на «нет такого» и «выключен» — иначе перебором можно
  // выяснить, какие коды вообще существуют.
  if (!p || !p.active) return { ok: false, error: 'Промокод не найден' };
  if (p.usesLeft !== null && p.usesLeft <= 0) return { ok: false, error: 'Промокод уже использован' };
  if (p.minTotal && total < p.minTotal) {
    return { ok: false, error: `Промокод действует от ${money(p.minTotal, s)}` };
  }

  const raw = p.type === 'percent' ? Math.round(total * p.value / 100) : p.value;
  const discount = Math.max(0, Math.min(raw, total)); // скидка не больше суммы заказа
  return {
    ok: true, code: p.code, discount,
    total: total - discount,
    label: p.type === 'percent' ? `−${p.value}%` : `−${money(p.value, s)}`,
  };
}

// Списываем одно применение кода. Отдельно от расчёта: проверять можно сколько
// угодно раз, а тратить — только при реальном заказе.
function consumePromo(store, code) {
  const raw = store.read('settings', {});
  const list = (raw.promo && raw.promo.codes) || [];
  const p = list.find(c => String(c.code || '').toUpperCase() === code);
  if (!p) return;
  p.used = (p.used || 0) + 1;
  if (p.usesLeft !== null && p.usesLeft !== undefined) p.usesLeft = Math.max(0, p.usesLeft - 1);
  store.write('settings', raw);
}

function buildOrderText(s, items, c, tgUser, promo, finalTotal) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const total = finalTotal === undefined ? subtotal : finalTotal;
  const L = [];
  L.push('🛒 <b>Новый заказ</b>');
  L.push('');
  L.push(`👤 Клиент: ${esc(c.name || (tgUser && tgUser.first_name) || 'Без имени')}`);
  if (c.phone) L.push(`📱 Телефон: ${esc(c.phone)}`);
  if (c.email) L.push(`✉️ Email: ${esc(c.email)}`);
  if (c.address) L.push(`📍 Адрес: ${esc(c.address)}`);
  if (c.delivery) L.push(`🚚 Доставка: ${esc(c.delivery)}`);
  if (c.payment) L.push(`💳 Оплата: ${esc(c.payment)}`);
  if (c.comment) L.push(`📝 Комментарий: ${esc(c.comment)}`);
  L.push('');
  L.push('📦 <b>Товары:</b>');
  items.forEach(i => L.push(`• ${esc(i.name)} × ${i.qty} = ${money(i.price * i.qty, s)}`));
  L.push('');
  if (promo) {
    L.push(`Сумма: ${money(subtotal, s)}`);
    L.push(`🏷 Промокод <code>${esc(promo.code)}</code> (${esc(promo.label)}): −${money(promo.discount, s)}`);
  }
  L.push(`💰 <b>Итого: ${money(total, s)}</b>`);
  L.push(`🕒 ${new Date().toLocaleString(s.advanced.locale, { timeZone: s.advanced.timezone })}`);
  if (s.notify.includeCustomerLink && tgUser) {
    L.push(tgUser.username ? `💬 <a href="https://t.me/${esc(tgUser.username)}">@${esc(tgUser.username)}</a>` : `💬 id: <code>${tgUser.id}</code>`);
  }
  return { text: L.join('\n'), total };
}

// Заказ целиком: проверки, сохранение, списание остатков и промокода,
// уведомление менеджеру. Ответ покупателю — забота вызывающего: мини-апп
// и чат благодарят по-разному.
//
// Возвращает { ok:false, status, error } или { ok:true, order, finalTotal, text }.
// source — откуда пришёл заказ ('chat' для кнопочного бота), попадает в
// уведомление и в сам заказ, чтобы продавец видел канал продаж.
async function placeOrder(t, { items: rawItems, customer, tgUser, promoCode, source = '' }) {
  const s = t.settings();
  // Магазин на паузе. Витрина в этом режиме показывает заглушку вместо
  // каталога, но POST мимо неё проходил — и «закрытый» магазин продолжал
  // копить заказы, о которых продавец не знал.
  if (s.advanced.maintenanceMode) return { ok: false, status: 503, error: s.advanced.maintenanceText };

  const products = t.store.read('products', []);

  const items = (rawItems || []).map(i => {
    // hidden — товар снят с витрины: заказать его нельзя даже по прямой ссылке
    const prod = products.find(x => x.id === Number(i.id) && !x.hidden);
    if (!prod) return null;
    const qty = Math.max(1, Math.min(999, Number(i.qty) || 1));
    return { id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty };
  }).filter(Boolean);

  if (!items.length) return { ok: false, status: 400, error: 'корзина пуста' };

  // Остатки проверяет сервер, а не только витрина. Витрина не даёт положить в
  // корзину больше, чем есть, но прямой запрос это обходил: заказ на
  // раскупленный товар принимался, а остаток гасился в ноль через Math.max —
  // продавец получал заказ на то, чего нет.
  for (const i of items) {
    const prod = products.find(x => x.id === i.id);
    if (!prod || typeof prod.stock !== 'number' || prod.stock >= i.qty) continue;
    return {
      ok: false, status: 400,
      error: prod.stock === 0
        ? `«${prod.name}» раскуплен`
        : `«${prod.name}»: осталось ${prod.stock} шт.`,
    };
  }

  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (s.commerce.minOrder && total < s.commerce.minOrder) {
    return { ok: false, status: 400, error: `Минимальный заказ — ${money(s.commerce.minOrder, s)}` };
  }

  // Промокод пересчитываем здесь заново, а не берём скидку из запроса:
  // клиент мог бы прислать любую сумму. Если код за это время кончился —
  // заказ всё равно проходит, просто без скидки, и это видно в уведомлении.
  let promo = null;
  if (promoCode) {
    const r = applyPromo(s, promoCode, total);
    if (r.ok) promo = { code: r.code, discount: r.discount, label: r.label };
  }
  const finalTotal = total - (promo ? promo.discount : 0);

  const c = customer || {};
  // Обязательный телефон проверяем и здесь: на витрине это валидация формы,
  // а сервер принимал заказ без контакта, до которого потом не дозвониться.
  // Порог в 10 цифр — тот же, что в форме, чтобы правила не разъезжались.
  if (s.checkout.askPhone && s.checkout.phoneRequired &&
      String(c.phone || '').replace(/\D/g, '').length < 10) {
    return { ok: false, status: 400, error: 'Укажите телефон' };
  }
  const built = buildOrderText(s, items, c, tgUser, promo, finalTotal);
  let text = built.text;
  if (!tgUser) text += '\n\n⚠️ <i>Заказ оформлен вне Telegram — личность не подтверждена</i>';
  if (source === 'chat') text += '\n\n🤖 <i>Оформлен в чате бота</i>';

  const order = {
    id: Date.now(),
    at: new Date().toISOString(),
    items, total: finalTotal, subtotal: total, promo, customer: c,
    user: tgUser ? { id: tgUser.id, username: tgUser.username || '', name: tgUser.first_name || '' } : null,
    status: 'new',
  };
  if (source) order.source = source;
  if (promo) consumePromo(t.store, promo.code);
  t.orders.add(order);
  // копия заказа — внешнему сайту магазина, если он есть (sitesync.js); заказ от этого не зависит
  if (typeof t.onOrder === 'function') Promise.resolve().then(() => t.onOrder(order)).catch(() => {});

  // списываем остатки, если они заданы
  let changed = false;
  for (const i of items) {
    const prod = products.find(x => x.id === i.id);
    if (prod && typeof prod.stock === 'number') { prod.stock = Math.max(0, prod.stock - i.qty); changed = true; }
  }
  if (changed) t.store.write('products', products);

  if (s.notify.enabled && s.notify.onOrder) {
    // Ошибки доставки логирует сам notifyManagers ([notify] ...)
    await t.bot.notifyManagers(s, text).catch(e => console.error('[checkout] notifyManagers:', e.message));
  }

  return { ok: true, order, finalTotal, text: built.text };
}

// Ссылка на онлайн-оплату уже оформленного заказа. Сумму берём из
// сохранённого заказа, а не из запроса — иначе её можно было бы занизить.
// Возвращает { ok:false, status, error } или { ok:true, url, manual }.
async function createPaymentLink(t, orderId) {
  const s = t.settings();
  if (!s.payments.enabled) return { ok: false, status: 400, error: 'онлайн-оплата выключена' };

  const order = t.orders.find(orderId);
  if (!order) return { ok: false, status: 404, error: 'заказ не найден' };
  if (order.paid) return { ok: false, status: 400, error: 'заказ уже оплачен' };

  const provider = payments.getProvider(s.payments.provider);
  if (!provider) return { ok: false, status: 400, error: 'платёжный провайдер не настроен' };

  // Одноразовый ключ на возврат из платёжного сервиса. Мерчант приводит
  // покупателя обратно на PUBLIC_URL/?paid=<id>&t=<ключ>, и витрина по нему
  // спрашивает у нас настоящий статус. Без ключа адрес был бы оракулом:
  // номера заказов — это Date.now(), их легко перебрать и узнать, кто и что
  // оплатил. Ключ живёт в самом заказе и наружу больше нигде не появляется.
  const returnToken = order.returnToken || crypto.randomBytes(16).toString('hex');

  let result;
  try {
    result = await provider.createPayment(s.payments.creds, order, {
      currencyCode: s.payments.currencyCode,
      publicUrl: t.publicUrl,
      returnToken,
    });
  } catch (e) {
    console.error('[pay] createPayment failed:', e.message);
    return { ok: false, status: 502, error: 'платёжный сервис недоступен, попробуйте позже' };
  }
  if (!result.ok) return { ok: false, status: 502, error: result.error || 'не удалось создать платёж' };

  t.orders.update(order.id, {
    returnToken,
    payment: { provider: s.payments.provider, externalId: result.externalId, at: new Date().toISOString() },
  });
  return { ok: true, url: result.url, manual: !!result.manual };
}

module.exports = { money, applyPromo, consumePromo, buildOrderText, placeOrder, createPaymentLink };
