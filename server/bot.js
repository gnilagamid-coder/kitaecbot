'use strict';
// Бот на long polling. Сознательно не webhook: вебхуку нужен публичный HTTPS
// с валидным сертификатом ДО первого запуска, а long polling работает сразу
// после `systemctl start` — даже пока домен ещё не приехал. Один процесс с
// веб-сервером, отдельный демон поднимать не нужно.

const crypto = require('node:crypto');
const store = require('./store');
const { tgApi, esc, BOT_TOKEN } = require('./telegram');

let offset = 0;
let running = false;

function settings() { return require('./settings').sanitize(store.read('settings', {})); }

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// URL для открытия мини-аппа кнопками web_app и menu button.
// Приоритет: ссылка вида t.me/bot/app (это уже готовая ссылка Mini App,
// Telegram открывает её нативно), затем https-адрес PUBLIC_URL из .env.
// Важно по Bot API: web_app принимает только https, а для «чужих» доменов
// домен должен быть привязан к боту в @BotFather (/setdomain), иначе клиент
// откатится на открытие в браузере. t.me-ссылка от этого не страдает.
function shopWebAppUrl(s) {
  const link = String(s.channel.miniAppLink || '').trim();
  if (/^https:\/\/(t\.me|telegram\.me)\//i.test(link)) return link;
  const pub = String(process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (/^https:\/\//i.test(pub)) return pub;
  return '';
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

function menuKeyboard(s, chatId) {
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
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function normalize(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('@')) return 'https://t.me/' + t.slice(1);
  if (/^[a-zA-Z0-9_]{5,}$/.test(t)) return 'https://t.me/' + t;
  return t;
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

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

  if (text === '/start' || text.startsWith('/start ')) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: fill(s.bot.welcomeText, { name, shop: esc(s.brand.shopName) }),
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s, chatId),
    });
    return;
  }

  if (text === '/help' || text === '/support') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: fill(s.bot.helpText, { name, shop: esc(s.brand.shopName) }),
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s, chatId),
    });
    return;
  }

  if (text === '/shop' || text === '/menu' || text === '/catalog') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `🛍 ${esc(s.brand.shopName)}`,
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s, chatId),
    });
    return;
  }

  if (text === '/id') {
    await tgApi('sendMessage', { chat_id: chatId, text: `Ваш chat_id: <code>${chatId}</code>`, parse_mode: 'HTML' });
    return;
  }

  // всё остальное — пересылаем менеджеру как вопрос от клиента
  if (text && s.notify.enabled && s.notify.onInquiry) {
    const who = msg.from && msg.from.username ? `@${esc(msg.from.username)}` : `<code>${chatId}</code>`;
    await notifyManagers(s, `💬 Сообщение боту от ${name} ${who}:\n\n${esc(text)}`);
  }
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
    const res = await tgApi('sendMessage', payload);
    if (!res.ok) {
      failed++;
      console.error(`[notify] менеджеру ${id} не доставлено: ${res.description}`);
    }
  }
  return failed === 0;
}

const POLL_TIMEOUT = 25;                 // сколько Telegram держит соединение
const POLL_ABORT_MS = POLL_TIMEOUT * 1000 + 8000; // запас на дорогу

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
        { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] },
        { retries: 0, timeoutMs: POLL_ABORT_MS }
      );

      if (res && res.ok) {
        failures = 0;
        for (const u of res.result) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { console.error('[bot] update failed:', e.message); }
        }
        continue; // сразу за следующей порцией, без пауз
      }

      if (res && /conflict/i.test(res.description || '')) {
        // где-то ещё запущен второй экземпляр или висит вебхук
        console.error('[bot]', res.description, '— снимаю вебхук и продолжаю');
        await tgApi('deleteWebhook', {});
        await sleep(5000);
        continue;
      }

      // Сетевой сбой: первый раз переподключаемся мгновенно — обычно это как раз
      // протухший коннект, и повтор проходит сразу. Дальше нарастающая пауза,
      // чтобы не долбить недоступный сервер, но не больше 30 с.
      failures++;
      if (res && !res.ok) console.error('[bot] getUpdates:', res.description);
      const wait = failures === 1 ? 0 : Math.min(30000, 2000 * failures);
      if (wait) await sleep(wait);
    } catch (e) {
      failures++;
      console.error('[bot] poll error:', e.message);
      await sleep(Math.min(30000, 2000 * failures));
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Секрет вебхука выводим детерминированно из токенов, чтобы не заводить ещё одну
// переменную окружения: Telegram шлёт его в заголовке X-Telegram-Bot-Api-Secret-Token,
// и без этой проверки любой желающий мог бы слать боту поддельные апдейты POST-запросом.
function webhookSecret() {
  return crypto.createHash('sha256')
    .update(BOT_TOKEN + '|' + (process.env.ADMIN_TOKEN || ''))
    .digest('hex')
    .slice(0, 48);
}

const COMMANDS = [
  { command: 'start', description: 'Открыть магазин' },
  { command: 'shop', description: 'Каталог' },
  { command: 'support', description: 'Связаться с менеджером' },
  { command: 'id', description: 'Показать мой chat_id' },
];

async function start() {
  if (!BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN не задан — бот выключен, витрина работает без него');
    return;
  }
  const me = await tgApi('getMe', {});
  if (!me.ok) {
    console.error('[bot] не удалось авторизоваться:', me.description);
    return;
  }
  await tgApi('setMyCommands', { commands: COMMANDS });

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
      if (mb.ok) console.log(`[bot] кнопка меню → web_app: ${appUrl}`);
      // Подсказка по тексту ошибки: /setdomain помогает только при проблемах
      // с URL, а «text must be non-empty» — это валидация самого текста.
      else if (/url|domain/i.test(mb.description || '')) console.warn('[bot] setChatMenuButton не удался:', mb.description,
        '— проверьте домен в @BotFather (/setdomain) или используйте t.me-ссылку мини-аппа');
      else console.warn('[bot] setChatMenuButton не удался:', mb.description);
    }
  }

  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const wantWebhook = String(process.env.BOT_MODE || '').toLowerCase() === 'webhook';

  if (wantWebhook) {
    // Telegram принимает вебхук только на портах 443, 80, 88 и 8443 и только по HTTPS
    if (!/^https:\/\//i.test(publicUrl)) {
      console.error('[bot] BOT_MODE=webhook, но PUBLIC_URL не https — откатываюсь на long polling');
    } else {
      const url = `${publicUrl}/api/webhook`;
      const res = await tgApi('setWebhook', {
        url,
        secret_token: webhookSecret(),
        allowed_updates: ['message'],
        max_connections: 40,
      });
      if (res.ok) {
        console.log(`[bot] запущен как @${me.result.username}, режим: webhook → ${url}`);
        return; // апдейты придёт приносить HTTP-сервер, опрос не нужен
      }
      console.error('[bot] setWebhook не удался:', res.description, '— откатываюсь на long polling');
    }
  }

  console.log(`[bot] запущен как @${me.result.username}, режим: long polling`);
  // long polling и вебхук взаимоисключающи — снимаем вебхук, иначе getUpdates не работает
  await tgApi('deleteWebhook', { drop_pending_updates: false });
  running = true;
  poll();
}

function stop() { running = false; }

module.exports = { start, stop, notifyManagers, fill, normalize, handleUpdate, webhookSecret, shopWebAppUrl };
