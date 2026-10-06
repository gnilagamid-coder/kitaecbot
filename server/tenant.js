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
const { createOwners } = require('./owners');
const { sanitize } = require('./settings');

function createTenant({
  id = '',
  dataDir,
  botToken = '',
  adminToken = '',
  // Платформа хранит не сам пароль админки, а его sha256 — тогда хэш можно
  // передать сюда и не светить пароль в процессах. Задан — берём его.
  adminHash = null,
  // Ключ подписи билетов админки из Telegram. По умолчанию ADMIN_TOKEN,
  // у магазинов платформы — хэш пароля (свой у каждого, стабильный).
  sessionKey = '',
  publicUrl = '',
  apiBase = DEFAULT_API_BASE,
  botMode = 'polling',
  // Запрет отката на long polling при неудачном setWebhook. Нужен, когда
  // процессов несколько: два поллера на один токен дают вечный 409 Conflict
  // у обоих, и лучше остаться без бота с записью в логе, чем сломать соседа.
  strictWebhook = false,
  adminChatIds = [],
  // Готовое хранилище (например, store-db в режиме платформы). Не задано —
  // файловый стор на dataDir, как всегда.
  store: givenStore = null,
} = {}) {
  const store = givenStore || createStore(dataDir);
  let settingsMemo = { v: null, value: null };
  // Владельцы: базовый список (.env / реестр) плюс добавленные через бота.
  const owners = createOwners({ store, base: adminChatIds });

  const tenant = {
    id,
    store,
    orders: createOrders(store),
    telegram: createTelegram({ botToken, apiBase }),
    adminToken,
    publicUrl: String(publicUrl || '').replace(/\/$/, ''),
    botMode,
    strictWebhook,
    // Кому из телеграма открыта админка (chat_id владельцев): ADMIN_CHAT_IDS
    // плюс добавленные через бота (/owner + пароль). Пусто — входа из бота
    // нет, остаётся только ADMIN_TOKEN.
    owners,
    isOwner: id => owners.has(id),
    get adminChatIds() { return owners.ids(); },

    // Настройки всегда отдаются уже нормализованными: витрина и админка
    // про дефолты ничего не знают, за них отвечает settings.js.
    // Нормализация пересчитывается только после записи настроек: её зовут на
    // каждом запросе и по нескольку раз на каждый апдейт бота. Результат общий
    // для всех вызовов — его только читают, менять нельзя.
    settings: () => {
      const v = store.version ? store.version('settings') : null;
      if (v !== null && settingsMemo.v === v) return settingsMemo.value;
      const value = sanitize(store.read('settings', {}));
      if (v !== null) settingsMemo = { v, value };
      return value;
    },

    // Сравнение токена без утечки времени. Сравниваем именно sha256-дайджесты:
    // timingSafeEqual требует равной длины буферов и бросает исключение при
    // разной, а токен может быть любым — в том числе кириллицей, где длина
    // в байтах не равна длине строки.
    adminHash: adminHash
      ? Buffer.from(adminHash)
      : crypto.createHash('sha256').update(String(adminToken)).digest(),
    sessionKey: sessionKey || adminToken,

    // Пароль от админки, присланный боту (сценарий /owner). Тот же дайджест,
    // что у веб-входа; пустая строка не подходит никогда — иначе магазин без
    // пароля пускал бы кого угодно.
    checkAdminPassword(given) {
      const s = String(given || '');
      if (!s) return false;
      const hash = crypto.createHash('sha256').update(s).digest();
      return hash.length === tenant.adminHash.length && crypto.timingSafeEqual(hash, tenant.adminHash);
    },
  };

  // Бот создаётся последним: ему нужен уже собранный арендатор, потому что
  // он читает и настройки, и хранилище, и публичный адрес.
  tenant.bot = createBot(tenant);

  return tenant;
}

module.exports = { createTenant };
