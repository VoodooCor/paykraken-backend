const express = require('express');
const { generateExternalId } = require('../utils/id');
const { SERVER_API_KEY } = require('../config');

function requireServerKey(req, res, next) {
  const key = req.header('X-Server-Key');
  if (!key || key !== SERVER_API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED_SERVER', code: 'UNAUTHORIZED_SERVER' });
  }
  next();
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  // Регистрация/получение externalId для игрока
  router.post('/register', requireServerKey, async (req, res, next) => {
    try {
      const { steamId, nickname } = req.body || {};
      if (!steamId) return res.status(400).json({ error: 'steamId required' });

      let user = await prisma.user.findUnique({ where: { steamId } });
      if (!user) {
        let externalId = generateExternalId();
        while (await prisma.user.findUnique({ where: { externalId } })) {
          externalId = generateExternalId();
        }
        user = await prisma.user.create({
          data: {
            steamId,
            externalId,
            rustNickname: nickname || null,
            wallet: { create: {} }
          },
          include: { wallet: true }
        });
      } else {
        if (nickname && user.rustNickname !== nickname) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { rustNickname: nickname }
          });
        }
      }

      res.json({
        steamId: user.steamId,
        externalId: user.externalId,
        link: 'https://t.me/your_bot_here/app?start=link' // TODO: заменить на реальный deep-link
      });
    } catch (e) { next(e); }
  });

  // Запрос инфо об игроке по steamId (для UI в плагине)
  router.get('/user/:steamId', requireServerKey, async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { steamId: req.params.steamId },
        include: { wallet: true }
      });
      if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

      res.json({
        steamId: user.steamId,
        externalId: user.externalId,
        nickname: user.rustNickname,
        balanceAtomic: user.wallet?.balanceAtomic || '0'
      });
    } catch (e) { next(e); }
  });

  // Создание лота (плагин уже изъял ресурсы/время привилегии)
  router.post('/market/listings', requireServerKey, async (req, res, next) => {
    try {
      const { steamId, type, itemId, title, iconUrl, quantity, priceAtomic } = req.body || {};
      if (!steamId || !type || !itemId || !title || !priceAtomic) {
        return res.status(400).json({ error: 'missing fields' });
      }
      if (!['RESOURCE', 'PRIVILEGE'].includes(type)) {
        return res.status(400).json({ error: 'invalid listing type' });
      }
      const user = await prisma.user.findUnique({ where: { steamId } });
      if (!user) return res.status(404).json({ error: 'user not found' });

      const listing = await prisma.listing.create({
        data: {
          userId: user.id,
          type,
          itemId,
          title,
          iconUrl: iconUrl || null,
          quantity: quantity || 1,
          priceAtomic: BigInt(priceAtomic)
        }
      });

      res.json({ listing });
    } catch (e) { next(e); }
  });

  // Плагин опрашивает задания на доставку
  router.get('/deliveries/pending', requireServerKey, async (_req, res, next) => {
    try {
      const list = await prisma.pendingDelivery.findMany({
        where: { status: 'PENDING' },
        take: 50
      });
      res.json({ deliveries: list });
    } catch (e) { next(e); }
  });

  // Плагин подтверждает доставку/ошибку
  router.post('/deliveries/:id/status', requireServerKey, async (req, res, next) => {
    try {
      const { status, details } = req.body || {};
      const id = Number(req.params.id);
      if (!['SENT', 'CONFIRMED', 'FAILED'].includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      const del = await prisma.pendingDelivery.update({
        where: { id },
        data: { status, payload: details || undefined }
      });

      if (status === 'CONFIRMED') {
        await prisma.trade.update({
          where: { id: del.tradeId },
          data: { status: 'COMPLETED' }
        });
      }
      if (status === 'FAILED') {
        await prisma.trade.update({
          where: { id: del.tradeId },
          data: { status: 'FAILED' }
        });
      }

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
};