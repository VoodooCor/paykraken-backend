const crypto = require('crypto');
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_AUTH_MAX_AGE_SECONDS,
  BLKR_DECIMALS
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function atomicToBLKR(value, decimals = BLKR_DECIMALS) {
  try {
    const s = String(value ?? '0');
    const neg = s.startsWith('-');
    const raw = neg ? s.slice(1) : s;
    const pad = raw.padStart(decimals + 1, '0');
    const i = pad.slice(0, -decimals);
    let f = pad.slice(-decimals).replace(/0+$/, '');
    return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`;
  } catch {
    return '0';
  }
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not set');
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data || { status: response.status })}`);
  }

  return data.result;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  return telegramApi('sendMessage', {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

function buildWithdrawalStatusMessage(withdrawal, user) {
  const amount = atomicToBLKR(withdrawal.amountAtomic);
  const destination = escapeHtml(withdrawal.destination || '—');
  const txSignature = escapeHtml(withdrawal.txSignature || '—');
  const externalId = escapeHtml(user?.externalId || '—');
  const nickname = escapeHtml(user?.rustNickname || user?.displayName || 'Игрок');

  const meta = withdrawal?.meta && typeof withdrawal.meta === 'object' ? withdrawal.meta : {};
  const rejectReason = escapeHtml(meta.rejectReason || 'Не указана');

  if (withdrawal.status === 'APPROVED') {
    return [
      `✅ <b>Заявка на вывод одобрена</b>`,
      ``,
      `Игрок: <b>${nickname}</b>`,
      `External ID: <code>${externalId}</code>`,
      `Сумма: <b>${amount} BLKR</b>`,
      `Адрес: <code>${destination}</code>`,
      ``,
      `Статус: <b>APPROVED</b>`
    ].join('\n');
  }

  if (withdrawal.status === 'SENT') {
    return [
      `🚀 <b>Вывод отправлен</b>`,
      ``,
      `Игрок: <b>${nickname}</b>`,
      `External ID: <code>${externalId}</code>`,
      `Сумма: <b>${amount} BLKR</b>`,
      `Адрес: <code>${destination}</code>`,
      `Tx Signature: <code>${txSignature}</code>`,
      ``,
      `Статус: <b>SENT</b>`
    ].join('\n');
  }

  if (withdrawal.status === 'REJECTED') {
    return [
      `❌ <b>Заявка на вывод отклонена</b>`,
      ``,
      `Игрок: <b>${nickname}</b>`,
      `External ID: <code>${externalId}</code>`,
      `Сумма: <b>${amount} BLKR</b>`,
      `Адрес: <code>${destination}</code>`,
      `Причина: <b>${rejectReason}</b>`,
      ``,
      `Статус: <b>REJECTED</b>`
    ].join('\n');
  }

  return [
    `ℹ️ <b>Обновление статуса вывода</b>`,
    ``,
    `Сумма: <b>${amount} BLKR</b>`,
    `Статус: <b>${escapeHtml(withdrawal.status || '—')}</b>`
  ].join('\n');
}

async function sendWithdrawalStatusNotification(user, withdrawal) {
  if (!user?.telegramUserId) {
    return { ok: false, skipped: true, reason: 'telegramUserId missing' };
  }

  if (!['APPROVED', 'SENT', 'REJECTED'].includes(withdrawal?.status)) {
    return { ok: false, skipped: true, reason: 'status not supported' };
  }

  const text = buildWithdrawalStatusMessage(withdrawal, user);
  const result = await sendTelegramMessage(user.telegramUserId, text);
  return { ok: true, result };
}

module.exports = {
  extractInitData,
  verifyTelegramInitData,
  getTelegramUserFromInitData,
  sendTelegramMessage,
  sendWithdrawalStatusNotification,
  buildWithdrawalStatusMessage,
  atomicToBLKR,
  escapeHtml
};