'use strict';
// Пул соединений MySQL. Единственная драйверная зависимость проекта
// (mysql2): файловое хранилище БД не требует, а протокол MySQL с нуля
// писать нельзя. Драйвер подгружается лениво — пока магазин живёт на файлах,
// require mysql2 вообще не выполняется.

function createDb({ host, port, user, password, database } = {}) {
  // Лениво: в файловом режиме модуль не нужен даже установленный
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host: host || '127.0.0.1',
    port: Number(port) || 3306,
    user: user || 'root',
    password: password || '',
    database: database || undefined,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    // Долгие миграции и массовый импорт заказов не должны рваться на таймауте
    connectTimeout: 10000,
    timezone: '+00:00',
  });

  const query = (sql, params) => pool.query(sql, params);

  // Транзакция на отдельном соединении: в пуле каждая query может уйти
  // на разные коннекты, и BEGIN/COMMIT разъехались бы.
  async function tx(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  const end = () => pool.end();

  return { pool, query, tx, end };
}

// Конфиг из окружения: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE.
// Пустой хост — БД не настроена, вызывающий решает, что делать (падать
// или работать по-файловому).
function dbConfigFromEnv() {
  return {
    host: (process.env.MYSQL_HOST || '').trim(),
    port: process.env.MYSQL_PORT,
    user: (process.env.MYSQL_USER || '').trim(),
    password: process.env.MYSQL_PASSWORD || '',
    database: (process.env.MYSQL_DATABASE || '').trim(),
  };
}

module.exports = { createDb, dbConfigFromEnv };
