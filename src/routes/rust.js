const express = require('express');
const { generateExternalId } = require('../utils/id');
const {
  SERVER_API_KEY,
  TELEGRAM_MINI_APP_URL,
  TELEGRAM_BOT_USERNAME
} = require('../config');

function requireServerKey(req, res, next) {
  const key = req.header('X-Server-Key');
  if (!key || key !== SERVER_API_KEY) {
    return res.status(401).json({
      error: 'UNAUTHORIZED_SERVER',
      code: 'UNAUTHORIZED_SERVER'
    });
  }
  next();
}

function parseAtomicAmount(value, field = 'amount') {
  if (value === undefined || value === null || value === '') {
    throw Object.assign(new Error(`${field} required`), { status: 400 });
  }

  try {
    return BigInt(String(value));
  } catch {
    throw Object.assign(new Error(`${field} must be an integer string`), { status: 400 });
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mergeJson(base, patch) {
  return {
    ...asObject(base),
    ...asObject(patch)
  };
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.post('/register', requireServerKey, async (req, res, next) => {
    try {
      const { steamId, nickname } = req.body || {};
      if (!steamId) {
        return res.status(400).json({ error: 'steamId required' });
      }

      let user = await prisma.user.findUnique({
        where: { steamId }
      });

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
      } else if (nickname && user.rustNickname !== nickname) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { rustNickname: nickname }
        });
      }

      const link = TELEGRAM_BOT_USERNAME
        ? `https://t.me/${TELEGRAM_BOT_USERNAME}/app?startapp=${encodeURIComponent(user.externalId)}`
        : TELEGRAM_MINI_APP_URL;

      res.json({
        steamId: user.steamId,
        externalId: user.externalId,
        link
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/user/:steamId', requireServerKey, async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { steamId: req.params.steamId },
        include: { wallet: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      res.json({
        steamId: user.steamId,
        externalId: user.externalId,
        nickname: user.rustNickname,
        telegramLinked: Boolean(user.telegramUserId),
        balanceAtomic: user.wallet?.balanceAtomic || '0'
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/market/listings', requireServerKey, async (req, res, next) => {
    try {
      const {
        steamId,
        type,
        itemId,
        title,
        iconUrl,
        quantity,
        priceAtomic,
        meta
      } = req.body || {};

      if (!steamId || !type || !itemId || !title || priceAtomic === undefined) {
        return res.status(400).json({ error: 'missing fields' });
      }

      if (!['RESOURCE', 'PRIVILEGE'].includes(type)) {
        return res.status(400).json({ error: 'invalid listing type' });
      }

      const user = await prisma.user.findUnique({
        where: { steamId }
      });

      if (!user) {
        return res.status(404).json({ error: 'user not found' });
      }

      const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
      const atomicPrice = parseAtomicAmount(priceAtomic, 'priceAtomic');

      if (atomicPrice <= 0n) {
        return res.status(400).json({ error: 'priceAtomic must be > 0' });
      }

      const listing = await prisma.listing.create({
        data: {
          userId: user.id,
          type,
          itemId,
          title,
          iconUrl: iconUrl || null,
          quantity: qty,
          priceAtomic: atomicPrice,
          meta: meta || undefined
        }
      });

      res.json({ listing });
    } catch (e) {
      next(e);
    }
  });

  router.get('/deliveries/pending', requireServerKey, async (_req, res, next) => {
    try {
      const list = await prisma.pendingDelivery.findMany({
        where: { status: 'PENDING' },
        take: 50
      });

      res.json({ deliveries: list });
    } catch (e) {
      next(e);
    }
  });

  router.post('/deliveries/:id/status', requireServerKey, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid delivery id' });
      }

      const { status, details } = req.body || {};
      if (!['SENT', 'CONFIRMED', 'FAILED'].includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const delivery = await tx.pendingDelivery.findUnique({
          where: { id },
          include: {
            trade: true
          }
        });

        if (!delivery) {
          throw Object.assign(new Error('delivery not found'), { status: 404 });
        }

        const nextPayload = mergeJson(delivery.payload, {
          deliveryStatus: status,
          deliveryDetails: details || null,
          deliveryUpdatedAt: new Date().toISOString()
        });

        const updatedDelivery = await tx.pendingDelivery.update({
          where: { id },
          data: {
            status,
            payload: nextPayload
          }
        });

        if (status === 'SENT') {
          return { delivery: updatedDelivery };
        }

        if (status === 'CONFIRMED') {
          if (delivery.trade.status === 'FAILED') {
            throw Object.assign(new Error('trade already failed'), { status: 400 });
          }

          if (delivery.trade.status !== 'COMPLETED') {
            await tx.trade.update({
              where: { id: delivery.tradeId },
              data: {
                status: 'COMPLETED',
                meta: mergeJson(delivery.trade.meta, {
                  sellerPaid: true,
                  buyerRefunded: false,
                  deliveryConfirmedAt: new Date().toISOString(),
                  deliveryDetails: details || null
                })
              }
            });

            await tx.wallet.update({
              where: { userId: delivery.trade.sellerId },
              data: {
                balanceAtomic: { increment: delivery.trade.amountAtomic }
              }
            });

            await tx.ledgerEntry.create({
              data: {
                userId: delivery.trade.sellerId,
                type: 'SALE',
                amountAtomic: delivery.trade.amountAtomic,
                reference: `listing:${delivery.trade.listingId}`,
                meta: {
                  tradeId: delivery.tradeId
                }
              }
            });
          }

          return { delivery: updatedDelivery };
        }

        if (status === 'FAILED') {
          if (delivery.trade.status === 'COMPLETED') {
            throw Object.assign(new Error('trade already completed'), { status: 400 });
          }

          if (delivery.trade.status !== 'FAILED') {
            await tx.trade.update({
              where: { id: delivery.tradeId },
              data: {
                status: 'FAILED',
                meta: mergeJson(delivery.trade.meta, {
                  sellerPaid: false,
                  buyerRefunded: true,
                  deliveryFailedAt: new Date().toISOString(),
                  deliveryDetails: details || null
                })
              }
            });

            await tx.wallet.update({
              where: { userId: delivery.trade.buyerId },
              data: {
                balanceAtomic: { increment: delivery.trade.amountAtomic }
              }
            });

            await tx.ledgerEntry.create({
              data: {
                userId: delivery.trade.buyerId,
                type: 'ADJUSTMENT',
                amountAtomic: delivery.trade.amountAtomic,
                reference: `trade:${delivery.tradeId}:refund`,
                meta: {
                  reason: 'DELIVERY_FAILED'
                }
              }
            });

            await tx.listing.update({
              where: { id: delivery.trade.listingId },
              data: {
                status: 'ACTIVE'
              }
            });
          }

          return { delivery: updatedDelivery };
        }

        return { delivery: updatedDelivery };
      });

      res.json({
        ok: true,
        ...result
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};