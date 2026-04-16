const express = require('express');
const crypto = require('crypto');
const { ADMIN_API_KEY, SERVER_API_KEY } = require('../config');
const { createAdminAudit } = require('../services/adminAuditService');

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

const ALLOWED_TRANSITIONS = {
  REQUESTED: ['REQUESTED', 'APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  APPROVED: ['APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  SENDING: ['SENDING', 'SENT', 'REJECTED'],
  SENT: ['SENT'],
  REJECTED: ['REJECTED']
};

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/withdrawals', requireAdmin, async (req, res, next) => {
    try {
      const status = req.query.status || 'open';

      let where = {};
      if (status === 'open') {
        where = {
          status: { in: ['REQUESTED', 'APPROVED', 'SENDING'] }
        };
      } else if (status === 'all') {
        where = {};
      } else {
        where = { status };
      }

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

      if (!['APPROVED', 'SENDING', 'SENT', 'REJECTED'].includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }

      const normalizedRejectReason = normalizeOptionalText(rejectReason, 500);
      const normalizedAdminComment = normalizeOptionalText(adminComment, 2000);

      if (status === 'REJECTED' && !normalizedRejectReason) {
        return res.status(400).json({
          error: 'rejectReason is required for REJECTED status'
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
        const allowed = ALLOWED_TRANSITIONS[wr.status] || [];

        if (!allowed.includes(status)) {
          throw Object.assign(
            new Error(`invalid transition: ${wr.status} -> ${status}`),
            { status: 400 }
          );
        }

        const shouldRefund =
          status === 'REJECTED' &&
          wr.status !== 'REJECTED' &&
          wr.status !== 'SENT';

        if (shouldRefund) {
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
                adminComment: normalizedAdminComment || null
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
          txSignature: txSignature || null,
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
          statusHistory: [...statusHistory, historyEntry]
        });

        const updated = await tx.withdrawalRequest.update({
          where: { id },
          data: {
            status,
            txSignature: txSignature || undefined,
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
            txSignature: txSignature || null,
            refunded: shouldRefund,
            amountAtomic: updated.amountAtomic?.toString?.() || String(updated.amountAtomic),
            destination: updated.destination,
            rejectReason: normalizedRejectReason,
            adminComment: normalizedAdminComment,
            requestMetaPatch: meta || null
          }
        });

        return updated;
      });

      res.json({
        ok: true,
        withdrawal: result
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/audit', requireAdmin, async (req, res, next) => {
    try {
      const action = req.query.action || null;
      const targetType = req.query.targetType || null;
      const targetId = req.query.targetId || null;
      const take = Math.min(Number.parseInt(req.query.take || '100', 10) || 100, 500);

      const where = {};
      if (action) where.action = action;
      if (targetType) where.targetType = targetType;
      if (targetId) where.targetId = String(targetId);

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
          targetType,
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

  return router;
};