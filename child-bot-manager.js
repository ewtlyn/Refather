const TelegramBot = require('node-telegram-bot-api');
const { db, logSpam, logIncident } = require('./db');
const { anonymizeId, xorDecrypt, escapeMarkdown } = require('./crypto-helper');
const captchaModule = require('./captcha');
const { validateContent, calcSpamScore, shouldRequireCaptchaForContent } = require('./antispam');
const rateLimitModule = require('./rate-limiting');

const runningBots = new Map();

// ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ

function setupChildBot(bot, tokenHash, ownerChatIdEnc) {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const anonId = anonymizeId(chatId);

    const blockStatus = captchaModule.isBlocked(anonId);
    if (blockStatus.blocked) {
      const mins = Math.ceil(blockStatus.blockEndsIn / 60);
      return bot.sendMessage(chatId,
        `🚫 Ты заблокирован за неверные ответы на капчу.\n\n⏳ Разблокировка через *${mins}* мин.`,
        { parse_mode: 'Markdown' }
      );
    }

    const alreadyPassed = captchaModule.hasPassed(anonId, tokenHash);
    if (alreadyPassed) {
      return bot.sendMessage(chatId,
        `👋 Привет! Капча уже пройдена.\n\n` +
        `Отправь своё анонимное сообщение (макс. 4000 символов).`,
        { parse_mode: 'Markdown' }
      );
    }

    const question = captchaModule.issueCaptcha(anonId, tokenHash);
    bot.sendMessage(chatId,
      `👋 Привет! Здесь можно отправить *анонимное сообщение*.\n\n` +
      `Сначала пройди капчу — защита от ботов и спама.\n\n` +
      `🔢 *${question}*\n\n` +
      `_Твой Telegram ID никогда не сохраняется и не может быть раскрыт._`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/stats/, (msg) => {
    const ownerChatId = xorDecrypt(ownerChatIdEnc);
    if (String(msg.chat.id) !== ownerChatId) {
      return bot.sendMessage(msg.chat.id, '❌ Эта команда только для владельца бота.');
    }

    const stats = require('./db').getBotStats(tokenHash);
    bot.sendMessage(msg.chat.id,
      `📊 Статистика бота\n\n` +
      `📨 Всего сообщений: ${stats.total}\n` +
      `📅 За 24 часа: ${stats.today}\n` +
      `⏱ За последний час: ${stats.thisHour}\n` +
      `👥 Уникальных отправителей: ${stats.unique}\n` +
      `🚫 Спама заблокировано (24ч): ${stats.spamBlockedToday}\n\n` +
      `Только анонимные хэши — личности неизвестны системе.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const anonId = anonymizeId(chatId);
    const ownerChatId = xorDecrypt(ownerChatIdEnc);
    const text = msg.text.trim();

    // ЭТАП 1: ПРОВЕРКА КАПЧИ 

    const hasPassed = captchaModule.hasPassed(anonId, tokenHash);
    const pendingCaptcha = captchaModule.getPendingCaptcha(anonId);

    if (pendingCaptcha) {
      const result = captchaModule.verifyCaptcha(anonId, text);

      if (result.ok) {
        rateLimitModule.initReputation(anonId, tokenHash);
        return bot.sendMessage(chatId,
          `✅ Капча пройдена!\n\n` +
          `Теперь отправь своё анонимное сообщение (макс. 4000 символов).`,
          { parse_mode: 'Markdown' }
        );
      }

      return bot.sendMessage(chatId,
        result.message,
        { parse_mode: 'Markdown' }
      );
    }

    if (!hasPassed) {
      return bot.sendMessage(chatId,
        `❌ Капча не пройдена!\n\nОтправь /start и пройди проверку.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ЭТАП 2: ПРОВЕРКА БЛОКИРОВКИ

    const blockStatus = captchaModule.isBlocked(anonId);
    if (blockStatus.blocked) {
      const mins = Math.ceil(blockStatus.blockEndsIn / 60);
      return bot.sendMessage(chatId,
        `🚫 Ты заблокирован. Попробуй через *${mins}* мин.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ЭТАП 3: АНТИ-СПАМ ─ ВАЛИДАЦИЯ КОНТЕНТА

    const spamValidation = validateContent(text);
    if (!spamValidation.ok) {
      logSpam(tokenHash, anonId, spamValidation.reason, spamValidation.severity);

      if (spamValidation.severity === 'high') {
        const newQuestion = captchaModule.requireCaptchaAgain(anonId, tokenHash);
        return bot.sendMessage(chatId,
          `${spamValidation.reason}\n\n` +
          `🔐 Требуется повторная проверка:\n\n` +
          `🔢 *${newQuestion}*`,
          { parse_mode: 'Markdown' }
        );
      }

      return bot.sendMessage(chatId, spamValidation.reason, { parse_mode: 'Markdown' });
    }

    // ЭТАП 4: ПРОВЕРКА СОБСТВЕННИКА

    if (String(chatId) === ownerChatId) {
      return bot.sendMessage(chatId, '😅 Нельзя отправить сообщение самому себе.');
    }

    // ЭТАП 5: RATE LIMITING

    const rlResult = rateLimitModule.checkRateLimit(anonId, tokenHash);
    if (!rlResult.allowed) {
      const mins = Math.ceil(rlResult.resetIn / 60);
      
      if (rlResult.remaining === 0) {
        logIncident(tokenHash, 'rate_limit_hit', 'medium', {
          anonId,
          limit: rlResult.limit,
          reputation: rlResult.reputation
        });
      }

      return bot.sendMessage(chatId,
        `⏳ Лимит исчерпан. Попробуй через *${mins}* мин.\n\n` +
        `Лимит: *${rlResult.limit}* в час.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ЭТАП 6: ОТПРАВКА СООБЩЕНИЯ

    db.prepare(`
      INSERT INTO messages (token_hash, sender_anon_id, ts)
      VALUES (?, ?, ?)
    `).run(tokenHash, anonId, Date.now());

    await bot.sendMessage(ownerChatId,
      `💌 *Анонимное сообщение*\n\n${escapeMarkdown(text)}`,
      { parse_mode: 'Markdown' }
    ).catch(err => {
      console.error(`[child] Failed to send to owner: ${err.message}`);
    });

    // ЭТАП 7: ОТВЕТ ОТПРАВИТЕЛЮ И ОБНОВЛЕНИЕ РЕПУТАЦИИ

    rateLimitModule.updateReputation(anonId, tokenHash, true);

    const repLevel = rateLimitModule.getReputationLevel(rateLimitModule.getReputation(anonId, tokenHash));

    bot.sendMessage(chatId,
      `✅ Сообщение отправлено анонимно!\n\n` +
      { parse_mode: 'Markdown' }
    );
  });

  bot.on('polling_error', (err) => {
    console.error(`[child polling_error ${tokenHash.slice(0, 8)}]`, {
      code: err.code,
      message: err.message,
      statusCode: err.response?.statusCode
    });

    if (err.code === 'ETELEGRAM' && err.response?.statusCode === 401) {
      console.error(`[child] Invalid token for ${tokenHash.slice(0, 8)}... — removing`);
      db.prepare('DELETE FROM child_bots WHERE token_hash = ?').run(tokenHash);
      bot.stopPolling().catch(() => {});
      runningBots.delete(tokenHash);
    }
  });
}

// ЗАПУСК И ОСТАНОВКА БОТОВ

async function launchChildBot(tokenHash, tokenEnc, ownerChatIdEnc) {
  if (runningBots.has(tokenHash)) return;

  const { xorDecrypt } = require('./crypto-helper');
  const token = xorDecrypt(tokenEnc);
  const bot = new TelegramBot(token, { polling: false });

  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
  } catch (e) {
    console.error(`[child] deleteWebHook failed for ${tokenHash.slice(0, 8)}...`, e.message);
  }

  setupChildBot(bot, tokenHash, ownerChatIdEnc);

  try {
    await bot.startPolling();
    runningBots.set(tokenHash, bot);
    console.log(`[child] ✅ Started bot ${tokenHash.slice(0, 8)}...`);
  } catch (e) {
    console.error(`[child] ❌ Failed to start polling for ${tokenHash.slice(0, 8)}...`, e.message);
  }
}

async function stopChildBot(tokenHash) {
  const bot = runningBots.get(tokenHash);
  if (!bot) return;
  await bot.stopPolling();
  runningBots.delete(tokenHash);
  console.log(`[child] Stopped bot ${tokenHash.slice(0, 8)}...`);
}

function restoreAllBots() {
  const bots = db.prepare('SELECT * FROM child_bots').all();
  console.log(`[child] Restoring ${bots.length} bot(s)...`);
  for (const row of bots) {
    launchChildBot(row.token_hash, row.token_enc, row.owner_chat_id_enc);
  }
}

module.exports = { launchChildBot, stopChildBot, restoreAllBots, runningBots };