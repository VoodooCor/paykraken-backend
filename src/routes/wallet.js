const express = require('express');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { TextEncoder } = require('util');
const { PublicKey } = require('@solana/web3.js');
const { validateTelegramInitData } = require('../utils/telegramAuth');
const { scanAndCreditUserDeposits } = require('../services/depositService');
const { getMerchantTokenAccount } = require('../utils/solana_rpc');
const {
  TELEGRAM_BOT_TOKEN,
  MERCHANT_WALLET,
  ALLOW_MANUAL_WALLET_LINK,
  BLKR_DECIMALS
} = require('../config');

const NONCE_TTL_MS = 10 * 60 * 1000;
const MIN_WITHDRAW_ATOMIC = 10n ** BigInt(BLKR_DECIMALS); // 1 BLKR

function getTelegramInitData(req) {
  return (
    req.headers['x-telegram-init-data'] ||
    req.body?.initData ||
    req.query?.initData ||
    ''
  );
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'string') {
    throw Object.assign(new Error('Wallet address is required'), { status: 400 });
  }

  try {
    const pubkey = new PublicKey(address.trim());
    return pubkey.toBase58();
  } catch {
    throw Object.assign(new Error('Invalid Solana wallet address'), { status: 400 });
  }
}

function buildWalletLinkMessage({ externalId, telegramUserId, nonce }) {
  return [
    'Pay Blood Kraken wallet link',
    `External ID: ${externalId}`,
    `Telegram User ID: ${telegramUserId}`,
    `Nonce: ${nonce}`,
    'Sign this message to confirm ownership of this Solana wallet.',
    'Only sign this message inside the official Pay Blood Kraken app.'
  ].join('\n');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toPublicWithdrawal(withdrawal) {
  const meta = asObject(withdrawal?.meta);

  return {
    id: withdrawal.id,
    amountAtomic: withdrawal.amountAtomic,
    destination: withdrawal.destination,
    status: withdrawal.status,
    txSignature: withdrawal.txSignature,
    createdAt: withdrawal.createdAt,
    processedAt: withdrawal.processedAt,
    meta: {
      rejectReason: meta.rejectReason || null
    }
  };
}

function parseAtomicAmount(value, fieldName = 'amountAtomic') {
  if (value === undefined || value === null || value === '') {
    throw Object.assign(new Error(`${fieldName} is required`), { status: 400 });
  }

  const raw = String(value).trim();

  if (!/^\d+$/.test(raw)) {
    throw Object.assign(
      new Error(`${fieldName} must be a positive integer string`),
      { status: 400 }
    );
  }

  let parsed;
  try {
    parsed = BigInt(raw);
  } catch {
    throw Object.assign(
      new Error(`${fieldName} is too large or invalid`),
      { status: 400 }
    );
  }

  if (parsed <= 0n) {
    throw Object.assign(new Error(`${fieldName} must be > 0`), { status: 400 });
  }

  return parsed;
}

async function getAuthorizedUser(prisma, req, externalId) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is not configured'), { status: 500 });
  }

  if (!externalId || typeof externalId !== 'string') {
    throw Object.assign(new Error('externalId is required'), { status: 400 });
  }

  const initData = getTelegramInitData(req);
  const { telegramUser } = validateTelegramInitData(initData, TELEGRAM_BOT_TOKEN);

  const user = await prisma.user.findUnique({
    where: { externalId: externalId.trim() },
    include: { wallet: true }
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  if (!user.telegramUserId) {
    throw Object.assign(new Error('Telegram is not linked to this account'), { status: 403 });
  }

  if (String(user.telegramUserId) !== String(telegramUser.id)) {
    throw Object.assign(
      new Error('This Telegram account cannot manage the selected externalId'),
      { status: 403 }
    );
  }

  if (!user.wallet) {
    throw Object.assign(new Error('Wallet record not found'), { status: 500 });
  }

  return { appUser: user, telegramUser };
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/profile/:externalId', async (req, res, next) => {
    try {
      const { appUser } = await getAuthorizedUser(prisma, req, req.params.externalId);
      const merchantTokenAccount = await getMerchantTokenAccount();

      const deposits = await prisma.deposit.findMany({
        where: { userId: appUser.id },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      const withdrawalsRaw = await prisma.withdrawalRequest.findMany({
        where: { userId: appUser.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          amountAtomic: true,
          destination: true,
          status: true,
          txSignature: true,
          createdAt: true,
          processedAt: true,
          meta: true
        }
      });

      const withdrawals = withdrawalsRaw.map(toPublicWithdrawal);

      res.json({
        ok: true,
        profile: {
          externalId: appUser.externalId,
          steamId: appUser.steamId,
          nickname: appUser.rustNickname,
          telegramUserId: appUser.telegramUserId,
          telegramUsername: appUser.telegramUsername,
          solanaAddress: appUser.wallet?.solanaAddress || null,
          solanaVerified: appUser.wallet?.solanaVerified || false,
          walletVerifiedAt: appUser.wallet?.walletVerifiedAt || null,
          balanceAtomic: appUser.wallet?.balanceAtomic || 0n,
          merchantWallet: MERCHANT_WALLET,
          merchantTokenAccount,
          allowManualWalletLink: ALLOW_MANUAL_WALLET_LINK
        },
        deposits,
        withdrawals
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/nonce', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      const { appUser, telegramUser } = await getAuthorizedUser(prisma, req, externalId);

      const nonce = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

      await prisma.wallet.update({
        where: { userId: appUser.id },
        data: {
          walletNonce: nonce,
          walletNonceExpiresAt: expiresAt
        }
      });

      const message = buildWalletLinkMessage({
        externalId: appUser.externalId,
        telegramUserId: String(telegramUser.id),
        nonce
      });

      res.json({
        ok: true,
        nonce,
        expiresAt,
        message
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/link/manual', async (req, res, next) => {
    try {
      if (!ALLOW_MANUAL_WALLET_LINK) {
        return res.status(403).json({
          ok: false,
          error: 'Manual wallet linking is disabled'
        });
      }

      const { externalId, address } = req.body || {};
      const { appUser } = await getAuthorizedUser(prisma, req, externalId);
      const normalizedAddress = normalizeAddress(address);

      const existing = await prisma.wallet.findFirst({
        where: { solanaAddress: normalizedAddress }
      });

      if (existing && existing.userId !== appUser.id) {
        return res.status(409).json({
          ok: false,
          error: 'This wallet is already linked to another account'
        });
      }

      const updated = await prisma.wallet.update({
        where: { userId: appUser.id },
        data: {
          solanaAddress: normalizedAddress,
          solanaVerified: false,
          walletVerifiedAt: null,
          walletNonce: null,
          walletNonceExpiresAt: null
        }
      });

      res.json({
        ok: true,
        mode: 'manual',
        wallet: updated
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/link', async (req, res, next) => {
    try {
      const { externalId, address, signatureBase64 } = req.body || {};
      const { appUser, telegramUser } = await getAuthorizedUser(prisma, req, externalId);
      const normalizedAddress = normalizeAddress(address);

      if (!signatureBase64 || typeof signatureBase64 !== 'string') {
        return res.status(400).json({
          ok: false,
          error: 'signatureBase64 is required'
        });
      }

      const wallet = await prisma.wallet.findUnique({
        where: { userId: appUser.id }
      });

      if (!wallet?.walletNonce || !wallet?.walletNonceExpiresAt) {
        return res.status(400).json({
          ok: false,
          error: 'Wallet nonce was not requested'
        });
      }

      if (new Date(wallet.walletNonceExpiresAt).getTime() < Date.now()) {
        return res.status(400).json({
          ok: false,
          error: 'Wallet nonce expired'
        });
      }

      const existing = await prisma.wallet.findFirst({
        where: { solanaAddress: normalizedAddress }
      });

      if (existing && existing.userId !== appUser.id) {
        return res.status(409).json({
          ok: false,
          error: 'This wallet is already linked to another account'
        });
      }

      const message = buildWalletLinkMessage({
        externalId: appUser.externalId,
        telegramUserId: String(telegramUser.id),
        nonce: wallet.walletNonce
      });

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(signatureBase64, 'base64');
      const publicKey = new PublicKey(normalizedAddress);

      const verified = nacl.sign.detached.verify(
        messageBytes,
        new Uint8Array(signatureBytes),
        new Uint8Array(publicKey.toBytes())
      );

      if (!verified) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid wallet signature'
        });
      }

      const updated = await prisma.wallet.update({
        where: { userId: appUser.id },
        data: {
          solanaAddress: normalizedAddress,
          solanaVerified: true,
          walletVerifiedAt: new Date(),
          walletNonce: null,
          walletNonceExpiresAt: null
        }
      });

      res.json({
        ok: true,
        mode: 'signed',
        wallet: updated
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/link', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      const { appUser } = await getAuthorizedUser(prisma, req, externalId);

      const updated = await prisma.wallet.update({
        where: { userId: appUser.id },
        data: {
          solanaAddress: null,
          solanaVerified: false,
          walletVerifiedAt: null,
          walletNonce: null,
          walletNonceExpiresAt: null
        }
      });

      res.json({
        ok: true,
        wallet: updated
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/deposit/check', async (req, res, next) => {
    try {
      const { externalId } = req.body || {};
      const { appUser } = await getAuthorizedUser(prisma, req, externalId);

      const user = await prisma.user.findUnique({
        where: { id: appUser.id },
        include: { wallet: true }
      });

      const result = await scanAndCreditUserDeposits(prisma, user);

      res.json({
        ok: true,
        creditedCount: result.deposits.length,
        deposits: result.deposits,
        balanceAtomic: result.balanceAtomic
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/withdraw', async (req, res, next) => {
    try {
      const { externalId, amountAtomic } = req.body || {};
      const { appUser } = await getAuthorizedUser(prisma, req, externalId);

      const wallet = await prisma.wallet.findUnique({
        where: { userId: appUser.id }
      });

      if (!wallet?.solanaAddress) {
        return res.status(400).json({
          ok: false,
          error: 'Solana wallet is not linked'
        });
      }

      if (!wallet?.solanaVerified) {
        return res.status(400).json({
          ok: false,
          error: 'Solana wallet is not verified'
        });
      }

      const amount = parseAtomicAmount(amountAtomic, 'amountAtomic');

      if (amount < MIN_WITHDRAW_ATOMIC) {
        return res.status(400).json({
          ok: false,
          error: 'Minimum withdraw is 1 BLKR'
        });
      }

      if (wallet.solanaAddress === MERCHANT_WALLET) {
        return res.status(400).json({
          ok: false,
          error: 'Withdraw to merchant wallet is not allowed'
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const freshWallet = await tx.wallet.findUnique({
          where: { userId: appUser.id }
        });

        if (!freshWallet) {
          throw Object.assign(new Error('Wallet not found'), { status: 500 });
        }

        if (BigInt(freshWallet.balanceAtomic) < amount) {
          throw Object.assign(new Error('Insufficient funds'), { status: 400 });
        }

        await tx.wallet.update({
          where: { userId: appUser.id },
          data: {
            balanceAtomic: { decrement: amount }
          }
        });

        await tx.ledgerEntry.create({
          data: {
            userId: appUser.id,
            type: 'WITHDRAWAL',
            amountAtomic: amount * -1n,
            reference: 'withdraw:request',
            txSignature: null,
            meta: {
              destination: freshWallet.solanaAddress
            }
          }
        });

        const withdrawal = await tx.withdrawalRequest.create({
          data: {
            userId: appUser.id,
            amountAtomic: amount,
            destination: freshWallet.solanaAddress,
            status: 'REQUESTED',
            meta: {
              requestedFrom: 'miniapp',
              requestedAt: new Date().toISOString(),
              statusHistory: [
                {
                  at: new Date().toISOString(),
                  previousStatus: null,
                  newStatus: 'REQUESTED',
                  actorType: 'USER',
                  actorId: String(appUser.telegramUserId || ''),
                  actorLabel: appUser.telegramUsername || appUser.externalId || 'user',
                  txSignature: null,
                  rejectReason: null,
                  adminComment: null
                }
              ]
            }
          }
        });

        const updatedWallet = await tx.wallet.findUnique({
          where: { userId: appUser.id }
        });

        return {
          withdrawal,
          wallet: updatedWallet
        };
      });

      res.json({
        ok: true,
        message: 'Withdrawal request created',
        withdrawal: {
          id: result.withdrawal.id,
          amountAtomic: result.withdrawal.amountAtomic,
          destination: result.withdrawal.destination,
          status: result.withdrawal.status,
          createdAt: result.withdrawal.createdAt
        },
        balanceAtomic: result.wallet?.balanceAtomic || 0n
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};