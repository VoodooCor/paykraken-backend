const express = require('express');
const { isValidBase58Address } = require('../utils/solana_rpc');
const { scanAndCreditUserDeposits } = require('../services/depositService');

module.exports = ({ prisma }) => {
  const router = express.Router();

  // Привязка/проверка Solana-адреса пользователя
  router.post('/link', async (req, res, next) => {
    try {
      const { externalId, solanaAddress } = req.body || {};
      if (!externalId || !solanaAddress) return res.status(400).json({ error: 'missing fields' });

      if (!isValidBase58Address(solanaAddress)) {
        return res.status(400).json({ error: 'INVALID_SOLANA_ADDRESS' });
      }

      const user = await prisma.user.findUnique({
        where: { externalId },
        include: { wallet: true }
      });
      if (!user || !user.wallet) return res.status(404).json({ error: 'user/wallet not found' });

      await prisma.wallet.update({
        where: { userId: user.id },
        data: { solanaAddress }
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Проверка поступления. Клиент может повторить до 3 раз с ~минутным интервалом.
  router.post('/deposit/check', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      if (!externalId) return res.status(400).json({ error: 'externalId required' });

      const user = await prisma.user.findUnique({
        where: { externalId },
        include: { wallet: true }
      });
      if (!user || !user.wallet) return res.status(404).json({ error: 'user/wallet not found' });

      const result = await scanAndCreditUserDeposits(prisma, user);

      res.json({
        ok: true,
        balanceAtomic: result.balanceAtomic,
        credited: result.deposits.map(d => ({
          id: d.id,
          txSignature: d.txSignature,
          amountAtomic: d.amountAtomic
        }))
      });
    } catch (e) { next(e); }
  });

  // Создание заявки на вывод
  router.post('/withdraw', async (req, res, next) => {
    try {
      const { externalId, destination, amount } = req.body || {};
      if (!externalId || !destination || amount === undefined) {
        return res.status(400).json({ error: 'missing fields' });
      }
      if (!isValidBase58Address(destination)) {
        return res.status(400).json({ error: 'INVALID_DESTINATION' });
      }
      const amountAtomic = BigInt(amount);
      if (amountAtomic <= 0n) return res.status(400).json({ error: 'amount must be > 0' });

      const user = await prisma.user.findUnique({
        where: { externalId },
        include: { wallet: true }
      });
      if (!user || !user.wallet) return res.status(404).json({ error: 'user/wallet not found' });

      const wr = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId: user.id } });
        if (!wallet) throw new Error('Wallet not found');
        if (BigInt(wallet.balanceAtomic) < amountAtomic) {
          throw Object.assign(new Error('Insufficient funds'), { status: 400 });
        }

        await tx.wallet.update({
          where: { userId: user.id },
          data: { balanceAtomic: { decrement: amountAtomic } }
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'WITHDRAWAL',
            amountAtomic: amountAtomic * -1n,
            reference: 'withdraw:request'
          }
        });

        return await tx.withdrawalRequest.create({
          data: {
            userId: user.id,
            amountAtomic,
            destination,
            status: 'REQUESTED'
          }
        });
      });

      res.json({ ok: true, requestId: wr.id });
    } catch (e) { next(e); }
  });

  // Баланс/профиль кошелька
  router.get('/profile/:externalId', async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { externalId: req.params.externalId },
        include: { wallet: true }
      });
      if (!user || !user.wallet) return res.status(404).json({ error: 'user/wallet not found' });
      res.json({
        externalId: user.externalId,
        steamId: user.steamId,
        nickname: user.rustNickname,
        solanaAddress: user.wallet.solanaAddress,
        balanceAtomic: user.wallet.balanceAtomic
      });
    } catch (e) { next(e); }
  });

  return router;
};