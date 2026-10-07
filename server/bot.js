'use strict';
// Бот на long polling. Сознательно не webhook по умолчанию: вебхуку нужен
// публичный HTTPS с валидным сертификатом ДО первого запуска, а long polling
// работает сразу после `systemctl start` — даже пока домен ещё не приехал.
// Один процесс с веб-сервером, отдельный демон поднимать не нужно.
//
// Фабрика, а не синглтон: курсор опроса и флаг работы раньше жили на уровне
// модуля, то есть на процесс приходился ровно один бот. Теперь у каждого
// магазина свой экземпляр со своим состоянием — это и есть подготовка к тому,
// чтобы один процесс вёл много магазинов сразу.

const crypto = require('node:crypto');
const { esc } = require('./telegram');
const { createShopBot, SHOP_COMMANDS } = require('./shopbot');
const { createOwnerFlow } = require('./owners');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- чистые помощники (состояние не нужно) ----------

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// принимает и "@username", и "username", и уже готовую полную ссылку
function normalize(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('@')) return 'https://t.me/' + t.slice(1);
  if (/^[a-zA-Z0-9_]{5,}$/.test(t)) return 'https://t.me/' + t;
  return t;
}

// Текст кнопки меню (MenuButtonWebApp.text — обязательное и непустое поле).
// Берём buttonText магазина, срезаем эмодзи/пробелы в начале и пустой остаток
// заменяем запасным названием. Раньше здесь стоял replace(/^\W+/) без флага u:
// в JS \W = [^A-Za-z0-9_], поэтому кириллица тоже считалась «мусором» и
// строка «🛍 Открыть магазин» вычищалась целиком — Telegram отвечал
// «menu button text must be non-empty» на каждом старте.
function menuButtonText(s) {
  const cleaned = String(s.bot.buttonText || '')
    .trim()
    .replace(/^[\s\p{Extended_Pictographic}]+/u, '')
    .trim()
    .slice(0, 20);
  return cleaned || 'Магазин';
}

const POLL_TIMEOUT = 25;                 // сколько Telegram держит соединение
const POLL_ABORT_MS = POLL_TIMEOUT * 1000 + 8000; // запас на дорогу

const COMMANDS = [
  { command: 'start', description: 'Открыть магазин' },
  { command: 'shop', description: 'Каталог' },
  { command: 'subscribe', description: 'Получать анонсы новинок' },
  { command: 'unsubscribe', description: 'Не получать анонсы' },
  { command: 'support', description: 'Связаться с менеджером' },
  { command: 'id', description: 'Показать мой chat_id' },
  { command: 'admin', description: 'Панель управления (владелец)' },
];

// Владельцам в меню «/» добавляется управление владельцами — меню ставится
// на их чат отдельно (scope chat), покупатели этой команды не видят.
const ownerCommands = base => [...base, { command: 'admins', description: 'Владельцы магазина' }];

