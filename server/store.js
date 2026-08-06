'use strict';
// Хранилище на файлах. Никакой БД — весь магазин это несколько JSON-файлов и папка
// с картинками, поэтому бэкап = `tar czf backup.tgz data/`, а перенос на другой
// сервер = скопировать папку.
//
// Фабрика, а не синглтон. Раньше DATA_DIR, кэш и очередь записи жили на уровне
// модуля: `require('./store')` намертво привязывал весь процесс к одной папке,
// и второй магазин в этот же процесс было не поселить. Теперь состояние живёт
// в замыкании, и экземпляров может быть сколько угодно — это фундамент под
// мультиарендность, поведение одного магазина при этом не меняется.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createImages } = require('./images');

function createStore(dataDir) {
  const DATA_DIR = dataDir || path.join(__dirname, '..', 'data');
  const IMG_DIR = path.join(DATA_DIR, 'images');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Картинки одинаковы при любом бэкенде — общий модуль, чтобы защита от ../
  // и генерация имён не разъезжались между двумя реализациями.
  const images = createImages(IMG_DIR);

  // Кэш в памяти + очередь записи: запросы на витрину читают из памяти (быстро),
  // а на диск пишем последовательно, чтобы два параллельных сохранения
  // не порвали файл на середине.
  const cache = new Map();
  let writeChain = Promise.resolve();

  const fileFor = key => path.join(DATA_DIR, `${key}.json`);

  function read(key, fallback) {
    if (cache.has(key)) return cache.get(key);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    } catch (e) {
      value = fallback;
    }
    cache.set(key, value);
    return value;
  }

  function write(key, value) {
    cache.set(key, value);
    // атомарно: пишем во временный файл и переименовываем — при выключении питания
    // на середине записи старый файл остаётся целым
    writeChain = writeChain.then(async () => {
      const tmp = fileFor(key) + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fsp.rename(tmp, fileFor(key));
    }).catch(err => console.error('[store] write failed', key, err.message));
    return writeChain;
  }

  // Дождаться, пока всё записанное реально легло на диск. Нужно тестам и
  // корректной остановке процесса: без этого можно выйти на середине записи.
  const flush = () => writeChain;

  return {
    read, write, flush,
    saveImage: images.saveImage,
    imagePath: images.imagePath,
    deleteImage: images.deleteImage,
    DATA_DIR, IMG_DIR,
  };
}

module.exports = { createStore };
