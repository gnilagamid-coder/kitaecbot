// Общий модуль для витрины и админки — иконки, форматирование и движок тем
// в одном месте, чтобы не держать одинаковый код в двух html-файлах.

const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.7L5.8 21l1.6-7L2 9.3l7.1-.7L12 2z"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19 19 0 0 1 5.1-5.9M9.9 4.2A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/></svg>';

// ---------- темы ----------
// Пресеты, палитра и знаки переехали в theme-core.js — его читает и браузер,
// и сервер, чтобы подставлять тему прямо в HTML и не давать витрине моргнуть.
// Здесь остаётся только то, что имеет смысл лишь в браузере.

// Применяет тему через CSS-переменные. И витрина, и превью в админке зовут
// именно эту функцию — поэтому превью не может разойтись с реальностью.
function applyTheme(theme, rootEl) {
  const el = rootEl || document.documentElement;
  const r = resolveTheme(theme);
  const set = (k, v) => el.style.setProperty(k, v);
  set('--bg', r.bg); set('--surface', r.surface); set('--surface-2', r.surface2);
  set('--text', r.text); set('--muted', r.muted);
  set('--accent', r.accent); set('--accent-2', r.accent2); set('--heart', r.accent);
  set('--on-accent', contrastOnColor(el, r.accent));
  set('--radius', r.radius + 'px');
  set('--bw', r.borderWidth + 'px');
  set('--font-display', FONT_STACKS[r.fontDisplay] || FONT_STACKS.system);
  // Текстовый шрифт тела: если тема выбрана с «текстовой» гарнитурой
  // (Inter, Space Grotesk), тело тоже идёт ею — иначе на странице живут две
  // разные гарнитуры и клиент видит «шрифт разный». Дисплейные (Oswald,
  // Archivo Black) для длинного текста не предназначены — тело системное.
  set('--font-body', /Inter|Space Grotesk/.test(r.fontDisplay) && FONT_STACKS[r.fontDisplay]
    ? FONT_STACKS[r.fontDisplay] : FONT_STACKS.system);
  set('--fs', (r.fontScale / 100).toFixed(2));
  set('--gap', (DENSITY[r.density] || 1).toFixed(2));
  set('--caps', r.uppercase ? 'uppercase' : 'none');
  // Класс стеклянного слоя живёт на body — туда же его кладёт серверный
  // bootClass при первом кадре, поэтому переключаем именно body (в превью
  // админки это body внутри iframe). Раньше класса не было вовсе.
  const classEl = (document.body && (el === document.documentElement)) ? document.body : el;
  if (classEl && classEl.classList) classEl.classList.toggle('glass', !!r.glass);
  loadFont(r.fontDisplay);
  return r;
}

// Контрастный цвет текста для акцентного фона. Hex считаем математикой
// (onAccentColor из theme-core), а если продавец вписал rgb() или название
// цвета — спрашиваем браузер, подставив цвет во временный элемент.
function contrastOnColor(el, color) {
  const hex = onAccentColor(color);
  if (hex) return hex;
  const d = el.ownerDocument || document;
  const t = d.createElement('i');
  t.style.cssText = 'position:absolute;visibility:hidden;color:' + color;
  el.appendChild(t);
  const rgb = (getComputedStyle(t).color.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
  t.remove();
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return L > 0.45 ? '#000000' : '#ffffff';
}

// Подгружаем только выбранный шрифт, а не все восемь сразу.
function loadFont(name) {
  if (!name || name === 'system') return;
  const id = 'font-' + name.replace(/\s+/g, '-');
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  // media="print" + onload — файл качается в фоне и не задерживает первый кадр.
  // Витрина сразу рисуется системным шрифтом и подменяет его, когда файл придёт
  // (у ссылки стоит display=swap, так что текст не мигает пустотой).
  link.media = 'print';
  link.onload = function(){ this.media = 'all'; this.onload = null; };
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

// ---------- формат ----------
let CURRENCY = { symbol: '₽', position: 'after', locale: 'ru-RU' };
function setCurrency(c) { CURRENCY = { ...CURRENCY, ...c }; }
const fmt = n => {
  const v = Number(n).toLocaleString(CURRENCY.locale);
  return CURRENCY.position === 'before' ? `${CURRENCY.symbol}${v}` : `${v} ${CURRENCY.symbol}`;
};

// Экранирование перед вставкой в innerHTML: названия товаров приходят из
// админки и вполне могут содержать кавычки, < и &.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// подстановка {переменных} в шаблоны сообщений из настроек
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// принимает и "@username", и "username", и уже готовую полную ссылку —
// возвращает рабочий URL. Так в админке проще: не нужно помнить формат https://t.me/...
function normalizeLink(input){
  const v = (input || '').trim();
  if(!v) return '';
  if(/^https?:\/\//i.test(v)) return v;
  if(v.startsWith('@')) return `https://t.me/${v.slice(1)}`;
  if(/^[a-zA-Z0-9_]{5,}$/.test(v)) return `https://t.me/${v}`; // голый юзернейм без @ и без https
  return v; // что-то нестандартное (wa.me/79991234567 и т.п.) — не трогаем
}

// простой debounce — используется для живого поиска, чтобы не дёргать рендер на каждый символ
function debounce(fn, wait){
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
