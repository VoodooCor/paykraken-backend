const express = require('express');
const { getBlkrValuation } = require('../services/blkrValuationService');

module.exports = () => {
  const router = express.Router();

  router.get('/blkr-valuation', async (req, res, next) => {
    try {
      const amount = req.query.amount
        ? Number(req.query.amount)
        : undefined;

      const force =
        String(req.query.force || '').toLowerCase() === 'true';

      const data = await getBlkrValuation(amount, { force });

      res.json({
        ok: true,
        data
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
};