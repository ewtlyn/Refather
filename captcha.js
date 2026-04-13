const { db } = require('./db');
const { issueBlock, unblock, getBlockAttemptCount } = require('./rate-limiting');

const MAX_ATTEMPTS = () => parseInt(process.env.CAPTCHA_MAX_ATTEMPTS || '5');

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


function generateCaptcha() {
  const type = rand(0, 2);
  let a, b, answer, symbol;
  
  if (type === 0) {
    a = rand(1, 20); b = rand(1, 20); answer = a + b; symbol = '+';
  } else if (type === 1) {
    a = rand(5, 20); b = rand(1, a); answer = a - b; symbol = '-';
  } else {
    a = rand(2, 9); b = rand(2, 9); answer = a * b; symbol = '×';
  }
  
  return { question: `${a} ${symbol} ${b} = ?`, answer };
}

function issueCaptcha(anonId, tokenHash) {
  const { question, answer } = generateCaptcha();
  
  db.prepare(`
    INSERT INTO captcha_sessions (anon_id, token_hash, question, answer, issued_at, attempts)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(anon_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      question   = excluded.question,
      answer     = excluded.answer,
      issued_at  = excluded.issued_at,
      attempts   = 0
  `).run(anonId, tokenHash, question, answer, Date.now());
  
  return question;
}


function markCaptchaPassed(anonId, tokenHash) {
  db.prepare(`
    INSERT INTO captcha_passed (anon_id, token_hash, passed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(anon_id, token_hash) DO UPDATE SET
      passed_at = excluded.passed_at
  `).run(anonId, tokenHash, Date.now());
  
  db.prepare('DELETE FROM captcha_sessions WHERE anon_id = ?').run(anonId);
}

function hasPassed(anonId, tokenHash) {
  const row = db.prepare(`
    SELECT 1 FROM captcha_passed
    WHERE anon_id = ? AND token_hash = ?
  `).get(anonId, tokenHash);
  
  return !!row;
}

function verifyCaptcha(anonId, userAnswer) {
  const blockStatus = isBlocked(anonId);
  if (blockStatus.blocked) {
    const minutes = Math.ceil(blockStatus.blockEndsIn / 60);
    return {
      ok: false,
      blocked: true,
      blockEndsIn: blockStatus.blockEndsIn,
      message: `🚫 Ты заблокирован. Попробуй через *${minutes}* мин.`
    };
  }

  const session = db.prepare(
    'SELECT * FROM captcha_sessions WHERE anon_id = ?'
  ).get(anonId);

  if (!session) {
    return {
      ok: false,
      noSession: true,
      message: `❌ Нет активной капчи. Отправь /start.`
    };
  }

  const parsed = parseInt(String(userAnswer).trim());
  if (isNaN(parsed) || parsed !== session.answer) {
    const newAttempts = session.attempts + 1;
    const attemptsLeft = MAX_ATTEMPTS() - newAttempts;

    if (attemptsLeft <= 0) {
      const blockInfo = issueBlock(anonId, session.token_hash);
      const minutes = Math.ceil(blockInfo.blockMs / 60000);
      
      db.prepare('DELETE FROM captcha_sessions WHERE anon_id = ?').run(anonId);
      
      return {
        ok: false,
        blocked: true,
        justBlocked: true,
        blockEndsIn: Math.ceil(blockInfo.blockMs / 1000),
        attemptCount: blockInfo.attemptCount,
        message: `🚫 Слишком много неверных ответов!\n\n` +
                 `⏳ Заблокирован на *${minutes}* мин.` +
                 (blockInfo.attemptCount > 1 ? `\n\nЭто блокировка #${blockInfo.attemptCount}.` : '')
      };
    }

    db.prepare(
      'UPDATE captcha_sessions SET attempts = ? WHERE anon_id = ?'
    ).run(newAttempts, anonId);

    return {
      ok: false,
      blocked: false,
      attemptsLeft,
      message: `❌ Неверно! Осталось попыток: *${attemptsLeft}*`
    };
  }

  markCaptchaPassed(anonId, session.token_hash);
  
  return {
    ok: true,
    message: `✅ Капча пройдена! Теперь можешь отправлять сообщения.`
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
    blockEndsIn: Math.ceil(remaining / 1000)
  };
}

function getPendingCaptcha(anonId) {
  return db.prepare(
    'SELECT * FROM captcha_sessions WHERE anon_id = ?'
  ).get(anonId);
}

function requireCaptchaAgain(anonId, tokenHash) {
  const { question } = generateCaptcha();
  const { question: q2, answer: a2 } = generateCaptcha();
  
  db.prepare(`
    INSERT INTO captcha_sessions (anon_id, token_hash, question, answer, issued_at, attempts)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(anon_id) DO UPDATE SET
      question = excluded.question,
      answer = excluded.answer,
      issued_at = excluded.issued_at,
      attempts = 0
  `).run(anonId, tokenHash, q2, a2, Date.now());

  db.prepare(`
    DELETE FROM captcha_passed
    WHERE anon_id = ? AND token_hash = ?
  `).run(anonId, tokenHash);

  return q2;
}

function skipCaptcha(anonId, tokenHash) {
  markCaptchaPassed(anonId, tokenHash);
  db.prepare('DELETE FROM captcha_sessions WHERE anon_id = ?').run(anonId);
}

function resetCaptchaPass(anonId, tokenHash) {
  db.prepare(`
    DELETE FROM captcha_passed
    WHERE anon_id = ? AND token_hash = ?
  `).run(anonId, tokenHash);
}


module.exports = {
  generateCaptcha,
  issueCaptcha,
  markCaptchaPassed,
  hasPassed,
  verifyCaptcha,
  isBlocked,
  getPendingCaptcha,
  requireCaptchaAgain,
  skipCaptcha,
  resetCaptchaPass,
  MAX_ATTEMPTS
};