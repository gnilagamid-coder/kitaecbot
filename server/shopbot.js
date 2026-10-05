'use strict';
// Магазин прямо в чате бота — для тех, кому мини-апп непривычен или у кого
// он не открывается: каталог по разделам, карточки с фото, корзина и
// оформление заказа по шагам на обычных кнопках Telegram.
//
// Правила продажи здесь не дублируются: остатки, промокоды, минимальная
// сумма, сохранение заказа и уведомление менеджеру живут в checkout.js — тем
// же путём оформляет и мини-апп. Этот модуль только разговаривает с
// покупателем.
//
// Состояние покупателя (корзина, шаг оформления, черновик формы) лежит в
// документе 'chats' хранилища магазина: переживает перезапуск, а в режиме
// платформы уезжает в MySQL вместе с остальными документами.
//
// Все кнопки шлют callback_data с префиксом «s:», поэтому бот отличает их от
// старых кнопок подписки и не путает между собой. Telegram ограничивает
// callback_data 64 байтами — раздел в нём передаётся номером, а не названием.

const { esc } = require('./telegram');
const { money, applyPromo, placeOrder, createPaymentLink } = require('./checkout');
const { STATUS_LABELS } = require('./orders');

const PAGE_SIZE = 8;              // товаров на одной странице списка
const CAPTION_MAX = 1024;         // потолок подписи к фото в Telegram
const SEARCH_LIMIT = 50;
const SESSION_TTL_MS = 60 * 24 * 3600 * 1000; // брошенная корзина живёт два месяца
const SESSION_SOFT_CAP = 3000;    // после этого числа чатов чистим протухшие

// Подписи постоянной клавиатуры. Нажатие приходит обычным текстом — по этим
// же строкам его и узнаём.
const KB = {
  catalog: '🛍 Каталог',
  search: '🔎 Поиск',
  cart: '🛒 Корзина',
  orders: '📦 Мои заказы',
  manager: '💬 Менеджер',
  help: '❓ Помощь',
};
const KEYBOARD_NAV = new Map([
  [KB.catalog, 'catalog'], [KB.search, 'search'], [KB.cart, 'cart'],
  [KB.orders, 'orders'], [KB.manager, 'manager'], [KB.help, 'help'],
]);
const COMMAND_NAV = new Map([
  ['menu', 'home'], ['shop', 'catalog'], ['catalog', 'catalog'], ['search', 'search'],
  ['cart', 'cart'], ['orders', 'orders'], ['support', 'manager'], ['manager', 'manager'],
  ['help', 'help'], ['cancel', 'cancel'],
]);
const KB_CONTACT = '📱 Отправить мой номер';
const KB_SKIP = '⏭ Пропустить';
const KB_CANCEL = '✖️ Отменить оформление';

// Шаги оформления в порядке показа. Ненужные (поле выключено в админке)
// пропускаются — так чат спрашивает ровно то же, что форма мини-аппа.
const STEPS = ['name', 'phone', 'email', 'delivery', 'address', 'payment', 'comment', 'promo', 'agree', 'confirm'];

const STATUS_ICONS = { new: '🆕', processing: '⏳', shipped: '🚚', done: '✅', cancelled: '✖️' };

// ---------- чистые помощники ----------

// Что делает кнопка покупки — та же развилка, что quickBuy() в мини-аппе:
// корзина, сообщение менеджеру, заявка по товару или витрина без покупки.
function buyMode(s) {
  const m = s.commerce;
  if (m.mode === 'catalog') return 'none';
  if (m.mode === 'inquiry') return 'inquiry';
  if (m.mode === 'cart' && m.enableCart) return 'cart';
  return 'manager';
}
const hasCart = s => buyMode(s) === 'cart';
const hasOrders = s => buyMode(s) === 'cart' || buyMode(s) === 'inquiry';

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

// Обрезка по символам без разрыва суррогатной пары (эмодзи в названиях).
function cut(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  let end = max - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end).trimEnd() + '…';
}

// Длина текста так, как её считает Telegram: после разбора HTML-разметки.
function visibleLength(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot);/g, '_')
    .length;
}

function priceHtml(p, s) {
  if (s.commerce.priceHidden) return esc(s.commerce.priceHiddenText);
  const now = `<b>${esc(money(p.price, s))}</b>`;
  return p.oldPrice && p.oldPrice > p.price ? `<s>${esc(money(p.oldPrice, s))}</s>  ${now}` : now;
}

function pricePlain(p, s) {
  return s.commerce.priceHidden ? s.commerce.priceHiddenText : money(p.price, s);
}

function stockLine(p, s) {
  if (typeof p.stock !== 'number') return '';
  if (p.stock === 0) return '❌ Нет в наличии';
  if (!s.catalog.showStock) return '';
  return p.stock <= s.catalog.lowStockThreshold ? `⚠️ Осталось ${p.stock} шт.` : `✅ В наличии: ${p.stock} шт.`;
}

const maxQty = p => (typeof p.stock === 'number' ? Math.min(999, p.stock) : 999);

// t.me и wa.me открывают чат с готовым черновиком через ?text= — ровно как
// openBuyLink() в мини-аппе. Пробелы кодируем %20, а не «+»: Telegram
// показывает плюсы буквально.
function draftLink(url, text) {
  try {
    const u = new URL(url);
    if (['t.me', 'telegram.me', 'wa.me'].includes(u.hostname) && text) {
      return `${u.origin}${u.pathname}?text=${encodeURIComponent(text)}`;
    }
  } catch (e) { /* не URL — отдаём как есть */ }
  return url;
}

const btn = (text, data) => ({ text, callback_data: `s:${data}` });

