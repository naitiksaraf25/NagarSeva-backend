/**
 * NagarSeva — Smart City Complaint Portal
 * ✅ FINAL FIXED Backend
 *
 * Bug Fixes Applied:
 * 1. Category always saved as lowercase (server-side normalization)
 * 2. Old data migration — existing uppercase categories converted to lowercase on startup
 * 3. Login: strict 404 vs 401 error codes for frontend to handle properly
 * 4. Stats: CASE WHEN used instead of SUM(status = '...') for SQLite compatibility
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const Database   = require('better-sqlite3');
const rateLimit  = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const path       = require('path');

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nagarseva_super_secret_key_change_in_prod';
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'nagarseva.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── DB Init ──────────────────────────────────────────────────────────────────
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      email         TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'citizen',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      category     TEXT NOT NULL,
      description  TEXT NOT NULL,
      location     TEXT NOT NULL,
      priority     TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'pending',
      citizen_name TEXT NOT NULL,
      user_id      INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER REFERENCES users(id),
      action       TEXT NOT NULL,
      complaint_id INTEGER REFERENCES complaints(id),
      details      TEXT,
      timestamp    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_complaints_user     ON complaints(user_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_status   ON complaints(status);
    CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category);
    CREATE INDEX IF NOT EXISTS idx_complaints_created  ON complaints(created_at DESC);
  `);

  // ✅ BUG FIX: Migrate old data — any category that isn't already lowercase gets fixed
  // This handles complaints submitted before the lowercase fix was applied
  const migrated = db.prepare(`
    UPDATE complaints SET category = LOWER(category)
    WHERE category != LOWER(category)
  `).run();
  if (migrated.changes > 0) {
    console.log(`[MIGRATE] Fixed ${migrated.changes} complaint(s) with uppercase categories → lowercase`);
  }

  // Seed only if DB is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) seedData();
}

function seedData() {
  console.log('[SEED] Seeding default users and sample complaints...');

  const adminHash   = bcrypt.hashSync('admin123',   10);
  const citizenHash = bcrypt.hashSync('citizen123', 10);

  const insertUser = db.prepare(`INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`);
  insertUser.run('Admin NagarSeva', 'admin@nagarseva.in', adminHash,   'admin');
  insertUser.run('Ramesh Kumar',    'ramesh@gmail.com',   citizenHash, 'citizen');

  const citizenId = db.prepare("SELECT id FROM users WHERE email = 'ramesh@gmail.com'").get().id;

  const ins = db.prepare(`
    INSERT INTO complaints (title, category, description, location, priority, status, citizen_name, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ✅ All seed categories are lowercase — matches frontend CAT_ICONS keys
  const seeds = [
    ['Broken Street Light on MG Road',         'electricity',    'Three consecutive street lights near MG Road bus stop have been non-functional for 2 weeks causing safety issues at night.',  'MG Road, Near Bus Stop No. 14, Pune',     'high',     'pending',    'Ramesh Kumar',   citizenId],
    ['Overflowing Garbage Bin near Market',    'sanitation',     'The garbage bin near Laxmi Market has been overflowing for 3 days. Foul smell spreading to nearby shops and homes.',          'Laxmi Market, Sector 7, Nagpur',          'high',     'inProgress', 'Priya Sharma',   citizenId],
    ['Pothole on NH-48 Causing Accidents',     'roads',          'Large pothole on NH-48 near Zomato office junction. Two bike accidents reported this week. Immediate repair needed.',          'NH-48, Near Zomato Office, Bengaluru',    'critical', 'pending',    'Suresh Nair',    citizenId],
    ['Water Supply Disruption for 5 Days',     'water',          'Entire colony has not received municipal water for 5 days. Residents buying expensive tankers.',                               'Shanti Nagar Colony, Block C, Jaipur',    'critical', 'inProgress', 'Meena Devi',     citizenId],
    ['Unauthorized Construction Blocking Road','infrastructure', 'Builder placed construction material on public road without permission, blocking traffic flow completely.',                    'Gandhi Nagar Road, Near Park, Ahmedabad', 'medium',   'resolved',   'Ajay Patel',     citizenId],
    ['Sewage Overflow in Residential Area',    'sanitation',     'Sewage overflowing from drain on Main Street and entering homes. Health hazard for children and elderly.',                     'Model Town, Sector 12, Ludhiana',         'critical', 'pending',    'Harpreet Singh', citizenId],
    ['Damaged Park Benches and Broken Swings', 'parks',          'Most benches in community park are broken and swings damaged. Children getting hurt while playing.',                           'Central Park, Anna Nagar, Chennai',       'low',      'pending',    'Kavitha Rao',    citizenId],
    ['Stray Dogs Menace Near School',          'animal control', 'Pack of aggressive stray dogs near St. Mary School gates. Three biting incidents reported this week.',                         'St. Mary School Road, Bhopal',            'high',     'inProgress', 'Father Thomas',  citizenId],
  ];

  for (const s of seeds) ins.run(...s);
  console.log(`[SEED] ✅ Inserted ${seeds.length} sample complaints.`);
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Railway proxy

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Middleware helpers ───────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(422).json({ errors: errors.array() }); return false; }
  return true;
}

function logActivity(userId, action, complaintId, details) {
  try {
    db.prepare(`INSERT INTO activity_logs (user_id, action, complaint_id, details) VALUES (?, ?, ?, ?)`)
      .run(userId, action, complaintId ?? null, details ?? null);
  } catch (e) { console.error('[LOG_ERR]', e.message); }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'NagarSeva API' });
});

// ── REGISTER ──────────────────────────────────────────────────────────────────
app.post('/api/auth/register',
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  (req, res) => {
    if (!validate(req, res)) return;
    const { name, email, password } = req.body;

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing)
      return res.status(409).json({ error: 'Email already registered. Please sign in.', code: 'EMAIL_EXISTS' });

    const password_hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'citizen')`
    ).run(name, email, password_hash);

    const user = { id: result.lastInsertRowid, name, email, role: 'citizen' };
    logActivity(user.id, 'USER_REGISTER', null, `New citizen: ${email}`);
    console.log(`[AUTH] Registered: ${email}`);
    res.status(201).json({ token: generateToken(user), user });
  }
);

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// ✅ BUG FIX: Strict 404 vs 401 error codes
// Frontend uses these to show different messages and switch tabs correctly
app.post('/api/auth/login',
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
  (req, res) => {
    if (!validate(req, res)) return;
    const { email, password } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    // 404 = account doesn't exist at all
    if (!user) {
      return res.status(404).json({
        error: 'No account found with this email. Please register first.',
        code: 'USER_NOT_FOUND'
      });
    }

    // 401 = account exists but password wrong
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({
        error: 'Incorrect password. Please try again.',
        code: 'WRONG_PASSWORD'
      });
    }

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    logActivity(user.id, 'USER_LOGIN', null, `Login from ${req.ip}`);
    console.log(`[AUTH] Login: ${email} (${user.role})`);
    res.json({ token: generateToken(safeUser), user: safeUser });
  }
);

// ── GET ALL COMPLAINTS (admin) ────────────────────────────────────────────────
app.get('/api/complaints',
  authenticate,
  query('category').optional().trim(),
  query('status').optional().trim(),
  (req, res) => {
    if (!validate(req, res)) return;
    const { category, status } = req.query;
    let sql = 'SELECT * FROM complaints WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND LOWER(category) = LOWER(?)'; params.push(category); }
    if (status)   { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const complaints = db.prepare(sql).all(...params);
    res.json({ count: complaints.length, complaints });
  }
);

// ── GET MY COMPLAINTS (citizen) ───────────────────────────────────────────────
app.get('/api/my-complaints',
  authenticate,
  (req, res) => {
    const complaints = db.prepare(
      'SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json({ count: complaints.length, complaints });
  }
);

// ── POST COMPLAINT ────────────────────────────────────────────────────────────
app.post('/api/complaints',
  authenticate,
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('description').trim().isLength({ min: 10 }).withMessage('Description must be at least 10 characters'),
  body('location').trim().notEmpty().withMessage('Location is required'),
  body('priority').optional().isIn(['low','medium','high','critical']).withMessage('Invalid priority'),
  (req, res) => {
    if (!validate(req, res)) return;

    const { title, description, location, priority = 'medium' } = req.body;

    // ✅ BUG FIX: Always normalize category to lowercase server-side
    // Even if frontend sends "Roads" instead of "roads", we store "roads"
    const category = req.body.category.toLowerCase().trim();

    const result = db.prepare(`
      INSERT INTO complaints (title, category, description, location, priority, citizen_name, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, category, description, location, priority, req.user.name, req.user.id);

    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(result.lastInsertRowid);
    logActivity(req.user.id, 'COMPLAINT_CREATED', complaint.id, `"${title}" [${category}]`);
    console.log(`[COMPLAINT] #${complaint.id}: "${title}" by ${req.user.name}`);
    res.status(201).json(complaint);
  }
);

// ── UPDATE STATUS (admin only) ────────────────────────────────────────────────
app.patch('/api/complaints/:id/status',
  authenticate,
  requireAdmin,
  body('status').isIn(['pending','inProgress','resolved','rejected']).withMessage('Invalid status'),
  (req, res) => {
    if (!validate(req, res)) return;
    const id = parseInt(req.params.id);
    const { status, note } = req.body;

    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    db.prepare(`UPDATE complaints SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);

    const details = `${complaint.status} → ${status}${note ? ' | ' + note : ''}`;
    logActivity(req.user.id, 'STATUS_UPDATED', id, details);
    console.log(`[ADMIN] #${id}: ${complaint.status} → ${status} by ${req.user.email}`);

    res.json({ message: 'Status updated', complaint: db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) });
  }
);

// ── ADMIN STATS ───────────────────────────────────────────────────────────────
app.get('/api/admin/stats',
  authenticate,
  requireAdmin,
  (_req, res) => {
    // ✅ Using CASE WHEN instead of SUM(status = '...') — more compatible with SQLite
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'inProgress' THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN status = 'resolved'   THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'rejected'   THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN priority = 'critical' AND status != 'resolved' THEN 1 ELSE 0 END) AS criticalOpen
      FROM complaints
    `).get();

    const byCategory = db.prepare(
      `SELECT category, COUNT(*) as count FROM complaints GROUP BY category ORDER BY count DESC`
    ).all();

    const recentActivity = db.prepare(`
      SELECT al.*, u.name as user_name
      FROM activity_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.timestamp DESC LIMIT 10
    `).all();

    res.json({
      total:        row.total        || 0,
      pending:      row.pending      || 0,
      inProgress:   row.inProgress   || 0,
      resolved:     row.resolved     || 0,
      rejected:     row.rejected     || 0,
      criticalOpen: row.criticalOpen || 0,
      byCategory,
      recentActivity,
    });
  }
);

// ─── 404 & Global Error Handler ───────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` }));
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB();
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   🏙️  NagarSeva API  —  Port ${PORT}          ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log('[INFO] Admin   → admin@nagarseva.in  / admin123');
  console.log('[INFO] Citizen → ramesh@gmail.com    / citizen123\n');
});