const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const dotenv  = require('dotenv');

dotenv.config();
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const app  = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3001;

const stripTrailingSlash = value => String(value || '').replace(/\/+$/, '');
const configuredFrontendUrls = (process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(url => stripTrailingSlash(url.trim()))
  .filter(Boolean);

const apiBaseUrl = () => {
  const explicitApi = stripTrailingSlash(process.env.API_BASE_URL || process.env.PUBLIC_API_BASE_URL);
  if (explicitApi) return explicitApi;

  const backendUrl = stripTrailingSlash(process.env.BACKEND_URL || process.env.BACKEND_ORIGIN);
  return backendUrl ? `${backendUrl}/api` : '';
};

const FRONTEND_DIR = [
  path.join(__dirname, '..', 'frontend'),
  __dirname,
  path.join(__dirname, '..'),
].find(d => fs.existsSync(path.join(d, 'index.html'))) || path.join(__dirname, '..', 'frontend');

app.use(cors({
  origin: configuredFrontendUrls.length ? configuredFrontendUrls : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = { API_BASE: ${JSON.stringify(apiBaseUrl())} };`);
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(FRONTEND_DIR));

app.use('/api',        require('./routes/public'));
app.use('/api/admin',  require('./routes/admin'));

app.get('/api/health', (_q, res) => res.json({ status: 'ok', service: 'GB Election 2026 Results — SKD-4 Roundu' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});
app.use((err, _q, res, _n) => { console.error('Error:', err); res.status(500).json({ error: 'Internal server error.' }); });

// ── Schema + migration ─────────────────────────────────────────────────────────
async function initDb(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS parties (
      id INT PRIMARY KEY AUTO_INCREMENT, party_name VARCHAR(150) NOT NULL,
      short_name VARCHAR(40) NOT NULL UNIQUE, color VARCHAR(20) DEFAULT '#64748b',
      logo VARCHAR(500), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS candidates (
      id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL,
      father_name VARCHAR(255), party_name VARCHAR(100) NOT NULL, party_id INT,
      symbol VARCHAR(100), photo VARCHAR(500), description TEXT, contact VARCHAR(100),
      active TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS unions (
      id INT PRIMARY KEY AUTO_INCREMENT, union_name VARCHAR(255) NOT NULL,
      union_code VARCHAR(40), registered_voters INT DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS polling_stations (
      id INT PRIMARY KEY AUTO_INCREMENT, union_id INT, station_name VARCHAR(255) NOT NULL,
      station_code VARCHAR(40), location VARCHAR(255), registered_voters INT DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS results (
      id INT PRIMARY KEY AUTO_INCREMENT, polling_station_id INT NOT NULL, candidate_id INT NOT NULL,
      votes INT NOT NULL DEFAULT 0, form45_ref VARCHAR(120), entered_by VARCHAR(80),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ps_cand (polling_station_id, candidate_id))`,
    `CREATE TABLE IF NOT EXISTS admin_users (
      id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id INT PRIMARY KEY AUTO_INCREMENT, action VARCHAR(100) NOT NULL, details TEXT,
      ip_address VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ];
  for (const sql of tables) await db.execute(sql);

  // safe migrations on older tables
  const alters = [
    "ALTER TABLE candidates ADD COLUMN father_name VARCHAR(255)",
    "ALTER TABLE candidates ADD COLUMN party_id INT",
    "ALTER TABLE candidates ADD COLUMN contact VARCHAR(100)",
    "ALTER TABLE unions ADD COLUMN union_code VARCHAR(40)",
    "ALTER TABLE unions ADD COLUMN registered_voters INT DEFAULT 0",
  ];
  for (const a of alters) { try { await db.execute(a); } catch (e) {} }

  // wipe old public-voting data (kept candidates)
  for (const w of ['DELETE FROM votes', 'DELETE FROM voters', 'DELETE FROM otps']) {
    try { await db.execute(w); } catch (e) {}
  }

  // seed parties
  const [[{ pc }]] = await db.execute('SELECT COUNT(*) AS pc FROM parties');
  if (pc === 0) {
    await db.execute(`INSERT INTO parties (party_name, short_name, color) VALUES
      ('Pakistan Peoples Party','PPP','#3b82f6'),
      ('Pakistan Muslim League-N','PML-N','#ef4444'),
      ('Pakistan Istehkam Party','IPP','#f97316'),
      ('Pakistan Tehreek-e-Insaf','PTI','#22c55e'),
      ('Majlis Wahdat-e-Muslimeen','MWM','#991b1b'),
      ('Pakistan Nazriyati Party','PNP','#7c3aed'),
      ('Islamic Tehreek Pakistan','ITP','#0d9488'),
      ('Awami Workers Party','AWP','#dc2626'),
      ('Independent','Independent','#94a3b8')`);
  }
  // link candidates to parties by short_name
  try { await db.execute('UPDATE candidates c JOIN parties p ON p.short_name = c.party_name SET c.party_id = p.id WHERE c.party_id IS NULL'); } catch (e) {}
  // correction kept from before
  try { await db.execute("UPDATE candidates SET party_name='ITP' WHERE name='Wazir Ejaz' AND party_name='Independent'"); } catch (e) {}

  // default party flags (only if not already set)
  const flagMap={'PPP':'/logos/ppp.svg','PML-N':'/logos/pmln.svg','IPP':'/logos/ipp.svg','MWM':'/logos/mwm.svg','PTI':'/logos/pti.svg','ITP':'/logos/itp.svg','PNP':'/logos/pnp.svg','AWP':'/logos/awp.svg','Independent':'/logos/ind1.svg'};
  for (const sn of Object.keys(flagMap)) { try { await db.execute("UPDATE parties SET logo=? WHERE short_name=? AND (logo IS NULL OR logo='')", [flagMap[sn], sn]); } catch (e) {} }
  // candidate name corrections to final list
  try { await db.execute("UPDATE candidates SET name='Allama Mushtaq Hakimi' WHERE name='Mushtaq Hakimi'"); } catch (e) {}
  try { await db.execute("UPDATE candidates SET name='Dr. Muhammad Sharif' WHERE name='Muhammad Sharif (Dr. Sharif)'"); } catch (e) {}

  // seed unions if empty
  const [[{ uc }]] = await db.execute('SELECT COUNT(*) AS uc FROM unions');
  if (uc === 0) {
    await db.execute(`INSERT INTO unions (union_name, union_code, registered_voters) VALUES
      ('Union Council Roundu','UC-01',0),('Union Council Ghasing','UC-02',0),
      ('Union Council Kalam','UC-03',0),('Union Council Bahrain','UC-04',0),
      ('Union Council Madyan','UC-05',0)`);
  }
}

async function start() {
  const db = require('./config/db');
  console.log('Frontend dir:', FRONTEND_DIR);
  console.log('Connecting to MySQL...');
  try { await db.execute('SELECT 1'); console.log('MySQL connected.'); }
  catch (err) { console.error('MySQL connection failed:', err.code || '', err.message); process.exit(1); }

  try { await initDb(db); console.log('Schema ready & migrated.'); }
  catch (err) { console.error('DB init warning:', err.message); }

  const [admins] = await db.execute('SELECT id FROM admin_users LIMIT 1');
  if (!admins.length) {
    const u = process.env.ADMIN_USERNAME || 'admin';
    const p = process.env.ADMIN_PASSWORD || 'admin123';
    await db.execute('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [u, await bcrypt.hash(p, 10)]);
    console.log('Admin user created:', u);
  }
  app.listen(PORT, () => console.log('GB Election 2026 Results (SKD-4 Roundu) on port ' + PORT));
}
start();
