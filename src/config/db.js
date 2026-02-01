const mysql = require('mysql2/promise');
const { runMigrations } = require('../db/migrations');

let pool;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value;
}

async function initDb() {
  if (pool) return pool;

  const host = requireEnv('DB_HOST');
  const user = requireEnv('DB_USER');
  const password = requireEnv('DB_PASSWORD');
  const database = requireEnv('DB_NAME');
  const port = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // Connectivity test
  await pool.query('SELECT 1');

  // Automatically create tables and seed core data (roles, super admin)
  await runMigrations(pool);

  return pool;
}

function getDb() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initDb() first.');
  }
  return pool;
}

module.exports = {
  initDb,
  getDb,
};


