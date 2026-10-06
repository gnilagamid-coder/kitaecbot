'use strict';
// Резервные копии магазина: снимок всей папки данных (JSON + картинки) в
// отдельный каталог, по расписанию или вручную из админки.
//
// Почему снимок-каталог, а не сразу архив. Восстановление из своей же копии
// должно быть максимально простым и не зависеть от распаковщика: файлы
// копируются обратно как есть, а целостность проверяется по sha256 из
// манифеста. В архив (.tar.gz) снимок превращается только на скачивание.
// Когда данные переедут в MySQL (следующие стадии SaaS), этот модуль заменит
// дамп базы — интерфейс для админки останется тем же.
//
// Раскладка на диске:
//   <backupsRoot>/<tenant>/2026-08-06_14-30-05/   — снимок
//     manifest.json                                 — время, список файлов, sha256
//     products.json, settings.json, ...             — копии JSON из DATA_DIR
//     images/                                       — копии картинок
// Конфиг автобэкапа живёт в <DATA_DIR>/backup-config.json и в снимки НЕ
// попадает: восстановление не должно откатывать сами настройки бэкапов.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Имя снимка — это его дата в UTC, заодно и сортировка по алфавиту = по времени.
const NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const CONFIG_FILE = 'backup-config.json';
// Не откатываются при восстановлении: настройки самих бэкапов и список
// владельцев (доступ к админке). Снимок недельной давности не должен
// вернуть права тому, кого с тех пор убрали.
const KEEP_ON_RESTORE = new Set([CONFIG_FILE, 'admins.json']);

const DEFAULTS = { enabled: false, intervalHours: 24, retention: 10 };

