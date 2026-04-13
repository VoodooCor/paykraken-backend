const express = require('express');
const crypto = require('crypto');
const { TELEGRAM_BOT_TOKEN } = require('../config');

// Проверка WebApp initData (по правилам Telegram)
function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const url = new URLSearchParams(initData);
  const hash = url.get('hash');
  if (!hash) return false;

  const params = [];
  url.forEach((v, k) => {
    if (k === 'hash') return;
    params.push(`${k}=${v}`);
  });
  params.sort();
  const dataCheckString = params.join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  return h === hash;
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  // Линковка Telegram ↔ User по externalId
  router.post('/link', async (req, res, next) => {
    try {
      const { externalId, initData } = req.body || {};
      if (!externalId || !initData) return res.status(400).json({ error: 'missing fields' });

      if (!verifyTelegramInitData(initData)) {
        return res.status(401).json({ error: 'INVALID_TELEGRAM_AUTH' });
      }

      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      const tg = userParam ? JSON.parse(userParam) : null;
      const telegramUserId = tg?.id?.toString();
      const telegramUsername = tg?.username || null;

      if (!telegramUserId) {
        return res.status(400).json({ error: 'telegram userId missing' });
      }

      const user = await prisma.user.findUnique({ where: { externalId } });
      if (!user) return res.status(404).json({ error: 'user not found' });

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { telegramUserId, telegramUsername }
      });

      res.json({ ok: true, user: { externalId: updated.externalId, telegramUserId: updated.telegramUserId, telegramUsername: updated.telegramUsername } });
    } catch (e) { next(e); }
  });

  return router;
};