const router = require('express').Router();
const db     = require('./db');

const num = n => Number(n) || 0;

async function candidateTotals() {
  const [rows] = await db.execute(`
    SELECT c.id, c.name, c.father_name, c.party_name, c.symbol, c.photo, c.description, c.active,
           p.color AS party_color, p.party_name AS party_full,
           COALESCE(SUM(r.votes),0) AS vote_count
    FROM candidates c
    LEFT JOIN parties p ON p.id = c.party_id
    LEFT JOIN results r ON r.candidate_id = c.id
    WHERE c.active = 1
    GROUP BY c.id
    ORDER BY vote_count DESC, c.name`);
  return rows;
}

// GET /api/candidates
router.get('/candidates', async (_q, res) => {
  try { res.json(await candidateTotals()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/candidates/:id
router.get('/candidates/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM candidates WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found.' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parties
router.get('/parties', async (_q, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.*, COUNT(c.id) AS candidate_count
      FROM parties p LEFT JOIN candidates c ON c.party_id = p.id
      GROUP BY p.id ORDER BY p.short_name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/polling-stations
router.get('/polling-stations', async (_q, res) => {
  try {
    const [stations] = await db.execute(`
      SELECT ps.*, u.union_name FROM polling_stations ps
      LEFT JOIN unions u ON u.id = ps.union_id ORDER BY ps.id`);
    const [rows] = await db.execute(`
      SELECT r.polling_station_id AS psid, c.id AS cid, c.name, c.party_name,
             p.color AS party_color, r.votes
      FROM results r JOIN candidates c ON c.id = r.candidate_id
      LEFT JOIN parties p ON p.id = c.party_id`);
    const byPs = {};
    rows.forEach(r => { (byPs[r.psid] = byPs[r.psid] || []).push(r); });
    res.json(stations.map(s => {
      const cands = (byPs[s.id] || []).sort((a,b)=>b.votes-a.votes);
      const counted = cands.reduce((t,c)=>t+num(c.votes),0);
      const reg = num(s.registered_voters);
      return { ...s, candidates: cands, votes_counted: counted,
        turnout: reg ? +(counted/reg*100).toFixed(1) : 0, leader: cands[0] || null,
        reported: cands.length > 0 };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/unions
router.get('/unions', async (_q, res) => {
  try {
    const [unions] = await db.execute('SELECT * FROM unions ORDER BY id');
    const [psAgg] = await db.execute(`
      SELECT union_id, COUNT(*) AS ps_count, COALESCE(SUM(registered_voters),0) AS ps_reg
      FROM polling_stations GROUP BY union_id`);
    const [rows] = await db.execute(`
      SELECT ps.union_id AS uid, c.id AS cid, c.name, c.party_name, p.color AS party_color,
             SUM(r.votes) AS votes
      FROM results r JOIN polling_stations ps ON ps.id = r.polling_station_id
      JOIN candidates c ON c.id = r.candidate_id
      LEFT JOIN parties p ON p.id = c.party_id
      GROUP BY ps.union_id, c.id`);
    const psMap = {}; psAgg.forEach(p => psMap[p.union_id] = p);
    const byU = {}; rows.forEach(r => { (byU[r.uid] = byU[r.uid] || []).push(r); });
    res.json(unions.map(u => {
      const cands = (byU[u.id] || []).map(c => ({...c, votes:num(c.votes)})).sort((a,b)=>b.votes-a.votes);
      const counted = cands.reduce((t,c)=>t+c.votes,0);
      const reg = num(u.registered_voters) || num(psMap[u.id]?.ps_reg);
      return { ...u, ps_count: num(psMap[u.id]?.ps_count),
        registered_total: reg, total_votes: counted,
        turnout: reg ? +(counted/reg*100).toFixed(1) : 0,
        candidates: cands, leader: cands[0] || null };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/results  (full aggregate for dashboard)
router.get('/results', async (_q, res) => {
  try {
    const candidates = await candidateTotals();
    const total = candidates.reduce((t,c)=>t+num(c.vote_count),0);

    const [[reg]] = await db.execute('SELECT COALESCE(SUM(registered_voters),0) AS ps_reg FROM polling_stations');
    const [[ureg]] = await db.execute('SELECT COALESCE(SUM(registered_voters),0) AS u_reg FROM unions');
    const registered = num(reg.ps_reg) || num(ureg.u_reg);

    const [[pc]]  = await db.execute('SELECT COUNT(*) AS n FROM parties');
    const [[uc]]  = await db.execute('SELECT COUNT(*) AS n FROM unions');
    const [[psc]] = await db.execute('SELECT COUNT(*) AS n FROM polling_stations');
    const [[rep]] = await db.execute('SELECT COUNT(DISTINCT polling_station_id) AS n FROM results');

    const psCount = num(psc.n), reported = num(rep.n);

    // unions + polling stations breakdowns (reuse endpoints' logic via internal calls)
    const unionsResp = await fetchUnions();
    const psResp = await fetchStations();

    const [trend] = await db.execute(`
      SELECT DATE(created_at) AS day, COALESCE(SUM(votes),0) AS count
      FROM results WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(created_at) ORDER BY day ASC`);

    res.json({
      total, registered,
      turnout: registered ? +(total/registered*100).toFixed(1) : 0,
      counts: {
        candidates: candidates.length, parties: num(pc.n), unions: num(uc.n),
        polling_stations: psCount, ps_reported: reported, ps_pending: Math.max(psCount - reported, 0),
      },
      candidates, unions: unionsResp, polling_stations: psResp, trend,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchUnions() {
  const [unions] = await db.execute('SELECT * FROM unions ORDER BY id');
  const [psAgg] = await db.execute('SELECT union_id, COUNT(*) AS ps_count, COALESCE(SUM(registered_voters),0) AS ps_reg FROM polling_stations GROUP BY union_id');
  const [rows] = await db.execute(`
    SELECT ps.union_id AS uid, c.id AS cid, c.name, c.party_name, p.color AS party_color, SUM(r.votes) AS votes
    FROM results r JOIN polling_stations ps ON ps.id = r.polling_station_id
    JOIN candidates c ON c.id = r.candidate_id LEFT JOIN parties p ON p.id = c.party_id
    GROUP BY ps.union_id, c.id`);
  const psMap = {}; psAgg.forEach(p => psMap[p.union_id] = p);
  const byU = {}; rows.forEach(r => { (byU[r.uid] = byU[r.uid] || []).push(r); });
  return unions.map(u => {
    const cands = (byU[u.id]||[]).map(c=>({...c,votes:num(c.votes)})).sort((a,b)=>b.votes-a.votes);
    const counted = cands.reduce((t,c)=>t+c.votes,0);
    const reg = num(u.registered_voters) || num(psMap[u.id]?.ps_reg);
    return { ...u, ps_count:num(psMap[u.id]?.ps_count), registered_total:reg, total_votes:counted,
      turnout: reg ? +(counted/reg*100).toFixed(1):0, candidates:cands, leader:cands[0]||null };
  });
}
async function fetchStations() {
  const [stations] = await db.execute('SELECT ps.*, u.union_name FROM polling_stations ps LEFT JOIN unions u ON u.id=ps.union_id ORDER BY ps.id');
  const [rows] = await db.execute(`
    SELECT r.polling_station_id AS psid, c.id AS cid, c.name, c.party_name, p.color AS party_color, r.votes
    FROM results r JOIN candidates c ON c.id=r.candidate_id LEFT JOIN parties p ON p.id=c.party_id`);
  const byPs = {}; rows.forEach(r => { (byPs[r.psid]=byPs[r.psid]||[]).push(r); });
  return stations.map(s => {
    const cands = (byPs[s.id]||[]).map(c=>({...c,votes:num(c.votes)})).sort((a,b)=>b.votes-a.votes);
    const counted = cands.reduce((t,c)=>t+c.votes,0);
    const reg = num(s.registered_voters);
    return { ...s, candidates:cands, votes_counted:counted,
      turnout: reg ? +(counted/reg*100).toFixed(1):0, leader:cands[0]||null, reported:cands.length>0 };
  });
}

module.exports = router;
