// Владельцы магазина через бота: пароль от админки → chat_id нового владельца.
// Настоящий бот магазина против стаба Telegram Bot API: что увидел человек,
// что удалилось из чата, что легло в хранилище и кого теперь пускает админка.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');

const { createTenant } = require('../server/tenant');
const { createStore } = require('../server/store');
const { createBackupManager } = require('../server/backup');
const { BTN_ME, _internal } = require('../server/owners');

const PASSWORD = 'Sup3r-Secret-Pass';
const OWNER = 100001;      // будущий владелец
const FRIEND = 100002;     // его компаньон
const STRANGER = 100003;   // подбирает пароль
const ENV_OWNER = 100009;  // из ADMIN_CHAT_IDS

// ---------- стаб Telegram Bot API ----------
const calls = [];
let stub, apiBase, nextId = 1000;
// chat_id, которые «писали боту»: getChat и sendMessage им отвечают
const known = new Set([OWNER, FRIEND, STRANGER, ENV_OWNER]);

test.before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const method = (req.url.match(/^\/bot[^/]+\/(.+)$/) || [])[1] || req.url;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      calls.push({ method, body });
      res.setHeader('Content-Type', 'application/json');
      const id = Number(body.chat_id);
      if ((method === 'sendMessage' || method === 'getChat') && !known.has(id)) {
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
      }
      if (method === 'getChat') {
        return res.end(JSON.stringify({ ok: true, result: { id, type: 'private', first_name: `User${id}`, username: `u${id}` } }));
      }
      if (method === 'sendMessage') {
        return res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId, chat: { id, type: 'private' }, text: body.text } }));
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${stub.address().port}`;
});

const dirs = [];
test.after(async () => {
  if (stub) stub.close();
  await new Promise(r => setTimeout(r, 100));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeShop({ classic = true, adminChatIds = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-owners-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    brand: { shopName: 'Лавка' },
    bot: { classicMenu: classic },
    checkout: { askName: true },
  }));
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify([{ id: 1, name: 'Кружка', price: 500, images: [] }]));
  const shop = createTenant({
    dataDir: dir, botToken: '777:test', adminToken: PASSWORD, apiBase,
    publicUrl: 'https://shop.example', adminChatIds,
  });
  return { shop, dir };
}

// ---------- апдейты ----------
let updateId = 1;
const userOf = id => ({ id, is_bot: false, first_name: `User${id}`, username: `u${id}` });
const chatOf = id => ({ id, type: 'private', first_name: `User${id}` });
const send = (shop, from, extra) => {
  const message_id = ++updateId;
  return shop.bot.handleUpdate({
    update_id: updateId, message: { message_id, date: 0, chat: chatOf(from), from: userOf(from), ...extra },
  }).then(() => message_id);
};
const say = (shop, from, text) => send(shop, from, { text });
const press = (shop, from, data) => shop.bot.handleUpdate({
  update_id: ++updateId,
  callback_query: { id: `cb${updateId}`, from: userOf(from), message: { message_id: 77, chat: chatOf(from), text: 'экран' }, data },
});

const since = mark => calls.slice(mark);
const sentTo = (list, id) => list.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === id);
const lastText = (list, id) => { const m = sentTo(list, id); return m.length ? m[m.length - 1].body.text : ''; };
const deleted = (list, id, messageId) => list.some(c => c.method === 'deleteMessage'
  && Number(c.body.chat_id) === id && c.body.message_id === messageId);
const buttons = markup => (markup && (markup.inline_keyboard || markup.keyboard) || []).flat();

// ---------- сценарии ----------

test('чужому /admin — отказ с подсказкой про /owner', async () => {
  const { shop } = makeShop();
  const mark = calls.length;
  await say(shop, OWNER, '/admin');
  const text = lastText(since(mark), OWNER);
  assert.match(text, /только владельцу/);
  assert.match(text, /\/owner/);
  assert.ok(!buttons(sentTo(since(mark), OWNER).pop().body.reply_markup).length, 'кнопки панели нет');
});

test('/owner → пароль (удаляется) → «Это я»: владелец добавлен и сохранён', async () => {
  const { shop, dir } = makeShop();

  let mark = calls.length;
  await say(shop, OWNER, '/owner');
  assert.match(lastText(since(mark), OWNER), /пароль от админки/);

  // неверный пароль: удалён из чата, попытки считаются
  mark = calls.length;
  let mid = await say(shop, OWNER, 'wrong-password');
  await new Promise(r => setTimeout(r, 30));
  assert.ok(deleted(since(mark), OWNER, mid), 'неверный пароль тоже удаляется');
  assert.match(lastText(since(mark), OWNER), /не подошёл.*Осталось попыток: 4/s);

  // верный пароль
  mark = calls.length;
  mid = await say(shop, OWNER, PASSWORD);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(deleted(since(mark), OWNER, mid), 'сообщение с паролем удалено');
  const prompt = sentTo(since(mark), OWNER).pop();
  assert.match(prompt.body.text, /chat_id/);
  const kb = buttons(prompt.body.reply_markup);
  assert.ok(kb.some(b => b.text === BTN_ME), 'кнопка «Это я»');
  assert.ok(kb.some(b => b.request_users && b.request_users.max_quantity === 1), 'выбор контакта через request_users');
  assert.ok(!shop.isOwner(OWNER), 'до chat_id ещё не владелец');

  mark = calls.length;
  await say(shop, OWNER, BTN_ME);
  assert.ok(shop.isOwner(OWNER), 'теперь владелец');
  assert.deepStrictEqual(shop.adminChatIds, [OWNER]);
  const after = since(mark);
  assert.ok(sentTo(after, OWNER).some(m => /вы владелец/.test(m.body.text)));
  // клавиатура магазина вернулась на место
  assert.ok(sentTo(after, OWNER).some(m => m.body.reply_markup && m.body.reply_markup.is_persistent));
  // кнопка панели сразу следом
  assert.ok(sentTo(after, OWNER).some(m => buttons(m.body.reply_markup).some(b => b.web_app && /admin\.html$/.test(b.web_app.url))));
  // владельцу — меню с /admins на его чат
  const cmd = after.find(c => c.method === 'setMyCommands' && c.body.scope && c.body.scope.chat_id === OWNER);
  assert.ok(cmd && cmd.body.commands.some(c => c.command === 'admins'));

  await shop.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'admins.json'), 'utf8'));
  assert.strictEqual(saved.owners[0].id, OWNER);
  assert.strictEqual(saved.owners[0].addedBy, OWNER);

  // и /admin теперь даёт панель
  mark = calls.length;
  await say(shop, OWNER, '/admin');
  assert.ok(buttons(sentTo(since(mark), OWNER).pop().body.reply_markup).some(b => /Открыть панель/.test(b.text)));
});

test('пароль без команды и chat_id компаньона числом: ему сообщение, остальным владельцам — тоже', async () => {
  const { shop } = makeShop({ adminChatIds: [ENV_OWNER] });

  let mark = calls.length;
  const mid = await say(shop, OWNER, PASSWORD);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(deleted(since(mark), OWNER, mid));
  assert.match(lastText(since(mark), OWNER), /Пароль верный/);

  mark = calls.length;
  await say(shop, OWNER, String(FRIEND));
  assert.ok(shop.isOwner(FRIEND));
  assert.ok(!shop.isOwner(OWNER), 'добавлял — не значит сам стал владельцем');
  const after = since(mark);
  assert.ok(after.some(c => c.method === 'getChat' && Number(c.body.chat_id) === FRIEND), 'имя подтянуто через getChat');
  assert.match(lastText(after, OWNER), /User100002.*теперь владелец/s);
  assert.match(lastText(after, FRIEND), /открыт доступ к панели управления «Лавка»/);
  assert.match(lastText(after, ENV_OWNER), /Новый владелец магазина/, 'владелец из .env узнал о новом');

  const entry = shop.owners.list().find(o => o.id === FRIEND);
  assert.strictEqual(entry.name, 'User100002');
  assert.strictEqual(entry.username, 'u100002');
});

test('chat_id из выбора контакта, пересылки и карточки контакта', async () => {
  const { shop } = makeShop({ adminChatIds: [ENV_OWNER] });

  // владелец из .env добавляет без пароля
  await say(shop, ENV_OWNER, '/owner');
  await send(shop, ENV_OWNER, { users_shared: { request_id: 1, users: [{ user_id: FRIEND, first_name: 'Друг' }] } });
  assert.ok(shop.isOwner(FRIEND), 'users_shared');

  await say(shop, ENV_OWNER, '/owner');
  await send(shop, ENV_OWNER, { text: 'привет', forward_origin: { type: 'user', date: 0, sender_user: userOf(OWNER) } });
  assert.ok(shop.isOwner(OWNER), 'пересланное сообщение');

  await say(shop, ENV_OWNER, '/owner');
  let mark = calls.length;
  await send(shop, ENV_OWNER, { text: 'x', forward_origin: { type: 'hidden_user', date: 0, sender_user_name: 'Скрытный' } });
  assert.match(lastText(since(mark), ENV_OWNER), /скрыл аккаунт/);

  mark = calls.length;
  await send(shop, ENV_OWNER, { contact: { phone_number: '+7000', first_name: 'Без ТГ' } });
  assert.match(lastText(since(mark), ENV_OWNER), /нет аккаунта Telegram/);

  // группа владельцем быть не может
  mark = calls.length;
  await say(shop, ENV_OWNER, '-1001234567890');
  assert.match(lastText(since(mark), ENV_OWNER), /группы или канала/);

  // человек, который ещё не писал боту: добавлен, но предупредили
  mark = calls.length;
  await say(shop, ENV_OWNER, '555000111');
  assert.ok(shop.isOwner(555000111));
  assert.match(lastText(since(mark), ENV_OWNER), /ещё не писал боту/);
});

test('подбор пароля: 5 ошибок — пауза, верный пароль в паузе не проходит', async () => {
  const { shop } = makeShop();
  for (let i = 0; i < 5; i++) await say(shop, STRANGER, `/owner guess-${i}`);
  let mark = calls.length;
  await say(shop, STRANGER, `/owner ${PASSWORD}`);
  assert.match(lastText(since(mark), STRANGER), /Слишком много неверных попыток/);
  assert.ok(!shop.isOwner(STRANGER));

  // и без команды пароль в паузе не сверяется: уходит как обычное сообщение
  mark = calls.length;
  await say(shop, STRANGER, PASSWORD);
  assert.ok(!/Пароль верный/.test(lastText(since(mark), STRANGER)));

  // другой чат при этом не задет
  mark = calls.length;
  await say(shop, OWNER, `/owner ${PASSWORD}`);
  assert.match(lastText(since(mark), OWNER), /Пароль верный/);
});

test('кнопка меню магазина посреди сценария — выход из него, а не попытка пароля', async () => {
  const { shop } = makeShop();
  await say(shop, OWNER, '/owner');
  const mark = calls.length;
  await say(shop, OWNER, shop.settings().chatbot.buttons.catalog);
  const list = since(mark);
  assert.ok(!list.some(c => c.method === 'deleteMessage'), 'это не пароль');
  assert.ok(sentTo(list, OWNER).some(m => buttons(m.body.reply_markup).some(b => /Кружка/.test(b.text))), 'открылся каталог');
  assert.strictEqual(shop.bot && _internal.looksLikePassword('🛍 Каталог'), false);
});

test('шаг оформления заказа не съедает пароль', async () => {
  const { shop } = makeShop();
  // кладём товар в корзину и начинаем оформление — бот ждёт имя
  await press(shop, OWNER, 's:C+:1');
  await press(shop, OWNER, 's:o');
  assert.ok(sentTo(calls, OWNER).length || calls.some(c => /editMessage/.test(c.method)), 'оформление началось');
  const mark = calls.length;
  const mid = await say(shop, OWNER, PASSWORD);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(deleted(since(mark), OWNER, mid), 'пароль удалён');
  assert.match(lastText(since(mark), OWNER), /Пароль верный/);
});

test('/admins: список, удаление кнопкой, базовых из .env не убрать, чужим — отказ', async () => {
  const { shop } = makeShop({ adminChatIds: [ENV_OWNER] });
  shop.owners.add(FRIEND, { name: 'Друг', addedBy: ENV_OWNER });

  let mark = calls.length;
  await say(shop, ENV_OWNER, '/admins');
  const screen = sentTo(since(mark), ENV_OWNER).pop();
  assert.match(screen.body.text, /Владельцы магазина/);
  assert.match(screen.body.text, /из настроек сервера/);
  const rm = buttons(screen.body.reply_markup).find(b => /Убрать Друг/.test(b.text));
  assert.strictEqual(rm.callback_data, `own:rm:${FRIEND}`);
  assert.ok(!buttons(screen.body.reply_markup).some(b => b.callback_data === `own:rm:${ENV_OWNER}`), 'базового кнопкой не убрать');

  // чужой не может ни смотреть, ни удалять
  mark = calls.length;
  await say(shop, STRANGER, '/admins');
  assert.match(lastText(since(mark), STRANGER), /только владельцу/);
  await press(shop, STRANGER, `own:rm:${FRIEND}`);
  assert.ok(shop.isOwner(FRIEND));

  mark = calls.length;
  await press(shop, ENV_OWNER, `own:rm:${FRIEND}`);
  assert.ok(!shop.isOwner(FRIEND));
  const after = since(mark);
  assert.ok(after.some(c => c.method === 'deleteMyCommands' && c.body.scope.chat_id === FRIEND), 'меню владельца снято');
  assert.match(lastText(after, FRIEND), /закрыт/);
  assert.ok(after.some(c => c.method === 'editMessageText' && !/Друг/.test(c.body.text)), 'список обновился');

  mark = calls.length;
  await press(shop, ENV_OWNER, `own:rm:${ENV_OWNER}`);
  const ans = since(mark).find(c => c.method === 'answerCallbackQuery');
  assert.match(ans.body.text, /\.env/);
  assert.ok(shop.isOwner(ENV_OWNER));
});

test('в группе сценарий не работает: пароль там не сверяется', async () => {
  const { shop } = makeShop({ classic: false });
  const group = { id: -100500, type: 'group', title: 'Чат' };
  const mark = calls.length;
  await shop.bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: 9, date: 0, chat: group, from: userOf(OWNER), text: `/owner ${PASSWORD}` },
  });
  assert.ok(!since(mark).some(c => c.method === 'deleteMessage'));
  assert.ok(!shop.isOwner(OWNER));
});

test('магазин без пароля (пустой) не пускает пустую строку', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-owners-'));
  dirs.push(dir);
  const t = createTenant({ dataDir: dir, adminToken: '' });
  assert.strictEqual(t.checkAdminPassword(''), false);
  assert.strictEqual(t.checkAdminPassword('x'), false);
});

test('восстановление бэкапа не откатывает список владельцев', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-owners-data-'));
  const backupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-owners-bk-'));
  dirs.push(dataDir, backupsRoot);
  const store = createStore(dataDir);
  const mgr = createBackupManager({ dataDir, backupsRoot, tenantId: 'shop', store });
  store.write('admins', { owners: [{ id: FRIEND }] });
  store.write('products', [{ id: 1, name: 'Было' }]);
  await store.flush();
  const snap = await mgr.runNow('manual');

  // после снимка компаньона убрали, товары поменяли
  store.write('admins', { owners: [] });
  store.write('products', [{ id: 2, name: 'Стало' }]);
  await store.flush();

  await mgr.restore(snap.name);
  assert.strictEqual(store.read('products', [])[0].name, 'Было', 'данные откатились');
  assert.deepStrictEqual(store.read('admins', null), { owners: [] }, 'убранный владелец не вернулся');
});
