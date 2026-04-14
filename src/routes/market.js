const express = require('express');
const { SERVER_API_KEY } = require('../config');
const {
  extractInitData,
  getTelegramUserFromInitData
} = require('../utils/telegram');

function hasServerKey(req) {
  return req.header('X-Server-Key') === SERVER_API_KEY;
}

async function resolveBuyer(prisma, req) {
  const buyerExternalId = req.body?.buyerExternalId || null;

  if (hasServerKey(req)) {
    if (!buyerExternalId) {
      throw Object.assign(new Error('buyerExternalId required'), { status: 400 });
    }

    const buyer = await prisma.user.findUnique({
      where: { externalId: buyerExternalId },
      include: { wallet: true }
    });

    if (!buyer || !buyer.wallet) {
      throw Object.assign(new Error('buyer not found'), { status: 404 });
    }

    return buyer;
  }

  const tg = getTelegramUserFromInitData(extractInitData(req));
  if (!tg) {
    throw Object.assign(new Error('INVALID_TELEGRAM_AUTH'), { status: 401 });
  }

  if (buyerExternalId) {
    const buyer = await prisma.user.findUnique({
      where: { externalId: buyerExternalId },
      include: { wallet: true }
    });

    if (!buyer || !buyer.wallet) {
      throw Object.assign(new Error('buyer not found'), { status: 404 });
    }

    if (buyer.telegramUserId !== tg.id) {
      throw Object.assign(new Error('FORBIDDEN_FOR_THIS_ACCOUNT'), { status: 403 });
    }

    return buyer;
  }

  const buyer = await prisma.user.findUnique({
    where: { telegramUserId: tg.id },
    include: { wallet: true }
  });

  if (!buyer || !buyer.wallet) {
    throw Object.assign(new Error('ACCOUNT_NOT_LINKED'), { status: 404 });
  }

  return buyer;
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/listings', async (_req, res, next) => {
    try {
      const list = await prisma.listing.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: 100
      });

      res.json({ listings: list });
    } catch (e) {
      next(e);
    }
  });

  router.post('/listings/:id/buy', async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid listing id' });
      }

      const { serverId } = req.body || {};
      if (!serverId) {
        return res.status(400).json({ error: 'serverId required' });
      }

      const buyer = await resolveBuyer(prisma, req);

      const result = await prisma.$transaction(async (tx) => {
        const listing = await tx.listing.findUnique({
          where: { id }
        });

        if (!listing || listing.status !== 'ACTIVE') {
          throw Object.assign(new Error('listing not available'), { status: 400 });
        }

        if (listing.userId === buyer.id) {
          throw Object.assign(new Error('cannot buy your own listing'), { status: 400 });
        }

        const buyerWallet = await tx.wallet.findUnique({
          where: { userId: buyer.id }
        });

        if (!buyerWallet) {
          throw new Error('buyer wallet not found');
        }

        const amountAtomic = BigInt(listing.priceAtomic);
        if (BigInt(buyerWallet.balanceAtomic) < amountAtomic) {
          throw Object.assign(new Error('Insufficient funds'), { status: 400 });
        }

        const markSold = await tx.listing.updateMany({
          where: {
            id: listing.id,
            status: 'ACTIVE'
          },
          data: {
            status: 'SOLD'
          }
        });

        if (markSold.count !== 1) {
          throw Object.assign(new Error('listing not available'), { status: 400 });
        }

        await tx.wallet.update({
          where: { userId: buyer.id },
          data: {
            balanceAtomic: { decrement: amountAtomic }
          }
        });

        await tx.ledgerEntry.create({
          data: {
            userId: buyer.id,
            type: 'PURCHASE',
            amountAtomic: amountAtomic * -1n,
            reference: `listing:${listing.id}`
          }
        });

        const trade = await tx.trade.create({
          data: {
            listingId: listing.id,
            buyerId: buyer.id,
            sellerId: listing.userId,
            amountAtomic,
            status: 'DELIVERING',
            meta: {
              sellerPaid: false,
              buyerRefunded: false
            }
          }
        });

        const delivery = await tx.pendingDelivery.create({
          data: {
            tradeId: trade.id,
            serverId,
            action: 'DELIVER_ITEM_OR_PERMISSION',
            payload: {
              type: listing.type,
              itemId: listing.itemId,
              quantity: listing.quantity,
              title: listing.title,
              iconUrl: listing.iconUrl,
              meta: listing.meta || null,
              buyerExternalId: buyer.externalId
            },
            status: 'PENDING'
          }
        });

        const soldListing = await tx.listing.findUnique({
          where: { id: listing.id }
        });

        return {
          listing: soldListing,
          trade,
          delivery
        };
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