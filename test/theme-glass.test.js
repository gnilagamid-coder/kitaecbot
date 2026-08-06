// Liquid Glass: пресет glass — дефолт новых магазинов, флаг glass тянется
// из пресета через resolveTheme, sanitize наследует radius/шрифт/капслок из
// пресета, а серверный boot вписывает класс glass в первый кадр витрины.
// Сквозная часть — на живом сервере (схема admin-bot.test.js).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const { THEME_PRESETS, resolveTheme } = require('../public/theme-core.js');
const { DEFAULTS, sanitize, mergeDeep } = require('../server/settings');

test('пресет glass существует и помечен флагом glass', () => {
  const g = THEME_PRESETS.glass;
  assert.ok(g, 'пресет glass должен быть в THEME_PRESETS');
  assert.strictEqual(g.glass, true);
  assert.strictEqual(g.fontDisplay, 'Inter');
  assert.strictEqual(g.uppercase, false);
  assert.ok(g.radius >= 16, 'стекло живёт только с крупными радиусами');
});

test('resolveTheme тянет флаг glass из пресета, у остальных его нет', () => {
  assert.strictEqual(resolveTheme({ preset: 'glass' }).glass, true);
  assert.strictEqual(resolveTheme({ preset: 'brutalist' }).glass, false);
  // ручные переопределения цветов не должны гасить структурный признак
  assert.strictEqual(resolveTheme({ preset: 'glass', accent: '#ff0000' }).glass, true);
});

test('пустые radius/fontDisplay/uppercase наследуются из пресета glass', () => {
  const r = resolveTheme({ preset: 'glass', radius: '', borderWidth: '', fontDisplay: '', uppercase: null });
  assert.strictEqual(r.radius, THEME_PRESETS.glass.radius);
  assert.strictEqual(r.borderWidth, THEME_PRESETS.glass.borderWidth);
  assert.strictEqual(r.fontDisplay, 'Inter');
  assert.strictEqual(r.uppercase, false);
});

test('дефолты нового магазина — glass без жёстких значений брутализма', () => {
  const s = sanitize(mergeDeep(DEFAULTS, {}));
  assert.strictEqual(s.theme.preset, 'glass');
  assert.strictEqual(s.theme.radius, '');       // наследуется из пресета
  assert.strictEqual(s.theme.fontDisplay, '');
  assert.strictEqual(s.theme.uppercase, null);
});

test('явно заданные значения старого магазина не затираются дефолтами', () => {
  const s = sanitize(mergeDeep(DEFAULTS, {
    theme: { preset: 'brutalist', radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true },
  }));
  assert.strictEqual(s.theme.preset, 'brutalist');
  assert.strictEqual(s.theme.radius, 0);         // 0 — заданное значение, не «пусто»
  assert.strictEqual(s.theme.fontDisplay, 'Oswald');
  assert.strictEqual(s.theme.uppercase, true);
  assert.strictEqual(resolveTheme(s.theme).glass, false);
});

// ---------- сквозной тест: сервер подставляет glass в первый кадр ----------
const PORT = 4500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgshop-glass-'));
let child;

test.before(async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), '[]');

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      ADMIN_TOKEN: TOKEN, DATA_DIR,
      BOT_TOKEN: '',                // без бота: сервер поднимается как чистая витрина
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/settings'); return; } catch (e) { /* ещё не поднялся */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся за 6 секунд');
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('новый магазин отдаёт тему glass в /api/settings', async () => {
  const res = await fetch(BASE + '/api/settings');
  const data = await res.json();
  assert.strictEqual(data.theme.preset, 'glass');
});

test('первый кадр витрины: bootClass содержит glass, радиус из пресета', async () => {
  const res = await fetch(BASE + '/', { headers: { 'User-Agent': 'Mozilla/5.0 TelegramWebApp/10.5' } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // bootScript кладёт список классов в dataset; glass обязан быть в нём
  const m = /dataset\.bootClass="([^"]*)"/.exec(html) || /dataset\.bootClass='([^']*)'/.exec(html);
  assert.ok(m, 'bootClass должен быть в первом кадре');
  assert.ok(m[1].split(/\s+/).includes('glass'), `в bootClass нет glass: "${m[1]}"`);
  // радиус приехал из пресета (24px), а не дефолтные 0
  assert.ok(html.includes('--radius:24px'), 'boot-переменные должны нести радиус пресета glass');
});

test('переключение пресета продавцом меняет boot-класс на лету', async () => {
  const put = await fetch(BASE + '/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: Buffer.from(JSON.stringify({ theme: { preset: 'brutalist', radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true } })),
  });
  assert.strictEqual(put.status, 200);
  const res = await fetch(BASE + '/');
  const html = await res.text();
  const m = /dataset\.bootClass="([^"]*)"/.exec(html);
  assert.ok(m, 'bootClass должен быть в первом кадре');
  assert.ok(!m[1].split(/\s+/).includes('glass'), 'после смены пресета glass исчезает из bootClass');
  assert.ok(html.includes('--radius:0px'));
});
