const express = require('express');
const crypto = require('crypto');
const { ADMIN_API_KEY, SERVER_API_KEY } = require('../config');
const { createAdminAudit } = require('../services/adminAuditService');
const { sendWithdrawalStatusNotification } = require('../utils/telegram');

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function getActorFromRequest(req) {
  const key = req.header('X-Admin-Key') || req.header('X-Server-Key') || '';
  const actorType = req.header('X-Admin-Key') ? 'ADMIN_API_KEY' : 'SERVER_API_KEY';

  return {
    actorType,
    actorId: hashKey(key),
    actorLabel: actorType
  };
}

function requireAdmin(req, res, next) {
  const key = req.header('X-Admin-Key') || req.header('X-Server-Key');

  if (!key || (key !== ADMIN_API_KEY && key !== SERVER_API_KEY)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  req.adminActor = getActorFromRequest(req);
  next();
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

function normalizeOptionalText(value, max = 1000) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeTxSignature(value) {
  return normalizeOptionalText(value, 300);
}

function parseAtomic(value, field = 'amountAtomic') {
  if (value === undefined || value === null || value === '') {
    throw Object.assign(new Error(`${field} required`), { status: 400 });
  }

  const raw = String(value).trim();

  if (!/^-?\d+$/.test(raw)) {
    throw Object.assign(new Error(`${field} must be integer string`), { status: 400 });
  }

  try {
    return BigInt(raw);
  } catch {
    throw Object.assign(new Error(`${field} is invalid`), { status: 400 });
  }
}

function toAdjustmentMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!['set', 'add', 'sub'].includes(mode)) {
    throw Object.assign(new Error('mode must be set/add/sub'), { status: 400 });
  }
  return mode;
}

const ALLOWED_STATUSES = ['REQUESTED', 'APPROVED', 'SENDING', 'SENT', 'REJECTED'];