function stripWebApp(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  const rows = markup.inline_keyboard
    .map(r => r.filter(b => !b.web_app))
    .filter(r => r.length);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

const notModified = r => r && !r.ok && /not modified/i.test(r.description || '');

// ---------- экземпляр на магазин ----------
// helpers — то, что живёт в bot.js и нужно здесь: уведомление менеджеров,
// адрес мини-аппа, нормализация ссылок, подстановка переменных. Передаются
// явно, а не через require: bot.js сам подключает этот модуль.
function createShopBot(t, helpers) {
  const { tgApi, tgUpload } = t.telegram;
  const settings = () => t.settings();
  const { notifyManagers, shopWebAppUrl, normalize, fill } = helpers;
  const tag = t.id ? `[shopbot:${t.id}]` : '[shopbot]';

  // id картинки → file_id в Telegram. Первый показ грузит файл с диска,
  // дальше Telegram получает уже готовый file_id.
  const photoIds = new Map();
  // Чаты, где прямо сейчас оформляется заказ: двойное нажатие «Подтвердить»
  // не должно превратиться в два одинаковых заказа.
  const placing = new Set();

  // ----- сессии -----

  function loadSession(chatId) {
    const all = t.store.read('chats', {});
    const raw = all[chatId];
    const sess = raw && typeof raw === 'object' ? raw : {};
    return {
      cart: sess.cart && typeof sess.cart === 'object' ? sess.cart : {},
      step: sess.step || null,
      draft: sess.draft || null,
      contact: sess.contact || {},
      search: Array.isArray(sess.search) ? sess.search : [],
      at: sess.at || 0,
    };
  }

  function saveSession(chatId, sess) {
    const all = t.store.read('chats', {});
    sess.at = Date.now();
    all[chatId] = sess;
    const ids = Object.keys(all);
    if (ids.length > SESSION_SOFT_CAP) {
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const id of ids) if (!all[id] || (all[id].at || 0) < cutoff) delete all[id];
    }
    t.store.write('chats', all);
  }

  // ----- каталог -----

  function productsRaw() {
    return t.store.read('products', []).filter(p => p && !p.hidden);
  }

  function visibleProducts(s) {
    let list = productsRaw();
    if (s.catalog.hideSoldOut) list = list.filter(p => p.stock !== 0);
    const sort = s.catalog.defaultSort;
    if (sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price);
    else if (sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price);
    else if (sort === 'name') list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), s.advanced.locale || 'ru'));
    return list;
  }

  // Разделы — в порядке товаров в админке, без учёта сортировки по цене:
  // номер раздела уходит в кнопку, и от смены цен он не должен уезжать.
  function categories(s) {
    const counts = new Map();
    let list = productsRaw();
    if (s.catalog.hideSoldOut) list = list.filter(p => p.stock !== 0);
    for (const p of list) {
      const c = String(p.category || '').trim();
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }

  const showFeatured = (s, all) => s.catalog.showFeaturedBadge && all.some(p => p.featured);

  // Ключ списка: a — все товары, f — хиты, s — последний поиск, k<n> — раздел.
  function resolveList(s, sess, key) {
    const all = visibleProducts(s);
    if (key === 'f') return { title: `🔥 ${s.catalog.featuredLabel || 'Хиты'}`, items: all.filter(p => p.featured) };
    if (key === 's') {
      const byId = new Map(all.map(p => [p.id, p]));
      return { title: '🔎 Результаты поиска', items: sess.search.map(id => byId.get(id)).filter(Boolean) };
    }
    if (/^k\d+$/.test(key)) {
      const cat = categories(s)[Number(key.slice(1))];
      if (cat) return { title: `📂 ${cat.name}`, items: all.filter(p => String(p.category || '').trim() === cat.name) };
    }
    return { title: '📋 Все товары', items: all };
  }

  // Корень каталога нужен, только когда есть из чего выбирать: два раздела
  // и больше или подборка хитов. Иначе сразу показываем список.
  function hasCatalogRoot(s) {
    const all = visibleProducts(s);
    return (s.catalog.showCategories && categories(s).length > 1) || showFeatured(s, all);
  }

  function findProduct(id) {
    return productsRaw().find(p => p.id === Number(id)) || null;
  }

  // ----- корзина -----

  function cartLines(sess) {
    const all = productsRaw();
    const lines = [];
    for (const [id, qty] of Object.entries(sess.cart)) {
      const p = all.find(x => x.id === Number(id));
      if (p && qty > 0) lines.push({ p, qty: Math.min(qty, maxQty(p)) });
    }
    return lines.filter(l => l.qty > 0);
  }

  const cartCount = sess => cartLines(sess).reduce((n, l) => n + l.qty, 0);
  const cartTotal = lines => lines.reduce((sum, l) => sum + (Number(l.p.price) || 0) * l.qty, 0);

  function cartButtonLabel(s, sess) {
    const lines = cartLines(sess);
    if (!lines.length) return KB.cart;
    const n = lines.reduce((k, l) => k + l.qty, 0);
    return s.commerce.priceHidden ? `🛒 Корзина · ${n} шт.` : `🛒 Корзина · ${n} шт. · ${money(cartTotal(lines), s)}`;
  }

  // ----- доставка экранов -----

  async function sendPhoto(chatId, imageId, caption, markup) {
    const base = { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: markup };
    const cached = photoIds.get(imageId);
    if (cached) {
      const r = await tgApi('sendPhoto', { ...base, photo: cached });
      if (r.ok) return r;
      photoIds.delete(imageId);
    }
    const file = t.store.imagePath(imageId);
    if (!file) return { ok: false, description: 'файл картинки не найден' };
    const r = await tgUpload('sendPhoto', base, { photo: file });
    rememberPhoto(imageId, r);
    if (!r.ok) console.warn(`${tag} фото ${imageId} не отправлено: ${r.description}`);
    return r;
  }

  async function editPhoto(chatId, messageId, imageId, caption, markup) {
    const target = { chat_id: chatId, message_id: messageId, reply_markup: markup };
    const media = { type: 'photo', caption, parse_mode: 'HTML' };
    const cached = photoIds.get(imageId);
    if (cached) {
      const r = await tgApi('editMessageMedia', { ...target, media: { ...media, media: cached } });
      if (r.ok || notModified(r)) return { ok: true };
      photoIds.delete(imageId);
    }
    const file = t.store.imagePath(imageId);
    if (!file) return { ok: false, description: 'файл картинки не найден' };
    const r = await tgUpload('editMessageMedia', { ...target, media: { ...media, media: 'attach://photo' } }, { photo: file });
    rememberPhoto(imageId, r);
    return r.ok || notModified(r) ? { ok: true } : r;
  }

  function rememberPhoto(imageId, r) {
    const sizes = r && r.ok && r.result && r.result.photo;
    if (Array.isArray(sizes) && sizes.length) photoIds.set(imageId, sizes[sizes.length - 1].file_id);
  }

  async function sendText(chatId, text, markup) {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup };
    let r = await tgApi('sendMessage', payload);
    if (r.ok || !markup) return r;
    // Чаще всего отказ — web_app-кнопка с доменом, не привязанным в
    // @BotFather. Без неё экран полезнее, чем никакого.
    console.warn(`${tag} экран не отправлен: ${r.description} — повторяю без кнопки мини-аппа`);
    r = await tgApi('sendMessage', { ...payload, reply_markup: stripWebApp(markup) });
    if (r.ok) return r;
    return tgApi('sendMessage', { ...payload, reply_markup: undefined });
  }

  // Новый экран отдельным сообщением.
  async function send(chatId, screen) {
    const markup = screen.kb && screen.kb.length ? { inline_keyboard: screen.kb } : undefined;
    if (screen.photo) {
      const r = await sendPhoto(chatId, screen.photo, screen.text, markup);
      if (r.ok) return r;
    }
    return sendText(chatId, screen.text, markup);
  }

  // Экран вместо сообщения, на котором нажали кнопку. Текст правится в
  // текст, фото — в фото; смена типа так не правится, поэтому старое
  // сообщение убираем и присылаем новое.
  async function show(chatId, screen, msg) {
    if (!msg || !msg.message_id) return send(chatId, screen);
    const markup = screen.kb && screen.kb.length ? { inline_keyboard: screen.kb } : undefined;
    const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

    if (screen.photo && isPhoto) {
      const r = await editPhoto(chatId, msg.message_id, screen.photo, screen.text, markup);
      if (r.ok) return r;
    } else if (!screen.photo && !isPhoto && msg.text !== undefined) {
      const r = await tgApi('editMessageText', {
        chat_id: chatId, message_id: msg.message_id, text: screen.text,
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup,
      });
      if (r.ok || notModified(r)) return { ok: true };
    }
    await tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    return send(chatId, screen);
  }

  // ----- клавиатуры -----

  function managerUrl(s) {
    const raw = s.manager.supportUrl || s.manager.buyUrl;
    return raw ? normalize(raw) : '';
  }

  const inquiriesReachManager = s => s.notify.enabled && s.notify.onInquiry && s.notify.chatIds.length > 0;
  const managerAvailable = s => Boolean(managerUrl(s)) || inquiriesReachManager(s);

  function mainKeyboard(s) {
    const rows = [[KB.catalog, KB.search]];
    const second = [];
    if (hasCart(s)) second.push(KB.cart);
    if (hasOrders(s)) second.push(KB.orders);
    if (second.length) rows.push(second);
    rows.push(managerAvailable(s) ? [KB.manager, KB.help] : [KB.help]);
    return {
      keyboard: rows.map(r => r.map(text => ({ text }))),
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: 'Выберите раздел в меню ниже',
    };
  }

  function appButton(s, chatId) {
    const url = shopWebAppUrl(s);
    return url && Number(chatId) > 0 ? { text: '📱 Открыть в приложении', web_app: { url } } : null;
  }

  // ----- экраны -----

  function homeScreen(s, sess, chatId) {
    const b = s.brand;
    const L = [`<b>${b.shopIcon ? esc(b.shopIcon) + ' ' : ''}${esc(b.shopName)}</b>`];
    if (b.tagline) L.push(`<i>${esc(b.tagline)}</i>`);
    if (s.profile.aboutText) L.push('', esc(s.profile.aboutText));
    L.push('', hasCart(s)
      ? 'Выбирайте товары и оформляйте заказ прямо здесь, в чате 👇'
      : 'Смотрите каталог прямо здесь, в чате 👇');

    const kb = [[btn('🛍 Каталог', 'c'), btn('🔎 Поиск', 'q')]];
    const second = [];
    if (hasCart(s)) second.push(btn(cartButtonLabel(s, sess), 'C'));
    if (hasOrders(s)) second.push(btn('📦 Мои заказы', 'O'));
    if (second.length) kb.push(second);
    const app = appButton(s, chatId);
    if (app) kb.push([app]);
    if (managerAvailable(s)) kb.push([btn('💬 Связаться с менеджером', 'M')]);
    if (s.announce && s.announce.enabled) {
      const users = t.store.read('users', {});
      const on = Boolean(users[chatId] && users[chatId].subAnnounce === true);
      kb.push([on ? btn('🔕 Не сообщать о новинках', 'u:0') : btn('🔔 Сообщать о новинках', 'u:1')]);
    }
    return { text: L.join('\n'), kb };
  }

  function catalogScreen(s, sess) {
    const all = visibleProducts(s);
    if (!all.length) {
      return { text: esc(s.catalog.emptyText), kb: [[btn('🏠 Главная', 'h')]] };
    }
    if (!hasCatalogRoot(s)) return listScreen(s, sess, 'a', 0);

    const kb = [];
    if (showFeatured(s, all)) {
      kb.push([btn(`🔥 ${s.catalog.featuredLabel || 'Хиты'} · ${all.filter(p => p.featured).length}`, 'l:f:0')]);
    }
    if (s.catalog.showCategories) {
      const cats = categories(s);
      for (let i = 0; i < cats.length; i += 2) {
        kb.push(cats.slice(i, i + 2).map((c, j) => btn(`${cut(c.name, 28)} · ${c.count}`, `l:k${i + j}:0`)));
      }
    }
    kb.push([btn(`📋 Все товары · ${all.length}`, 'l:a:0')]);
    kb.push([btn('🔎 Поиск', 'q'), btn('🏠 Главная', 'h')]);
    return { text: '🛍 <b>Каталог</b>\n\nВыберите раздел 👇', kb };
  }

  function productLabel(p, s) {
    const hot = p.featured && s.catalog.showFeaturedBadge ? '🔥 ' : '';
    const tail = p.stock === 0 ? 'нет в наличии' : pricePlain(p, s);
    return `${hot}${cut(p.name, 34)} · ${tail}`;
  }

  function listScreen(s, sess, key, page) {
    const { title, items } = resolveList(s, sess, key);
    const back = hasCatalogRoot(s) ? btn('⬅️ Разделы', 'c') : btn('🏠 Главная', 'h');
    if (!items.length) {
      return {
        text: `<b>${esc(title)}</b>\n\nЗдесь пока пусто.`,
        kb: [[back, btn('🔎 Поиск', 'q')]],
      };
    }
    const pages = Math.ceil(items.length / PAGE_SIZE);
    const pg = Math.min(Math.max(0, Number(page) || 0), pages - 1);
    const slice = items.slice(pg * PAGE_SIZE, pg * PAGE_SIZE + PAGE_SIZE);

    const kb = slice.map(p => [btn(productLabel(p, s), `p:${p.id}:${key}:0`)]);
    if (pages > 1) {
      kb.push([
        btn('◀️', `l:${key}:${(pg - 1 + pages) % pages}`),
        btn(`${pg + 1} / ${pages}`, 'x'),
        btn('▶️', `l:${key}:${(pg + 1) % pages}`),
      ]);
    }
    const bottom = [back];
    if (hasCart(s)) bottom.push(btn(cartButtonLabel(s, sess), 'C'));
    kb.push(bottom);

    const count = `${items.length} ${plural(items.length, 'товар', 'товара', 'товаров')}`;
    const where = pages > 1 ? ` · страница ${pg + 1} из ${pages}` : '';
    return {
      text: `<b>${esc(title)}</b>\n${count}${where}\n\nНажмите на товар, чтобы увидеть фото и подробности 👇`,
      kb,
    };
  }

  function productCaption(p, s, inCart) {
    let title = `<b>${esc(p.name)}</b>`;
    if (p.badge) title += `  ·  ${esc(p.badge)}`;
    else if (p.featured && s.catalog.showFeaturedBadge) title += `  ·  🔥 ${esc(s.catalog.featuredLabel)}`;
    const head = [title, priceHtml(p, s)];
    const stock = stockLine(p, s);
    if (stock) head.push(stock);
    if (p.category) head.push(`📂 ${esc(p.category)}`);
    const headText = head.join('\n');
    const tail = inCart ? `\n\n🛒 В корзине: ${inCart} шт.` : '';

    const desc = String(p.description || '').trim();
    const room = CAPTION_MAX - visibleLength(headText) - visibleLength(tail) - 4;
    const body = desc && room > 20 ? `\n\n${esc(cut(desc, room))}` : '';
    return headText + body + tail;
  }

  function buyRow(s, p, sess, key, img) {
    const mode = buyMode(s);
    if (mode === 'none') return null;
    if (p.stock === 0) return [btn('❌ Нет в наличии', 'x')];
    if (mode === 'cart') {
      const q = sess.cart[p.id] || 0;
      if (!q) return [btn('🛒 Добавить в корзину', `+:${p.id}:${key}:${img}`)];
      return [btn('➖', `-:${p.id}:${key}:${img}`), btn(`${q} шт. в корзине`, 'C'), btn('➕', `+:${p.id}:${key}:${img}`)];
    }
    if (mode === 'inquiry') return [btn(`📝 ${s.commerce.ctaProduct || 'Оставить заявку'}`, `i:${p.id}`)];
    return [btn(`💬 ${s.commerce.ctaProduct || 'Купить через менеджера'}`, `m:${p.id}`)];
  }

  function productScreen(s, sess, id, key, img) {
    const { items } = resolveList(s, sess, key);
    const idx = items.findIndex(x => x.id === Number(id));
    const p = idx >= 0 ? items[idx] : findProduct(id);
    if (!p) {
      return { text: 'Этот товар больше недоступен.', kb: [[btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]] };
    }
    const images = (p.images || []).filter(Boolean);
    const n = images.length;
    const im = n ? ((Number(img) || 0) % n + n) % n : 0;

    const kb = [];
    const buy = buyRow(s, p, sess, key, im);
    if (buy) kb.push(buy);
    if (hasCart(s) && cartCount(sess) > 0) kb.push([btn(`${cartButtonLabel(s, sess)} →`, 'C')]);
    if (n > 1) {
      kb.push([
        btn('◀️ фото', `p:${p.id}:${key}:${im - 1}`),
        btn(`🖼 ${im + 1} из ${n}`, 'x'),
        btn('фото ▶️', `p:${p.id}:${key}:${im + 1}`),
      ]);
    }
    if (idx >= 0 && items.length > 1) {
      const prev = items[(idx - 1 + items.length) % items.length];
      const next = items[(idx + 1) % items.length];
      kb.push([
        btn('⬅️', `p:${prev.id}:${key}:0`),
        btn(`товар ${idx + 1} из ${items.length}`, 'x'),
        btn('➡️', `p:${next.id}:${key}:0`),
      ]);
    }
    const page = idx >= 0 ? Math.floor(idx / PAGE_SIZE) : 0;
    kb.push([btn('📋 К списку', `l:${key}:${page}`), btn('🏠 Главная', 'h')]);

    return { text: productCaption(p, s, sess.cart[p.id] || 0), kb, photo: images[im] || null };
  }

  function cartScreen(s, sess) {
    const lines = cartLines(sess);
    if (!lines.length) {
      return {
        text: '🛒 <b>Корзина пуста</b>\n\nЗагляните в каталог — там есть из чего выбрать 👇',
        kb: [[btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]],
      };
    }
    const hidden = s.commerce.priceHidden;
    const total = cartTotal(lines);
    const L = ['🛒 <b>Ваша корзина</b>', ''];
    lines.forEach((l, i) => {
      L.push(`${i + 1}. ${esc(l.p.name)}`);
      L.push(hidden
        ? `     ${l.qty} шт.`
        : `     ${l.qty} × ${esc(money(l.p.price, s))} = <b>${esc(money(l.p.price * l.qty, s))}</b>`);
    });
    if (!hidden) L.push('', `💰 <b>Итого: ${esc(money(total, s))}</b>`);

    const min = s.commerce.minOrder;
    const below = min && total < min;
    if (below) L.push('', `⚠️ Минимальный заказ — ${esc(money(min, s))}. Добавьте товаров ещё на ${esc(money(min - total, s))}.`);
    L.push('', 'Количество меняется кнопками ➖ ➕, нажатие на название открывает товар.');

    const kb = lines.map(l => [
      btn('➖', `C-:${l.p.id}`),
      btn(`${cut(l.p.name, 20)} · ${l.qty}`, `p:${l.p.id}:a:0`),
      btn('➕', `C+:${l.p.id}`),
    ]);
    if (!below) {
      const cta = s.commerce.ctaCart || 'Оформить заказ';
      kb.push([btn(`✅ ${cta}${hidden ? '' : ' · ' + money(total, s)}`, 'o')]);
    }
    kb.push([btn('🗑 Очистить', 'Cx'), btn('🛍 Продолжить покупки', 'c')]);
    return { text: L.join('\n'), kb };
  }

  function ordersScreen(s, userId) {
    const mine = t.orders.all().filter(o => o.user && Number(o.user.id) === Number(userId)).slice(0, 10);
    if (!mine.length) {
      return { text: '📦 <b>Мои заказы</b>\n\nЗаказов пока нет.', kb: [[btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]] };
    }
    const L = ['📦 <b>Мои заказы</b>'];
    const kb = [];
    for (const o of mine) {
      let date = '';
      try { date = new Date(o.at).toLocaleDateString(s.advanced.locale, { timeZone: s.advanced.timezone }); } catch (e) { /* дата не критична */ }
      const items = o.items.map(i => `${esc(i.name)} × ${i.qty}`).join(', ');
      const status = `${STATUS_ICONS[o.status] || ''} ${STATUS_LABELS[o.status] || o.status}`.trim();
      L.push('', `<b>№ ${o.id}</b>${date ? ' · ' + esc(date) : ''}`, cut(items, 300));
      L.push(`${s.commerce.priceHidden ? '' : esc(money(o.total, s)) + ' · '}${status}${o.paid ? ' · 💳 оплачен' : ''}`);
      if (s.payments.enabled && !o.paid && o.status !== 'cancelled' && kb.length < 3) {
        kb.push([btn(`💳 Оплатить № ${o.id}`, `pay:${o.id}`)]);
      }
    }
    kb.push([btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]);
    return { text: L.join('\n'), kb };
  }

  function managerScreen(s) {
    const url = managerUrl(s);
    if (url) {
      return {
        text: '💬 <b>Связь с менеджером</b>\n\nНажмите кнопку ниже — откроется чат с менеджером.',
        kb: [[{ text: '💬 Написать менеджеру', url }], [btn('🏠 Главная', 'h')]],
      };
    }
    if (inquiriesReachManager(s)) {
      return {
        text: '💬 <b>Связь с менеджером</b>\n\nПросто напишите вопрос сюда, в этот чат, — менеджер получит его и ответит вам.',
        kb: [[btn('🏠 Главная', 'h')]],
      };
    }
    return { text: 'Связь с менеджером пока не настроена.', kb: [[btn('🏠 Главная', 'h')]] };
  }

  function helpText(s, name) {
    const L = [];
    const own = fill(s.bot.helpText, { name, shop: esc(s.brand.shopName) }).trim();
    if (own) L.push(own, '');
    L.push('<b>Как пользоваться</b>');
    L.push(`${KB.catalog} — товары по разделам, с фото и ценами`);
    L.push(`${KB.search} — найти товар по названию`);
    if (hasCart(s)) L.push(`${KB.cart} — проверить выбранное и оформить заказ`);
    if (hasOrders(s)) L.push(`${KB.orders} — что с вашими заказами`);
    if (managerAvailable(s)) L.push(`${KB.manager} — задать вопрос человеку`);
    L.push('', 'Кнопки всегда внизу, под полем ввода. Если они пропали — отправьте /start');
    return L.join('\n');
  }

  // ----- оформление -----

  function stepNeeded(step, s) {
    const c = s.checkout;
    switch (step) {
      case 'name': return c.askName;
      case 'phone': return c.askPhone;
      case 'email': return c.askEmail;
      case 'delivery': return c.deliveryMethods.length > 0;
      case 'address': return c.askAddress && c.deliveryMethods.length > 0;
      case 'payment': return c.paymentMethods.length > 0;
      case 'comment': return c.askComment;
      case 'promo': return s.promo.enabled;
      case 'agree': return c.requireAgreement;
      default: return true;
    }
  }

  const nextStep = (s, after) => STEPS.slice(after ? STEPS.indexOf(after) + 1 : 0).find(st => stepNeeded(st, s));

  function orderItems(sess) {
    const d = sess.draft || {};
    if (d.inquiry) return [{ id: d.inquiry, qty: 1 }];
    return cartLines(sess).map(l => ({ id: l.p.id, qty: l.qty }));
  }

  function draftSubtotal(sess) {
    const all = productsRaw();
    return orderItems(sess).reduce((sum, i) => {
      const p = all.find(x => x.id === Number(i.id));
      return sum + (p ? (Number(p.price) || 0) * i.qty : 0);
    }, 0);
  }

  // Подсказка «как в прошлый раз»: постоянному покупателю не нужно
  // перепечатывать имя и телефон в каждом заказе.
  function suggestion(step, sess, from) {
    const saved = sess.contact || {};
    if (step === 'name') return saved.name || (from && from.first_name) || '';
    if (step === 'phone' || step === 'email' || step === 'address') return saved[step] || '';
    return '';
  }

  const CANCEL = btn('✖️ Отменить', 'fx');

  function stepScreen(s, sess, from, error) {
    const step = sess.step;
    const c = s.checkout;
    const d = sess.draft || {};
    const warn = error ? `⚠️ ${esc(error)}\n\n` : '';
    const hint = sess.draft && sess.draft.inquiry ? '📝 <b>Заявка</b>' : '🧾 <b>Оформление заказа</b>';
    const sug = suggestion(step, sess, from);
    const useBtn = sug ? [btn(`✅ ${cut(sug, 40)}`, 'fu')] : null;

    switch (step) {
      case 'name':
        return { text: `${warn}${hint}\n\n👤 Как к вам обращаться?\n\nНапишите имя в ответ ✍️`, kb: [useBtn, [CANCEL]].filter(Boolean) };
      case 'phone': {
        // Номер удобнее всего отдать кнопкой «поделиться контактом» — она
        // бывает только у обычной клавиатуры, поэтому этот шаг без инлайна.
        const rows = [[{ text: KB_CONTACT, request_contact: true }]];
        if (sug) rows.push([{ text: sug }]);
        if (!c.phoneRequired) rows.push([{ text: KB_SKIP }]);
        rows.push([{ text: KB_CANCEL }]);
        return {
          text: `${warn}${hint}\n\n📱 Ваш номер телефона${c.phoneRequired ? '' : ' (по желанию)'}\n\nНажмите «${KB_CONTACT}» внизу или напишите номер вручную ✍️`,
          reply: { keyboard: rows, resize_keyboard: true, one_time_keyboard: true },
        };
      }
      case 'email':
        return { text: `${warn}${hint}\n\n✉️ Ваш email (по желанию)\n\nНапишите адрес в ответ ✍️`, kb: [useBtn, [btn('⏭ Пропустить', 'fs')], [CANCEL]].filter(Boolean) };
      case 'delivery':
        return {
          text: `${warn}${hint}\n\n🚚 Как доставить заказ?`,
          kb: [...c.deliveryMethods.map((m, i) => [btn(`${d.delivery === m ? '✅ ' : ''}${m}`, `fd:${i}`)]), [CANCEL]],
        };
      case 'address':
        return { text: `${warn}${hint}\n\n📍 Адрес доставки\n\nГород, улица, дом, квартира — одним сообщением ✍️`, kb: [useBtn, [btn('⏭ Пропустить', 'fs')], [CANCEL]].filter(Boolean) };
      case 'payment':
        return {
          text: `${warn}${hint}\n\n💳 Как удобнее оплатить?`,
          kb: [...c.paymentMethods.map((m, i) => [btn(`${d.payment === m ? '✅ ' : ''}${m}`, `fp:${i}`)]), [CANCEL]],
        };
      case 'comment':
        return { text: `${warn}${hint}\n\n📝 Комментарий к заказу\n\nНапишите пожелания или нажмите «Пропустить» ✍️`, kb: [[btn('⏭ Пропустить', 'fs')], [CANCEL]] };
      case 'promo':
        return { text: `${warn}${hint}\n\n🏷 ${esc(s.promo.label)}\n\nЕсли есть — напишите его в ответ ✍️`, kb: [[btn('Без промокода', 'fs')], [CANCEL]] };
      case 'agree':
        return { text: `${warn}${hint}\n\n${esc(c.agreementText)}`, kb: [[btn('✅ Согласен', 'fa')], [CANCEL]] };
      default:
        return confirmScreen(s, sess, from, warn);
    }
  }

  function confirmScreen(s, sess, from, warn = '') {
    const d = sess.draft || {};
    const all = productsRaw();
    const hidden = s.commerce.priceHidden;
    const L = [`${warn}✅ <b>Проверьте ${d.inquiry ? 'заявку' : 'заказ'}</b>`, ''];
    for (const i of orderItems(sess)) {
      const p = all.find(x => x.id === Number(i.id));
      if (!p) continue;
      L.push(hidden ? `• ${esc(p.name)} × ${i.qty}` : `• ${esc(p.name)} × ${i.qty} = ${esc(money(p.price * i.qty, s))}`);
    }
    const subtotal = draftSubtotal(sess);
    let total = subtotal;
    if (d.promo) {
      const r = applyPromo(s, d.promo, subtotal);
      if (r.ok) {
        total = r.total;
        L.push('', `Сумма: ${esc(money(subtotal, s))}`, `🏷 Промокод <code>${esc(r.code)}</code> (${esc(r.label)}): −${esc(money(r.discount, s))}`);
      }
    }
    if (!hidden) L.push(`💰 <b>Итого: ${esc(money(total, s))}</b>`);
    const who = [
      d.name && `👤 ${esc(d.name)}`,
      d.phone && `📱 ${esc(d.phone)}`,
      d.email && `✉️ ${esc(d.email)}`,
      d.delivery && `🚚 ${esc(d.delivery)}`,
      d.address && `📍 ${esc(d.address)}`,
      d.payment && `💳 ${esc(d.payment)}`,
      d.comment && `📝 ${esc(d.comment)}`,
    ].filter(Boolean);
    if (who.length) L.push('', ...who);
    return {
      text: L.join('\n'),
      kb: [
        [btn(d.inquiry ? '✅ Отправить заявку' : '✅ Подтвердить заказ', 'fok')],
        [btn('✏️ Заполнить заново', 'fr'), CANCEL],
      ],
    };
  }

  // Показ шага. Шаг с телефоном живёт на обычной клавиатуре, поэтому всегда
  // уходит новым сообщением; остальные правят то, на чём нажали кнопку.
  async function promptStep(chatId, sess, from, msg, error) {
    const s = settings();
    const screen = stepScreen(s, sess, from, error);
    if (screen.reply) {
      if (msg && msg.message_id) await tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return sendText(chatId, screen.text, screen.reply);
    }
    return show(chatId, screen, msg);
  }

  // Вернуть главное меню под полем ввода после шага с телефоном.
  async function restoreKeyboard(chatId, text) {
    return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: mainKeyboard(settings()) });
  }

  async function advance(chatId, sess, from, msg) {
    const s = settings();
    const was = sess.step;
    sess.step = nextStep(s, was);
    saveSession(chatId, sess);
    if (was === 'phone') {
      await restoreKeyboard(chatId, sess.draft.phone ? '✅ Телефон записали' : 'Хорошо, без телефона');
      msg = null;
    }
    return promptStep(chatId, sess, from, msg);
  }

  async function startCheckout(chatId, from, msg, inquiryId) {
    const s = settings();
    const sess = loadSession(chatId);
    if (s.advanced.maintenanceMode) return show(chatId, maintenanceScreen(s), msg);

    if (inquiryId) {
      const p = findProduct(inquiryId);
      if (!p || p.stock === 0) return show(chatId, { text: 'Этот товар сейчас недоступен.', kb: [[btn('🛍 Каталог', 'c')]] }, msg);
      sess.draft = { inquiry: p.id };
    } else {
      const lines = cartLines(sess);
      if (!lines.length) return show(chatId, cartScreen(s, sess), msg);
      if (s.commerce.minOrder && cartTotal(lines) < s.commerce.minOrder) return show(chatId, cartScreen(s, sess), msg);
      sess.draft = { inquiry: null };
    }
    sess.step = null;
    return advance(chatId, sess, from, msg);
  }

  function rememberContact(sess, field, value) {
    sess.contact = { ...(sess.contact || {}), [field]: value };
  }

  // Ответ текстом на вопрос шага. Возвращает текст ошибки или '' — принято.
  function acceptInput(s, sess, step, text, contact) {
    const d = sess.draft;
    const c = s.checkout;
    switch (step) {
      case 'name':
        if (!text || text.length > 60) return 'Имя — от 1 до 60 символов';
        d.name = text; rememberContact(sess, 'name', text); return '';
      case 'phone': {
        const phone = contact ? String(contact.phone_number || '') : text;
        if (!contact && text === KB_SKIP && !c.phoneRequired) { d.phone = ''; return ''; }
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) return c.phoneRequired ? 'Нужен номер телефона — минимум 10 цифр' : 'Проверьте номер — в нём должно быть минимум 10 цифр';
        const value = contact && !phone.startsWith('+') ? `+${phone}` : phone;
        d.phone = cut(value, 32); rememberContact(sess, 'phone', d.phone); return '';
      }
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'Проверьте адрес почты — например, mail@example.com';
        d.email = cut(text, 120); rememberContact(sess, 'email', d.email); return '';
      case 'address':
        if (text.length < 3) return 'Адрес слишком короткий';
        d.address = cut(text, 300); rememberContact(sess, 'address', d.address); return '';
      case 'comment':
        d.comment = cut(text, 500); return '';
      case 'promo': {
        const r = applyPromo(s, text, draftSubtotal(sess));
        if (!r.ok) return r.error;
        d.promo = r.code; return '';
      }
      default:
        return 'Выберите вариант кнопкой ниже 👇';
    }
  }

  async function finishCheckout(chatId, from, msg) {
    const s = settings();
    const sess = loadSession(chatId);
    if (!sess.draft || sess.step !== 'confirm') {
      return show(chatId, { text: 'Этот заказ уже оформлен или отменён.', kb: [[btn('📦 Мои заказы', 'O'), btn('🏠 Главная', 'h')]] }, msg);
    }
    if (placing.has(chatId)) return null;
    placing.add(chatId);
    try {
      const d = sess.draft;
      const customer = {};
      for (const k of ['name', 'phone', 'email', 'address', 'delivery', 'payment', 'comment']) if (d[k]) customer[k] = d[k];
      const tgUser = { id: from.id, username: from.username || '', first_name: from.first_name || '' };
      const placed = await placeOrder(t, { items: orderItems(sess), customer, tgUser, promoCode: d.promo, source: 'chat' });
      if (!placed.ok) {
        return show(chatId, {
          text: `⚠️ <b>Не получилось оформить</b>\n\n${esc(placed.error)}`,
          kb: [[btn(hasCart(s) ? '🛒 Корзина' : '🛍 Каталог', hasCart(s) ? 'C' : 'c'), btn('🏠 Главная', 'h')]],
        }, msg);
      }
      if (!d.inquiry) sess.cart = {};
      sess.step = null;
      sess.draft = null;
      saveSession(chatId, sess);

      const { order, finalTotal } = placed;
      const L = [`<b>${esc(s.checkout.successTitle)}</b>`, '', esc(s.checkout.successText), '', `🧾 Номер: <code>${order.id}</code>`];
      if (!s.commerce.priceHidden) L.push(`💰 Сумма: <b>${esc(money(finalTotal, s))}</b>`);
      const kb = [];
      if (s.payments.enabled) kb.push([btn(`💳 ${s.payments.buttonText}`, `pay:${order.id}`)]);
      kb.push([btn('📦 Мои заказы', 'O'), btn('🛍 В каталог', 'c')]);
      return show(chatId, { text: L.join('\n'), kb }, msg);
    } finally {
      placing.delete(chatId);
    }
  }

  async function cancelCheckout(chatId, msg, viaKeyboard) {
    const s = settings();
    const sess = loadSession(chatId);
    const wasInquiry = sess.draft && sess.draft.inquiry;
    sess.step = null;
    sess.draft = null;
    saveSession(chatId, sess);
    const text = hasCart(s) && !wasInquiry ? 'Оформление отменено. Товары остались в корзине 🛒' : 'Оформление отменено.';
    if (viaKeyboard) return restoreKeyboard(chatId, text);
    return show(chatId, {
      text,
      kb: [[hasCart(s) ? btn('🛒 Корзина', 'C') : btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]],
    }, msg);
  }

  // ----- покупка через менеджера -----

  async function buyViaManager(chatId, from, msg, productId) {
    const s = settings();
    const p = findProduct(productId);
    if (!p) return show(chatId, { text: 'Этот товар больше недоступен.', kb: [[btn('🛍 Каталог', 'c')]] }, null);
    const price = pricePlain(p, s);
    const draft = fill(s.manager.templateProduct, { product: p.name, price, shop: s.brand.shopName, name: from.first_name || '' });

    if (inquiriesReachManager(s)) {
      const who = from.username ? `@${esc(from.username)}` : `id <code>${from.id}</code>`;
      notifyManagers(s, `👀 <b>Интерес к товару</b>\n\nТовар: ${esc(p.name)} — ${esc(price)}\n\nОт: ${who}`).catch(() => {});
    }
    const url = managerUrl(s);
    if (!url) {
      return send(chatId, {
        text: `💬 Менеджер получил ваш интерес к «${esc(p.name)}» и свяжется с вами здесь, в Telegram.`,
        kb: [[btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]],
      });
    }
    return send(chatId, {
      text: `💬 Чтобы купить «${esc(p.name)}», напишите менеджеру.\n\nСообщение уже подготовлено — нажмите кнопку и отправьте его. Если текст не подставился, скопируйте:\n\n<code>${esc(draft)}</code>`,
      kb: [[{ text: '💬 Написать менеджеру', url: draftLink(url, draft) }], [btn('🛍 Каталог', 'c')]],
    });
  }

  // ----- поиск -----

  function runSearch(s, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return visibleProducts(s)
      .filter(p => `${p.name} ${p.description || ''} ${p.category || ''}`.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
      .map(p => p.id);
  }

  async function showSearchResults(chatId, sess, query) {
    const s = settings();
    sess.search = runSearch(s, query);
    sess.step = null;
    saveSession(chatId, sess);
    if (!sess.search.length) {
      return send(chatId, {
        text: `🔎 По запросу «${esc(cut(query, 60))}» ничего не нашлось.\n\nПопробуйте другое слово или загляните в каталог.`,
        kb: [[btn('🔎 Искать ещё', 'q'), btn('🛍 Каталог', 'c')]],
      });
    }
    return send(chatId, listScreen(s, sess, 's', 0));
  }

  function searchPrompt() {
    return {
      text: '🔎 <b>Поиск по каталогу</b>\n\nНапишите, что ищете — например, название товара ✍️',
      kb: [[btn('✖️ Отмена', 'h')]],
    };
  }

  function maintenanceScreen(s) {
    return { text: esc(s.advanced.maintenanceText), kb: [] };
  }

  function trackView(id) {
    try {
      const views = t.store.read('views', {});
      const key = String(Number(id));
      views[key] = (views[key] || 0) + 1;
      t.store.write('views', views);
    } catch (e) { /* счётчик не критичен */ }
  }

  // ---------- входящие ----------

  // /start: приветствие продавца с меню под полем ввода, следом — главный
  // экран с кнопками (и мини-аппом, если он настроен).
  async function welcome(chatId, name) {
    const s = settings();
    const sess = loadSession(chatId);
    if (sess.step) { sess.step = null; saveSession(chatId, sess); }
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: fill(s.bot.welcomeText, { name, shop: esc(s.brand.shopName) }),
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(s),
    });
    return send(chatId, homeScreen(s, sess, chatId));
  }

  // Сообщение покупателя. true — обработано здесь, false — пусть разбирается
  // bot.js (служебные команды /id, /admin, /subscribe и прочие).
  async function handleMessage(msg, { name }) {
    const s = settings();
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const text = String(msg.text || '').trim();
    const cmd = text.startsWith('/') ? text.slice(1).split(/[\s@]/)[0].toLowerCase() : '';
    const arg = cmd ? text.slice(cmd.length + 1).replace(/^@\S+/, '').trim() : '';

    if (cmd === 'start') { await welcome(chatId, name); return true; }

    let sess = loadSession(chatId);

    // Пункты постоянного меню и команды разделов уводят из любого шага.
    // Черновик заказа при этом сохраняется — «Оформить» продолжит с ним.
    const nav = KEYBOARD_NAV.get(text) || COMMAND_NAV.get(cmd);

    if (nav) {
      if (nav === 'cancel') {
        if (sess.step && sess.step !== 'search') await cancelCheckout(chatId, null, true);
        else await restoreKeyboard(chatId, 'Хорошо 👌');
        return true;
      }
      if (sess.step) { sess.step = null; saveSession(chatId, sess); }
      if (s.advanced.maintenanceMode && nav !== 'help') { await send(chatId, maintenanceScreen(s)); return true; }
      switch (nav) {
        case 'home': await send(chatId, homeScreen(s, sess, chatId)); break;
        case 'catalog': await send(chatId, catalogScreen(s, sess)); break;
        case 'search':
          if (arg) await showSearchResults(chatId, sess, arg);
          else { sess.step = 'search'; saveSession(chatId, sess); await send(chatId, searchPrompt()); }
          break;
        case 'cart': await send(chatId, hasCart(s) ? cartScreen(s, sess) : catalogScreen(s, sess)); break;
        case 'orders': await send(chatId, ordersScreen(s, from.id)); break;
        case 'manager': await send(chatId, managerScreen(s)); break;
        case 'help': await tgApi('sendMessage', { chat_id: chatId, text: helpText(s, name), parse_mode: 'HTML', reply_markup: mainKeyboard(s) }); break;
      }
      return true;
    }

    // Прочие команды — не наши (служебные /id, /admin, /subscribe…).
    if (cmd) return false;

    if (sess.step === 'search' && text) {
      await showSearchResults(chatId, sess, text);
      return true;
    }

    if (sess.step && sess.draft && (text || msg.contact)) {
      if (text === KB_CANCEL) { await cancelCheckout(chatId, null, true); return true; }
      const error = acceptInput(s, sess, sess.step, text, msg.contact);
      if (error) { await promptStep(chatId, sess, from, null, error); return true; }
      await advance(chatId, sess, from, null);
      return true;
    }

    if (!text) return true; // стикеры, фото и прочее без шага — молча

    // Свободный текст вне шагов — вопрос менеджеру, как и раньше. Только
    // теперь покупатель видит, что сообщение ушло, а не пишет в пустоту.
    if (inquiriesReachManager(s)) {
      const who = from.username ? `@${esc(from.username)}` : `<code>${chatId}</code>`;
      await notifyManagers(s, `💬 Сообщение боту от ${name} ${who}:\n\n${esc(text)}`).catch(() => {});
      await send(chatId, {
        text: '✅ Сообщение передано менеджеру — он ответит вам здесь, в Telegram.\n\nА пока можно заглянуть в каталог 👇',
        kb: [[btn('🛍 Каталог', 'c'), btn('🏠 Главная', 'h')]],
      });
    } else {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Я отвечаю на кнопки меню 🙂 Выберите раздел внизу или отправьте /help',
        reply_markup: mainKeyboard(s),
      });
    }
    return true;
  }

  const ownsCallback = cb => String(cb && cb.data || '').startsWith('s:');

  async function handleCallback(cb) {
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const from = cb.from || {};
    const msg = cb.message;
    const parts = String(cb.data || '').slice(2).split(':');
    const [op] = parts;
    let toast = '';
    let alert = false;

    try {
      const s = settings();
      if (!chatId) return;
      if (!s.bot.enabled || !s.bot.classicMenu) { toast = 'Меню магазина в чате сейчас выключено'; return; }
      if (s.advanced.maintenanceMode && op !== 'x') { await show(chatId, maintenanceScreen(s), msg); return; }

      const sess = loadSession(chatId);

      switch (op) {
        case 'x': return;
        case 'h':
          if (sess.step) { sess.step = null; saveSession(chatId, sess); }
          await show(chatId, homeScreen(s, sess, chatId), msg);
          return;
        case 'c': await show(chatId, catalogScreen(s, sess), msg); return;
        case 'l': await show(chatId, listScreen(s, sess, parts[1] || 'a', Number(parts[2]) || 0), msg); return;
        case 'p': {
          if ((Number(parts[3]) || 0) === 0) trackView(parts[1]);
          await show(chatId, productScreen(s, sess, Number(parts[1]), parts[2] || 'a', Number(parts[3]) || 0), msg);
          return;
        }
        case '+': case '-': case 'C+': case 'C-': {
          if (!hasCart(s)) { toast = 'Корзина сейчас выключена'; return; }
          const p = findProduct(parts[1]);
          if (!p) { toast = 'Товар больше недоступен'; return; }
          const now = sess.cart[p.id] || 0;
          const up = op === '+' || op === 'C+';
          if (up && p.stock === 0) { toast = 'Нет в наличии'; return; }
          if (up && now >= maxQty(p)) { toast = `Больше нет в наличии — всего ${maxQty(p)} шт.`; alert = true; return; }
          const next = up ? now + 1 : now - 1;
          if (next > 0) sess.cart[p.id] = next; else delete sess.cart[p.id];
          saveSession(chatId, sess);
          toast = up ? (now === 0 ? '✅ Добавлено в корзину' : `В корзине: ${next} шт.`) : (next ? `В корзине: ${next} шт.` : 'Убрано из корзины');
          const screen = op.startsWith('C')
            ? cartScreen(s, sess)
            : productScreen(s, sess, p.id, parts[2] || 'a', Number(parts[3]) || 0);
          await show(chatId, screen, msg);
          return;
        }
        case 'C': await show(chatId, cartScreen(s, sess), msg); return;
        case 'Cx':
          await show(chatId, {
            text: '🗑 Очистить корзину целиком?',
            kb: [[btn('Да, очистить', 'Cx!'), btn('Нет, оставить', 'C')]],
          }, msg);
          return;
        case 'Cx!':
          sess.cart = {};
          saveSession(chatId, sess);
          toast = 'Корзина очищена';
          await show(chatId, cartScreen(s, sess), msg);
          return;
        case 'o': await startCheckout(chatId, from, msg, null); return;
        case 'i': await startCheckout(chatId, from, msg, Number(parts[1])); return;
        case 'm': await buyViaManager(chatId, from, msg, Number(parts[1])); return;
        case 'O': await show(chatId, ordersScreen(s, from.id), msg); return;
        case 'M': await show(chatId, managerScreen(s), msg); return;
        case 'q':
          sess.step = 'search';
          saveSession(chatId, sess);
          await show(chatId, searchPrompt(), msg);
          return;
        case 'u': {
          const on = parts[1] === '1';
          const users = t.store.read('users', {});
          users[chatId] = { ...(users[chatId] || { id: chatId }), subAnnounce: on };
          t.store.write('users', users);
          toast = on ? 'Будем сообщать о новинках 🔔' : 'Больше не будем присылать новинки';
          await show(chatId, homeScreen(s, sess, chatId), msg);
          return;
        }
        case 'pay': {
          const order = t.orders.find(parts[1]);
          if (!order || !order.user || Number(order.user.id) !== Number(from.id)) { toast = 'Заказ не найден'; alert = true; return; }
          const r = await createPaymentLink(t, order.id);
          if (!r.ok) { toast = r.error; alert = true; return; }
          await send(chatId, {
            text: `💳 <b>Оплата заказа № ${order.id}</b>\n\nСумма: <b>${esc(money(order.total, s))}</b>\n\nНажмите кнопку — откроется страница оплаты. Когда платёж пройдёт, здесь появится подтверждение.`,
            kb: [[{ text: '💳 Перейти к оплате', url: r.url }]],
          });
          return;
        }
      }

      // ---- шаги оформления ----
      if (!sess.draft || !sess.step || sess.step === 'search') {
        toast = 'Оформление уже закрыто — начните заново из корзины';
        alert = true;
        return;
      }
      const d = sess.draft;
      switch (op) {
        case 'fx': await cancelCheckout(chatId, msg, false); return;
        case 'fr':
          sess.draft = { inquiry: d.inquiry || null };
          sess.step = null;
          await advance(chatId, sess, from, msg);
          return;
        case 'fok': await finishCheckout(chatId, from, msg); return;
        case 'fu': {
          const value = suggestion(sess.step, sess, from);
          const error = value ? acceptInput(s, sess, sess.step, value, null) : 'Напишите ответ сообщением';
          if (error) { toast = error; alert = true; return; }
          await advance(chatId, sess, from, msg);
          return;
        }
        case 'fs':
          if (!['email', 'address', 'comment', 'promo'].includes(sess.step)) { toast = 'Этот шаг нельзя пропустить'; return; }
          d[sess.step] = '';
          await advance(chatId, sess, from, msg);
          return;
        case 'fd': case 'fp': {
          const step = op === 'fd' ? 'delivery' : 'payment';
          const list = op === 'fd' ? s.checkout.deliveryMethods : s.checkout.paymentMethods;
          const value = list[Number(parts[1])];
          if (sess.step !== step || !value) { toast = 'Вариант устарел — выберите ещё раз'; return; }
          d[step] = value;
          await advance(chatId, sess, from, msg);
          return;
        }
        case 'fa':
          if (sess.step !== 'agree') return;
          d.agree = true;
          await advance(chatId, sess, from, msg);
          return;
      }
    } catch (e) {
      console.error(`${tag} callback ${cb.data} failed:`, e.message);
      toast = 'Что-то пошло не так, попробуйте ещё раз';
    } finally {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: toast || undefined, show_alert: alert || undefined })
        .catch(() => {});
    }
  }

  return { handleMessage, handleCallback, ownsCallback, welcome, mainKeyboard, KB };
}

// Команды для меню «/» в режиме магазина в чате.
const SHOP_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'catalog', description: 'Каталог товаров' },
  { command: 'cart', description: 'Корзина' },
  { command: 'search', description: 'Поиск товара' },
  { command: 'orders', description: 'Мои заказы' },
  { command: 'support', description: 'Связаться с менеджером' },
  { command: 'help', description: 'Как пользоваться ботом' },
  { command: 'subscribe', description: 'Получать анонсы новинок' },
  { command: 'unsubscribe', description: 'Не получать анонсы' },
  { command: 'id', description: 'Показать мой chat_id' },
  { command: 'admin', description: 'Панель управления (владелец)' },
];

module.exports = { createShopBot, SHOP_COMMANDS, buyMode, _internal: { cut, plural, visibleLength, draftLink, stripWebApp } };
