'use strict';
// Владельцы магазина в Telegram — кому бот открывает панель управления
// (/admin) и кого пускает вход в админку из Mini App.
//
// Итоговый список — объединение двух источников:
//  • базовый — ADMIN_CHAT_IDS из .env (у магазинов платформы — колонка
//    admin_chat_ids реестра). Бот его не трогает: .env сервису на запись
//    закрыт, и так у владельца сервера всегда остаются ключи от магазина;
//  • добавленные через бота — документ 'admins' в хранилище магазина
//    (data/admins.json или строка shop_docs). Сюда пишет сценарий /owner:
//    пароль от админки → chat_id нового владельца.
//
// Пароль сверяется с тем же дайджестом, что и вход в веб-админку. Попытки
// ограничены на чат и на магазин целиком, сообщение с паролем бот удаляет.

const { esc } = require('./telegram');

const DOC = 'admins';

const toId = v => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
};

// ---------- список владельцев ----------
function createOwners({ store, base = [] }) {
  const baseIds = [...new Set((base || []).map(toId).filter(Boolean))];
  // Пересобираем только после записи документа — список спрашивают на каждом
  // запросе к админке и на каждом апдейте бота.
  let memo = { v: null, ids: baseIds };

  const extra = () => {
    const d = store.read(DOC, null);
    return d && Array.isArray(d.owners) ? d.owners.filter(o => o && toId(o.id)) : [];
  };

  function ids() {
    const v = store.version ? store.version(DOC) : null;
    if (v !== null && memo.v === v) return memo.ids;
    const all = [...new Set([...baseIds, ...extra().map(o => toId(o.id))])];
    if (v !== null) memo = { v, ids: all };
    return all;
  }

  const has = id => ids().includes(Number(id));
  const isBase = id => baseIds.includes(Number(id));

  function list() {
    const added = extra().filter(o => !isBase(o.id));
    return [
      ...baseIds.map(id => ({ id, source: 'env' })),
      ...added.map(o => ({ ...o, id: toId(o.id), source: 'bot' })),
    ];
  }

  // { added: true } | { added: false, reason: 'exists' | 'bad-id' }
  function add(id, meta = {}) {
    const n = toId(id);
    if (!n) return { added: false, reason: 'bad-id' };
    if (has(n)) return { added: false, reason: 'exists' };
    const entry = {
      id: n,
      name: String(meta.name || '').slice(0, 64),
      username: String(meta.username || '').slice(0, 64),
      addedBy: toId(meta.addedBy),
      addedAt: Date.now(),
    };
    store.write(DOC, { owners: [...extra(), entry] });
    return { added: true, entry };
  }

  // { removed: true } | { removed: false, reason: 'env' | 'missing' }
  function remove(id) {
    const n = toId(id);
    if (isBase(n)) return { removed: false, reason: 'env' };
    const rest = extra().filter(o => toId(o.id) !== n);
    if (rest.length === extra().length) return { removed: false, reason: 'missing' };
    store.write(DOC, { owners: rest });
    return { removed: true };
  }

  return { ids, has, isBase, list, add, remove };
}

// ---------- сценарий в боте ----------
const STAGE_TTL = 10 * 60 * 1000;      // сколько ждём пароль / chat_id
const CHAT_MAX_FAILS = 5;              // неверных паролей с одного чата…
const CHAT_WINDOW = 15 * 60 * 1000;    // …за 15 минут — и чат на паузе
const SHOP_MAX_FAILS = 30;             // со всех чатов за час — ввод закрыт всем
const SHOP_WINDOW = 60 * 60 * 1000;
const BARE_MAX = 10;                   // «голых» сообщений-кандидатов на чат…
const BARE_WINDOW = 10 * 60 * 1000;    // …за 10 минут, дальше не сверяем

const BTN_ME = '👤 Это я';
const BTN_PICK = '📇 Выбрать контакт';
const BTN_CANCEL = '✖️ Отмена';

// Пароль без команды узнаём, только если сообщение похоже на пароль: одно
// «слово» без пробелов. Фразы покупателей так не сверяются и не тратят лимит.
const looksLikePassword = text => /^\S{6,256}$/.test(text) && !text.startsWith('/');

