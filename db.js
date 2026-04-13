const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bot.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`

  CREATE TABLE IF NOT EXISTS child_bots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    token_enc         TEXT    NOT NULL UNIQUE,
    token_hash        TEXT    NOT NULL UNIQUE,
    bot_username      TEXT    NOT NULL,
    owner_anon_id     TEXT    NOT NULL UNIQUE,
    owner_chat_id_enc TEXT    NOT NULL,
    owner_master_chat INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash     TEXT    NOT NULL,
    sender_anon_id TEXT    NOT NULL,
    ts             INTEGER NOT NULL
  );


  CREATE TABLE IF NOT EXISTS captcha_sessions (
    anon_id    TEXT    PRIMARY KEY,
    token_hash TEXT    NOT NULL,
    question   TEXT    NOT NULL,
    answer     INTEGER NOT NULL,
    issued_at  INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );


  CREATE TABLE IF NOT EXISTS captcha_passed (
    anon_id    TEXT    NOT NULL,
    token_hash TEXT    NOT NULL,
    passed_at  INTEGER NOT NULL,
    PRIMARY KEY (anon_id, token_hash)
  );

  CREATE TABLE IF NOT EXISTS captcha_blocks (
    anon_id       TEXT    PRIMARY KEY,
    token_hash    TEXT    NOT NULL,
    blocked_until INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_reputation (
    anon_id       TEXT    NOT NULL,
    token_hash    TEXT    NOT NULL,
    score         INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL,
    PRIMARY KEY (anon_id, token_hash)
  );

  CREATE TABLE IF NOT EXISTS rate_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    anon_id    TEXT    NOT NULL,
    token_hash TEXT    NOT NULL,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spam_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT    NOT NULL,
    anon_id    TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    severity   TEXT    NOT NULL,
    spam_score INTEGER,
    ts         INTEGER NOT NULL
  );


  CREATE TABLE IF NOT EXISTS incident_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT    NOT NULL,
    event_type TEXT    NOT NULL,  -- 'rate_limit_spike', 'spam_wave', 'captcha_fail_surge'
    severity   TEXT    NOT NULL,  -- 'low', 'medium', 'high'
    details    TEXT,              -- JSON с деталями
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS master_sessions (
    chat_id INTEGER PRIMARY KEY,
    step    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_token       ON messages(token_hash);
  CREATE INDEX IF NOT EXISTS idx_messages_ts          ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_rate_log_lookup      ON rate_log(anon_id, token_hash, ts);
  CREATE INDEX IF NOT EXISTS idx_captcha_passed       ON captcha_passed(anon_id, token_hash);
  CREATE INDEX IF NOT EXISTS idx_user_reputation      ON user_reputation(anon_id, token_hash);
  CREATE INDEX IF NOT EXISTS idx_spam_log_token       ON spam_log(token_hash, ts);
  CREATE INDEX IF NOT EXISTS idx_spam_log_anon        ON spam_log(anon_id, ts);
  CREATE INDEX IF NOT EXISTS idx_incident_log_token   ON incident_log(token_hash, ts);
  CREATE INDEX IF NOT EXISTS idx_captcha_blocks_until ON captcha_blocks(blocked_until);
`);

// МИГРАЦИИ 

function cleanupOldLogs(keepDaysMessages = 30, keepDaysLogs = 7) {
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  
  const oldSpamTime = now - (keepDaysLogs * msPerDay);
  db.prepare('DELETE FROM spam_log WHERE ts < ?').run(oldSpamTime);
  
  db.prepare('DELETE FROM incident_log WHERE ts < ?').run(oldSpamTime);
  
  const oldRateTime = now - (2 * msPerDay);
  db.prepare('DELETE FROM rate_log WHERE ts < ?').run(oldRateTime);
  
  console.log('[DB] Cleanup completed');
}


function getBotStats(tokenHash) {
  const total = db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE token_hash = ?'
  ).get(tokenHash).c;

  const today = db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE token_hash = ? AND ts > ?'
  ).get(tokenHash, Date.now() - 86400000).c;

  const thisHour = db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE token_hash = ? AND ts > ?'
  ).get(tokenHash, Date.now() - 3600000).c;

  const unique = db.prepare(
    'SELECT COUNT(DISTINCT sender_anon_id) as c FROM messages WHERE token_hash = ?'
  ).get(tokenHash).c;

  const spamBlockedToday = db.prepare(
    'SELECT COUNT(*) as c FROM spam_log WHERE token_hash = ? AND ts > ?'
  ).get(tokenHash, Date.now() - 86400000).c;

  return {
    total,
    today,
    thisHour,
    unique,
    spamBlockedToday
  };
}


function logSpam(tokenHash, anonId, reason, severity = 'low', spamScore = null) {
  db.prepare(`
    INSERT INTO spam_log (token_hash, anon_id, reason, severity, spam_score, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenHash, anonId, reason, severity, spamScore, Date.now());
}


function logIncident(tokenHash, eventType, severity = 'medium', details = null) {
  db.prepare(`
    INSERT INTO incident_log (token_hash, event_type, severity, details, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, eventType, severity, details ? JSON.stringify(details) : null, Date.now());
}

module.exports = {
  db,
  cleanupOldLogs,
  getBotStats,
  logSpam,
  logIncident
};

setInterval(() => cleanupOldLogs(), 24 * 60 * 60 * 1000);