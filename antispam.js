const MIN_LENGTH = () => parseInt(process.env.MSG_MIN_LENGTH || '5');
const LINK_RE = /(?:https?:\/\/|t\.me\/|@[a-z0-9_]{5,})/gi;
const REPEAT_CHAR_RE = /(.)\1{4,}/g; 
const SPAM_PATTERNS = [
  /bit\.ly|tinyurl|short\.link|ow\.ly/i,
  /(?:crypto|bitcoin|ethereum|forex|casino|ставки)[\s:]*(?:\+?\d+%|free|earn)/i,
  /(?:трейди?нг|крипто|биток|казино|ставки).*(?:100%|гарантированно|заработай)/i,
    /подпишись|подписывайтесь|follow|subscribe.*now/i,
  /нажми сюда|перейди по ссылке|жми сюда/i,
    /^[a-z0-9]{30,}$/i,  
  /^[а-я0-9]{40,}$/i,   
];

const BLACKLIST_WORDS = [
  // пока не придумала
];

function validateContent(text) {
  const t = text.trim();

  // базовые проверки
  if (t.length < MIN_LENGTH()) {
    return {
      ok: false,
      reason: `❌ Минимум *${MIN_LENGTH()} символов*.`,
      severity: 'low'
    };
  }

  if (t.length > 4000) {
    return {
      ok: false,
      reason: `❌ Максимум *4000 символов*.`,
      severity: 'low'
    };
  }

  // флуд
  const repeats = t.match(REPEAT_CHAR_RE);
  if (repeats && repeats.length > 2) {
    return {
      ok: false,
      reason: `❌ Сообщение выглядит как спам (слишком много повторений).`,
      severity: 'medium'
    };
  }

  // ссылки
  const linkMatches = t.match(LINK_RE);
  if (linkMatches) {
    if (linkMatches.length >= 3) {
      return {
        ok: false,
        reason: `❌ Слишком много ссылок в одном сообщении.`,
        severity: 'high'
      };
    }
    if (linkMatches.length >= 1 && t.length < 30) {
      return {
        ok: false,
        reason: `❌ Ссылка без контекста выглядит как спам.`,
        severity: 'medium'
      };
    }
  }

  // проверка спам паттернов
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(t)) {
      return {
        ok: false,
        reason: `❌ Сообщение выглядит как спам.`,
        severity: 'high'
      };
    }
  }

  for (const word of BLACKLIST_WORDS) {
    if (t.toLowerCase().includes(word.toLowerCase())) {
      return {
        ok: false,
        reason: `❌ Сообщение содержит запрещённое содержимое.`,
        severity: 'high'
      };
    }
  }

  return { ok: true, severity: 'clean' };
}

function calcSpamScore(text) {
  let score = 0;
  const t = text.trim();

  if (t.length < 10) score += 10;
  if (t.length > 3000) score += 20;

  if (REPEAT_CHAR_RE.test(t)) score += 25;

  const links = t.match(LINK_RE);
  if (links) score += Math.min(links.length * 15, 50);

  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(t)) {
      score += 40;
      break;
    }
  }

  const uniqueChars = new Set(t).size;
  if (uniqueChars > t.length * 0.8) score += 15;

  return Math.min(score, 100);
}

function shouldRequireCaptchaForContent(text) {
  const validation = validateContent(text);
  if (!validation.ok) {
    return validation.severity === 'high' || validation.severity === 'medium';
  }
  return false;
}

module.exports = {
  validateContent,
  calcSpamScore,
  shouldRequireCaptchaForContent,
  SPAM_PATTERNS,
  BLACKLIST_WORDS
};