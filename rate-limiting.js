const { db } = require('./db');

// РЕПУТАЦИОННАЯ СИСТЕМА

function initReputation(anonId, tokenHash) {
  const existing = db.prepare(
    'SELECT 1 FROM user_reputation WHERE anon_id=? AND token_hash=?'
  ).get(anonId, tokenHash);
  
  if (!existing) {
    db.prepare(`
      INSERT INTO user_reputation (anon_id, token_hash, score, last_activity)
      VALUES (?, ?, ?, ?)
    `).run(anonId, tokenHash, 0, Date.now());
  }
}

function updateReputation(anonId, tokenHash, positive) {
  const delta = positive ? 5 : -10;
  db.prepare(`
    UPDATE user_reputation
    SET score = MAX(-50, MIN(50, score + ?)),
        last_activity = ?
    WHERE anon_id = ? AND token_hash = ?
  `).run(delta, Date.now(), anonId, tokenHash);
}


function getReputation(anonId, tokenHash) {
  const row = db.prepare(
    'SELECT score FROM user_reputation WHERE anon_id=? AND token_hash=?'
  ).get(anonId, tokenHash);
  return row?.score ?? 0;
}

function getReputationLevel(score) {
  if (score < -20) return { level: 'enemy', label: '🔴 Враг' };
  if (score < 0) return { level: 'newbie', label: '⚪ Новичок' };
  if (score < 20) return { level: 'trusted', label: '🟢 Доверенный' };
  return { level: 'regular', label: '⭐ Постоянный' };
}

function getMessageLimit(reputationScore) {
  const level = getReputationLevel(reputationScore).level;
  
  switch (level) {
    case 'enemy':     return 1;    
    case 'newbie':    return 5;    
    case 'trusted':   return 15;     
    case 'regular':   return 30;   
    default:          return 5;
  }
}

function checkRateLimit(anonId, tokenHash) {
  initReputation(anonId, tokenHash);
  
  const reputation = getReputation(anonId, tokenHash);
  const limit = getMessageLimit(reputation);
  
  const windowMs = 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = now - windowMs;

  const count = db
    .prepare(`
      SELECT COUNT(*) as c FROM rate_log
      WHERE anon_id=? AND token_hash=? AND ts>?
    `)
    .get(anonId, tokenHash, windowStart).c;

  if (count >= limit) {
    const oldest = db
      .prepare(`
        SELECT MIN(ts) as oldest FROM rate_log
        WHERE anon_id=? AND token_hash=? AND ts>?
      `)
      .get(anonId, tokenHash, windowStart).oldest;
    
    const resetIn = Math.ceil((oldest + windowMs - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetIn,
      limit,
      reputation
    };
  }

  db.prepare(`
    INSERT INTO rate_log (anon_id, token_hash, ts)
    VALUES (?, ?, ?)
  `).run(anonId, tokenHash, now);

  db.prepare('DELETE FROM rate_log WHERE ts < ?').run(windowStart);

  return {
    allowed: true,
    remaining: limit - count - 1,
    limit,
    reputation
  };
}


const MAX_ATTEMPTS = () => parseInt(process.env.CAPTCHA_MAX_ATTEMPTS || '5');

function calculateBlockTime(anonId, tokenHash, attemptNumber = 1) {
  let baseMinutes = 1;

  baseMinutes = Math.min(Math.pow(2, attemptNumber - 1), 16);

  const reputation = getReputation(anonId, tokenHash);
  if (reputation > 10) {
    baseMinutes = Math.max(0.5, baseMinutes / 2);
  }

  return baseMinutes * 60 * 1000; 
}

function getBlockAttemptCount(anonId, tokenHash) {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM captcha_blocks
    WHERE anon_id=? AND token_hash=?
  `).get(anonId, tokenHash);
  return row?.c ?? 0;
}

function issueBlock(anonId, tokenHash) {
  const attemptCount = getBlockAttemptCount(anonId, tokenHash) + 1;
  const blockMs = calculateBlockTime(anonId, tokenHash, attemptCount);
  const blockedUntil = Date.now() + blockMs;

  db.prepare(`
    INSERT INTO captcha_blocks (anon_id, token_hash, blocked_until, attempt_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(anon_id) DO UPDATE SET
      blocked_until = excluded.blocked_until,
      attempt_count = excluded.attempt_count
  `).run(anonId, tokenHash, blockedUntil, attemptCount);

  return {
    blockMs,
    attemptCount,
    blockedUntil
  };
}

function isBlocked(anonId) {
  const block = db.prepare(
    'SELECT * FROM captcha_blocks WHERE anon_id = ?'
  ).get(anonId);

  if (!block) return { blocked: false };

  const remaining = block.blocked_until - Date.now();
  if (remaining <= 0) {
    db.prepare('DELETE FROM captcha_blocks WHERE anon_id = ?').run(anonId);
    return { blocked: false };
  }

  return {
    blocked: true,
    blockEndsIn: Math.ceil(remaining / 1000),
    attemptCount: block.attempt_count
  };
}

function unblock(anonId) {
  const block = db.prepare('SELECT * FROM captcha_blocks WHERE anon_id = ?').get(anonId);
  if (block) {
    db.prepare('DELETE FROM captcha_blocks WHERE anon_id = ?').run(anonId);
    return true;
  }
  return false;
}

module.exports = {
  initReputation,
  updateReputation,
  getReputation,
  getReputationLevel,

  getMessageLimit,
  checkRateLimit,

  calculateBlockTime,
  getBlockAttemptCount,
  issueBlock,
  isBlocked,
  unblock,

  MAX_ATTEMPTS
};