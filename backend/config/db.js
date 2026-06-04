const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const commonOptions = {
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:            'utf8mb4',
};

const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL;

const pool = databaseUrl ? mysql.createPool({
  uri: databaseUrl,
  ...commonOptions,
}) : mysql.createPool({
  host:             process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
  port:             Number(process.env.DB_PORT || process.env.MYSQLPORT) || 3306,
  user:             process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password:         process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
  database:         process.env.DB_NAME || process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || 'halqa4_roundu',
  ...commonOptions,
});

module.exports = pool;
