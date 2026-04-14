const express = require('express');
const { ADMIN_API_KEY, SERVER_API_KEY } = require('../config');

function requireAdmin(req, res, next) {
  const key = req.header('X-Admin-Key') || req.header('X-Server-Key');
  if (!key || (key !== ADMIN_API_KEY && key !== SERVER_API_KEY)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
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

const ALLOWED_TRANSITIONS = {
  REQUESTED: ['REQUESTED', 'APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  APPROVED: ['APPROVED', 'SENDING', 'SENT', 'REJECTED'],
  SENDING: ['SENDING', 'SENT', 'REJECTED'],
  SENT: ['SENT'],
  REJECTED: ['REJECTED']
};

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/withdrawals', requireAdmin, async (_req, res, next) => {
    try {
      const list = await prisma.withdrawalRequest.findMany({
        where: {
          status: { in: ['REQUESTED', 'APPROVED', 'SENDING'] }
        },
        include: {
          user: {
            include: {
              wallet: true
            }
          }
        },
        orderBy: { createdAt: 'asc' },
        take: 100
      });

      res.json({ withdrawals: list });
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

      const { status, txSignature, meta } = req.body || {};
      if (!['APPROVED', 'SENDING', 'SENT', 'REJECTED'].includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const wr = await tx.withdrawalRequest.findUnique({
          where: { id }
        });

        if (!wr) {
          throw Object.assign(new Error('withdrawal not found'), { status: 404 });
        }

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
                reason: 'WITHDRAW_REJECTED'
              }
            }
          });
        }

        return tx.withdrawalRequest.update({
          where: { id },
          data: {
            status,
            txSignature: txSignature || undefined,
            processedAt: new Date(),
            meta: mergeJson(wr.meta, meta || {})
          }
        });
      });

      res.json({
        ok: true,
        withdrawal: result
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};