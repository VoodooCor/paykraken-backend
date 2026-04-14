const crypto = require('crypto');
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_AUTH_MAX_AGE_SECONDS
} = require('../config');

function extractInitData(req) {
  return (
    req.header('X-Telegram-Init-Data') ||
    req.body?.initData ||
    req.query?.initData ||
    ''
  );
}

function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Object.assign(new Error('TELEGRAM_BOT_TOKEN not set'), { status: 500 });
  }

  if (!initData || typeof initData !== 'string') return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

  const authDate = Number(params.get('auth_date') || 0);
  if (TELEGRAM_AUTH_MAX_AGE_SECONDS > 0 && authDate > 0) {
    const now = Math.floor(Date.now() / 1000);
    const age = now - authDate;
    if (age < 0 || age > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
      return false;
    }
  }

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }

  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(calculatedHash, 'hex'),
      Buffer.from(hash, 'hex')
    );
  } catch {
    return false;
  }
}

function getTelegramUserFromInitData(initData) {
  if (!verifyTelegramInitData(initData)) return null;

  const params = new URLSearchParams(initData);
  const rawUser = params.get('user');
  if (!rawUser) return null;

  let parsed;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return null;
  }

  if (!parsed?.id) return null;

  return {
    id: String(parsed.id),
    username: parsed.username || null,
    firstName: parsed.first_name || null,
    lastName: parsed.last_name || null,
    raw: parsed
  };
}

module.exports = {
  extractInitData,
  verifyTelegramInitData,
  getTelegramUserFromInitData
};