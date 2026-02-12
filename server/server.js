const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Config ---
const PORT = process.env.PS_PORT || 7450;
const AUTH_TOKEN = process.env.PS_AUTH_TOKEN; // Required — set before starting
const DATA_DIR = process.env.PS_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'notes.db');

if (!AUTH_TOKEN) {
  console.error('ERROR: PS_AUTH_TOKEN environment variable is required.');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// --- Init ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    site TEXT,            -- 'unity' or 'voa'
    note_type TEXT,       -- 'initial_eval', 'follow_up', 'soap', etc.
    label TEXT,           -- patient initials or tab label (no full names)
    input_text TEXT,      -- transcription / pasted input
    output_text TEXT,     -- generated note
    model TEXT,           -- which model generated it
    version INTEGER DEFAULT 1,
    tokens_in INTEGER,
    tokens_out INTEGER,
    metadata TEXT         -- JSON blob for anything else
  );

  CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
  CREATE INDEX IF NOT EXISTS idx_notes_site ON notes(site);
`);

const app = express();
app.use(express.json({ limit: '5mb' }));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', requireAuth);

// --- Routes ---

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', notes: db.prepare('SELECT COUNT(*) as count FROM notes').get().count });
});

// Submit a note
app.post('/api/notes', (req, res) => {
  const { site, note_type, label, input_text, output_text, model, version, tokens_in, tokens_out, metadata } = req.body;

  if (!output_text) {
    return res.status(400).json({ error: 'output_text is required' });
  }

  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO notes (id, site, note_type, label, input_text, output_text, model, version, tokens_in, tokens_out, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, site || null, note_type || null, label || null, input_text || null, output_text,
    model || null, version || 1, tokens_in || null, tokens_out || null,
    metadata ? JSON.stringify(metadata) : null);

  res.status(201).json({ id, created_at: new Date().toISOString() });
});

// List notes (recent, with optional filters)
app.get('/api/notes', (req, res) => {
  const { site, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT id, created_at, site, note_type, label, model, version, tokens_in, tokens_out FROM notes';
  const params = [];

  if (site) {
    sql += ' WHERE site = ?';
    params.push(site);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  res.json(db.prepare(sql).all(...params));
});

// Get a single note (full content)
app.get('/api/notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  if (note.metadata) note.metadata = JSON.parse(note.metadata);
  res.json(note);
});

// Delete a note
app.delete('/api/notes/:id', (req, res) => {
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Psych Scribe server listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