// ---------- экземпляр бота одного магазина ----------
// t — арендатор: { id, store, telegram, settings(), publicUrl, adminToken, botMode }
function createBot(t) {
  const { tgApi, BOT_TOKEN } = t.telegram;
  const store = t.store;
  const settings = () => t.settings();
  // Префикс в логах: когда процесс ведёт несколько магазинов, без него
  // непонятно, чей бот ругается.
  const tag = t.id ? `[bot:${t.id}]` : '[bot]';
  // Владелец ли пишет: ADMIN_CHAT_IDS из .env плюс добавленные через бота.
  const isAdminChat = id => t.isOwner(id);

  let offset = 0;
  let running = false;
  // 'off' | 'polling' | 'webhook' — нужен, чтобы stop() знал, что именно гасить:
  // цикл опроса или регистрацию у Telegram.
  let mode = 'off';

  // URL для открытия мини-аппа кнопками web_app и menu button.
  // Приоритет: ссылка вида t.me/bot/app (это уже готовая ссылка Mini App,
  // Telegram открывает её нативно), затем https-адрес магазина.
  // Важно по Bot API: web_app принимает только https, а для «чужих» доменов
  // домен должен быть привязан к боту в @BotFather (/setdomain), иначе клиент
  // откатится на открытие в браузере. t.me-ссылка от этого не страдает.
  function shopWebAppUrl(s) {
    const link = String(s.channel.miniAppLink || '').trim();
    // Прямая ссылка мини-аппа — это https://t.me/<бот>/<appname>; голая ссылка
    // на бота мини-аппом не является и в web_app не принимается.
    if (/^https:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+/i.test(link)) return link;
    const pub = String(t.publicUrl || '').trim().replace(/\/$/, '');
    if (/^https:\/\//i.test(pub)) return pub;
    return '';
  }

  function menuKeyboard(s, chatId, subscribed) {
    const link = s.channel.miniAppLink;
    const rows = [];
    // web_app открывает НАСТОЯЩИЙ мини-апп (обвязка Telegram, initData),
    // но по Bot API работает только в приватных чатах. В группы и без
    // проверенного https-URL кладём обычную url-ссылку.
    const appUrl = shopWebAppUrl(s);
    if (appUrl && Number(chatId) > 0) rows.push([{ text: s.bot.buttonText, web_app: { url: appUrl } }]);
    else if (link) rows.push([{ text: s.bot.buttonText, url: link }]);
    if (s.manager.supportUrl || s.manager.buyUrl) {
      const raw = s.manager.supportUrl || s.manager.buyUrl;
      rows.push([{ text: '💬 Написать менеджеру', url: normalize(raw) }]);
    }
    // Переключатель подписки на анонсы. Подписка строго опциональна, поэтому
    // кнопка показывается только когда явно передали состояние (приветствие
    // /start, ответы /subscribe//unsubscribe, нажатие кнопки) — в остальных
    // местах она не мельтешит.
    if (subscribed !== undefined && s.announce && s.announce.enabled) {
      rows.push([subscribed
        ? { text: '🔕 Отписаться от анонсов', callback_data: 'sub:off' }
        : { text: '🔔 Подписаться на анонсы', callback_data: 'sub:on' }]);
    }
    return rows.length ? { inline_keyboard: rows } : undefined;
  }

  // Отправка с аварийным отстёгиванием клавиатуры. Самая частая причина 400 на
  // sendMessage с web_app-кнопкой — домен не привязан к боту в @BotFather
  // (/setdomain): Telegram отклоняет ВЕСЬ message целиком, и получатель не
  // видит ничего. Текст важнее кнопки: при отказе шлём сообщение без неё.
  async function sendWithFallback(payload, label) {
    const res = await tgApi('sendMessage', payload);
    if (res.ok) return res;
    console.error(`${tag} ${label} не отправлено: ${res.description}`);
    if (!payload.reply_markup) return res;
    const retry = await tgApi('sendMessage', { ...payload, reply_markup: undefined });
    if (retry.ok) {
      console.warn(`${tag} ${label} доставлено без кнопки магазина — привяжите домен в @BotFather (/setdomain) или впишите прямую ссылку мини-аппа t.me/бот/app в настройках`);
      return retry;
    }
    console.error(`${tag} ${label} без кнопки тоже не ушло: ${retry.description}`);
    return retry;
  }

  // Магазин прямо в чате: каталог, корзина и оформление на кнопках. Живёт
  // отдельным модулем, а отсюда получает то, что уже умеет этот файл.
  const shop = createShopBot(t, { notifyManagers, shopWebAppUrl, normalize, fill });

  // Кнопочный магазин включается настройкой bot.classicMenu и работает только
  // в личке: в группах обычная клавиатура и пошаговая форма мешали бы всем.
  const classicFor = (s, chat) =>
    Boolean(s.bot.classicMenu) && (chat.type ? chat.type === 'private' : Number(chat.id) > 0);

  // Кнопка админки: web_app — только в личке и только по https; иначе ссылка.
  function adminButton(chatId) {
    const adminUrl = t.publicUrl ? `${t.publicUrl}/admin.html` : '';
    if (!adminUrl) return null;
    return /^https:\/\//i.test(adminUrl) && Number(chatId) > 0
      ? { text: '⚙️ Открыть панель', web_app: { url: adminUrl } }
      : { text: '⚙️ Открыть панель', url: adminUrl };
  }

  // Владелец магазина в Telegram: пароль от админки → chat_id (см. owners.js).
  const owners = createOwnerFlow(t, {
    keyboardAfter: chatId => {
      const s = settings();
      return classicFor(s, { id: chatId }) ? shop.mainKeyboard(s) : { remove_keyboard: true };
    },
    isMenuText: text => shop.isMenuText(text),
    adminButton,
    syncChatCommands,
  });

  async function sendAdminPanel(chatId) {
    if (!isAdminChat(chatId)) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '⛔ Панель управления доступна только владельцу магазина.\n\n'
          + 'Вы владелец? Отправьте /owner — бот попросит пароль от админки.',
      });
      return;
    }
    const button = adminButton(chatId);
    if (!button) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'Админка ещё не настроена: нет PUBLIC_URL.' });
      return;
    }
    await sendWithFallback({
      chat_id: chatId,
      text: 'Панель управления магазином — откроется прямо в Telegram.',
      reply_markup: { inline_keyboard: [[button]] },
    }, 'кнопка админки');
  }

  async function handleUpdate(update) {
    if (update.callback_query) {
      if (owners.ownsCallback(update.callback_query)) return owners.handleCallback(update.callback_query);
      if (shop.ownsCallback(update.callback_query)) return shop.handleCallback(update.callback_query);
      return handleCallback(update.callback_query);
    }
    // Правка старого сообщения — не новая реплика: в режиме магазина её
    // нельзя принимать за ответ на шаг оформления.
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return;

    // Владельцы и вход в панель работают даже при выключенном боте магазина:
    // иначе включить его обратно из Telegram было бы нечем. Сценарий /owner
    // идёт раньше магазина — шаг оформления заказа не должен съесть пароль.
    if (update.message && await owners.handleMessage(msg)) return;
    const firstWord = String(msg.text || '').trim().split(/\s/)[0];
    if (update.message && /^\/admin(@\w+)?$/i.test(firstWord)) { await sendAdminPanel(msg.chat.id); return; }

    const s = settings();
    if (!s.bot.enabled) return;

    const chatId = msg.chat.id;
    const name = esc(msg.from && msg.from.first_name || 'друг');
    const text = String(msg.text || '').trim();

    // новый пользователь — опционально дёргаем менеджера
    const users = store.read('users', {});
    if (!users[chatId]) {
      users[chatId] = { id: chatId, username: msg.from && msg.from.username || '', name, firstSeen: Date.now() };
      store.write('users', users);
      if (s.notify.enabled && s.notify.onNewUser) {
        const who = msg.from && msg.from.username ? `@${esc(msg.from.username)}` : `<code>${chatId}</code>`;
        await notifyManagers(s, `👤 Новый пользователь бота: ${name} ${who}`);
      }
    }

    if (classicFor(s, msg.chat) && update.message && await shop.handleMessage(msg, { name })) return;

    if (text === '/start' || text.startsWith('/start ')) {
      // подписка на анонсы строго опциональна: в приветствии показываем кнопку
      // «🔔 Подписаться», но без явного действия никто не подписывается
      const sub = s.announce.enabled
        ? Boolean(users[chatId] && users[chatId].subAnnounce === true)
        : undefined;
      await sendWithFallback({
        chat_id: chatId,
        text: fill(s.bot.welcomeText, { name, shop: esc(s.brand.shopName) }),
        parse_mode: 'HTML',
        reply_markup: menuKeyboard(s, chatId, sub),
      }, 'приветствие');
      return;
    }

    if (text === '/help' || text === '/support') {
      await sendWithFallback({
        chat_id: chatId,
        text: fill(s.bot.helpText, { name, shop: esc(s.brand.shopName) }),
        parse_mode: 'HTML',
        reply_markup: menuKeyboard(s, chatId),
      }, 'ответ на /help');
      return;
    }

    if (text === '/shop' || text === '/menu' || text === '/catalog') {
      await sendWithFallback({
        chat_id: chatId,
        text: `🛍 ${esc(s.brand.shopName)}`,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard(s, chatId),
      }, 'каталог');
      return;
    }

    if (text === '/id') {
      await tgApi('sendMessage', { chat_id: chatId, text: `Ваш chat_id: <code>${chatId}</code>`, parse_mode: 'HTML' });
      return;
    }

    // Подписка на анонсы — только явное действие: кнопка «🔔 Подписаться»
    // в приветствии или команда /subscribe. По умолчанию НЕ подписан никто.
    if (text === '/unsubscribe') {
      users[chatId] = { ...(users[chatId] || { id: chatId }), name, subAnnounce: false };
      store.write('users', users);
      await sendWithFallback({
        chat_id: chatId,
        text: `Готово, ${name} — анонсы приходить не будут. Передумаете — отправьте /subscribe`,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard(s, chatId, false),
      }, 'ответ на /unsubscribe');
      return;
    }

    if (text === '/subscribe') {
      users[chatId] = { ...(users[chatId] || { id: chatId }), name, subAnnounce: true };
      store.write('users', users);
      await sendWithFallback({
        chat_id: chatId,
        text: `Отлично, ${name}! Теперь вы будете первыми узнавать о новинках и смене цен.`,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard(s, chatId, true),
      }, 'ответ на /subscribe');
      return;
    }

    // всё остальное — пересылаем менеджеру как вопрос от клиента
    if (text && s.notify.enabled && s.notify.onInquiry) {
      const who = msg.from && msg.from.username ? `@${esc(msg.from.username)}` : `<code>${chatId}</code>`;
      await notifyManagers(s, `💬 Сообщение боту от ${name} ${who}:\n\n${esc(text)}`);
    }
  }

  // Нажатие кнопок подписки на анонсы. Сюда попадаем только с явным действием,
  // так что рассылка остаётся строго опциональной: получает её лишь тот,
  // у кого subAnnounce === true.
  async function handleCallback(cb) {
    const data = String(cb.data || '');
    if (data !== 'sub:on' && data !== 'sub:off') return;
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    if (!chatId) return;
    const on = data === 'sub:on';
    const users = store.read('users', {});
    users[chatId] = {
      ...(users[chatId] || { id: chatId }),
      name: esc(cb.from && cb.from.first_name || 'друг'),
      subAnnounce: on,
    };
    store.write('users', users);
    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: on ? 'Подписались на анонсы 🔔' : 'Отписались от анонсов',
    });
    // переключаем кнопку на противоположную — состояние видно прямо в чате
    await tgApi('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: menuKeyboard(settings(), chatId, on),
    });
  }

  // Заявка с сайта магазина (отдельный сервис, см. /api/inbound-lead).
  // Уходит админам бота — владельцам из /admins (ADMIN_CHAT_IDS и добавленные
  // через /owner). Админов нет — получателям уведомлений о заказах, чтобы
  // заявка не терялась.
  const LEAD_TYPES = { buy: 'Купить', tradein: 'Trade-in', sell: 'Продать', repair: 'Ремонт' };
  async function notifySiteLead(s, raw) {
    const l = raw || {};
    const one = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
    const contact = one(l.contact, 120);
    if (!l.test && !contact) return { ok: false, error: 'в заявке нет контакта' };
    const name = one(l.name, 80);
    const product = one(l.product, 160);
    const price = one(l.price, 40);
    const message = String(l.message == null ? '' : l.message).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
    const https = v => (/^https:\/\/[^\s"<>]+$/i.test(String(v || '')) ? String(v).slice(0, 400) : '');
    const url = https(l.url);
    const adminUrl = https(l.adminUrl);
    const site = one(l.site, 80);
    const user = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(contact);
    // сайт присылает проверенный номер в международном виде: его Telegram
    // делает кликабельным, а кнопки открывают клиента в Telegram и WhatsApp
    const phone = /^\+\d{8,15}$/.test(String(l.phone || '')) ? String(l.phone) : '';
    const country = one(l.country, 60);
    const type = LEAD_TYPES[l.type] || 'Заявка';

    const text = l.test
      ? `🧪 <b>Проверка связи с сайтом</b>${site ? ` ${esc(site)}` : ''}\n\nЗаявки с формы на сайте будут приходить сюда.`
      : `🌐 <b>Заявка с сайта · ${esc(type)}</b>\n\n`
        + `Имя: ${esc(name || '—')}\n`
        + (user ? `Telegram: <a href="https://t.me/${user[1]}">@${esc(user[1])}</a>`
          : phone ? `Телефон: ${phone}${country ? ` · ${esc(country)}` : ''}`
            : `Контакт: <code>${esc(contact)}</code>`)
        + (product ? `\nТовар: ${url ? `<a href="${esc(url)}">${esc(product)}</a>` : esc(product)}${price ? ` — ${esc(price)}` : ''}` : '')
        + (message ? `\n\n${esc(message)}` : '')
        + (site ? `\n\n<i>${esc(site)}</i>` : '');
    const kb = [];
    if (user) kb.push([{ text: '💬 Написать клиенту', url: `https://t.me/${user[1]}` }]);
    else if (phone) {
      kb.push([
        { text: '💬 Telegram', url: `https://t.me/${phone}` },
        { text: '🟢 WhatsApp', url: `https://wa.me/${phone.slice(1)}` },
      ]);
    }
    if (adminUrl) kb.push([{ text: 'Все заявки на сайте', url: adminUrl }]);

    let ids = t.owners.ids().filter(id => id > 0);
    let to = 'admins';
    if (!ids.length) { ids = s.notify.enabled ? (s.notify.chatIds || []).filter(Boolean) : []; to = 'managers'; }
    if (!ids.length) return { ok: false, sent: 0, total: 0, error: 'у бота нет админов: добавьте себя командой /owner' };

    let sent = 0;
    for (const id of ids) {
      const res = await tgApi('sendMessage', {
        chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true,
        disable_notification: Boolean(s.notify.silent),
        reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
      });
      if (res.ok) sent++;
      else console.warn(`${tag} заявка с сайта не дошла до ${id}: ${res.description}`);
    }
    return { ok: sent > 0, sent, total: ids.length, to };
  }

  async function notifyManagers(s, text) {
    const appUrl = shopWebAppUrl(s);
    let failed = 0;
    for (const id of s.notify.chatIds) {
      const payload = {
        chat_id: id, text, parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: s.notify.silent,
      };
      // та же кнопка «Открыть», что у покупателя: web_app — только в личке,
      // в группы (отрицательный chat_id) не пришиваем
      if (appUrl && Number(id) > 0) {
        payload.reply_markup = { inline_keyboard: [[{ text: s.bot.buttonText, web_app: { url: appUrl } }]] };
      }
      const res = await sendWithFallback(payload, `уведомление менеджеру ${id}`);
      if (!res.ok) failed++;
    }
    return failed === 0;
  }

  // Анонс только явно подписавшимся: subAnnounce === true ставится кнопкой
  // «🔔 Подписаться на анонсы» в приветствии или командой /subscribe.
  // По умолчанию не подписан никто. Группы и каналы (отрицательный chat_id)
  // не трогаем, потолок одной рассылки — 200 адресатов с паузой 35 мс,
  // чтобы не влететь в глобальный лимит Telegram.
  async function sendToSubscribers(text, label, s0) {
    const s = s0 || settings();
    const users = store.read('users', {});
    const ids = Object.keys(users)
      .filter(id => Number(id) > 0 && users[id] && users[id].subAnnounce === true)
      .slice(0, 200);
    if (!ids.length) {
      console.log(`${tag} ${label}: подписчиков нет — пропускаю`);
      return { sent: 0, total: 0 };
    }
    // кнопка мини-аппа, как у покупателей; если домен не привязан —
    // sendWithFallback сам переотправит сообщение без неё
    const appUrl = shopWebAppUrl(s);
    const kb = appUrl
      ? { inline_keyboard: [[{ text: s.bot.buttonText, web_app: { url: appUrl } }]] }
      : undefined;
    let sent = 0;
    for (const id of ids) {
      const res = await sendWithFallback({
        chat_id: Number(id), text,
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: kb,
      }, `${label} подписчику ${id}`);
      if (res.ok) sent++;
      await sleep(35);
    }
    console.log(`${tag} ${label}: доставлено ${sent}/${ids.length} подписчикам`);
    return { sent, total: ids.length };
  }

  async function poll() {
    let failures = 0;
    while (running) {
      try {
        // retries:0 здесь принципиально. Раньше шли ретраи по умолчанию, и при
        // оборванном соединении один цикл опроса занимал до 3 × 35 с + паузы —
        // около двух минут, в течение которых бот не отвечал вообще. Именно это
        // выглядело как «после простоя бот долго просыпается»: NAT провайдера
        // тихо выбрасывает простаивающий коннект, а мы этого не замечали.
        // Цикл сам себе ретрай, дублировать его внутри tgApi не нужно.
        const res = await tgApi(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] },
          { retries: 0, timeoutMs: POLL_ABORT_MS }
        );

        if (res && res.ok) {
          failures = 0;
          for (const u of res.result) {
            offset = u.update_id + 1;
            try { await handleUpdate(u); } catch (e) { console.error(`${tag} update failed:`, e.message); }
          }
          continue; // сразу за следующей порцией, без пауз
        }

        if (res && /conflict/i.test(res.description || '')) {
          // где-то ещё запущен второй экземпляр или висит вебхук
          console.error(tag, res.description, '— снимаю вебхук и продолжаю');
          await tgApi('deleteWebhook', {});
          await sleep(5000);
          continue;
        }

        // Сетевой сбой: первый раз переподключаемся мгновенно — обычно это как раз
        // протухший коннект, и повтор проходит сразу. Дальше нарастающая пауза,
        // чтобы не долбить недоступный сервер, но не больше 30 с.
        failures++;
        if (res && !res.ok) console.error(`${tag} getUpdates:`, res.description);
        const wait = failures === 1 ? 0 : Math.min(30000, 2000 * failures);
        if (wait) await sleep(wait);
      } catch (e) {
        failures++;
        console.error(`${tag} poll error:`, e.message);
        await sleep(Math.min(30000, 2000 * failures));
      }
    }
  }

  // Секрет вебхука выводим детерминированно, чтобы не заводить ещё одну
  // переменную окружения: Telegram шлёт его в заголовке
  // X-Telegram-Bot-Api-Secret-Token, и без этой проверки любой желающий мог бы
  // слать боту поддельные апдейты обычным POST-запросом.
  //
  // В состав входит ключ магазина, а не только токен бота. Раньше секрет был
  // sha256(BOT_TOKEN + '|' + adminToken), а в режиме платформы adminToken пуст —
  // и у всех магазинов без подключённого бота секрет получался одинаковым.
  // Плюс он вычислялся из одного лишь токена: утечка токена давала и секрет.
  function webhookSecret() {
    return crypto.createHash('sha256')
      .update(`${BOT_TOKEN}|${t.sessionKey || ''}|${t.adminToken || ''}|${t.id || ''}`)
      .digest('hex')
      .slice(0, 48);
  }

  async function start() {
    if (!BOT_TOKEN) {
      console.warn(`${tag} BOT_TOKEN не задан — бот выключен, витрина работает без него`);
      return;
    }
    const me = await tgApi('getMe', {});
    if (!me.ok) {
      console.error(`${tag} не удалось авторизоваться:`, me.description);
      return;
    }
    // Имя бота нужно наружу: сайт магазина строит по нему диплинки на товар
    t.botUsername = me.result.username || t.botUsername || '';
    await syncCommands();

    // Кнопка меню слева от поля ввода — её же видно в превью чата. Без этого
    // вызова у бота стоит type=default («Open»/список команд), а если продавец
    // когда-то вписал туда обычный url через BotFather — магазин открывается
    // браузерным окном без обвязки Mini App. Ставим web_app программно,
    // без chat_id = дефолт для всех приватных чатов. Текст ограничен 20 символами.
    {
      const s0 = settings();
      const appUrl = shopWebAppUrl(s0);
      if (appUrl) {
        const mb = await tgApi('setChatMenuButton', {
          menu_button: {
            type: 'web_app',
            text: menuButtonText(s0),
            web_app: { url: appUrl },
          },
        });
        if (mb.ok) console.log(`${tag} кнопка меню → web_app: ${appUrl}`);
        // Подсказка по тексту ошибки: /setdomain помогает только при проблемах
        // с URL, а «text must be non-empty» — это валидация самого текста.
        else if (/url|domain/i.test(mb.description || '')) console.warn(`${tag} setChatMenuButton не удался:`, mb.description,
          '— проверьте домен в @BotFather (/setdomain) или используйте t.me-ссылку мини-аппа');
        else console.warn(`${tag} setChatMenuButton не удался:`, mb.description);
      }
    }

    const publicUrl = String(t.publicUrl || '').replace(/\/$/, '');
    const wantWebhook = String(t.botMode || '').toLowerCase() === 'webhook';

    if (wantWebhook) {
      // Telegram принимает вебхук только на портах 443, 80, 88 и 8443 и только по HTTPS
      if (!/^https:\/\//i.test(publicUrl)) {
        if (t.strictWebhook) {
          console.error(`${tag} BOT_MODE=webhook, но PUBLIC_URL не https — бот не запущен (откат на polling запрещён)`);
          return;
        }
        console.error(`${tag} BOT_MODE=webhook, но PUBLIC_URL не https — откатываюсь на long polling`);
      } else {
        const url = `${publicUrl}/api/webhook`;
        const res = await tgApi('setWebhook', {
          url,
          secret_token: webhookSecret(),
          allowed_updates: ['message', 'callback_query'],
          max_connections: 40,
        });
        if (res.ok) {
          mode = 'webhook';
          console.log(`${tag} запущен как @${me.result.username}, режим: webhook → ${url}`);
          return; // апдейты придёт приносить HTTP-сервер, опрос не нужен
        }
        // Откат на polling безопасен, только пока процесс один. При нескольких
        // экземплярах (кластер, балансировщик) два поллера на один токен дают
        // вечный 409 Conflict у обоих — там лучше остаться без бота и увидеть
        // это в логе, чем тихо сломать соседний процесс.
        if (t.strictWebhook) {
          console.error(`${tag} setWebhook не удался:`, res.description, '— бот не запущен (откат на polling запрещён)');
          return;
        }
        console.error(`${tag} setWebhook не удался:`, res.description, '— откатываюсь на long polling');
      }
    }

    console.log(`${tag} запущен как @${me.result.username}, режим: long polling`);
    // long polling и вебхук взаимоисключающи — снимаем вебхук, иначе getUpdates не работает
    await tgApi('deleteWebhook', { drop_pending_updates: false });
    mode = 'polling';
    running = true;
    poll();
  }

  // Остановка бота. В режиме опроса достаточно погасить цикл, а вот вебхук
  // нужно снять у самого Telegram: иначе приостановленный магазин остаётся
  // зарегистрированным, апдейты продолжают литься на его адрес, сервер отвечает
  // отказом — и Telegram ретраит это часами. Раньше stop() гасил только цикл,
  // и в режиме вебхука фактически не останавливал ничего.
  async function stop() {
    running = false;
    if (mode !== 'webhook') { mode = 'off'; return; }
    mode = 'off';
    if (!BOT_TOKEN) return;
    const res = await tgApi('deleteWebhook', { drop_pending_updates: false }).catch(e => ({ ok: false, description: e.message }));
    if (res && res.ok) console.log(`${tag} вебхук снят`);
    else console.warn(`${tag} не удалось снять вебхук:`, res && res.description);
  }

  // Список команд в меню «/» зависит от того, включён ли магазин в чате.
  // Зовётся на старте и после сохранения настроек в админке — без
  // перезапуска сервиса.
  const baseCommands = () => (settings().bot.classicMenu ? SHOP_COMMANDS : COMMANDS);

  async function syncCommands() {
    if (!BOT_TOKEN) return;
    const res = await tgApi('setMyCommands', { commands: baseCommands() });
    if (!res.ok) console.warn(`${tag} setMyCommands не удался:`, res.description);
    // у владельцев своё меню поверх общего — его тоже пересобираем
    for (const id of t.owners.ids()) await syncChatCommands(id, true);
  }

  // Меню команд конкретного чата: владельцу — общее плюс /admins, бывшему
  // владельцу — снимаем, и он видит общее. Чат, который ещё не писал боту,
  // Telegram не знает («chat not found») — это не ошибка, меню встанет позже.
  async function syncChatCommands(id, isOwner) {
    if (!BOT_TOKEN || !(Number(id) > 0)) return;
    const scope = { type: 'chat', chat_id: Number(id) };
    const res = isOwner
      ? await tgApi('setMyCommands', { commands: ownerCommands(baseCommands()), scope })
      : await tgApi('deleteMyCommands', { scope });
    if (res && !res.ok && !/chat not found/i.test(res.description || '')) {
      console.warn(`${tag} меню команд для ${id} не обновилось:`, res.description);
    }
  }

  const currentMode = () => mode;

  return {
    start, stop, notifyManagers, notifySiteLead, sendToSubscribers, fill, normalize,
    handleUpdate, webhookSecret, shopWebAppUrl, sendWithFallback, menuButtonText,
    currentMode, syncCommands, syncChatCommands,
    // экраны магазина в чате на произвольных настройках — для превью в админке
    chatPreview: (s, sampleName) => shop.preview(s, sampleName),
  };
}

module.exports = { createBot, fill, normalize, menuButtonText };
