const router  = require('express').Router();
const db      = require('./db');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const auth    = require('./auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_q,_f,cb)=>cb(null,uploadsDir),
  filename: (_q,file,cb)=>cb(null,'upload_'+Date.now()+path.extname(file.originalname).toLowerCase()),
});
const upload = multer({ storage, limits:{fileSize:5*1024*1024},
  fileFilter:(_q,file,cb)=>cb(null,['.jpg','.jpeg','.png','.gif','.webp','.svg'].includes(path.extname(file.originalname).toLowerCase())) });
const SECRET = () => process.env.JWT_SECRET || 'halqa4_secret';
const log = (action, details) => db.execute('INSERT INTO activity_logs (action, details) VALUES (?,?)', [action, details]).catch(()=>{});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  try {
    const [rows] = await db.execute('SELECT * FROM admin_users WHERE username = ?', [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });
    if (!(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, SECRET(), { expiresIn: '24h' });
    log('ADMIN_LOGIN', 'Admin logged in: ' + username);
    res.json({ token, username: rows[0].username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(auth);

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ url: '/uploads/' + req.file.filename });
});

router.get('/stats', async (_q, res) => {
  try {
    const [[v]]  = await db.execute('SELECT COALESCE(SUM(votes),0) AS n FROM results');
    const [[regp]] = await db.execute('SELECT COALESCE(SUM(registered_voters),0) AS n FROM polling_stations');
    const [[regu]] = await db.execute('SELECT COALESCE(SUM(registered_voters),0) AS n FROM unions');
    const [[cc]] = await db.execute('SELECT COUNT(*) AS n FROM candidates');
    const [[pc]] = await db.execute('SELECT COUNT(*) AS n FROM parties');
    const [[uc]] = await db.execute('SELECT COUNT(*) AS n FROM unions');
    const [[psc]]= await db.execute('SELECT COUNT(*) AS n FROM polling_stations');
    const [[rep]]= await db.execute('SELECT COUNT(DISTINCT polling_station_id) AS n FROM results');
    const [cands] = await db.execute(`SELECT c.id,c.name,c.party_name,COALESCE(SUM(r.votes),0) AS vote_count
      FROM candidates c LEFT JOIN results r ON r.candidate_id=c.id GROUP BY c.id ORDER BY vote_count DESC`);
    const [logs] = await db.execute('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 20');
    const registered = Number(regp.n) || Number(regu.n);
    const counted = Number(v.n);
    res.json({ total_votes: counted, registered_voters: registered,
      turnout: registered ? +(counted/registered*100).toFixed(1) : 0,
      total_candidates: Number(cc.n), total_parties: Number(pc.n), total_unions: Number(uc.n),
      total_polling_stations: Number(psc.n), ps_reported: Number(rep.n),
      ps_pending: Math.max(Number(psc.n)-Number(rep.n),0), candidates: cands, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CANDIDATES ──
router.get('/candidates', async (_q, res) => {
  try { const [rows] = await db.execute(`SELECT c.*, COALESCE(SUM(r.votes),0) AS vote_count
    FROM candidates c LEFT JOIN results r ON r.candidate_id=c.id GROUP BY c.id ORDER BY c.id`); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/candidates', async (req, res) => {
  const { name, father_name, party_name, party_id, symbol, photo, description, contact, active } = req.body;
  if (!name || !party_name) return res.status(400).json({ error: 'Name and party are required.' });
  try {
    const [r] = await db.execute(`INSERT INTO candidates (name,father_name,party_name,party_id,symbol,photo,description,contact,active)
      VALUES (?,?,?,?,?,?,?,?,?)`, [name, father_name||null, party_name, party_id||null, symbol||null, photo||null, description||null, contact||null, active!==false?1:0]);
    log('CANDIDATE_ADDED', `${name} (${party_name})`);
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/candidates/:id', async (req, res) => {
  const { name, father_name, party_name, party_id, symbol, photo, description, contact, active } = req.body;
  try {
    await db.execute(`UPDATE candidates SET name=?,father_name=?,party_name=?,party_id=?,symbol=?,photo=?,description=?,contact=?,active=? WHERE id=?`,
      [name, father_name||null, party_name, party_id||null, symbol||null, photo||null, description||null, contact||null, active?1:0, req.params.id]);
    log('CANDIDATE_UPDATED', `ID ${req.params.id}: ${name}`);
    res.json({ message: 'Candidate updated.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/candidates/:id', async (req, res) => {
  try {
    const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM results WHERE candidate_id=?', [req.params.id]);
    if (cnt > 0) { await db.execute('UPDATE candidates SET active=0 WHERE id=?', [req.params.id]); return res.json({ message: 'Candidate has results — deactivated instead.' }); }
    await db.execute('DELETE FROM candidates WHERE id=?', [req.params.id]);
    res.json({ message: 'Candidate deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PARTIES ──
router.get('/parties', async (_q, res) => {
  try { const [rows] = await db.execute(`SELECT p.*, COUNT(c.id) AS candidate_count FROM parties p LEFT JOIN candidates c ON c.party_id=p.id GROUP BY p.id ORDER BY p.short_name`); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/parties', async (req, res) => {
  const { party_name, short_name, color, logo } = req.body;
  if (!party_name || !short_name) return res.status(400).json({ error: 'Party name and short name required.' });
  try { const [r] = await db.execute('INSERT INTO parties (party_name,short_name,color,logo) VALUES (?,?,?,?)', [party_name, short_name, color||'#64748b', logo||null]);
    log('PARTY_ADDED', `${party_name} (${short_name})`); res.status(201).json({ id: r.insertId }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/parties/:id', async (req, res) => {
  const { party_name, short_name, color, logo } = req.body;
  try { await db.execute('UPDATE parties SET party_name=?,short_name=?,color=?,logo=? WHERE id=?', [party_name, short_name, color||'#64748b', logo||null, req.params.id]);
    res.json({ message: 'Party updated.' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/parties/:id', async (req, res) => {
  try { const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM candidates WHERE party_id=?', [req.params.id]);
    if (cnt > 0) return res.status(400).json({ error: `Cannot delete — ${cnt} candidate(s) use this party.` });
    await db.execute('DELETE FROM parties WHERE id=?', [req.params.id]); res.json({ message: 'Party deleted.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UNIONS ──
router.get('/unions', async (_q, res) => {
  try { const [rows] = await db.execute(`SELECT u.*, (SELECT COUNT(*) FROM polling_stations ps WHERE ps.union_id=u.id) AS ps_count FROM unions u ORDER BY u.id`); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/unions', async (req, res) => {
  const { union_name, union_code, registered_voters } = req.body;
  if (!union_name) return res.status(400).json({ error: 'Union name required.' });
  try { const [r] = await db.execute('INSERT INTO unions (union_name,union_code,registered_voters) VALUES (?,?,?)', [union_name, union_code||null, registered_voters||0]);
    log('UNION_ADDED', union_name); res.status(201).json({ id: r.insertId }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/unions/:id', async (req, res) => {
  const { union_name, union_code, registered_voters } = req.body;
  try { await db.execute('UPDATE unions SET union_name=?,union_code=?,registered_voters=? WHERE id=?', [union_name, union_code||null, registered_voters||0, req.params.id]);
    res.json({ message: 'Union updated.' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/unions/:id', async (req, res) => {
  try { const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM polling_stations WHERE union_id=?', [req.params.id]);
    if (cnt > 0) return res.status(400).json({ error: `Cannot delete — ${cnt} polling station(s) in this union.` });
    await db.execute('DELETE FROM unions WHERE id=?', [req.params.id]); res.json({ message: 'Union deleted.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POLLING STATIONS ──
router.get('/polling-stations', async (_q, res) => {
  try { const [rows] = await db.execute(`SELECT ps.*, u.union_name,
      (SELECT COALESCE(SUM(votes),0) FROM results r WHERE r.polling_station_id=ps.id) AS votes_counted,
      (SELECT COUNT(*) FROM results r WHERE r.polling_station_id=ps.id) AS result_rows
      FROM polling_stations ps LEFT JOIN unions u ON u.id=ps.union_id ORDER BY ps.id`); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/polling-stations', async (req, res) => {
  const { union_id, station_name, station_code, location, registered_voters } = req.body;
  if (!station_name) return res.status(400).json({ error: 'Station name required.' });
  try { const [r] = await db.execute('INSERT INTO polling_stations (union_id,station_name,station_code,location,registered_voters) VALUES (?,?,?,?,?)',
    [union_id||null, station_name, station_code||null, location||null, registered_voters||0]);
    log('PS_ADDED', station_name); res.status(201).json({ id: r.insertId }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/polling-stations/:id', async (req, res) => {
  const { union_id, station_name, station_code, location, registered_voters } = req.body;
  try { await db.execute('UPDATE polling_stations SET union_id=?,station_name=?,station_code=?,location=?,registered_voters=? WHERE id=?',
    [union_id||null, station_name, station_code||null, location||null, registered_voters||0, req.params.id]);
    res.json({ message: 'Polling station updated.' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/polling-stations/:id', async (req, res) => {
  try { await db.execute('DELETE FROM results WHERE polling_station_id=?', [req.params.id]);
    await db.execute('DELETE FROM polling_stations WHERE id=?', [req.params.id]); res.json({ message: 'Polling station deleted.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RESULTS (Form-45 entry) ──
router.get('/results', async (req, res) => {
  try {
    const where = req.query.station_id ? 'WHERE r.polling_station_id = ?' : '';
    const args = req.query.station_id ? [req.query.station_id] : [];
    const [rows] = await db.execute(`SELECT r.*, c.name AS candidate_name, c.party_name, ps.station_name
      FROM results r JOIN candidates c ON c.id=r.candidate_id JOIN polling_stations ps ON ps.id=r.polling_station_id
      ${where} ORDER BY r.polling_station_id, c.name`, args);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// upsert a batch of results for one polling station
router.post('/results', async (req, res) => {
  const { polling_station_id, form45_ref, entries } = req.body;
  if (!polling_station_id || !Array.isArray(entries)) return res.status(400).json({ error: 'polling_station_id and entries[] required.' });
  try {
    for (const e of entries) {
      if (e.candidate_id == null) continue;
      await db.execute(`INSERT INTO results (polling_station_id,candidate_id,votes,form45_ref,entered_by)
        VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE votes=VALUES(votes), form45_ref=VALUES(form45_ref), entered_by=VALUES(entered_by)`,
        [polling_station_id, e.candidate_id, Number(e.votes)||0, form45_ref||null, req.admin?.username||'admin']);
    }
    log('RESULTS_ENTERED', `Station ${polling_station_id} (${entries.length} candidates), Form-45: ${form45_ref||'-'}`);
    res.json({ message: 'Results saved.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/results/station/:id', async (req, res) => {
  try { await db.execute('DELETE FROM results WHERE polling_station_id=?', [req.params.id]); res.json({ message: 'Station results cleared.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export/csv', async (_q, res) => {
  try {
    const [rows] = await db.execute(`SELECT ps.station_name, ps.station_code, u.union_name, c.name AS candidate, c.party_name AS party,
      r.votes, r.form45_ref, r.entered_by, r.created_at
      FROM results r JOIN polling_stations ps ON ps.id=r.polling_station_id
      LEFT JOIN unions u ON u.id=ps.union_id JOIN candidates c ON c.id=r.candidate_id
      ORDER BY u.union_name, ps.station_name, r.votes DESC`);
    let csv = 'Union,Polling Station,Code,Candidate,Party,Votes,Form-45,Entered By,Time\n';
    rows.forEach(r => { csv += `"${r.union_name||''}","${r.station_name}","${r.station_code||''}","${r.candidate}","${r.party}",${r.votes},"${r.form45_ref||''}","${r.entered_by||''}","${r.created_at}"\n`; });
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="election_results_skd4.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required.' });
  try {
    const [rows] = await db.execute('SELECT * FROM admin_users WHERE id=?', [req.admin.id]);
    if (!(await bcrypt.compare(current_password, rows[0].password_hash))) return res.status(401).json({ error: 'Current password is incorrect.' });
    await db.execute('UPDATE admin_users SET password_hash=? WHERE id=?', [await bcrypt.hash(new_password,10), req.admin.id]);
    res.json({ message: 'Password updated.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
