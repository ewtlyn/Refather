require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { db } = require('./db');
const { anonymizeId, xorEncrypt, hashToken } = require('./crypto-helper');
const { launchChildBot, stopChildBot, restoreAllBots, runningBots } = require('./child-bot-manager');

const master = new TelegramBot(process.env.MASTER_BOT_TOKEN, { polling: true });

function setMasterSession(chatId, step) {
  const existing = db.prepare('SELECT 1 FROM master_sessions WHERE chat_id=?').get(chatId);
  if (existing) {
    db.prepare('UPDATE master_sessions SET step=? WHERE chat_id=?').run(step, chatId);
  } else {
    db.prepare('INSERT INTO master_sessions (chat_id, step) VALUES (?,?)').run(chatId, step);
  }
}


function getMasterSession(chatId) {
  return db.prepare('SELECT * FROM master_sessions WHERE chat_id=?').get(chatId);
}

function clearMasterSession(chatId) {
  db.prepare('UPDATE master_sessions SET step=NULL WHERE chat_id=?').run(chatId);
}


async function validateToken(token) {
  try {
    const testBot = new TelegramBot(token);
    const me = await testBot.getMe();
    return { valid: true, username: me.username, name: me.first_name };
  } catch {
    return { valid: false };
  }
}

master.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const ownerAnonId = anonymizeId(chatId);
  const existing = db.prepare('SELECT * FROM child_bots WHERE owner_anon_id=?').get(ownerAnonId);

  if (existing) {
    const isRunning = runningBots.has(existing.token_hash);
    return master.sendMessage(chatId,
      `👋 У тебя уже есть подключённый бот: @${existing.bot_username}` +
      `Статус: ${isRunning ? '🟢 Работает' : '🔴 Остановлен'}\n\n` +
      `📊 /stats — статистика\n` +
      `🗑 /disconnect — отключить бота`,
      { parse_mode: 'Markdown' }
    );
  }

  setMasterSession(chatId, 'awaiting_token');
  master.sendMessage(chatId,
    `👋 Добро пожаловать!\n\n` +
    `Для подключения бота выполни следующее:\n\n` +
    `1. Создай бота в @BotFather\n` +
    `2. Отправь мне токен своего нового бота, полученного в @BotFather\n` +
    `   _(выглядит как набор цифр и букв: \`12345:ABCD...\`)_`,
    { parse_mode: 'Markdown' }
  );
});


master.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const ownerAnonId = anonymizeId(chatId);
  const childBot = db.prepare('SELECT * FROM child_bots WHERE owner_anon_id=?').get(ownerAnonId);

  if (!childBot) {
    return master.sendMessage(chatId, '❌ У тебя нет подключённого бота. Напиши /start.');
  }

  const total    = db.prepare('SELECT COUNT(*) as c FROM messages WHERE token_hash=?').get(childBot.token_hash).c;
  const today    = db.prepare('SELECT COUNT(*) as c FROM messages WHERE token_hash=? AND ts>?').get(childBot.token_hash, Date.now()-86400000).c;
  const thisHour = db.prepare('SELECT COUNT(*) as c FROM messages WHERE token_hash=? AND ts>?').get(childBot.token_hash, Date.now()-3600000).c;
  const unique   = db.prepare('SELECT COUNT(DISTINCT sender_anon_id) as c FROM messages WHERE token_hash=?').get(childBot.token_hash).c;

master.sendMessage(chatId,
  `📊 Статистика @${childBot.bot_username}\n\n` +
  `📨 Всего сообщений: ${total}\n` +
  `📅 За 24 часа: ${today}\n` +
  `⏱ За последний час: ${thisHour}\n` +
  `👥 Уникальных отправителей: ${unique}\n\n` +
  `Только анонимные хэши — личности неизвестны системе.`
);
});


master.onText(/\/disconnect/, (msg) => {
  setMasterSession(msg.chat.id, 'confirm_disconnect');
  master.sendMessage(msg.chat.id,
    '⚠️ Ты уверен? Это остановит твой анон-бот и удалит все данные.\n\nНапиши *ДА* для подтверждения.',
    { parse_mode: 'Markdown' }
  );
});


master.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const session = getMasterSession(chatId);

  if (session?.step === 'confirm_disconnect') {
    clearMasterSession(chatId);
    if (msg.text.trim().toUpperCase() === 'ДА') {
      const ownerAnonId = anonymizeId(chatId);
      const childBot = db.prepare('SELECT * FROM child_bots WHERE owner_anon_id=?').get(ownerAnonId);
      if (childBot) {
        await stopChildBot(childBot.token_hash);
        db.prepare('DELETE FROM child_bots WHERE token_hash=?').run(childBot.token_hash);
        db.prepare('DELETE FROM messages WHERE token_hash=?').run(childBot.token_hash);
      }
      return master.sendMessage(chatId, '✅ Бот отключён и все данные удалены. Напиши /start чтобы подключить новый.');
    }
    return master.sendMessage(chatId, '❌ Отменено.');
  }

  if (session?.step === 'awaiting_token') {
    clearMasterSession(chatId);

    const token = msg.text.trim();

    if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
      setMasterSession(chatId, 'awaiting_token');
      return master.sendMessage(chatId,
        `❌ Неверный формат токена.\n\nТокен выглядит так: \`123456789:AAHxxxxxx...\`\n\nПопробуй ещё раз:`,
        { parse_mode: 'Markdown' }
      );
    }

    const tHash = hashToken(token);
    const alreadyExists = db.prepare('SELECT 1 FROM child_bots WHERE token_hash=?').get(tHash);
    if (alreadyExists) {
      return master.sendMessage(chatId, '❌ Этот токен уже зарегистрирован.');
    }

    const ownerAnonId = anonymizeId(chatId);
    const ownerHasBot = db.prepare('SELECT 1 FROM child_bots WHERE owner_anon_id=?').get(ownerAnonId);
    if (ownerHasBot) {
      return master.sendMessage(chatId, '❌ У тебя уже есть подключённый бот. Сначала отключи его через /disconnect.');
    }

    await master.sendMessage(chatId, '⏳ Проверяю токен...');

    const validation = await validateToken(token);
    if (!validation.valid) {
      setMasterSession(chatId, 'awaiting_token');
      return master.sendMessage(chatId,
        `❌ Токен недействителен или бот уже используется.\n\nПроверь токен в @BotFather и попробуй ещё раз:`,
        { parse_mode: 'Markdown' }
      );
    }

    const tokenEnc = xorEncrypt(token);
    const ownerChatIdEnc = xorEncrypt(String(chatId));

    db.prepare(`
      INSERT INTO child_bots
        (token_enc, token_hash, bot_username, owner_anon_id, owner_chat_id_enc, owner_master_chat, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(tokenEnc, tHash, validation.username, ownerAnonId, ownerChatIdEnc, chatId, Date.now());

    await launchChildBot(tHash, tokenEnc, ownerChatIdEnc);

master.sendMessage(chatId,
  `🟢 Поздравляем, бот t.me/${validation.username} успешно подключён!\n\n` +
  `Для проверки его работы выполни следующее:\n` +
  `1. Перейди в t.me/${validation.username}\n` +
  `2. Отправь /start\n\n` +
  `📊 Статистика: /stats\n` +
  `🗑 Отключить: /disconnect`
);

    return;
  }

  master.sendMessage(chatId, 'Напиши /start чтобы подключить своего анон-бота.');
});


restoreAllBots();
console.log('🤖 Мастер-бот запущен...');