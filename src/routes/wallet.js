const express = require('express');
const {
  SERVER_API_KEY,
  MERCHANT_WALLET,
  BLKR_MINT,
  BLKR_DECIMALS
} = require('../config');
const {
  isValidBase58Address,
  getMerchantTokenAccount
} = require('../utils/solana_rpc');
const { scanAndCreditUserDeposits } = require('../services/depositService');
const {
  extractInitData,
  getTelegramUserFromInitData
} = require('../utils/telegram');

function hasServerKey(req) {
  return req.header('X-Server-Key') === SERVER_API_KEY;
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

async function getUserByExternalId(prisma, externalId) {
  return prisma.user.findUnique({
    where: { externalId },
    include: { wallet: true }
  });
}

async function resolveAuthorizedUser(prisma, req, externalId = null) {
  if (hasServerKey(req)) {
    if (!externalId) {
      throw Object.assign(new Error('externalId required'), { status: 400 });
    }

    const user = await getUserByExternalId(prisma, externalId);
    if (!user || !user.wallet) {
      throw Object.assign(new Error('user/wallet not found'), { status: 404 });
    }

    return user;
  }

  const tg = getTelegramUserFromInitData(extractInitData(req));
  if (!tg) {
    throw Object.assign(new Error('INVALID_TELEGRAM_AUTH'), { status: 401 });
  }

  if (externalId) {
    const user = await getUserByExternalId(prisma, externalId);
    if (!user || !user.wallet) {
      throw Object.assign(new Error('user/wallet not found'), { status: 404 });
    }

    if (user.telegramUserId !== tg.id) {
      throw Object.assign(new Error('FORBIDDEN_FOR_THIS_ACCOUNT'), { status: 403 });
    }

    return user;
  }

  const user = await prisma.user.findUnique({
    where: { telegramUserId: tg.id },
    include: { wallet: true }
  });

  if (!user || !user.wallet) {
    throw Object.assign(new Error('ACCOUNT_NOT_LINKED'), { status: 404 });
  }

  return user;
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/config', async (_req, res, next) => {
    try {
      let merchantTokenAccount = null;

      try {
        merchantTokenAccount = await getMerchantTokenAccount();
      } catch {
        merchantTokenAccount = null;
      }

      res.json({
        merchantWallet: MERCHANT_WALLET,
        merchantTokenAccount,
        blkrMint: BLKR_MINT,
        blkrDecimals: BLKR_DECIMALS
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const user = await resolveAuthorizedUser(prisma, req);

      res.json({
        externalId: user.externalId,
        steamId: user.steamId,
        nickname: user.rustNickname,
        telegramUserId: user.telegramUserId,
        telegramUsername: user.telegramUsername,
        solanaAddress: user.wallet.solanaAddress,
        balanceAtomic: user.wallet.balanceAtomic
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/link', async (req, res, next) => {
    try {
      const { externalId, solanaAddress } = req.body || {};

      if (!solanaAddress) {
        return res.status(400).json({ error: 'solanaAddress required' });
      }

      if (!isValidBase58Address(solanaAddress)) {
        return res.status(400).json({ error: 'INVALID_SOLANA_ADDRESS' });
      }

      const user = await resolveAuthorizedUser(prisma, req, externalId || null);

      const existingWallet = await prisma.wallet.findFirst({
        where: {
          solanaAddress,
          NOT: { userId: user.id }
        }
      });

      if (existingWallet) {
        return res.status(409).json({ error: 'SOLANA_ADDRESS_ALREADY_IN_USE' });
      }

      await prisma.wallet.update({
        where: { userId: user.id },
        data: { solanaAddress }
      });

      res.json({
        ok: true,
        solanaAddress
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/deposit/check', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      const user = await resolveAuthorizedUser(prisma, req, externalId || null);

      if (!user.wallet?.solanaAddress) {
        return res.status(400).json({ error: 'USER_SOLANA_WALLET_NOT_LINKED' });
      }

      const result = await scanAndCreditUserDeposits(prisma, user);

      res.json({
        ok: true,
        balanceAtomic: result.balanceAtomic,
        credited: result.deposits.map((d) => ({
          id: d.id,
          txSignature: d.txSignature,
          amountAtomic: d.amountAtomic
        }))
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/withdraw', async (req, res, next) => {
    try {
      const { externalId, destination: rawDestination, amount } = req.body || {};
      const amountAtomic = parseAtomicAmount(amount, 'amount');

      if (amountAtomic <= 0n) {
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await resolveAuthorizedUser(prisma, req, externalId || null);

      let destination = null;
      if (hasServerKey(req)) {
        destination = rawDestination || user.wallet?.solanaAddress || null;
      } else {
        if (rawDestination && user.wallet?.solanaAddress && rawDestination !== user.wallet.solanaAddress) {
          return res.status(400).json({ error: 'DESTINATION_MUST_MATCH_LINKED_WALLET' });
        }
        destination = user.wallet?.solanaAddress || null;
      }

      if (!destination) {
        return res.status(400).json({ error: 'destination required' });
      }

      if (!isValidBase58Address(destination)) {
        return res.status(400).json({ error: 'INVALID_DESTINATION' });
      }

      const wr = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { userId: user.id }
        });

        if (!wallet) {
          throw new Error('Wallet not found');
        }

        if (BigInt(wallet.balanceAtomic) < amountAtomic) {
          throw Object.assign(new Error('Insufficient funds'), { status: 400 });
        }

        await tx.wallet.update({
          where: { userId: user.id },
          data: {
            balanceAtomic: { decrement: amountAtomic }
          }
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'WITHDRAWAL',
            amountAtomic: amountAtomic * -1n,
            reference: 'withdraw:request'
          }
        });

        return tx.withdrawalRequest.create({
          data: {
            userId: user.id,
            amountAtomic,
            destination,
            status: 'REQUESTED'
          }
        });
      });

      res.json({
        ok: true,
        requestId: wr.id,
        destination
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/profile/:externalId', async (req, res, next) => {
    try {
      if (!hasServerKey(req)) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const user = await prisma.user.findUnique({
        where: { externalId: req.params.externalId },
        include: { wallet: true }
      });

      if (!user || !user.wallet) {
        return res.status(404).json({ error: 'user/wallet not found' });
      }

      res.json({
        externalId: user.externalId,
        steamId: user.steamId,
        nickname: user.rustNickname,
        telegramLinked: Boolean(user.telegramUserId),
        telegramUsername: user.telegramUsername,
        solanaAddress: user.wallet.solanaAddress,
        balanceAtomic: user.wallet.balanceAtomic
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};