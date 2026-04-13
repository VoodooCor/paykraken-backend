const PORT = process.env.PORT || 8080;
const SERVER_API_KEY = process.env.SERVER_API_KEY || 'change-me-very-secret';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || '';
const BLKR_MINT = process.env.BLKR_MINT || '';
const BLKR_DECIMALS = parseInt(process.env.BLKR_DECIMALS || '9', 10);
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || '';
const MERCHANT_TOKEN_ACCOUNT = process.env.MERCHANT_TOKEN_ACCOUNT || '';

module.exports = {
  PORT,
  SERVER_API_KEY,
  TELEGRAM_BOT_TOKEN,
  SOLANA_RPC_URL,
  BLKR_MINT,
  BLKR_DECIMALS,
  MERCHANT_WALLET,
  MERCHANT_TOKEN_ACCOUNT
};