'use strict';
// Заказы: хранение, архив, статусы, выгрузка в CSV.
//
// Вынесено из index.js отдельным модулем по двум причинам. Первая: логику
// можно проверять тестами, не поднимая HTTP-сервер. Вторая: когда данные
// переедут в базу, менять придётся один этот файл, а не полтора десятка мест
// в обработчиках API.
//
// Раньше история резалась в одну строку — `orders.slice(0, 500)` — и
// пятьсот первый заказ бесшумно стирал первый. Ни ошибки, ни записи в логе:
// продавец узнавал об этом через месяцы, когда искал старый заказ. Теперь
// «горячий» файл держит последние HOT_LIMIT записей, а всё, что вытеснено,
// уезжает в архив и остаётся доступным для поиска и выгрузки.

const store = require('./store');

const HOT = 'orders';
const ARCHIVE = 'orders-archive';

// Сколько заказов остаётся в горячем файле. Админка почти всегда смотрит
// последние, а переписывать на каждый заказ файл из десяти тысяч записей —
// это лишние сотни миллисекунд на ровном месте.
const HOT_LIMIT = 500;

// Статусы намеренно линейные и короткие: это не CRM, а «что с заказом сейчас».
// cancelled — терминальный и единственный, который не считается выручкой.
const STATUSES = ['new', 'processing', 'shipped', 'done', 'cancelled'];
const STATUS_LABELS = {
  new: 'Новый',
  processing: 'В работе',
  shipped: 'Отправлен',
  done: 'Выполнен',
  cancelled: 'Отменён',
};

const hot = () => store.read(HOT, []);
// Архив читается лениво: пока админка листает первую страницу, файл вообще
// не открывается — store кэширует по ключу и трогает диск один раз.
const archive = () => store.read(ARCHIVE, []);

// Заказы, сохранённые до появления статусов, приезжают без поля status.
// Считаем их новыми, а не «неизвестными»: для продавца это ровно то же самое.
function normalize(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    ...o,
    status: STATUSES.includes(o.status) ? o.status : 'new',
    customer: o.customer && typeof o.customer === 'object' ? o.customer : {},
    items: Array.isArray(o.items) ? o.items : [],
  };
}

// Добавление заказа. Переполнение горячего файла уезжает в начало архива:
// оба списка отсортированы от новых к старым, и вытесняются как раз самые
// старые из горячих — то есть самые новые из тех, что должны лежать в архиве.
function add(order) {
  const list = hot();
  list.unshift(order);
  if (list.length > HOT_LIMIT) {
    const overflow = list.splice(HOT_LIMIT);
    const old = archive();
    old.unshift(...overflow);
    store.write(ARCHIVE, old);
  }
  store.write(HOT, list);
  return order;
}

// Страница заказов. Пока запрошенный диапазон умещается в горячий файл,
// архив не читается вообще; фильтр по статусу вынуждает прочитать оба, иначе
// «показать отменённые» врало бы неполным списком.
function list({ status = '', offset = 0, limit = 50 } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));

  let source;
  if (status || off + lim > hot().length) source = [...hot(), ...archive()];
  else source = hot();

  let rows = source.map(normalize).filter(Boolean);
  if (status) rows = rows.filter(o => o.status === status);

  return {
    items: rows.slice(off, off + lim),
    total: rows.length,
    hasMore: off + lim < rows.length,
  };
}

function find(id) {
  const num = Number(id);
  return normalize(hot().find(o => o.id === num) || archive().find(o => o.id === num)) || null;
}

// Точечное изменение заказа. Ищем в обоих файлах и переписываем только тот,
// в котором заказ реально лежит — иначе правка статуса у старого заказа
// молча терялась бы.
function update(id, patch) {
  const num = Number(id);
  for (const key of [HOT, ARCHIVE]) {
    const rows = store.read(key, []);
    const i = rows.findIndex(o => o.id === num);
    if (i === -1) continue;
    rows[i] = { ...rows[i], ...patch };
    store.write(key, rows);
    return normalize(rows[i]);
  }
  return null;
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) return null;
  return update(id, { status, statusAt: new Date().toISOString() });
}

function clearAll() {
  store.write(HOT, []);
  store.write(ARCHIVE, []);
}

// Сводка для дашборда. Выручка считается по всем заказам, кроме отменённых:
// отменённый заказ в сумме продаж — это ровно тот случай, когда красивая
// цифра в админке расходится с деньгами на счёте.
function stats() {
  const all = [...hot(), ...archive()].map(normalize).filter(Boolean);
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  let revenue = 0;
  for (const o of all) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (o.status !== 'cancelled') revenue += Number(o.total) || 0;
  }
  return { total: all.length, archived: archive().length, byStatus, revenue };
}

// ---------- выгрузка ----------

// Экранирование по RFC 4180: кавычка удваивается, поле берётся в кавычки,
// если внутри есть разделитель, кавычка или перенос строки.
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Числа для русской локали пишем с запятой: Excel с системными настройками РФ
// иначе принимает «1234.5» за текст, и колонка не суммируется.
function csvNumber(n, locale) {
  const v = Number(n) || 0;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return /^ru/i.test(locale || '') ? s.replace('.', ',') : s;
}

function csvDate(iso, s) {
  try {
    return new Date(iso).toLocaleString(s.advanced.locale, { timeZone: s.advanced.timezone });
  } catch (e) {
    return String(iso || '');
  }
}

// CSV для Excel: разделитель «;» (в русской локали Excel запятая — десятичный
// знак и файл с ней разъезжается на одну колонку) и BOM в начале, без него
// Excel открывает UTF-8 как cp1251 и вместо кириллицы показывает кракозябры.
function toCSV(rows, s) {
  const locale = s.advanced.locale;
  const cur = s.commerce.currency;
  const head = [
    'Номер', 'Дата', 'Статус', 'Оплачен', 'Клиент', 'Телефон', 'Email',
    'Адрес', 'Доставка', 'Способ оплаты', 'Комментарий', 'Товары',
    `Сумма, ${cur}`, 'Промокод', `Скидка, ${cur}`, `Итого, ${cur}`,
  ];
  const lines = [head.map(csvCell).join(';')];

  for (const raw of rows) {
    const o = normalize(raw);
    if (!o) continue;
    const c = o.customer;
    const items = o.items.map(i => `${i.name} x${i.qty}`).join('; ');
    lines.push([
      o.id,
      csvDate(o.at, s),
      STATUS_LABELS[o.status] || o.status,
      o.paid ? 'да' : 'нет',
      c.name || (o.user && o.user.name) || '',
      c.phone || '',
      c.email || '',
      c.address || '',
      c.delivery || '',
      c.payment || '',
      c.comment || '',
      items,
      csvNumber(o.subtotal != null ? o.subtotal : o.total, locale),
      (o.promo && o.promo.code) || '',
      csvNumber(o.promo ? o.promo.discount : 0, locale),
      csvNumber(o.total, locale),
    ].map(csvCell).join(';'));
  }

  // \r\n — Excel на Windows не любит одиночный \n в CSV
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Всё разом для выгрузки: горячее плюс архив, от новых к старым.
function all() {
  return [...hot(), ...archive()].map(normalize).filter(Boolean);
}

module.exports = {
  STATUSES, STATUS_LABELS, HOT_LIMIT,
  add, list, find, update, setStatus, clearAll, stats, toCSV, all,
  _internal: { normalize, csvCell, csvNumber },
};
