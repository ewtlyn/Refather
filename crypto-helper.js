const crypto = require('crypto');

const SECRET = () => process.env.ANON_SECRET;

function anonymizeId(telegramId) {
  return crypto
    .createHmac('sha256', SECRET())
    .update(String(telegramId))
    .digest('hex')
    .slice(0, 16);
}

function xorEncrypt(text, key = SECRET()) {
  const keyBytes = Buffer.from(
    crypto.createHash('sha256').update(key).digest('hex'),
    'hex'
  );
  const textBytes = Buffer.from(String(text), 'utf8');
  const result = Buffer.alloc(textBytes.length);

  for (let i = 0; i < textBytes.length; i++) {
    result[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return result.toString('hex');
}

function xorDecrypt(hex, key = SECRET()) {
  const keyBytes = Buffer.from(
    crypto.createHash('sha256').update(key).digest('hex'),
    'hex'
  );
  const encBytes = Buffer.from(hex, 'hex');
  const result = Buffer.alloc(encBytes.length);

  for (let i = 0; i < encBytes.length; i++) {
    result[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return result.toString('utf8');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = { anonymizeId, xorEncrypt, xorDecrypt, hashToken, escapeMarkdown };