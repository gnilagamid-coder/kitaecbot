'use strict';
// Картинки лежат на диске при любом бэкенде хранилища.
//
// Держать их в базе соблазнительно («всё в одном файле»), но неправильно:
// фото отдаются потоком с длинным кэшем и ETag, их читает nginx-подобный путь
// в serveStatic, и превращать каждый показ карточки в SELECT блоба — значит
// добросить работы и памяти на ровном месте. База берёт на себя данные,
// файловая система — файлы, каждый делает то, что умеет.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

function createImages(imgDir) {
  fs.mkdirSync(imgDir, { recursive: true });

  async function saveImage(contentType, base64) {
    const ext = EXT[contentType] || 'bin';
    const id = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await fsp.writeFile(path.join(imgDir, id), Buffer.from(base64, 'base64'));
    return id;
  }

  function imagePath(id) {
    // защита от ../ в id — наружу отдаём только файлы внутри папки картинок
    const safe = path.basename(String(id || ''));
    const full = path.join(imgDir, safe);
    return full.startsWith(imgDir) && fs.existsSync(full) ? full : null;
  }

  async function deleteImage(id) {
    const p = imagePath(id);
    if (p) await fsp.unlink(p).catch(() => {});
  }

  return { saveImage, imagePath, deleteImage, IMG_DIR: imgDir };
}

module.exports = { createImages, EXT };
