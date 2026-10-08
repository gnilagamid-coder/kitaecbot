'use strict';
// Каталог бота с сайта магазина (SITE_URL). Раз в минуту забираем ленту
// /api/bot/catalog и раскладываем в products.json и images/ — кнопочный
// магазин в чате, поиск, корзина и «Мои заказы» работают как раньше, а
// товары и цены те же, что на сайте. Заказ из корзины бот, как и раньше,
// рассылает сам, а копию отправляет сайту — она ложится в «Заявки».
//
// Ключ — тот же SITE_LEAD_TOKEN, по которому сайт шлёт боту заявки.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Картинки ленты в images/ — со своим префиксом: уборка трогает только их
const PREFIX = 'site_';
const EXT = /\.(webp|jpe?g|png)$/i;

// Стабильный числовой id по ключу ленты: товар остаётся тем же между
// обновлениями — корзины и ссылки «Мои заказы» не рассыпаются.
const idOf = key => parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12), 16);

// siteUrl — публичный адрес (ссылки «Открыть в приложении»), apiUrl — откуда
// забирать ленту и картинки: на одном сервере это внутренний http://127.0.0.1:…
function createSiteSync(t, { siteUrl, apiUrl = siteUrl, token, intervalMs = 60000, fetchImpl = fetch } = {}) {
  const tag = t.id ? `[site:${t.id}]` : '[site]';
  const base = String(apiUrl || '').replace(/\/+$/, '');
  const pub = String(siteUrl || '').replace(/\/+$/, '');
  const abs = u => new URL(String(u || ''), `${base}/`).toString();
  const link = u => new URL(String(u || ''), `${pub}/`).toString();
  let etag = '';
  let timer = null;
  let busy = null;
  let failing = false;
  let last = { at: 0, count: 0, error: '' };

  // Картинка по адресу → имя файла в images/. Уже скачанная не качается заново.
  async function download(url) {
    const ext = (EXT.exec(new URL(url).pathname) || [, 'webp'])[1].toLowerCase().replace('jpeg', 'jpg');
    const name = `${PREFIX}${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}.${ext}`;
    const file = path.join(t.store.IMG_DIR, name);
    if (fs.existsSync(file)) return name;
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`картинка ${url}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fsp.mkdir(t.store.IMG_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return name;
  }

  async function syncOnce() {
    const r = await fetchImpl(`${base}/api/bot/catalog`, {
      headers: { 'X-Site-Token': token, ...(etag ? { 'If-None-Match': etag } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 304) return { changed: false };
    if (r.status === 401) throw new Error('сайт не принял ключ — SITE_LEAD_TOKEN бота и BOT_SHOP_TOKEN сайта должны совпадать');
    if (!r.ok) throw new Error(`сайт ответил ${r.status}`);
    const feed = await r.json();
    const items = Array.isArray(feed.items) ? feed.items : [];

    const pics = new Map(); // адрес → имя файла (у комплектаций одного цвета картинка общая)
    const products = [];
    for (const [i, it] of items.entries()) {
      if (!it || !it.key || !it.name || !(Number(it.price) > 0)) continue;
      let images = [];
      if (it.image) {
        const url = abs(it.image);
        if (!pics.has(url)) pics.set(url, await download(url).catch(e => { console.warn(`${tag} ${e.message}`); return null; }));
        if (pics.get(url)) images = [pics.get(url)];
      }
      products.push({
        id: idOf(it.key),
        name: String(it.name).slice(0, 200),
        description: String(it.description || '').slice(0, 2000),
        category: String(it.category || '').slice(0, 80),
        price: Math.round(Number(it.price)),
        oldPrice: Number(it.oldPrice) > Number(it.price) ? Math.round(Number(it.oldPrice)) : 0,
        featured: Boolean(it.featured),
        hidden: false,
        badge: it.status === 'order' ? 'Под заказ' : '',
        images,
        thumbs: images,
        siteUrl: it.url && /^https:\/\//i.test(link(it.url)) ? link(it.url) : '',
        siteKey: String(it.key),
        sort: i,
      });
    }

    t.store.write('products', products);
    await t.store.flush();
    etag = r.headers.get('etag') || '';

    // картинки ленты, которых больше нет в каталоге, — убираем
    const used = new Set(products.flatMap(p => p.images));
    for (const f of await fsp.readdir(t.store.IMG_DIR).catch(() => [])) {
      if (f.startsWith(PREFIX) && !used.has(f)) await fsp.rm(path.join(t.store.IMG_DIR, f), { force: true }).catch(() => {});
    }
    return { changed: true, count: products.length };
  }

  // Один проход за раз: медленный сайт не наслаивает обновления друг на друга.
  // Позвали посреди прохода — значит, на сайте что-то поменялось уже после его
  // начала: пройдём ещё раз сразу следом.
  let again = false;
  function sync() {
    if (busy) {
      again = true;
      return busy;
    }
    busy = syncOnce().then(r => {
      if (r.changed) console.log(`${tag} каталог с сайта: ${r.count} ${r.count === 1 ? 'товар' : 'товаров'}`);
      if (failing) console.log(`${tag} связь с сайтом восстановлена`);
      failing = false;
      last = { at: Date.now(), count: r.changed ? r.count : last.count, error: '' };
      return r;
    }).catch(e => {
      // ошибку пишем один раз за серию, а не каждую минуту
      if (!failing) console.warn(`${tag} каталог с сайта не обновлён: ${e.message}`);
      failing = true;
      last = { ...last, error: e.message };
      return { changed: false, error: e.message };
    }).finally(() => {
      busy = null;
      if (again) { again = false; sync(); }
    });
    return busy;
  }

  function start() {
    sync();
    timer = setInterval(sync, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // Копия заказа из корзины — в «Заявки» сайта. Не дошла — заказ всё равно
  // принят и разослан ботом; в логе остаётся след.
  async function pushOrder(order) {
    try {
      const r = await fetchImpl(`${base}/api/bot/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Site-Token': token },
        body: JSON.stringify({
          id: order.id, total: order.total, items: order.items,
          customer: order.customer || {}, user: order.user || {},
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) console.warn(`${tag} заказ ${order.id} не попал в заявки сайта: ${r.status}`);
      return r.ok;
    } catch (e) {
      console.warn(`${tag} заказ ${order.id} не попал в заявки сайта: ${e.message}`);
      return false;
    }
  }

  return { start, stop, sync, pushOrder, state: () => ({ ...last }) };
}

module.exports = { createSiteSync, idOf };
