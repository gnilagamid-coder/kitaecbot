'use strict';
// ЕДИНСТВЕННЫЙ источник правды по настройкам магазина.
// Витрина и админка ничего не знают про дефолты — они всегда получают
// уже нормализованный объект с сервера. Добавляешь новую настройку —
// добавляешь её здесь, в DEFAULTS и в sanitize(), и больше нигде.

const DEFAULTS = {
  version: 2,

  // --- бренд ---
  brand: {
    shopName: 'MY SHOP',
    shopIcon: '🛒',
    logoMark: '',           // ключ готового знака из LOGO_MARKS, пусто = эмодзи
    logoImage: '',          // id загруженной картинки — старше знака и эмодзи
    tagline: '',            // подзаголовок под названием в шапке
    showTagline: false,
    headerStyle: 'bar',     // bar | banner | minimal
  },

  // --- тема оформления ---
  theme: {
    preset: 'brutalist',    // см. THEME_PRESETS в public/theme-core.js
    colorScheme: 'dark',    // dark | light | telegram (следовать теме клиента)
    bg: '', surface: '', surface2: '', text: '', muted: '', accent: '', accent2: '',
    radius: 0,              // px
    borderWidth: 1,         // px
    fontDisplay: 'Oswald',
    fontScale: 100,         // %
    uppercase: true,        // капслок в заголовках/кнопках
    density: 'normal',      // compact | normal | roomy
    cardStyle: 'bordered',  // bordered | flat | shadow | sticker
    gridColumns: 2,         // колонок в сетке на телефоне: 1 | 2
    imageRatio: 'landscape',// square | portrait | landscape
    animations: 'full',     // full | reduced | off
    grain: false,           // зернистая плёнка поверх фона
    marquee: false,         // бегущая строка под шапкой
    marqueeText: '',
    diagonal: true,         // косые срезы у шитов/бейджей (авангард)
    customCss: '',
  },

  // --- каталог ---
  catalog: {
    showSearch: true,
    showCategories: true,
    showSort: true,
    showCount: true,
    defaultSort: 'default', // default | price-asc | price-desc | name
    showStock: true,
    lowStockThreshold: 3,
    hideSoldOut: false,
    showFeaturedBadge: true,
    featuredLabel: 'TOP',
    emptyText: 'Каталог пока пуст.\nЗагляните позже.',
  },

  // --- коммерция ---
  commerce: {
    mode: 'cart',           // cart | manager | inquiry | catalog
    currency: '₽',
    currencyPosition: 'after', // after | before
    priceHidden: false,
    priceHiddenText: 'Цена по запросу',
    enableCart: true,
    enableFavorites: true,
    minOrder: 0,
    ctaProduct: '',         // пусто = подставим по режиму
    ctaCart: '',
  },

  // --- менеджер / прямая связь ---
  manager: {
    buyUrl: '',             // @username, t.me/..., wa.me/... — куда писать
    supportUrl: '',
    templateProduct: 'Здравствуйте! Интересует: {product} — {price}',
    templateCart: 'Здравствуйте! Хочу заказать:\n{items}\n\nИтого: {total}',
    autoCopy: true,         // копировать текст в буфер перед переходом
  },

  // --- форма заказа ---
  checkout: {
    askName: true,
    askPhone: false, phoneRequired: false,
    askEmail: false,
    askComment: false,
    askAddress: true,       // показывается только если есть способы доставки
    paymentMethods: [],
    deliveryMethods: [],
    requireAgreement: false,
    agreementText: 'Согласен на обработку персональных данных',
    successTitle: 'Заказ оформлен ✅',
    successText: 'Спасибо! Ваш заказ обрабатывается — ждите сообщение от менеджера.',
  },

  // --- промокоды ---
  promo: {
    enabled: false,
    label: 'Промокод',
    codes: [],   // [{code, type:'percent'|'fixed', value, minTotal, uses, usesLeft, active}]
  },

  // --- онлайн-оплата ---
  payments: {
    enabled: false,
    provider: 'platega',   // см. server/payments.js
    currencyCode: 'RUB',   // валюта для мерчанта (ISO), отдельно от символа на витрине
    required: false,       // true = заказ нельзя оформить без оплаты
    buttonText: 'Оплатить онлайн',
    successText: 'Оплата получена ✅ Спасибо!',
    creds: {},             // { merchantId, secret, paymentMethod, url, ... }
  },

  // --- уведомления менеджеру ---
  notify: {
    enabled: true,
    chatIds: [],            // куда слать: numeric id или @username группы/канала
    onOrder: true,
    onInquiry: true,        // «написал менеджеру» из мини-аппа
    onNewUser: false,
    includeCustomerLink: true,
    silent: false,          // без звука
  },
  announce: {
    enabled: true,          // анонсы новинок и смены цен подписчикам бота
  },

  // --- публикация в канал ---
  channel: {
    channelId: '',
    miniAppLink: '',
    postTemplate: '{name}\n\n{description}\n\nЦена: {price}',
    postButtonText: '🛍 Открыть в приложении',
  },

  // --- телеграм-бот (long polling на VPS) ---
  bot: {
    enabled: true,
    welcomeText: 'Привет, {name}! 👋\nОткрой каталог кнопкой ниже.',
    buttonText: '🛍 Открыть магазин',
    helpText: 'Нажми кнопку ниже, чтобы открыть каталог. По вопросам — /support',
    notifyCustomer: true,   // присылать покупателю подтверждение в чат
    // Покупателю — только статус и следующий шаг: номер, сумма и срок связи.
    // Служебная выгрузка заказа («Клиент/Телефон/Товары») остаётся у менеджера.
    customerReceiptText: 'Спасибо, {name}! Заказ № {id} принят ✅\nСумма: {total}\nМенеджер свяжется с вами в ближайшее время.',
  },

  // --- профиль покупателя ---
  profile: {
    socialLinks: [],        // [{label, url}]
    showFavorites: true,
    aboutText: '',
    // как показать, что аватарка в шапке — это меню: caret | dot | label | none
    avatarHint: 'caret',
  },

  // --- прочее ---
  advanced: {
    locale: 'ru-RU',
    timezone: 'Europe/Moscow',
    maintenanceMode: false,
    maintenanceText: 'Магазин временно на паузе. Скоро вернёмся!',
  },
};

