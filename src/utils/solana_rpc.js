const bs58 = require('bs58');
const {
  SOLANA_RPC_URL, BLKR_MINT, MERCHANT_WALLET, MERCHANT_TOKEN_ACCOUNT
} = require('../config');

if (!SOLANA_RPC_URL) {
  console.warn('WARN: SOLANA_RPC_URL is not set');
}

function isValidBase58Address(addr) {
  try {
    const bytes = bs58.decode(addr);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

async function rpcCall(method, params) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Solana RPC HTTP ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(`Solana RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getMerchantTokenAccount() {
  if (MERCHANT_TOKEN_ACCOUNT) return MERCHANT_TOKEN_ACCOUNT;

  const result = await rpcCall('getTokenAccountsByOwner', [
    MERCHANT_WALLET,
    { mint: BLKR_MINT },
    { encoding: 'jsonParsed' }
  ]);
  const list = result?.value || [];
  if (!list.length) {
    throw new Error('Associated token account for BLKR not found for MERCHANT_WALLET. Create ATA or set MERCHANT_TOKEN_ACCOUNT.');
  }
  return list[0].pubkey;
}

async function getSignaturesForAddress(address, limit = 50) {
  const result = await rpcCall('getSignaturesForAddress', [address, { limit }]);
  return result || [];
}

async function getParsedTransaction(signature) {
  const result = await rpcCall('getTransaction', [signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  }]);
  return result;
}

module.exports = {
  isValidBase58Address,
  getMerchantTokenAccount,
  getSignaturesForAddress,
  getParsedTransaction
};