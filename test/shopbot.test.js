// Магазин в чате бота end-to-end: настоящий бот магазина против стаба
// Telegram Bot API. Покупатель проходит весь путь кнопками — /start, разделы,
// карточка с фото, корзина, оформление по шагам, промокод, заказ — а тест
// проверяет и то, что увидел покупатель, и то, что легло в хранилище.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');

const { createTenant } = require('../server/tenant');
const { _internal } = require('../server/shopbot');

const CHAT = 424242;
const USER = { id: CHAT, is_bot: false, first_name: 'Анна', username: 'anna_buyer' };
const MANAGER = 555;
// 1×1 PNG — фото товара на диске
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// ---------- стаб Telegram Bot API (JSON и multipart) ----------
const calls = [];
let stub, apiBase, nextId = 100;

test.before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const method = (req.url.match(/^\/bot[^/]+\/(.+)$/) || [])[1] || req.url;
      const ct = String(req.headers['content-type'] || '');
      let body = {};
      const files = {};
      if (ct.startsWith('multipart/form-data')) {
        const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') {
            try { body[k] = /^[[{]/.test(v) ? JSON.parse(v) : v; } catch (e) { body[k] = v; }
          } else {
            files[k] = { name: v.name, size: v.size, type: v.type };
          }
        }
      } else {
        body = JSON.parse(raw.toString('utf8') || '{}');
      }
      calls.push({ method, body, files, multipart: ct.startsWith('multipart') });
      res.setHeader('Content-Type', 'application/json');
      const chat = { id: Number(body.chat_id), type: 'private' };
      if (method === 'sendMessage') {
        return res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId, chat, text: body.text } }));
      }
      if (method === 'sendPhoto') {
        return res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId, chat, photo: [{ file_id: 'small' }, { file_id: `FILE_${nextId}` }] } }));
      }
      if (method === 'editMessageMedia') {
        return res.end(JSON.stringify({ ok: true, result: { message_id: Number(body.message_id), chat, photo: [{ file_id: 'FILE_EDIT' }] } }));
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${stub.address().port}`;
});

// Папки магазинов из makeShop: убираем за собой, чтобы /tmp не копил их
// от прогона к прогону.
const shopDirs = [];

test.after(async () => {
  if (stub) stub.close();
  await new Promise(r => setTimeout(r, 100)); // дать очереди записи стора дописать
  for (const dir of shopDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- магазин ----------
const PRODUCTS = [
  { id: 1001, name: 'Кружка «Утро»', description: 'Керамика, 350 мл', category: 'Посуда', price: 900, oldPrice: 1200, stock: 3, images: ['img_mug.png'] },
  { id: 1002, name: 'Тарелка', description: 'Плоская, 24 см', category: 'Посуда', price: 700, stock: null, images: [] },
  { id: 1003, name: 'Футболка', description: 'Хлопок', category: 'Одежда', price: 1500, stock: 0, images: [] },
  { id: 1004, name: 'Скрытый товар', category: 'Одежда', price: 1, hidden: true, images: [] },
];

function makeShop(settingsPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-shopbot-'));
  shopDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'img_mug.png'), PNG);
  const base = {
    brand: { shopName: 'Лавка', shopIcon: '🏺' },
    bot: { classicMenu: true },
    notify: { enabled: true, chatIds: [String(MANAGER)], onOrder: true, onInquiry: true },
    checkout: { askName: true, askPhone: true, phoneRequired: true, deliveryMethods: ['Курьер', 'Самовывоз'], askAddress: true },
    promo: { enabled: true, codes: [{ code: 'SALE10', type: 'percent', value: 10, usesLeft: 5 }] },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(mergeDeep(base, settingsPatch)));
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(PRODUCTS));
  const shop = createTenant({ dataDir: dir, botToken: '777:test', adminToken: 'x', apiBase, publicUrl: '' });
  return { shop, dir };
}

function mergeDeep(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? mergeDeep(a[k], v) : v;
  }
  return out;
}

// ---------- апдейты покупателя ----------
let updateId = 1;
const chat = { id: CHAT, type: 'private', first_name: 'Анна' };
const say = (shop, text) => shop.bot.handleUpdate({
  update_id: updateId++, message: { message_id: updateId, date: 0, chat, from: USER, text },
});
const shareContact = (shop, phone) => shop.bot.handleUpdate({
  update_id: updateId++, message: { message_id: updateId, date: 0, chat, from: USER, contact: { phone_number: phone, user_id: CHAT } },
});
const textMsg = id => ({ message_id: id, chat, text: 'экран' });
const photoMsg = id => ({ message_id: id, chat, photo: [{ file_id: 'x' }], caption: 'экран' });
const press = (shop, data, message = textMsg(50)) => shop.bot.handleUpdate({
  update_id: updateId++, callback_query: { id: `cb${updateId}`, from: USER, message, data },
});

const since = mark => calls.slice(mark);
const lastOf = (list, method) => [...list].reverse().find(c => c.method === method);
const buttons = markup => (markup && (markup.inline_keyboard || markup.keyboard) || []).flat();
const hasButton = (markup, re) => buttons(markup).some(b => re.test(b.text));
const dataOf = (markup, re) => (buttons(markup).find(b => re.test(b.text)) || {}).callback_data;
const answer = list => lastOf(list, 'answerCallbackQuery');
const settle = () => new Promise(r => setTimeout(r, 50));
// toLocaleString('ru-RU') разделяет разряды неразрывным пробелом — сверяем по обычному
const plain = v => String(v).replace(/[  ]/g, ' ');

// ---------- сценарии ----------

test('/start: меню под полем ввода и главный экран с кнопками', async () => {
  const { shop } = makeShop();
  const mark = calls.length;
  await say(shop, '/start');
  const sent = since(mark).filter(c => c.method === 'sendMessage');
  assert.strictEqual(sent.length, 2, 'приветствие и главный экран');
  assert.ok(hasButton(sent[0].body.reply_markup, /Каталог/), 'обычная клавиатура с каталогом');
  assert.ok(hasButton(sent[0].body.reply_markup, /Корзина/));
  assert.ok(sent[0].body.reply_markup.is_persistent, 'меню не прячется');
  assert.match(plain(sent[1].body.text), /Лавка/);
  assert.strictEqual(dataOf(sent[1].body.reply_markup, /Каталог/), 's:c');
});

test('каталог → раздел → карточка с фото → корзина → заказ с промокодом', async () => {
  const { shop } = makeShop();

  // Разделы: два раздела, скрытый товар и раскупленное в счётчиках не прячем
  let mark = calls.length;
  await press(shop, 's:c');
  let screen = lastOf(since(mark), 'editMessageText');
  assert.match(plain(screen.body.text), /Каталог/);
  assert.ok(hasButton(screen.body.reply_markup, /^Посуда · 2$/));
  assert.ok(hasButton(screen.body.reply_markup, /^Одежда · 1$/), 'скрытый товар в разделе не считается');

  // Список раздела
  mark = calls.length;
  await press(shop, dataOf(screen.body.reply_markup, /^Посуда/));
  screen = lastOf(since(mark), 'editMessageText');
  assert.ok(hasButton(screen.body.reply_markup, /Кружка «Утро» · 900/));
  const cardData = dataOf(screen.body.reply_markup, /Кружка/);

  // Карточка с фото: текстовое сообщение не правится в фото — новое сообщение,
  // фото уходит файлом с диска
  mark = calls.length;
  await press(shop, cardData);
  let photo = lastOf(since(mark), 'sendPhoto');
  assert.ok(photo.multipart && photo.files.photo, 'фото загружено файлом');
  assert.ok(!photo.body.caption.includes('\r'), 'в подписи нет CR — переносы уходят как есть');
  assert.match(plain(photo.body.caption), /Кружка «Утро»/);
  assert.match(plain(photo.body.caption), /<s>1 200 ₽<\/s>/, 'старая цена зачёркнута');
  assert.match(plain(photo.body.caption), /Осталось 3 шт/);
  assert.ok(since(mark).some(c => c.method === 'deleteMessage'), 'старый экран убран');

  // В корзину: правится уже фото-сообщение, файл второй раз не грузится
  mark = calls.length;
  await press(shop, dataOf(photo.body.reply_markup, /Добавить в корзину/), photoMsg(51));
  const media = lastOf(since(mark), 'editMessageMedia');
  assert.ok(!media.multipart, 'повторный показ — по file_id');
  assert.match(media.body.media.media, /^FILE_/);
  assert.match(plain(media.body.media.caption), /В корзине: 1 шт/);
  assert.match(plain(answer(since(mark)).body.text), /Добавлено/);

  // ещё две штуки — упираемся в остаток 3
  await press(shop, 's:+:1001:k0:0', photoMsg(51));
  await press(shop, 's:+:1001:k0:0', photoMsg(51));
  mark = calls.length;
  await press(shop, 's:+:1001:k0:0', photoMsg(51));
  assert.match(plain(answer(since(mark)).body.text), /всего 3/);
  assert.strictEqual(answer(since(mark)).body.show_alert, true);
  await press(shop, 's:-:1001:k0:0', photoMsg(51)); // назад до двух

  // Корзина: фото → текст
  mark = calls.length;
  await press(shop, 's:C', photoMsg(51));
  const cart = lastOf(since(mark), 'sendMessage');
  assert.match(plain(cart.body.text), /2 × 900 ₽ = <b>1 800 ₽<\/b>/);
  assert.match(plain(cart.body.text), /Итого: 1 800 ₽/);
  const go = dataOf(cart.body.reply_markup, /Оформить заказ/);
  assert.strictEqual(go, 's:o');

  // Шаг 1: имя — кнопка с именем из Telegram
  mark = calls.length;
  await press(shop, go);
  screen = lastOf(since(mark), 'editMessageText');
  assert.match(plain(screen.body.text), /Как к вам обращаться/);
  assert.strictEqual(dataOf(screen.body.reply_markup, /Анна/), 's:fu');

  // Шаг 2: телефон — обычная клавиатура с «поделиться контактом»
  mark = calls.length;
  await press(shop, 's:fu');
  const phoneAsk = lastOf(since(mark), 'sendMessage');
  assert.ok(buttons(phoneAsk.body.reply_markup).some(b => b.request_contact), 'кнопка «Отправить мой номер»');
  assert.ok(!hasButton(phoneAsk.body.reply_markup, /Пропустить/), 'обязательный телефон не пропускается');

  // слишком короткий номер — повтор шага с ошибкой
  mark = calls.length;
  await say(shop, '12345');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, /минимум 10 цифр/);

  // Контакт кнопкой: меню возвращается, дальше — доставка
  mark = calls.length;
  await shareContact(shop, '79001234567');
  let sent = since(mark).filter(c => c.method === 'sendMessage');
  assert.ok(hasButton(sent[0].body.reply_markup, /Каталог/), 'главное меню вернулось под поле ввода');
  assert.match(plain(sent[1].body.text), /Как доставить/);

  // Шаг 3: доставка → адрес
  mark = calls.length;
  await press(shop, dataOf(sent[1].body.reply_markup, /Курьер/));
  assert.match(lastOf(since(mark), 'editMessageText').body.text, /Адрес доставки/);
  await say(shop, 'Москва, Тверская 1, кв 5');

  // Промокод: неверный — ошибка, верный — скидка на экране проверки
  mark = calls.length;
  await say(shop, 'NOPE');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, /Промокод не найден/);
  mark = calls.length;
  await say(shop, 'sale10');
  const confirm = lastOf(since(mark), 'sendMessage');
  assert.match(plain(confirm.body.text), /Проверьте заказ/);
  assert.match(plain(confirm.body.text), /SALE10/);
  assert.match(plain(confirm.body.text), /Итого: 1 620 ₽/);
  assert.match(plain(confirm.body.text), /\+79001234567/);
  assert.match(plain(confirm.body.text), /Курьер/);

  // Подтверждение
  mark = calls.length;
  await press(shop, 's:fok');
  const done = lastOf(since(mark), 'editMessageText');
  assert.match(plain(done.body.text), /Заказ оформлен/);
  const toManager = since(mark).find(c => c.method === 'sendMessage' && Number(c.body.chat_id) === MANAGER);
  assert.ok(toManager, 'менеджер получил заказ');
  assert.match(plain(toManager.body.text), /Оформлен в чате бота/);
  assert.match(plain(toManager.body.text), /Москва, Тверская 1/);

  await shop.store.flush();
  const orders = shop.store.read('orders', []);
  assert.strictEqual(orders.length, 1);
  assert.strictEqual(orders[0].source, 'chat');
  assert.strictEqual(orders[0].total, 1620);
  assert.deepStrictEqual(orders[0].items.map(i => [i.id, i.qty]), [[1001, 2]]);
  assert.strictEqual(orders[0].user.id, CHAT);
  assert.strictEqual(shop.store.read('products', []).find(p => p.id === 1001).stock, 1, 'остаток списан');
  assert.deepStrictEqual(shop.store.read('chats', {})[CHAT].cart, {}, 'корзина очищена');

  // Повторное «Подтвердить» — второго заказа нет
  await press(shop, 's:fok');
  assert.strictEqual(shop.store.read('orders', []).length, 1);

  // Мои заказы
  mark = calls.length;
  await say(shop, '📦 Мои заказы');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, new RegExp(`№ ${orders[0].id}`));
});

test('второй заказ: контакты подставляются «как в прошлый раз»', async () => {
  const { shop } = makeShop({ checkout: { deliveryMethods: [] }, promo: { enabled: false } });
  await press(shop, 's:+:1002:a:0');
  await press(shop, 's:o');
  await press(shop, 's:fu');           // имя
  await shareContact(shop, '+7 900 000-00-00');
  await press(shop, 's:fok');
  await shop.store.flush();
  const mark = calls.length;
  await press(shop, 's:+:1002:a:0');
  await press(shop, 's:o');
  await press(shop, 's:fu');
  const phoneAsk = lastOf(since(mark), 'sendMessage');
  assert.ok(hasButton(phoneAsk.body.reply_markup, /\+7 900 000-00-00/), 'прошлый номер — одной кнопкой');
});

test('раскупленный товар не кладётся в корзину, ниже минимальной суммы оформить нельзя', async () => {
  const { shop } = makeShop({ commerce: { minOrder: 2000 } });
  let mark = calls.length;
  await press(shop, 's:p:1003:a:0');
  const card = lastOf(since(mark), 'editMessageText');
  assert.match(plain(card.body.text), /Нет в наличии/);
  assert.ok(!hasButton(card.body.reply_markup, /Добавить в корзину/));

  await press(shop, 's:C+:1002');
  mark = calls.length;
  await press(shop, 's:C');
  const cart = lastOf(since(mark), 'editMessageText');
  assert.match(plain(cart.body.text), /Минимальный заказ — 2 000 ₽/);
  assert.ok(!hasButton(cart.body.reply_markup, /Оформить/));
});

test('режим «через менеджера»: кнопка ведёт в чат менеджера с готовым текстом', async () => {
  const { shop } = makeShop({ commerce: { mode: 'manager' }, manager: { buyUrl: '@lavka_manager' } });
  let mark = calls.length;
  await press(shop, 's:p:1002:a:0');
  const card = lastOf(since(mark), 'editMessageText');
  assert.ok(!hasButton(card.body.reply_markup, /корзин/i), 'корзины нет');
  mark = calls.length;
  await press(shop, dataOf(card.body.reply_markup, /менеджер/));
  await settle();
  const reply = since(mark).find(c => c.method === 'sendMessage' && Number(c.body.chat_id) === CHAT);
  const link = buttons(reply.body.reply_markup).find(b => b.url).url;
  assert.match(link, /^https:\/\/t\.me\/lavka_manager\?text=/);
  assert.match(decodeURIComponent(link), /Тарелка/);
  assert.ok(since(mark).some(c => Number(c.body.chat_id) === MANAGER && /Интерес к товару/.test(c.body.text)));

  // меню под полем ввода — без корзины и заказов
  mark = calls.length;
  await say(shop, '/start');
  const kb = lastOf(since(mark).filter(c => c.body.reply_markup && c.body.reply_markup.keyboard), 'sendMessage');
  assert.ok(!hasButton(kb.body.reply_markup, /Корзина|Мои заказы/));
});

test('режим «заявка»: один товар, корзина не трогается', async () => {
  const { shop } = makeShop({
    commerce: { mode: 'inquiry' },
    checkout: { askPhone: false, deliveryMethods: [] },
    promo: { enabled: false },
  });
  await press(shop, 's:i:1001');
  await press(shop, 's:fu');
  let mark = calls.length;
  await press(shop, 's:fok');
  assert.match(lastOf(since(mark), 'editMessageText').body.text, /Заказ оформлен/);
  await shop.store.flush();
  const [order] = shop.store.read('orders', []);
  assert.deepStrictEqual(order.items.map(i => [i.id, i.qty]), [[1001, 1]]);
});

test('поиск, свободный текст менеджеру и отмена оформления', async () => {
  const { shop } = makeShop();
  let mark = calls.length;
  await say(shop, '🔎 Поиск');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, /Поиск по каталогу/);
  mark = calls.length;
  await say(shop, 'керамика');
  const found = lastOf(since(mark), 'sendMessage');
  assert.ok(hasButton(found.body.reply_markup, /Кружка/), 'ищет и по описанию');
  assert.ok(!hasButton(found.body.reply_markup, /Тарелка/));

  mark = calls.length;
  await say(shop, 'А доставка в Казань есть?');
  assert.ok(since(mark).some(c => Number(c.body.chat_id) === MANAGER && /доставка в Казань/.test(c.body.text)));
  assert.match(lastOf(since(mark).filter(c => Number(c.body.chat_id) === CHAT), 'sendMessage').body.text, /передано менеджеру/);

  // начали оформление, на шаге с телефоном передумали
  await press(shop, 's:+:1002:a:0');
  await press(shop, 's:o');
  await press(shop, 's:fu');
  mark = calls.length;
  await say(shop, '✖️ Отменить оформление');
  const cancelled = lastOf(since(mark), 'sendMessage');
  assert.match(plain(cancelled.body.text), /остались в корзине/);
  assert.ok(hasButton(cancelled.body.reply_markup, /Каталог/));
  assert.ok(shop.store.read('chats', {})[CHAT].cart[1002], 'корзина цела');
});

test('выключенный classicMenu: прежнее поведение — приветствие с кнопкой магазина', async () => {
  const { shop } = makeShop({ bot: { classicMenu: false } });
  const mark = calls.length;
  await say(shop, '/start');
  const sent = since(mark).filter(c => c.method === 'sendMessage');
  assert.strictEqual(sent.length, 1);
  assert.ok(!sent[0].body.reply_markup || !sent[0].body.reply_markup.keyboard, 'без обычной клавиатуры');
});

test('меню команд зависит от classicMenu', async () => {
  let { shop } = makeShop();
  let mark = calls.length;
  await shop.bot.syncCommands();
  let cmds = lastOf(since(mark), 'setMyCommands').body.commands.map(c => c.command);
  assert.ok(cmds.includes('catalog') && cmds.includes('cart') && cmds.includes('orders'));

  ({ shop } = makeShop({ bot: { classicMenu: false } }));
  mark = calls.length;
  await shop.bot.syncCommands();
  cmds = lastOf(since(mark), 'setMyCommands').body.commands.map(c => c.command);
  assert.ok(!cmds.includes('cart'));
});

test('callback_data укладывается в 64 байта', async () => {
  const { shop } = makeShop();
  const mark = calls.length;
  await press(shop, 's:c');
  await press(shop, 's:l:k0:0');
  await press(shop, 's:p:1001:k0:0');
  for (const c of since(mark)) {
    for (const b of buttons(c.body.reply_markup)) {
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  }
});

test('помощники: обрезка без разрыва эмодзи и ссылка с черновиком', () => {
  const s = _internal.cut('ab😀cd', 4);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(s), 'суррогатная пара не разорвана');
  assert.strictEqual(_internal.draftLink('https://t.me/x', 'Привет мир'), 'https://t.me/x?text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%D0%BC%D0%B8%D1%80');
  assert.strictEqual(_internal.plural(21, 'товар', 'товара', 'товаров'), 'товар');
  assert.strictEqual(_internal.plural(12, 'товар', 'товара', 'товаров'), 'товаров');
});

// ---------- редактор чат-бота (вкладка «Чат-бот» в админке) ----------

test('настройки chatbot: пустая подпись — стандартная, размер страницы в пределах', () => {
  const { sanitize, DEFAULTS } = require('../server/settings');
  const s = sanitize({ chatbot: { buttons: { catalog: '   ', search: 'Найти' }, pageSize: 99, show: { help: false } } });
  assert.strictEqual(s.chatbot.buttons.catalog, DEFAULTS.chatbot.buttons.catalog, 'пустая подпись не превращается в пустую кнопку');
  assert.strictEqual(s.chatbot.buttons.search, 'Найти');
  assert.strictEqual(s.chatbot.pageSize, 10);
  assert.strictEqual(s.chatbot.show.help, false);
  assert.strictEqual(s.chatbot.show.search, true, 'не заданное — по умолчанию');
});

test('переименованные кнопки: меню, главный экран и старые подписи у покупателя', async () => {
  const { shop } = makeShop({
    chatbot: {
      buttons: { catalog: '🧥 Мерч', cart: '🧺 Пакет' },
      show: { search: false, help: false },
      homeText: 'Лучшие <кружки> города',
      pageSize: 4,
    },
  });
  let mark = calls.length;
  await say(shop, '/start');
  const [welcome, home] = since(mark).filter(c => c.method === 'sendMessage');
  const labels = buttons(welcome.body.reply_markup).map(b => b.text);
  assert.deepStrictEqual(labels.slice(0, 2), ['🧥 Мерч', '🧺 Пакет']);
  assert.ok(!labels.includes('🔎 Поиск') && !labels.includes('❓ Помощь'), 'выключенные пункты скрыты');
  assert.match(home.body.text, /Лучшие &lt;кружки&gt; города/, 'текст продавца экранирован');
  assert.ok(!hasButton(home.body.reply_markup, /Поиск/));

  // новая подпись ведёт в каталог…
  mark = calls.length;
  await say(shop, '🧥 Мерч');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, /Каталог/);
  // …и старая тоже: клавиатура у покупателя могла остаться прежней
  mark = calls.length;
  await say(shop, '🛍 Каталог');
  assert.match(lastOf(since(mark), 'sendMessage').body.text, /Каталог/);
});

test('превью для админки собирается тем же кодом на несохранённых настройках', () => {
  const { shop } = makeShop();
  const { sanitize } = require('../server/settings');
  const s = sanitize({ ...JSON.parse(fs.readFileSync(path.join(shop.store.DATA_DIR, 'settings.json'), 'utf8')), chatbot: { buttons: { catalog: 'Витрина' } } });
  const p = shop.bot.chatPreview(s, 'Анна');
  assert.strictEqual(p.keyboard.keyboard[0][0].text, 'Витрина');
  assert.match(p.welcome, /Анна/);
  assert.match(p.home.text, /Лавка/);
  assert.ok(p.catalog.kb.length > 0);
  assert.strictEqual(p.product.photo, 'img_mug.png', 'карточка с фото первого товара в наличии');
  assert.match(p.cart.text, /Ваша корзина/, 'в корзине превью лежит товар');
  assert.match(p.help.text, /Витрина — товары по разделам/);
});

test('file_id фото переживает перезапуск и сбрасывается при смене бота', async () => {
  const { shop, dir } = makeShop();
  await press(shop, 's:p:1001:a:0');
  await shop.store.flush();

  // тот же магазин после рестарта: фото уходит по file_id, без загрузки файла
  let again = createTenant({ dataDir: dir, botToken: '777:test', adminToken: 'x', apiBase, publicUrl: '' });
  let mark = calls.length;
  await press(again, 's:p:1001:a:0');
  let photo = lastOf(since(mark), 'sendPhoto');
  assert.ok(photo && !photo.multipart && /^FILE_/.test(photo.body.photo), 'повторно файл не грузится');

  // другой токен — старые file_id чужие, фото заливается заново
  again = createTenant({ dataDir: dir, botToken: '888:other', adminToken: 'x', apiBase, publicUrl: '' });
  mark = calls.length;
  await press(again, 's:p:1001:a:0');
  photo = lastOf(since(mark), 'sendPhoto');
  assert.ok(photo.multipart, 'для нового бота фото загружено файлом');
});