// Окно-счётчик: { n, start }. true — лимит ещё не исчерпан.
function hit(map, key, max, windowMs) {
  const now = Date.now();
  const rec = map.get(key);
  if (!rec || now - rec.start > windowMs) { map.set(key, { n: 1, start: now }); return true; }
  rec.n += 1;
  return rec.n <= max;
}
function lockedFor(rec, max, windowMs) {
  if (!rec || rec.n < max) return 0;
  const left = rec.start + windowMs - Date.now();
  return left > 0 ? left : 0;
}
const minutes = ms => Math.max(1, Math.ceil(ms / 60000));

const whoText = (u, id) => {
  const name = u && (u.first_name || u.name) ? esc(u.first_name || u.name) : '';
  const user = u && u.username ? ` @${esc(u.username)}` : '';
  return `${name || 'без имени'}${user} (<code>${id}</code>)`;
};

// t — арендатор; deps — что знает только bot.js:
//   keyboardAfter(chatId) — какую клавиатуру вернуть по завершении сценария,
//   isMenuText(text)      — текст с кнопки постоянного меню магазина,
//   adminButton(chatId)   — кнопка «Открыть панель» или null,
//   syncChatCommands(id, isOwner) — меню команд конкретного чата.
function createOwnerFlow(t, deps) {
  const { tgApi } = t.telegram;
  const owners = t.owners;
  const tag = t.id ? `[owners:${t.id}]` : '[owners]';
  const settings = () => t.settings();

  const stages = new Map();   // chatId → { stage: 'password' | 'id', until }
  const fails = new Map();    // chatId → { n, start }
  const bare = new Map();     // chatId → { n, start }
  let shopFails = null;       // { n, start, alerted }

  const isPrivate = chat => (chat.type ? chat.type === 'private' : Number(chat.id) > 0);

  function stageOf(chatId) {
    const st = stages.get(chatId);
    if (!st) return null;
    if (st.until < Date.now()) { stages.delete(chatId); return null; }
    return st.stage;
  }
  function setStage(chatId, stage) {
    // карты живут в памяти процесса — не даём им расти без предела
    if (stages.size > 1000) for (const [k, v] of stages) if (v.until < Date.now()) stages.delete(k);
    stages.set(chatId, { stage, until: Date.now() + STAGE_TTL });
  }

  const send = (chatId, text, reply_markup) => tgApi('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup,
  });

  // Всем владельцам, кроме перечисленных: о новых владельцах и о подборе пароля.
  async function tellOwners(text, except = []) {
    for (const id of owners.ids()) {
      if (id <= 0 || except.includes(id)) continue;
      await send(id, text).catch(() => {});
    }
  }

  function lockLeft(chatId) {
    const chat = lockedFor(fails.get(chatId), CHAT_MAX_FAILS, CHAT_WINDOW);
    const shop = lockedFor(shopFails, SHOP_MAX_FAILS, SHOP_WINDOW);
    return Math.max(chat, shop);
  }

  async function finish(chatId, text) {
    stages.delete(chatId);
    return send(chatId, text, deps.keyboardAfter(chatId));
  }

  // ---------- шаг 1: пароль ----------
  async function askPassword(chatId) {
    setStage(chatId, 'password');
    await send(chatId,
      '🔐 Пришлите пароль от админки магазина одним сообщением.\n'
      + 'Сообщение с паролем я сразу удалю из чата.',
      { inline_keyboard: [[{ text: BTN_CANCEL, callback_data: 'own:x' }]] });
  }

  async function tryPassword(msg, given) {
    const chatId = msg.chat.id;
    // пароль — даже неверный — в переписке не оставляем
    tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});

    const left = lockLeft(chatId);
    if (left) {
      stages.delete(chatId);
      await send(chatId, `⏳ Слишком много неверных попыток. Попробуйте через ${minutes(left)} мин.`);
      return;
    }

    if (t.checkAdminPassword(given)) {
      fails.delete(chatId);
      bare.delete(chatId);
      console.log(`${tag} верный пароль от chat ${chatId} — жду chat_id нового владельца`);
      await askOwnerId(chatId, true);
      return;
    }

    hit(fails, chatId, CHAT_MAX_FAILS, CHAT_WINDOW);
    if (!shopFails || Date.now() - shopFails.start > SHOP_WINDOW) shopFails = { n: 0, start: Date.now(), alerted: false };
    shopFails.n += 1;
    const tries = fails.get(chatId).n;
    console.warn(`${tag} неверный пароль от chat ${chatId} (${tries}/${CHAT_MAX_FAILS}, за час по магазину: ${shopFails.n})`);

    if (shopFails.n >= SHOP_MAX_FAILS && !shopFails.alerted) {
      shopFails.alerted = true;
      const until = new Date(shopFails.start + SHOP_WINDOW).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      await tellOwners(`⚠️ В боте подбирают пароль от админки: ${shopFails.n} неверных попыток за час. `
        + `Ввод пароля через бота закрыт до ${until}. Последняя попытка — chat <code>${chatId}</code>.`);
    }

    const rest = CHAT_MAX_FAILS - tries;
    if (rest > 0 && !lockLeft(chatId)) {
      setStage(chatId, 'password');
      await send(chatId, `❌ Пароль не подошёл. Осталось попыток: ${rest}.`,
        { inline_keyboard: [[{ text: BTN_CANCEL, callback_data: 'own:x' }]] });
    } else {
      stages.delete(chatId);
      await send(chatId, `⏳ Слишком много неверных попыток. Попробуйте через ${minutes(lockLeft(chatId))} мин.`);
    }
  }

  // ---------- шаг 2: chat_id ----------
  async function askOwnerId(chatId, afterPassword) {
    setStage(chatId, 'id');
    const head = afterPassword ? '🔓 Пароль верный, сообщение с ним я удалил.\n\n' : '';
    await send(chatId,
      `${head}Теперь пришлите <b>chat_id</b> нового владельца — число вида <code>123456789</code>.\n\n`
      + `• Себя — кнопка «${BTN_ME}».\n`
      + `• Другого человека — «${BTN_PICK}», или перешлите сюда любое его сообщение, `
      + 'или пусть он отправит боту /id и передаст вам число.',
      {
        keyboard: [
          [{ text: BTN_ME }],
          [{ text: BTN_PICK, request_users: { request_id: 1, user_is_bot: false, max_quantity: 1, request_name: true, request_username: true } }],
          [{ text: BTN_CANCEL }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'chat_id, например 123456789',
      });
  }

  // Откуда взять id: кнопка «Это я», выбор контакта, карточка контакта,
  // пересланное сообщение или просто число.
  function idFromMessage(msg) {
    const text = String(msg.text || '').trim();
    if (text === BTN_ME) return { id: msg.from && msg.from.id, user: msg.from };
    const shared = msg.users_shared && msg.users_shared.users && msg.users_shared.users[0];
    if (shared) return { id: shared.user_id, user: shared };
    if (msg.user_shared) return { id: msg.user_shared.user_id };
    if (msg.contact) {
      if (!msg.contact.user_id) return { error: 'У этого контакта нет аккаунта Telegram — пришлите chat_id числом.' };
      return { id: msg.contact.user_id, user: msg.contact };
    }
    const origin = msg.forward_origin;
    if (origin && origin.type === 'user') return { id: origin.sender_user.id, user: origin.sender_user };
    if (origin && origin.type === 'hidden_user') {
      return { error: `${esc(origin.sender_user_name || 'Этот человек')} скрыл аккаунт в пересылках. Пусть отправит боту /id и передаст вам число.` };
    }
    if (origin) return { error: 'Это пересылка из группы или канала. Владелец — конкретный человек: перешлите его личное сообщение или пришлите chat_id числом.' };
    if (msg.forward_from) return { id: msg.forward_from.id, user: msg.forward_from };
    const m = /^(?:id[:\s]*)?(-?\d{1,16})$/i.exec(text.replace(/\s+/g, ' '));
    if (m) return { id: Number(m[1]) };
    return null;
  }

  async function addOwner(msg, found) {
    const chatId = msg.chat.id;
    const id = Number(found.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await send(chatId, 'Это chat_id группы или канала. Владелец — конкретный человек: нужен его личный chat_id (положительное число).');
      setStage(chatId, 'id');
      return;
    }
    if (owners.has(id)) {
      await finish(chatId, `ℹ️ <code>${id}</code> уже владелец магазина. Список — /admins.`);
      return;
    }

    // Имя для списка /admins. getChat отвечает, только если человек уже писал
    // боту; нет — добавляем по числу, имя подтянется из его сообщений.
    let user = found.user || null;
    const info = await tgApi('getChat', { chat_id: id }).catch(() => ({ ok: false }));
    if (info.ok && info.result) {
      if (info.result.type && info.result.type !== 'private') {
        await send(chatId, 'Это chat_id группы или канала. Нужен личный chat_id человека.');
        setStage(chatId, 'id');
        return;
      }
      user = info.result;
    }

    const actor = msg.from || {};
    const res = owners.add(id, {
      name: user && (user.first_name || user.name) || '',
      username: user && user.username || '',
      addedBy: actor.id,
    });
    if (!res.added) {
      await finish(chatId, `ℹ️ <code>${id}</code> уже владелец магазина. Список — /admins.`);
      return;
    }
    console.log(`${tag} владелец ${id} добавлен (кем: ${actor.id || chatId})`);
    deps.syncChatCommands(id, true).catch(() => {});

    const self = id === Number(actor.id);
    let text = self
      ? '✅ Готово — вы владелец магазина.\n\nПанель управления: /admin\nВладельцы: /admins'
      : `✅ ${whoText(user, id)} теперь владелец магазина.\n\nСписок и удаление: /admins`;

    if (!self) {
      const shopName = esc(settings().brand.shopName || 'магазин');
      const btn = deps.adminButton(id);
      const greet = `🔑 Вам открыт доступ к панели управления «${shopName}».\nОткрыть: /admin`;
      let note = await send(id, greet, btn ? { inline_keyboard: [[btn]] } : undefined).catch(() => ({ ok: false }));
      // кнопку web_app Telegram может отвергнуть (домен не привязан) — текст важнее
      if (!note.ok && btn) note = await send(id, greet).catch(() => ({ ok: false }));
      if (!note.ok) text += '\n\nСообщить ему не получилось: он ещё не писал боту. Пусть отправит /start, а затем /admin.';
    }
    await finish(chatId, text);
    await tellOwners(`🔐 Новый владелец магазина: ${whoText(user, id)}.\nДобавил: ${whoText(actor, actor.id || chatId)}.`,
      [id, Number(actor.id), Number(chatId)]);
    if (self) {
      const btn = deps.adminButton(chatId);
      if (btn) await send(chatId, 'Панель управления — откроется прямо в Telegram.', { inline_keyboard: [[btn]] });
    }
  }

  // ---------- /admins ----------
  function listScreen() {
    const rows = [];
    const lines = owners.list().map(o => {
      if (o.source === 'env') return `• <code>${o.id}</code> — из настроек сервера`;
      const name = o.name ? esc(o.name) : 'без имени';
      const user = o.username ? ` @${esc(o.username)}` : '';
      rows.push([{ text: `✖️ Убрать ${(o.name || String(o.id)).slice(0, 24)}`, callback_data: `own:rm:${o.id}` }]);
      return `• ${name}${user} — <code>${o.id}</code>`;
    });
    rows.push([{ text: '➕ Добавить владельца', callback_data: 'own:add' }]);
    const text = `👑 <b>Владельцы магазина</b>\n\n${lines.join('\n') || 'Пока никого.'}`
      + (owners.list().some(o => o.source === 'env')
        ? '\n\nВладельцев «из настроек сервера» бот не убирает — это строка ADMIN_CHAT_IDS в .env.'
        : '');
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  // ---------- входящие ----------
  // true — сообщение относится к сценарию владельцев и уже обработано.
  async function handleMessage(msg) {
    if (!isPrivate(msg.chat)) return false;
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();
    const cmd = text.startsWith('/') ? text.slice(1).split(/[\s@]/)[0].toLowerCase() : '';
    const arg = cmd ? text.slice(cmd.length + 1).replace(/^@\S+/, '').trim() : '';
    const owner = owners.has(chatId);

    // /owner <пароль> и /admin <пароль> — пароль прямо в команде. Владельцу
    // /admin с хвостом — просто панель, а не попытка пароля.
    if (arg && (cmd === 'owner' || (cmd === 'admin' && !owner))) { await tryPassword(msg, arg); return true; }
    if (cmd === 'owner') {
      if (owner) await askOwnerId(chatId, false);
      else if (lockLeft(chatId)) await send(chatId, `⏳ Слишком много неверных попыток. Попробуйте через ${minutes(lockLeft(chatId))} мин.`);
      else await askPassword(chatId);
      return true;
    }
    if (cmd === 'admins') {
      if (!owner) { await send(chatId, '⛔ Доступно только владельцу магазина.'); return true; }
      stages.delete(chatId);
      const screen = listScreen();
      await send(chatId, screen.text, screen.reply_markup);
      return true;
    }

    const stage = stageOf(chatId);
    if (stage) {
      if (text === BTN_CANCEL || cmd === 'cancel') { await finish(chatId, 'Отменено.'); return true; }
      // другая команда или кнопка меню магазина — человек передумал
      if (cmd || (text && deps.isMenuText(text))) { stages.delete(chatId); return false; }

      if (stage === 'password') {
        if (!text) { await send(chatId, 'Пароль — текстом, одним сообщением.'); return true; }
        await tryPassword(msg, text);
        return true;
      }
      // stage === 'id': добавлять может только тот, кто прошёл пароль или уже владелец
      const found = idFromMessage(msg);
      if (!found) {
        await send(chatId, `Не вижу chat_id. Пришлите число, нажмите «${BTN_ME}» или «${BTN_PICK}».`);
        return true;
      }
      if (found.error) { await send(chatId, found.error); return true; }
      await addOwner(msg, found);
      return true;
    }

    // Пароль без команды: владелец просто присылает его боту
    if (!cmd && looksLikePassword(text) && !lockLeft(chatId)
        && hit(bare, chatId, BARE_MAX, BARE_WINDOW) && t.checkAdminPassword(text)) {
      tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      fails.delete(chatId);
      bare.delete(chatId);
      console.log(`${tag} верный пароль от chat ${chatId} — жду chat_id нового владельца`);
      await askOwnerId(chatId, true);
      return true;
    }
    return false;
  }

  const ownsCallback = cb => String(cb && cb.data || '').startsWith('own:');

  async function handleCallback(cb) {
    const data = String(cb.data || '');
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const answer = (text, alert) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: Boolean(alert) }).catch(() => {});
    if (!chatId) return answer();

    if (data === 'own:x') {
      stages.delete(chatId);
      await answer('Отменено');
      await tgApi('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id }).catch(() => {});
      return;
    }

    // Остальное — только владельцам, и решает тот, кто нажал, а не чат
    if (!owners.has(cb.from && cb.from.id)) return answer('Доступно только владельцу магазина', true);

    if (data === 'own:add') {
      await answer();
      await askOwnerId(chatId, false);
      return;
    }

    const rm = /^own:rm:(\d+)$/.exec(data);
    if (rm) {
      const id = Number(rm[1]);
      const res = owners.remove(id);
      if (!res.removed && res.reason === 'env') return answer('Этот владелец прописан в .env сервера — убрать можно только там', true);
      await answer(res.removed ? 'Убран' : 'Уже убран');
      if (res.removed) {
        console.log(`${tag} владелец ${id} убран (кем: ${cb.from.id})`);
        deps.syncChatCommands(id, false).catch(() => {});
        if (id !== Number(cb.from.id)) {
          await send(id, `Доступ к панели управления «${esc(settings().brand.shopName || 'магазин')}» закрыт.`).catch(() => {});
        }
        await tellOwners(`🔐 Убран владелец <code>${id}</code>. Кем: ${whoText(cb.from, cb.from.id)}.`, [id, Number(cb.from.id)]);
      }
      const screen = listScreen();
      await tgApi('editMessageText', {
        chat_id: chatId, message_id: cb.message.message_id,
        text: screen.text, parse_mode: 'HTML', reply_markup: screen.reply_markup,
      }).catch(() => {});
      return;
    }
    await answer();
  }

  return { handleMessage, handleCallback, ownsCallback, _internal: { stages, fails } };
}

module.exports = { createOwners, createOwnerFlow, BTN_ME, BTN_PICK, BTN_CANCEL, _internal: { looksLikePassword } };
