const express = require('express');
const {
  extractInitData,
  getTelegramUserFromInitData
} = require('../utils/telegram');

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.post('/link', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      if (!externalId) {
        return res.status(400).json({ error: 'externalId required' });
      }

      const initData = extractInitData(req);
      const tg = getTelegramUserFromInitData(initData);
      if (!tg) {
        return res.status(401).json({ error: 'INVALID_TELEGRAM_AUTH' });
      }

      const user = await prisma.user.findUnique({
        where: { externalId },
        include: { wallet: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'user not found' });
      }

      const existingByTelegram = await prisma.user.findFirst({
        where: {
          telegramUserId: tg.id,
          NOT: { id: user.id }
        }
      });

      if (existingByTelegram) {
        return res.status(409).json({
          error: 'TELEGRAM_ALREADY_LINKED_TO_ANOTHER_ACCOUNT'
        });
      }

      if (user.telegramUserId && user.telegramUserId !== tg.id) {
        return res.status(409).json({
          error: 'ACCOUNT_ALREADY_LINKED_TO_ANOTHER_TELEGRAM'
        });
      }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          telegramUserId: tg.id,
          telegramUsername: tg.username
        },
        include: { wallet: true }
      });

      res.json({
        ok: true,
        linked: true,
        user: {
          externalId: updated.externalId,
          steamId: updated.steamId,
          nickname: updated.rustNickname,
          telegramUserId: updated.telegramUserId,
          telegramUsername: updated.telegramUsername,
          solanaAddress: updated.wallet?.solanaAddress || null,
          balanceAtomic: updated.wallet?.balanceAtomic || 0n
        }
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const initData = extractInitData(req);
      const tg = getTelegramUserFromInitData(initData);
      if (!tg) {
        return res.status(401).json({ error: 'INVALID_TELEGRAM_AUTH' });
      }

      const user = await prisma.user.findUnique({
        where: { telegramUserId: tg.id },
        include: { wallet: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'ACCOUNT_NOT_LINKED' });
      }

      res.json({
        ok: true,
        user: {
          externalId: user.externalId,
          steamId: user.steamId,
          nickname: user.rustNickname,
          telegramUserId: user.telegramUserId,
          telegramUsername: user.telegramUsername,
          solanaAddress: user.wallet?.solanaAddress || null,
          balanceAtomic: user.wallet?.balanceAtomic || 0n
        }
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};