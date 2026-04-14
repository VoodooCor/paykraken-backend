require('dotenv').config();

const { app, prisma } = require('./app');
const { PORT } = require('./config');

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pay Blood Kraken API listening on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.error('Error during Prisma disconnect:', err);
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));