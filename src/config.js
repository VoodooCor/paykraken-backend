const PORT = Number(process.env.PORT || 8080);

const SERVER_API_KEY = process.env.SERVER_API_KEY || 'change-me-very-secret';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || SERVER_API_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const TELEGRAM_MINI_APP_URL =
  process.env.TELEGRAM_MINI_APP_URL ||
  (TELEGRAM_BOT_USERNAME ? `https://t.me/${TELEGRAM_BOT_USERNAME}/app?startapp=link` : '');
const TELEGRAM_AUTH_MAX_AGE_SECONDS = Number(
  process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400
);

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || '';
const BLKR_MINT = process.env.BLKR_MINT || '';
const BLKR_DECIMALS = parseInt(process.env.BLKR_DECIMALS || '9', 10);
const MERCHANT_WALLET =
  process.env.MERCHANT_WALLET || 'Fzt7CcgxXeuKzf9jHR8FCpnepdujSbtT1fmWGHqWA5FT';
const MERCHANT_TOKEN_ACCOUNT = process.env.MERCHANT_TOKEN_ACCOUNT || '';

const ALLOW_MANUAL_WALLET_LINK = String(
  process.env.ALLOW_MANUAL_WALLET_LINK || 'false'
).toLowerCase() === 'true';

module.exports = {
  PORT,
  SERVER_API_KEY,
  ADMIN_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  TELEGRAM_MINI_APP_URL,
  TELEGRAM_AUTH_MAX_AGE_SECONDS,
  SOLANA_RPC_URL,
  BLKR_MINT,
  BLKR_DECIMALS,
  MERCHANT_WALLET,
  MERCHANT_TOKEN_ACCOUNT,
  ALLOW_MANUAL_WALLET_LINK
};