'use strict';
// Заказы поверх SQL. Интерфейс тот же, что у файловой реализации в orders.js,
// поэтому наружу разницы нет — index.js и админка ничего не знают о бэкенде.
//
// Здесь исчезает деление на «горячий файл» и архив: оно существовало ровно
// потому, что переписывать на каждый заказ JSON из десяти тысяч записей дорого.
// В таблице с индексом по дате страница берётся LIMIT/OFFSET, фильтр по
// статусу — вторым индексом, счётчики — одним GROUP BY. Ничего никуда
// не вытесняется и не может потеряться.

const { STATUSES, STATUS_LABELS, toCSV, _internal } = require('./orders');
const { normalize } = _internal;

function createSqlOrders(db) {
  const insert = db.prepare('INSERT INTO orders (id, at, status, paid, total, doc) VALUES (?, ?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT doc FROM orders WHERE id = ?');
  const del = db.prepare('DELETE FROM orders');

  const parse = row => (row ? normalize(JSON.parse(row.doc)) : null);

  // Колонки повторяют то, что лежит в документе. Единственный источник правды —
  // документ; колонки существуют только ради запросов, поэтому пишутся всегда
  // из него и никогда отдельно.
  function columnsOf(o) {
    return [
      String(o.at || new Date().toISOString()),
      STATUSES.includes(o.status) ? o.status : 'new',
      o.paid ? 1 : 0,
      Number(o.total) || 0,
    ];
  }

  function add(order) {
    // id — это Date.now(), и два заказа в одну миллисекунду дают конфликт
    // первичного ключа. В файловом бэкенде такие заказы просто ложились
    // рядом с одинаковым номером, и find() всегда возвращал первый —
    // второй заказ существовал, но был недоступен. Здесь сдвигаем номер,
    // пока не найдём свободный: настоящих коллизий это стоит миллисекунды,
    // а тихой потери заказа больше не будет.
    let id = Number(order.id) || Date.now();
    for (let i = 0; i < 1000; i++) {
      const doc = { ...order, id };
      try {
        insert.run(id, ...columnsOf(doc), JSON.stringify(doc));
        return normalize(doc);
      } catch (e) {
        if (!/UNIQUE|PRIMARY KEY|constraint/i.test(e.message)) throw e;
        id += 1;
      }
    }
    throw new Error('не удалось подобрать свободный номер заказа');
  }

  function list({ status = '', offset = 0, limit = 50 } = {}) {
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));

    const where = status ? 'WHERE status = ?' : '';
    const args = status ? [status] : [];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT doc FROM orders ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, lim, off);

    return { items: rows.map(parse), total, hasMore: off + lim < total };
  }

  function find(id) {
    return parse(byId.get(Number(id)));
  }

  function update(id, patch) {
    const current = find(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare('UPDATE orders SET at = ?, status = ?, paid = ?, total = ?, doc = ? WHERE id = ?')
      .run(...columnsOf(next), JSON.stringify(next), Number(id));
    return normalize(next);
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) return null;
    return update(id, { status, statusAt: new Date().toISOString() });
  }

  function clearAll() { del.run(); }

  function stats() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n, SUM(total) AS sum FROM orders GROUP BY status').all();
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    let total = 0, revenue = 0;
    for (const r of rows) {
      byStatus[r.status] = r.n;
      total += r.n;
      // отменённые в выручку не идут — то же правило, что и в файловом бэкенде
      if (r.status !== 'cancelled') revenue += Number(r.sum) || 0;
    }
    // archived остаётся в ответе ради совместимости интерфейса: в SQL архива
    // нет, все заказы равноправны и лежат в одной таблице.
    return { total, archived: 0, byStatus, revenue };
  }

  function all() {
    return db.prepare('SELECT doc FROM orders ORDER BY at DESC, id DESC').all().map(parse);
  }

  return { add, list, find, update, setStatus, clearAll, stats, toCSV, all, STATUSES, STATUS_LABELS };
}

module.exports = { createSqlOrders };
