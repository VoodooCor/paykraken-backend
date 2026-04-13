const express = require('express');

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
} catch (e) { next(e); }
});

router.post('/listings/:id/buy', async (req, res, next) => {
try {
const id = Number(req.params.id);
const { buyerExternalId, serverId } = req.body || {};
if (!buyerExternalId || !serverId) return res.status(400).json({ error: 'missing fields' });

  const buyer = await prisma.user.findUnique({ where: { externalId: buyerExternalId }, include: { wallet: true } });
  if (!buyer) return res.status(404).json({ error: 'buyer not found' });

  const result = await prisma.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id } });
    if (!listing || listing.status !== 'ACTIVE') {
      throw Object.assign(new Error('listing not available'), { status: 400 });
    }
    const seller = await tx.user.findUnique({ where: { id: listing.userId }, include: { wallet: true } });
    if (!seller) throw new Error('seller not found');

    const amountAtomic = BigInt(listing.priceAtomic);
    const buyerWallet = await tx.wallet.findUnique({ where: { userId: buyer.id } });
    if (BigInt(buyerWallet.balanceAtomic) < amountAtomic) {
      throw Object.assign(new Error('Insufficient funds'), { status: 400 });
    }

    await tx.wallet.update({
      where: { userId: buyer.id },
      data: { balanceAtomic: { decrement: amountAtomic } }
    });
    await tx.ledgerEntry.create({
      data: { userId: buyer.id, type: 'PURCHASE', amountAtomic: amountAtomic * -1n, reference: `listing:${listing.id}` }
    });

    await tx.wallet.update({
      where: { userId: seller.id },
      data: { balanceAtomic: { increment: amountAtomic } }
    });
    await tx.ledgerEntry.create({
      data: { userId: seller.id, type: 'SALE', amountAtomic: amountAtomic, reference: `listing:${listing.id}` }
    });

    await tx.listing.update({ where: { id: listing.id }, data: { status: 'SOLD' } });

    const trade = await tx.trade.create({
      data: {
        listingId: listing.id,
        buyerId: buyer.id,
        sellerId: seller.id,
        amountAtomic: amountAtomic,
        status: 'DELIVERING'
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
          // ДОБАВЛЕНО: чтобы плагин мог понять кому выдавать
          buyerExternalId: buyer.externalId
        },
        status: 'PENDING'
      }
    });

    return { listing, trade, delivery };
  });

  res.json({ ok: true, ...result });
} catch (e) { next(e); }
});

return router;
};