const ALLOWED_TRANSITIONS = {
  REQUESTED: ['REQUESTED', 'APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  APPROVED: ['APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  SENDING: ['SENDING', 'SENT', 'REJECTED'],
  SENT: ['SENT'],
  REJECTED: ['REJECTED']
};

function buildWithdrawWhereByStatus(status) {
  if (!status || status === 'open') {
    return {
      status: { in: ['REQUESTED', 'APPROVED', 'SENDING'] }
    };
  }

  if (status === 'all') {
    return {};
  }

  if (!ALLOWED_STATUSES.includes(status)) {
    throw Object.assign(new Error('invalid status filter'), { status: 400 });
  }

  return { status };
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/withdrawals', requireAdmin, async (req, res, next) => {
    try {
      const status = String(req.query.status || 'open');
      const where = buildWithdrawWhereByStatus(status);

      const list = await prisma.withdrawalRequest.findMany({
        where,
        include: {
          user: {
            include: {
              wallet: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 200
      });

      res.json({
        ok: true,
        count: list.length,
        withdrawals: list
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/withdrawals/:id/status', requireAdmin, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid withdrawal id' });
      }

      const {
        status,
        txSignature,
        meta,
        rejectReason,
        adminComment
      } = req.body || {};

      if (!ALLOWED_STATUSES.includes(status) || status === 'REQUESTED') {
        return res.status(400).json({ error: 'invalid status' });
      }

      const normalizedRejectReason = normalizeOptionalText(rejectReason, 500);
      const normalizedAdminComment = normalizeOptionalText(adminComment, 2000);
      const normalizedTxSignature = normalizeTxSignature(txSignature);

      if (status === 'REJECTED' && !normalizedRejectReason) {
        return res.status(400).json({
          error: 'rejectReason is required for REJECTED status'
        });
      }

      if (status === 'SENT' && !normalizedTxSignature) {
        return res.status(400).json({
          error: 'txSignature is required for SENT status'
        });
      }

      const actor = req.adminActor;

      const result = await prisma.$transaction(async (tx) => {
        const wr = await tx.withdrawalRequest.findUnique({
          where: { id },
          include: {
            user: {
              include: {
                wallet: true
              }
            }
          }
        });

        if (!wr) {
          throw Object.assign(new Error('withdrawal not found'), { status: 404 });
        }

        const previousStatus = wr.status;
        const previousMeta = asObject(wr.meta);
        const allowed = ALLOWED_TRANSITIONS[previousStatus] || [];

        if (!allowed.includes(status)) {
          throw Object.assign(
            new Error(`invalid transition: ${previousStatus} -> ${status}`),
            { status: 400 }
          );
        }

        const alreadyRefunded =
          previousMeta.refundApplied === true ||
          previousMeta.refunded === true;

        const shouldRefund =
          status === 'REJECTED' &&
          previousStatus !== 'REJECTED' &&
          previousStatus !== 'SENT' &&
          !alreadyRefunded;

        if (shouldRefund) {
          const userWallet = await tx.wallet.findUnique({
            where: { userId: wr.userId }
          });

          if (!userWallet) {
            throw Object.assign(new Error('wallet not found for refund'), { status: 500 });
          }

          await tx.wallet.update({
            where: { userId: wr.userId },
            data: {
              balanceAtomic: { increment: wr.amountAtomic }
            }
          });

          await tx.ledgerEntry.create({
            data: {
              userId: wr.userId,
              type: 'ADJUSTMENT',
              amountAtomic: wr.amountAtomic,
              reference: `withdraw:${wr.id}:refund`,
              meta: {
                reason: 'WITHDRAW_REJECTED',
                rejectReason: normalizedRejectReason || null,
                adminComment: normalizedAdminComment || null,
                refundedBy: actor.actorType,
                refundedAt: new Date().toISOString()
              }
            }
          });
        }

        const statusHistory = Array.isArray(previousMeta.statusHistory)
          ? previousMeta.statusHistory
          : [];

        const historyEntry = {
          at: new Date().toISOString(),
          previousStatus,
          newStatus: status,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          txSignature: normalizedTxSignature,
          rejectReason: normalizedRejectReason,
          adminComment: normalizedAdminComment
        };

        const nextMeta = mergeJson(previousMeta, {
          ...asObject(meta),
          lastAdminActionAt: new Date().toISOString(),
          lastAdminActor: {
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel
          },
          rejectReason:
            status === 'REJECTED'
              ? normalizedRejectReason
              : previousMeta.rejectReason || null,
          adminComment:
            normalizedAdminComment != null
              ? normalizedAdminComment
              : previousMeta.adminComment || null,
          refundApplied: shouldRefund ? true : previousMeta.refundApplied || false,
          refunded: shouldRefund ? true : previousMeta.refunded || false,
          statusHistory: [...statusHistory, historyEntry]
        });

        const updated = await tx.withdrawalRequest.update({
          where: { id },
          data: {
            status,
            txSignature:
              normalizedTxSignature != null
                ? normalizedTxSignature
                : wr.txSignature || undefined,
            processedAt: new Date(),
            meta: nextMeta
          },
          include: {
            user: {
              include: {
                wallet: true
              }
            }
          }
        });

        await createAdminAudit(tx, {
          req,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          action: 'WITHDRAWAL_STATUS_CHANGED',
          targetType: 'WITHDRAWAL',
          targetId: String(updated.id),
          meta: {
            withdrawalId: updated.id,
            userId: updated.userId,
            externalId: updated.user?.externalId || null,
            previousStatus,
            newStatus: status,
            txSignature: normalizedTxSignature,
            refunded: shouldRefund,
            alreadyRefunded,
            amountAtomic: updated.amountAtomic?.toString?.() || String(updated.amountAtomic),
            destination: updated.destination,
            rejectReason: normalizedRejectReason,
            adminComment: normalizedAdminComment,
            requestMetaPatch: meta || null
          }
        });

        return updated;
      });

      let notification = null;

      if (['APPROVED', 'SENT', 'REJECTED'].includes(result.status)) {
        try {
          notification = await sendWithdrawalStatusNotification(result.user, result);
        } catch (notifyError) {
          console.error('Telegram withdrawal notification error:', notifyError);
          notification = {
            ok: false,
            error: notifyError.message || 'notification failed'
          };
        }
      }

      res.json({
        ok: true,
        withdrawal: result,
        notification
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/audit', requireAdmin, async (req, res, next) => {
    try {
      const action = req.query.action ? String(req.query.action) : null;
      const targetType = req.query.targetType ? String(req.query.targetType) : null;
      const targetId = req.query.targetId ? String(req.query.targetId) : null;
      const take = Math.min(Number.parseInt(req.query.take || '100', 10) || 100, 500);

      const where = {};
      if (action) where.action = action;
      if (targetType) where.targetType = targetType;
      if (targetId) where.targetId = targetId;

      const items = await prisma.adminAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take
      });

      res.json({
        ok: true,
        count: items.length,
        items
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/audit/:targetType/:targetId', requireAdmin, async (req, res, next) => {
    try {
      const { targetType, targetId } = req.params;

      const items = await prisma.adminAction.findMany({
        where: {
          targetType: String(targetType),
          targetId: String(targetId)
        },
        orderBy: { createdAt: 'desc' },
        take: 200
      });

      res.json({
        ok: true,
        count: items.length,
        items
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/audit/test', requireAdmin, async (req, res, next) => {
    try {
      const actor = req.adminActor;

      const item = await createAdminAudit(prisma, {
        req,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: 'ADMIN_TEST_ACTION',
        targetType: 'SYSTEM',
        targetId: 'self-test',
        meta: {
          message: 'audit log test ok',
          body: req.body || null
        }
      });

      res.json({
        ok: true,
        item
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/users/find', requireAdmin, async (req, res, next) => {
    try {
      const externalId = String(req.query.externalId || '').trim();
      const steamId = String(req.query.steamId || '').trim();

      if (!externalId && !steamId) {
        return res.status(400).json({
          error: 'externalId or steamId required'
        });
      }

      const where = externalId ? { externalId } : { steamId };

      const user = await prisma.user.findUnique({
        where,
        include: {
          wallet: true
        }
      });

      if (!user) {
        return res.status(404).json({
          error: 'USER_NOT_FOUND'
        });
      }

      res.json({
        ok: true,
        user: {
          id: user.id,
          externalId: user.externalId,
          steamId: user.steamId,
          rustNickname: user.rustNickname,
          telegramUserId: user.telegramUserId,
          telegramUsername: user.telegramUsername,
          wallet: {
            solanaAddress: user.wallet?.solanaAddress || null,
            solanaVerified: user.wallet?.solanaVerified || false,
            balanceAtomic: user.wallet?.balanceAtomic || 0n
          }
        }
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/users/:id/balance', requireAdmin, async (req, res, next) => {
    try {
      const userId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'invalid user id' });
      }

      const mode = toAdjustmentMode(req.body?.mode);
      const amountAtomic = parseAtomic(req.body?.amountAtomic, 'amountAtomic');
      const reason = normalizeOptionalText(req.body?.reason, 500);
      const comment = normalizeOptionalText(req.body?.comment, 2000);

      const actor = req.adminActor;

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          include: { wallet: true }
        });

        if (!user || !user.wallet) {
          throw Object.assign(new Error('user or wallet not found'), { status: 404 });
        }

        const currentBalance = BigInt(user.wallet.balanceAtomic || 0);
        let nextBalance = currentBalance;
        let delta = 0n;

        if (mode === 'set') {
          if (amountAtomic < 0n) {
            throw Object.assign(new Error('set balance cannot be negative'), { status: 400 });
          }
          nextBalance = amountAtomic;
          delta = nextBalance - currentBalance;
        }

        if (mode === 'add') {
          if (amountAtomic <= 0n) {
            throw Object.assign(new Error('add amount must be > 0'), { status: 400 });
          }
          delta = amountAtomic;
          nextBalance = currentBalance + delta;
        }

        if (mode === 'sub') {
          if (amountAtomic <= 0n) {
            throw Object.assign(new Error('sub amount must be > 0'), { status: 400 });
          }
          delta = -amountAtomic;
          nextBalance = currentBalance + delta;

          if (nextBalance < 0n) {
            throw Object.assign(new Error('result balance cannot be negative'), { status: 400 });
          }
        }

        const updatedWallet = await tx.wallet.update({
          where: { userId: user.id },
          data: {
            balanceAtomic: nextBalance
          }
        });

        const ledger = await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'ADJUSTMENT',
            amountAtomic: delta,
            reference: `admin_balance_adjustment:${mode}`,
            meta: {
              mode,
              previousBalance: currentBalance.toString(),
              newBalance: nextBalance.toString(),
              requestedAmountAtomic: amountAtomic.toString(),
              reason: reason || null,
              comment: comment || null,
              actorType: actor.actorType,
              actorId: actor.actorId,
              actorLabel: actor.actorLabel
            }
          }
        });

        await createAdminAudit(tx, {
          req,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          action: 'USER_BALANCE_ADJUSTED',
          targetType: 'USER',
          targetId: String(user.id),
          meta: {
            userId: user.id,
            externalId: user.externalId,
            steamId: user.steamId,
            mode,
            previousBalance: currentBalance.toString(),
            newBalance: nextBalance.toString(),
            delta: delta.toString(),
            requestedAmountAtomic: amountAtomic.toString(),
            reason: reason || null,
            comment: comment || null,
            ledgerEntryId: ledger.id
          }
        });

        return {
          user,
          wallet: updatedWallet,
          ledger
        };
      });

      res.json({
        ok: true,
        user: {
          id: result.user.id,
          externalId: result.user.externalId,
          steamId: result.user.steamId,
          rustNickname: result.user.rustNickname
        },
        wallet: result.wallet,
        ledger: result.ledger
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};