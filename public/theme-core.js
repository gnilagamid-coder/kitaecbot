// Ядро тем: пресеты, шрифты и разрешение итоговой палитры.
// UMD-обёртка не для красоты: этот же файл читает сервер (require) и браузер
// (<script>). Раньше пресеты жили только в браузере, поэтому сервер не мог
// подставить тему в HTML — и витрина успевала моргнуть дефолтной палитрой,
// прежде чем приезжали настройки. Единственный источник правды теперь один.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(root, factory());
}(typeof self !== 'undefined' ? self : this, function () {

const THEME_PRESETS = {
  brutalist: {
    label: 'Бруталист',
    bg: '#0d0d0d', surface: '#161616', surface2: '#202020',
    text: '#f2efe6', muted: '#8a8880', accent: '#e8341c', accent2: '#f2c94c',
    radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  constructivist: {
    label: 'Конструктивизм',
    bg: '#f2ece1', surface: '#ffffff', surface2: '#e6ded0',
    text: '#101010', muted: '#6b6558', accent: '#d81e05', accent2: '#111111',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
  bauhaus: {
    label: 'Баухаус',
    bg: '#faf7f0', surface: '#ffffff', surface2: '#ece7dc',
    text: '#141414', muted: '#7a746a', accent: '#1953d8', accent2: '#f5c400',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
  neon: {
    label: 'Неон',
    bg: '#07070c', surface: '#101020', surface2: '#191932',
    text: '#eef0ff', muted: '#8a8ab5', accent: '#00f5c8', accent2: '#ff2e9a',
    radius: 2, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  swiss: {
    label: 'Швейцарский',
    bg: '#ffffff', surface: '#ffffff', surface2: '#f0f0f0',
    text: '#000000', muted: '#767676', accent: '#ff0000', accent2: '#000000',
    radius: 0, borderWidth: 1, fontDisplay: 'Inter', uppercase: false,
  },
  mono: {
    label: 'Моно',
    bg: '#000000', surface: '#0b0b0b', surface2: '#171717',
    text: '#ffffff', muted: '#8f8f8f', accent: '#ffffff', accent2: '#c8c8c8',
    radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  soft: {
    label: 'Мягкий',
    bg: '#12121a', surface: '#1b1b26', surface2: '#252533',
    text: '#f4f4f8', muted: '#9a9ab0', accent: '#7b5cff', accent2: '#4ad4a0',
    radius: 16, borderWidth: 0, fontDisplay: 'Inter', uppercase: false,
  },
  acid: {
    label: 'Кислота',
    bg: '#0a0f00', surface: '#131a05', surface2: '#1d270a',
    text: '#eaffc7', muted: '#8fa06a', accent: '#c6ff00', accent2: '#ff4d00',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
  // Под аудиторию, которой близок ERD: почти чёрный холст, белый как акцент,
  // кровяной красный точечно. Ноль скруглений, волосяные рамки, крупный капслок —
  // интерфейс уходит на второй план, работает фотография.
  erd: {
    label: 'ERD',
    bg: '#0a0a0a', surface: '#101010', surface2: '#1a1a1a',
    text: '#f5f4f0', muted: '#7b7873', accent: '#ffffff', accent2: '#c8102e',
    radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  // Логика досок объявлений: светло, плотно, скруглённо. Бирюзовый акцент
  // читается как «безопасная сделка», цена и состояние выходят на первый план.
  market: {
    label: 'Маркет',
    bg: '#ffffff', surface: '#ffffff', surface2: '#f1f4f5',
    text: '#16191c', muted: '#6b7280', accent: '#007782', accent2: '#0f172a',
    radius: 14, borderWidth: 0, fontDisplay: 'Inter', uppercase: false,
  },
  // Вдохновлено travel-сайтом eightour.com: почти чёрный холст с фиолетовым
  // подтоном, орхидейные приглушённые подписи, сочный фиолетовый акцент.
  // Адаптировано под нашу систему: шрифты и знаки свои (Trajan лицензионный),
  // контраст текста к фону и приглушённого текста не хуже WCAG AA.
  voyage: {
    label: 'Вояж',
    bg: '#0a0412', surface: '#140a1f', surface2: '#241236',
    text: '#f2f2f2', muted: '#b98acb', accent: '#9e4ed3', accent2: '#9e9eff',
    radius: 0, borderWidth: 1, fontDisplay: 'Space Grotesk', uppercase: true,
  },
};

// Готовые фирменные знаки — альтернатива эмодзи для тех, кому нужен свой логотип,
// но рисовать его негде. Одноцветные: наследуют currentColor, поэтому одинаково
// хорошо ложатся на любую тему.
const LOGO_MARKS = {
  '': { label: 'Эмодзи', svg: '' },
  bolt:    { label: 'Молния',  svg: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>' },
  star:    { label: 'Звезда',  svg: '<path d="M12 2l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.7L5.8 21l1.6-7L2 9.3l7.1-.7L12 2z"/>' },
  flame:   { label: 'Пламя',   svg: '<path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1-.5-2-.5-2 2 1 3.5 3 3.5 5a6 6 0 0 1-12 0c0-5 6-6 6-12z"/>' },
  tag:     { label: 'Ярлык',   svg: '<path d="M2 11.5V3a1 1 0 0 1 1-1h8.5L22 12.5 12.5 22 2 11.5zM7 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>' },
  hanger:  { label: 'Вешалка', svg: '<path d="M12 2a3 3 0 0 0-3 3h2a1 1 0 1 1 1 1c-.6 0-1 .4-1 1v1.2L2.5 14c-.9.6-.5 2 .6 2h17.8c1.1 0 1.5-1.4.6-2L13 8.2V7.9A3 3 0 0 0 12 2z"/>' },
  diamond: { label: 'Ромб',    svg: '<path d="M12 1.5 22.5 12 12 22.5 1.5 12 12 1.5z"/>' },
  skull:   { label: 'Череп',   svg: '<path d="M12 2C7 2 3 5.6 3 10c0 2.7 1.5 5 3.8 6.4V20a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2v-3.6C19.5 15 21 12.7 21 10c0-4.4-4-8-9-8zM8.5 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' },
  cross:   { label: 'Крест',   svg: '<path d="M10 2h4v6h6v4h-6v10h-4V12H4V8h6V2z"/>' },
  eye:     { label: 'Глаз',    svg: '<path d="M12 4C5 4 1 12 1 12s4 8 11 8 11-8 11-8-4-8-11-8zm0 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>' },
};

// Возвращает готовый <svg> знака или пустую строку, если знак не выбран.
function logoMarkSVG(key, size = 26) {
  const m = LOGO_MARKS[key];
  if (!m || !m.svg) return '';
  return `<svg viewBox="0 0 24 24" fill="currentColor" width="${size}" height="${size}" aria-hidden="true">${m.svg}</svg>`;
}

const FONT_STACKS = {
  'Oswald': "'Oswald',sans-serif",
  'Archivo Black': "'Archivo Black',sans-serif",
  'Inter': "'Inter',-apple-system,sans-serif",
  'Space Grotesk': "'Space Grotesk',sans-serif",
  'system': "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
};

const DENSITY = { compact: 0.8, normal: 1, roomy: 1.25 };

// Цвет текста, гарантированно читаемый НА акцентном фоне. Акцент продавец
// выбирает свободно, а в пресетах вроде ERD акцент — белый: кнопки с фоном
// var(--accent) и «общим» цветом текста становились невидимыми (белое на
// белом) и выглядели пустыми плашками. Считаем по относительной яркости
// (формула WCAG): порог 0.45 — эмпирическая середина, жёлтый акцент уже
// получает чёрный текст, красный — белый.
function onAccentColor(color) {
  let c = String(color || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(c)) c = '#' + [...c.slice(1)].map(x => x + x).join('');
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return '';
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(parseInt(m[1].slice(0, 2), 16)) +
            0.7152 * lin(parseInt(m[1].slice(2, 4), 16)) +
            0.0722 * lin(parseInt(m[1].slice(4, 6), 16));
  return L > 0.45 ? '#000000' : '#ffffff';
}

// Собирает итоговую палитру: пресет как база, ручные поля из настроек — сверху.
function resolveTheme(theme) {
  const t = theme || {};
  const preset = THEME_PRESETS[t.preset] || THEME_PRESETS.brutalist;
  const pick = key => (t[key] ? t[key] : preset[key]);
  const numOr = (v, fb) => (v !== null && v !== undefined && v !== '' ? Number(v) : fb);
  return {
    bg: pick('bg'), surface: pick('surface'), surface2: pick('surface2'),
    text: pick('text'), muted: pick('muted'), accent: pick('accent'), accent2: pick('accent2'),
    radius: numOr(t.radius, preset.radius),
    borderWidth: numOr(t.borderWidth, preset.borderWidth),
    fontDisplay: t.fontDisplay || preset.fontDisplay,
    uppercase: t.uppercase != null ? !!t.uppercase : preset.uppercase,
    fontScale: Number(t.fontScale) || 100,
    density: t.density || 'normal',
  };
}


return { THEME_PRESETS, LOGO_MARKS, FONT_STACKS, DENSITY, resolveTheme, logoMarkSVG, onAccentColor };
}));
