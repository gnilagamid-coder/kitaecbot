'use strict';
// Мини-загрузчик .env — чтобы `node server/...` работал и без systemd,
// который в проде подставляет переменные сам через EnvironmentFile.
// Общий для index.js и CLI-утилит (migrate.js): раньше он жил прямо в index.js,
// но с появлением миграций понадобился и другим точкам входа.

const fs = require('node:fs');
const path = require('node:path');

function loadEnv(root = path.join(__dirname, '..')) {
  try {
    const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* нет .env — значит переменные пришли из окружения */ }
}

module.exports = { loadEnv };
