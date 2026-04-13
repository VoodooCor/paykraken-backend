const express = require('express');
const rust = require('./rust');
const telegram = require('./telegram');
const wallet = require('./wallet');
const market = require('./market');
const admin = require('./admin');

module.exports = ({ prisma }) => {
  const router = express.Router();

  router.use('/rust', rust({ prisma }));
  router.use('/telegram', telegram({ prisma }));
  router.use('/wallet', wallet({ prisma }));
  router.use('/market', market({ prisma }));
  router.use('/admin', admin({ prisma }));

  return router;
};