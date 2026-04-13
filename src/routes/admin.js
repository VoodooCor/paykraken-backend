const express = require('express');
const { SERVER_API_KEY } = require('../config');

function requireAdmin(req, res, next) {
  const key = req.header('X-Admin-Key') || req.header('X-Server-Key');
  if (!key || key !== SERVER_API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.get('/withdrawals', requireAdmin, async (_req, res, next) => {
    try {
      const list = await prisma.withdrawalRequest.findMany({
        where: { status: { in: ['REQUESTED', 'APPROVED', 'SENDING'] } },
        orderBy: { createdAt: 'asc' },
        take: 100
      });
      res.json({ withdrawals: list });
    } catch (e) { next(e); }
  });

  router.post('/withdrawals/:id/status', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { status, txSignature, meta } = req.body || {};
      if (!['APPROVED', 'SENDING', 'SENT', 'REJECTED'].includes(status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      const upd = await prisma.withdrawalRequest.update({
        where: { id },
        data: { status, txSignature: txSignature || undefined, processedAt: new Date(), meta: meta || undefined }
      });
      res.json({ ok: true, withdrawal: upd });
    } catch (e) { next(e); }
  });

  return router;
};