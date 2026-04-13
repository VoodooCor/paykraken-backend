const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { bigintJsonMiddleware } = require('./utils/bigint');
const routes = require('./routes');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(bigintJsonMiddleware);

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api', routes({ prisma }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

module.exports = { app, prisma };