// Любые входящие значения прогоняются через кламп: админка шлёт только свои
// числа, а сломать планировщик мусором из запроса не должно быть возможно.
// Числа разбираем аккуратно: пустая строка — это «верни дефолт», а не «ноль».
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function clampConfig(raw) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  return {
    enabled: !!c.enabled,
    intervalHours: Math.min(720, Math.max(1, Math.round(numOr(c.intervalHours, DEFAULTS.intervalHours)))),
    retention: Math.min(100, Math.max(1, Math.round(numOr(c.retention, DEFAULTS.retention)))),
  };
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Рекурсивный обход каталога; возвращает пути файлов относительно root.
async function walk(root, dir = root, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

// Атомарная запись конфига — как в store.js: временный файл + rename.
async function writeAtomic(file, value) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function createBackupManager({ dataDir, backupsRoot, tenantId = 'shop', store = null, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error('backup: не задан dataDir');
  const DATA_DIR = path.resolve(dataDir);
  // По умолчанию — папка backups рядом с папкой данных. BACKUP_DIR из
  // окружения позволяет вынести копии на другой диск/том.
  const ROOT = path.resolve(
    path.join(backupsRoot || path.join(path.dirname(DATA_DIR), 'backups'), String(tenantId || 'shop'))
  );
  const CONFIG_PATH = path.join(DATA_DIR, CONFIG_FILE);

  function getConfig() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* ещё не создан */ }
    return { ...clampConfig(raw), lastRunAt: String(raw.lastRunAt || '') };
  }

  async function saveConfig(patch) {
    const cur = getConfig();
    const next = clampConfig({ ...cur, ...patch });
    next.lastRunAt = patch.lastRunAt !== undefined ? String(patch.lastRunAt) : cur.lastRunAt;
    await writeAtomic(CONFIG_PATH, next);
    return next;
  }

  async function updateConfig(patch) {
    const cur = getConfig();
    const next = clampConfig({ ...cur, ...patch });
    next.lastRunAt = cur.lastRunAt;
    // Ждём запись на диск: планировщик читает конфиг прямо из файла, и ответ
    // «сохранено» не должен опережать реальное сохранение.
    await writeAtomic(CONFIG_PATH, next);
    return next;
  }

  const snapDir = name => path.join(ROOT, name);

  // Защита от выхода за пределы ROOT: имя обязано совпадать с форматом снимка,
  // а итоговый путь — лежать внутри ROOT. Двойной заслон от ../-подстановок.
  function resolveSnap(name) {
    const n = String(name || '');
    if (!NAME_RE.test(n)) throw Object.assign(new Error('неверное имя снимка'), { status: 400 });
    const dir = path.resolve(snapDir(n));
    if (!dir.startsWith(ROOT + path.sep)) throw Object.assign(new Error('неверное имя снимка'), { status: 400 });
    return dir;
  }

  async function list() {
    let names = [];
    try {
      names = (await fsp.readdir(ROOT, { withFileTypes: true }))
        .filter(e => e.isDirectory() && NAME_RE.test(e.name))
        .map(e => e.name)
        .sort()
        .reverse(); // новые сверху
    } catch (e) { /* папки ещё нет — снимков ноль */ }
    const out = [];
    for (const name of names) {
      try {
        const m = JSON.parse(await fsp.readFile(path.join(snapDir(name), 'manifest.json'), 'utf8'));
        out.push({
          name,
          createdAt: m.createdAt || '',
          source: m.source || '',
          files: Array.isArray(m.files) ? m.files.length : 0,
          size: Array.isArray(m.files) ? m.files.reduce((a, f) => a + (Number(f.size) || 0), 0) : 0,
        });
      } catch (e) {
        out.push({ name, createdAt: '', source: '', files: 0, size: 0, broken: true });
      }
    }
    return out;
  }

  // Один бэкап за раз: параллельные ручные нажатия и сработавший планировщик
  // не должны собирать два снимка одновременно.
  let busy = null;
  async function runNow(source = 'manual') {
    if (busy) return busy;
    busy = (async () => {
      // Дождаться, пока отложенные записи store лягут на диск — иначе снимок
      // может отстать от того, что продавец только что сохранил в админке.
      if (store && typeof store.flush === 'function') await store.flush();

      const createdAt = new Date(now()).toISOString();
      const name = createdAt.replace(/[-:]/g, m => (m === ':' ? '-' : m)).replace('T', '_').slice(0, 19);
      const dest = snapDir(name);
      await fsp.mkdir(dest, { recursive: true });

      const files = [];
      const rels = (await walk(DATA_DIR))
        .filter(r => !r.startsWith('..') && r !== CONFIG_FILE && !r.endsWith('.tmp'))
        .sort();
      for (const rel of rels) {
        const src = path.join(DATA_DIR, rel);
        const buf = await fsp.readFile(src);
        const to = path.join(dest, rel);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.writeFile(to, buf);
        files.push({ path: rel, size: buf.length, sha256: sha256(buf) });
      }
      const manifest = { createdAt, source, node: process.version, files };
      await writeAtomic(path.join(dest, 'manifest.json'), manifest);

      await prune(getConfig().retention);
      await saveConfig({ lastRunAt: createdAt });
      console.log(`[backup] снимок ${name}: файлов ${files.length}, источник ${source}`);
      return { name, createdAt, files: files.length, size: files.reduce((a, f) => a + f.size, 0) };
    })().finally(() => { busy = null; });
    return busy;
  }

  // Retention: держим только N последних снимков, старые стираем целиком.
  async function prune(retention) {
    const snaps = (await list()).map(s => s.name).sort(); // старые сверху
    while (snaps.length > retention) {
      const victim = snaps.shift();
      await fsp.rm(snapDir(victim), { recursive: true, force: true });
      console.log(`[backup] удалён старый снимок ${victim} (retention=${retention})`);
    }
  }

  async function readManifest(name) {
    const dir = resolveSnap(name);
    let m;
    try { m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')); }
    catch (e) { throw Object.assign(new Error('снимок не найден или испорчен'), { status: 404 }); }
    if (!Array.isArray(m.files)) throw Object.assign(new Error('манифест снимка испорчен'), { status: 500 });
    return { dir, m };
  }

  // Перед восстановлением сверяем каждый байт снимка с манифестом: если копия
  // побита, восстанавливать её нельзя — это добьёт данные вместо спасения.
  async function verify(name) {
    const { dir, m } = await readManifest(name);
    const bad = [];
    for (const f of m.files) {
      try {
        const buf = await fsp.readFile(path.join(dir, f.path));
        if (buf.length !== f.size || sha256(buf) !== f.sha256) bad.push(f.path);
      } catch (e) { bad.push(f.path); }
    }
    return { ok: bad.length === 0, bad };
  }

  async function remove(name) {
    const dir = resolveSnap(name);
    await fsp.rm(dir, { recursive: true, force: true });
    console.log(`[backup] снимок ${name} удалён вручную`);
    return { ok: true };
  }

  async function restore(name) {
    const { dir, m } = await readManifest(name);
    const v = await verify(name);
    if (!v.ok) throw Object.assign(new Error(`снимок испорчен: ${v.bad.slice(0, 5).join(', ')}`), { status: 500 });
    if (store && typeof store.flush === 'function') await store.flush();

    // JSON: снимаем всё, кроме конфига бэкапов и владельцев, и кладём копии из снимка.
    for (const e of await fsp.readdir(DATA_DIR)) {
      if (!e.endsWith('.json') || KEEP_ON_RESTORE.has(e)) continue;
      await fsp.rm(path.join(DATA_DIR, e), { force: true });
    }
    for (const f of m.files.filter(f => f.path.endsWith('.json') && !KEEP_ON_RESTORE.has(f.path))) {
      await fsp.copyFile(path.join(dir, f.path), path.join(DATA_DIR, f.path));
    }
    // Картинки: зеркалим папку images снимка — состояние откатывается целиком,
    // включая удалённые после снимка файлы.
    const imgDir = path.join(DATA_DIR, 'images');
    await fsp.rm(imgDir, { recursive: true, force: true });
    const snapImages = path.join(dir, 'images');
    if (fs.existsSync(snapImages)) await fsp.cp(snapImages, imgDir, { recursive: true });
    else await fsp.mkdir(imgDir, { recursive: true });

    // Кэш store после восстановления обязан перечитаться с диска.
    if (store && typeof store.reload === 'function') store.reload();
    console.log(`[backup] восстановление из снимка ${name} завершено`);
    return { ok: true, files: m.files.length };
  }

  // ---------- скачивание: снимок -> .tar.gz ----------
  // Минимальный ustar-писатель без зависимостей: архивы читаются и GNU tar,
  // и bsdtar, и 7-Zip. Достаточно для копий в пару десятков мегабайт.
  function tarHeader(name, size, mtime) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'utf8');   // mode
    h.write('0000000\0', 108, 8, 'utf8');   // uid
    h.write('0000000\0', 116, 8, 'utf8');   // gid
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    h.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
    h.write('        ', 148, 8, 'utf8');    // контрольная сумма — потом
    h.write('0', 156, 1, 'utf8');           // обычный файл
    h.write('ustar\0', 257, 6, 'utf8');
    h.write('00', 263, 2, 'utf8');
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    return h;
  }

  async function archive(name) {
    const { dir, m } = await readManifest(name);
    const parts = [];
    const entries = [{ rel: 'manifest.json', buf: await fsp.readFile(path.join(dir, 'manifest.json')) }];
    for (const f of m.files) entries.push({ rel: f.path, buf: await fsp.readFile(path.join(dir, f.path)) });
    const mtime = Date.parse(m.createdAt) / 1000 || now() / 1000;
    for (const e of entries) {
      const entryName = `${name}/${e.rel}`;
      parts.push(tarHeader(entryName, e.buf.length, mtime), e.buf);
      const pad = (512 - (e.buf.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
    parts.push(Buffer.alloc(1024)); // два пустых блока — конец архива
    return zlib.gzipSync(Buffer.concat(parts));
  }

  // ---------- планировщик ----------
  // Минутный тик: если автобэкап включён и с последнего снимка прошло не меньше
  // интервала — снимаем. Таймер unref, чтобы не держать процесс в тестах.
  let timer = null;
  async function tick() {
    const c = getConfig();
    if (!c.enabled) return;
    const last = Date.parse(c.lastRunAt || '') || 0;
    if (now() - last >= c.intervalHours * 3600 * 1000) {
      try { await runNow('auto'); }
      catch (e) { console.error('[backup] автоснимок не удался:', e.message); }
    }
  }
  function start() { stop(); timer = setInterval(() => { tick(); }, 60 * 1000); if (timer.unref) timer.unref(); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  async function status() {
    const c = getConfig();
    return { config: c, snapshots: await list() };
  }

  return {
    ROOT, getConfig, updateConfig, saveConfig,
    list, runNow, verify, restore, remove, archive, status,
    start, stop, tick,
  };
}

// Заглушка для магазинов, чьи данные живут в MySQL (режим платформы).
// Интерфейс повторяет createBackupManager, чтобы index.js и админка не
// ветвились; снимки папки не применяются — источник правды теперь БД,
// и её копии ведёт уже инфраструктура (dump/репликация), а не этот модуль.
function createDisabledBackup(reason) {
  const deny = () => {
    throw Object.assign(new Error(reason), { status: 400 });
  };
  return {
    ROOT: '',
    getConfig: () => ({ enabled: false, intervalHours: 24, retention: 10, lastRunAt: '' }),
    updateConfig: deny,
    saveConfig: deny,
    list: async () => [],
    runNow: deny,
    verify: deny,
    restore: deny,
    remove: deny,
    archive: deny,
    status: async () => ({
      config: { enabled: false, intervalHours: 24, retention: 10, lastRunAt: '' },
      snapshots: [],
      disabledReason: reason,
    }),
    start() {}, stop() {}, tick() {},
  };
}

module.exports = { createBackupManager, createDisabledBackup, clampConfig, NAME_RE };
