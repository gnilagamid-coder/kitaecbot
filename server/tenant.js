'use strict';
// Арендатор — один магазин со всем своим хозяйством: папка данных, токен бота,
// пароль админки, публичный адрес.
//
// Зачем это нужно. Раньше каждый из модулей читал своё из process.env прямо на
// загрузке и держал состояние на уровне файла: store помнил единственный
// DATA_DIR, telegram — единственный токен, bot — единственный курсор опроса.
// Из-за этого «магазин» и «процесс» были одним и тем же понятием, и второй
// магазин требовал второго systemd-юнита, порта и папки. Здесь эта связка
// разорвана: сколько объектов создали — столько магазинов процесс и обслужит.
//
// Сегодня объект ровно один и собирается из окружения, как и прежде: снаружи
// поведение не поменялось ни на байт. Многоарендный роутинг — следующий этап,
// а это фундамент под него.

const crypto = require('node:crypto');
const { createStore } = require('./store');
const { createOrders } = require('./orders');
const { createTelegram, DEFAULT_API_BASE } = require('./telegram');
const { createBot } = require('./bot');
const { sanitize } = require('./settings');

function createTenant({
  id = '',
  dataDir,
  botToken = '',
  adminToken = '',
  publicUrl = '',
  apiBase = DEFAULT_API_BASE,
  botMode = 'polling',
  adminChatIds = [],
} = {}) {
  const store = createStore(dataDir);

  const tenant = {
    id,
    store,
    orders: createOrders(store),
    telegram: createTelegram({ botToken, apiBase }),
    adminToken,
    publicUrl: String(publicUrl || '').replace(/\/$/, ''),
    botMode,
    // Кому из телеграма открыта админка (chat_id владельцев). Пусто —
    // входа из бота нет, остаётся только ADMIN_TOKEN.
    adminChatIds,

    // Настройки всегда отдаются уже нормализованными: витрина и админка
    // про дефолты ничего не знают, за них отвечает settings.js.
    settings: () => sanitize(store.read('settings', {})),

    // Сравнение токена без утечки времени. Сравниваем именно sha256-дайджесты:
    // timingSafeEqual требует равной длины буферов и бросает исключение при
    // разной, а токен может быть любым — в том числе кириллицей, где длина
    // в байтах не равна длине строки.
    adminHash: crypto.createHash('sha256').update(String(adminToken)).digest(),
  };

  // Бот создаётся последним: ему нужен уже собранный арендатор, потому что
  // он читает и настройки, и хранилище, и публичный адрес.
  tenant.bot = createBot(tenant);

  return tenant;
}

module.exports = { createTenant };