// ---------- нормализация ----------
const str = (v, fb, max) => String(v === undefined || v === null ? fb : v).slice(0, max);
const bool = (v, fb) => (v === undefined ? !!fb : !!v);
const num = (v, fb, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, n));
};
const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);
const strList = (v, fb, maxItems, maxLen) =>
  (Array.isArray(v) ? v : fb || []).slice(0, maxItems).map(s => String(s).trim().slice(0, maxLen)).filter(Boolean);

// глубокий merge входящего patch поверх текущих настроек, затем валидация всего объекта.
// Так админка может слать хоть один раздел — остальное не потеряется.
function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function sanitize(input) {
  const s = mergeDeep(DEFAULTS, input || {});
// Старые дефолтные тексты покупателя. Магазины, которые не меняли их вручную,
  // при следующей нормализации получают новые: покупатель больше не видит
  // служебную «менеджерскую» выгрузку заказа.
  const LEGACY_SUCCESS_TEXT = 'Спасибо! Заказ отправлен менеджеру — ждите обратной связи.';
  const LEGACY_RECEIPT_TEXT = 'Ваш заказ принят ✅\n\n{order}\n\nМенеджер скоро свяжется с вами.';
  const LEGACY_RECEIPT_V2 = 'Спасибо, {name}! Ваш заказ принят и обрабатывается ⏳\nМенеджер напишет вам в ближайшее время.';
  const b = s.brand, t = s.theme, c = s.catalog, m = s.commerce;
  const mg = s.manager, ch = s.checkout, n = s.notify, cn = s.channel, bt = s.bot, pr = s.profile, ad = s.advanced;
  const pay = s.payments || {};

  const out = {
    version: 2,
    brand: {
      shopName: str(b.shopName, 'MY SHOP', 40).trim() || 'MY SHOP',
      shopIcon: str(b.shopIcon, '🛒', 4),
      logoMark: str(b.logoMark, '', 24),
      logoImage: str(b.logoImage, '', 64),
      tagline: str(b.tagline, '', 80),
      showTagline: bool(b.showTagline),
      headerStyle: oneOf(b.headerStyle, ['bar', 'banner', 'minimal'], 'bar'),
    },
    theme: {
      preset: str(t.preset, 'brutalist', 24),
      colorScheme: oneOf(t.colorScheme, ['dark', 'light', 'telegram'], 'dark'),
      bg: str(t.bg, '', 24), surface: str(t.surface, '', 24), surface2: str(t.surface2, '', 24),
      text: str(t.text, '', 24), muted: str(t.muted, '', 24),
      accent: str(t.accent, '', 24), accent2: str(t.accent2, '', 24),
      radius: num(t.radius, 0, 0, 40),
      borderWidth: num(t.borderWidth, 1, 0, 6),
      fontDisplay: str(t.fontDisplay, 'Oswald', 40),
      fontScale: num(t.fontScale, 100, 80, 130),
      uppercase: bool(t.uppercase, true),
      density: oneOf(t.density, ['compact', 'normal', 'roomy'], 'normal'),
      cardStyle: oneOf(t.cardStyle, ['bordered', 'flat', 'shadow', 'sticker'], 'bordered'),
      gridColumns: oneOf(num(t.gridColumns, 2, 1, 2), [1, 2], 2),
      imageRatio: oneOf(t.imageRatio, ['square', 'portrait', 'landscape'], 'landscape'),
      animations: oneOf(t.animations, ['full', 'reduced', 'off'], 'full'),
      grain: bool(t.grain),
      marquee: bool(t.marquee),
      marqueeText: str(t.marqueeText, '', 200),
      diagonal: bool(t.diagonal, true),
      customCss: str(t.customCss, '', 4000),
    },
    catalog: {
      showSearch: bool(c.showSearch, true),
      showCategories: bool(c.showCategories, true),
      showSort: bool(c.showSort, true),
      showCount: bool(c.showCount, true),
      defaultSort: oneOf(c.defaultSort, ['default', 'price-asc', 'price-desc', 'name'], 'default'),
      showStock: bool(c.showStock, true),
      lowStockThreshold: num(c.lowStockThreshold, 3, 0, 99),
      hideSoldOut: bool(c.hideSoldOut),
      showFeaturedBadge: bool(c.showFeaturedBadge, true),
      featuredLabel: str(c.featuredLabel, 'TOP', 12),
      emptyText: str(c.emptyText, DEFAULTS.catalog.emptyText, 200),
    },
    commerce: {
      mode: oneOf(m.mode, ['cart', 'manager', 'inquiry', 'catalog'], 'cart'),
      currency: str(m.currency, '₽', 8),
      currencyPosition: oneOf(m.currencyPosition, ['after', 'before'], 'after'),
      priceHidden: bool(m.priceHidden),
      priceHiddenText: str(m.priceHiddenText, 'Цена по запросу', 40),
      enableCart: bool(m.enableCart, true),
      enableFavorites: bool(m.enableFavorites, true),
      minOrder: num(m.minOrder, 0, 0, 1e9),
      ctaProduct: str(m.ctaProduct, '', 40),
      ctaCart: str(m.ctaCart, '', 40),
    },
    manager: {
      buyUrl: str(mg.buyUrl, '', 300).trim(),
      supportUrl: str(mg.supportUrl, '', 300).trim(),
      templateProduct: str(mg.templateProduct, DEFAULTS.manager.templateProduct, 400),
      templateCart: str(mg.templateCart, DEFAULTS.manager.templateCart, 400),
      autoCopy: bool(mg.autoCopy, true),
    },
    checkout: {
      askName: bool(ch.askName, true),
      askPhone: bool(ch.askPhone), phoneRequired: bool(ch.phoneRequired),
      askEmail: bool(ch.askEmail),
      askComment: bool(ch.askComment),
      askAddress: bool(ch.askAddress, true),
      paymentMethods: strList(ch.paymentMethods, [], 12, 30),
      deliveryMethods: strList(ch.deliveryMethods, [], 12, 30),
      requireAgreement: bool(ch.requireAgreement),
      agreementText: str(ch.agreementText, DEFAULTS.checkout.agreementText, 200),
      successTitle: str(ch.successTitle, DEFAULTS.checkout.successTitle, 60),
      successText: str(ch.successText, DEFAULTS.checkout.successText, 400),
    },
    promo: {
      enabled: bool(s.promo && s.promo.enabled),
      label: str(s.promo && s.promo.label, 'Промокод', 30),
      codes: (Array.isArray(s.promo && s.promo.codes) ? s.promo.codes : []).slice(0, 50).map(c => ({
        // код нормализуем сразу: клиент вводит как попало, сравнивать надо одинаково
        code: str(c && c.code, '', 32).trim().toUpperCase(),
        type: oneOf(c && c.type, ['percent', 'fixed'], 'percent'),
        value: num(c && c.value, 0, 0, 1e9),
        minTotal: num(c && c.minTotal, 0, 0, 1e9),
        // null = без ограничения по количеству применений
        usesLeft: (c && (c.usesLeft === null || c.usesLeft === undefined || c.usesLeft === ''))
          ? null : Math.max(0, num(c.usesLeft, 0, 0, 1e6)),
        used: num(c && c.used, 0, 0, 1e9),
        active: bool(c && c.active, true),
      })).filter(c => c.code),
    },
    payments: {
      enabled: bool(pay.enabled),
      provider: str(pay.provider, 'platega', 24),
      currencyCode: str(pay.currencyCode, 'RUB', 8).toUpperCase(),
      required: bool(pay.required),
      buttonText: str(pay.buttonText, 'Оплатить онлайн', 40),
      successText: str(pay.successText, DEFAULTS.payments.successText, 200),
      // ключи мерчанта — произвольный набор полей, зависит от провайдера
      creds: Object.fromEntries(
        Object.entries(pay.creds || {}).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), String(v == null ? '' : v).slice(0, 300)])
      ),
    },
    notify: {
      enabled: bool(n.enabled, true),
      chatIds: strList(n.chatIds, [], 5, 60),
      onOrder: bool(n.onOrder, true),
      onInquiry: bool(n.onInquiry, true),
      onNewUser: bool(n.onNewUser),
      includeCustomerLink: bool(n.includeCustomerLink, true),
      silent: bool(n.silent),
    },
    announce: {
      enabled: bool((s.announce || {}).enabled, true),
    },
    channel: {
      channelId: str(cn.channelId, '', 60).trim(),
      miniAppLink: str(cn.miniAppLink, '', 200).trim(),
      postTemplate: str(cn.postTemplate, DEFAULTS.channel.postTemplate, 800),
      postButtonText: str(cn.postButtonText, DEFAULTS.channel.postButtonText, 40),
    },
    bot: {
      enabled: bool(bt.enabled, true),
      welcomeText: str(bt.welcomeText, DEFAULTS.bot.welcomeText, 800),
      buttonText: str(bt.buttonText, DEFAULTS.bot.buttonText, 40),
      helpText: str(bt.helpText, DEFAULTS.bot.helpText, 800),
      notifyCustomer: bool(bt.notifyCustomer, true),
      customerReceiptText: str(bt.customerReceiptText, DEFAULTS.bot.customerReceiptText, 800),
    },
    profile: {
      socialLinks: (Array.isArray(pr.socialLinks) ? pr.socialLinks : [])
        .slice(0, 12)
        .map(l => ({ label: str(l && l.label, '', 30), url: str(l && l.url, '', 300).trim() }))
        .filter(l => l.url),
      showFavorites: bool(pr.showFavorites, true),
      aboutText: str(pr.aboutText, '', 500),
      avatarHint: oneOf(pr.avatarHint, ['caret', 'dot', 'label', 'none'], 'caret'),
    },
    advanced: {
      locale: str(ad.locale, 'ru-RU', 12),
      timezone: str(ad.timezone, 'Europe/Moscow', 40),
      maintenanceMode: bool(ad.maintenanceMode),
      maintenanceText: str(ad.maintenanceText, DEFAULTS.advanced.maintenanceText, 300),
    },
  };

  if (out.checkout.successText === LEGACY_SUCCESS_TEXT) out.checkout.successText = DEFAULTS.checkout.successText;
  if (out.bot.customerReceiptText === LEGACY_RECEIPT_TEXT) out.bot.customerReceiptText = DEFAULTS.bot.customerReceiptText;
  if (out.bot.customerReceiptText === LEGACY_RECEIPT_V2) out.bot.customerReceiptText = DEFAULTS.bot.customerReceiptText;
  return out;
}

module.exports = { DEFAULTS, sanitize, mergeDeep };
