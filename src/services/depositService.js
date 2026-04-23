const {
  getMerchantTokenAccount,
  getSignaturesForAddress,
  getParsedTransaction
} = require('../utils/solana_rpc');
const { BLKR_MINT } = require('../config');

function normalizePubkey(value) {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    if (typeof value.pubkey === 'string') return value.pubkey;
    if (value.pubkey && typeof value.pubkey.toString === 'function') {
      return value.pubkey.toString();
    }
    if (typeof value.toString === 'function') {
      return value.toString();
    }
  }

  return null;
}

function accountPubkeyByIndex(parsedTx, idx) {
  const ak = parsedTx?.transaction?.message?.accountKeys?.[idx];
  return normalizePubkey(ak);
}

function getTokenAmountAtomic(tokenAmount) {
  const raw = tokenAmount?.amount;
  if (raw === undefined || raw === null) return 0n;
  return BigInt(String(raw));
}

function extractDepositFromInstructions(parsedTx, merchantTokenAccount) {
  const instructions = parsedTx?.transaction?.message?.instructions || [];

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed || parsed.type !== 'transferChecked') continue;

    const info = parsed.info || {};
    const mint = normalizePubkey(info.mint);
    const destination = normalizePubkey(info.destination);
    const source = normalizePubkey(info.source);
    const authority = normalizePubkey(info.authority || info.owner);
    const tokenAmount = info.tokenAmount || {};

    if (BLKR_MINT && mint !== BLKR_MINT) continue;
    if (destination !== merchantTokenAccount) continue;

    const amountAtomic = getTokenAmountAtomic(tokenAmount);
    if (amountAtomic <= 0n) continue;

    return {
      amountAtomic,
      sourceTokenAccount: source,
      sourceOwner: authority,
      parser: 'instruction.transferChecked'
    };
  }

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed || parsed.type !== 'transfer') continue;

    const info = parsed.info || {};
    const mint = normalizePubkey(info.mint);
    const destination = normalizePubkey(info.destination);
    const source = normalizePubkey(info.source);
    const authority = normalizePubkey(info.authority || info.owner);
    const amountRaw = info.amount;

    if (BLKR_MINT && mint && mint !== BLKR_MINT) continue;
    if (destination !== merchantTokenAccount) continue;

    const amountAtomic = amountRaw ? BigInt(String(amountRaw)) : 0n;
    if (amountAtomic <= 0n) continue;

    return {
      amountAtomic,
      sourceTokenAccount: source,
      sourceOwner: authority,
      parser: 'instruction.transfer'
    };
  }

  return null;
}

function parseDepositFromBalanceDiff(parsedTx, merchantTokenAccount) {
  const meta = parsedTx?.meta;
  if (!meta) return null;

  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];

  const before = pre.find(
    (b) =>
      accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount &&
      (!BLKR_MINT || b.mint === BLKR_MINT)
  );

  const after = post.find(
    (b) =>
      accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount &&
      (!BLKR_MINT || b.mint === BLKR_MINT)
  );

  if (!after) return null;

  const afterAmt = getTokenAmountAtomic(after.uiTokenAmount);
  const beforeAmt = getTokenAmountAtomic(before?.uiTokenAmount);
  const diff = afterAmt - beforeAmt;

  if (diff <= 0n) return null;

  let sourceOwner = null;
  let sourceTokenAccount = null;

  for (const p of pre) {
    const postMatch = post.find((x) => x.accountIndex === p.accountIndex);
    if (!postMatch) continue;

    if (BLKR_MINT && (p.mint !== BLKR_MINT || postMatch.mint !== BLKR_MINT)) {
      continue;
    }

    const delta =
      getTokenAmountAtomic(postMatch.uiTokenAmount) -
      getTokenAmountAtomic(p.uiTokenAmount);

    if (delta < 0n) {
      sourceOwner = normalizePubkey(p.owner) || null;
      sourceTokenAccount = accountPubkeyByIndex(parsedTx, p.accountIndex);
      break;
    }
  }

  return {
    amountAtomic: diff,
    sourceOwner,
    sourceTokenAccount,
    parser: 'balanceDiff'
  };
}

function extractRealSenderAddresses(parsedTx) {
  const result = new Set();

  const signerKeys = parsedTx?.transaction?.message?.accountKeys || [];
  for (const key of signerKeys) {
    const normalized = normalizePubkey(key);
    if (normalized) result.add(normalized);
    if (key && typeof key === 'object' && key.signer && normalized) {
      result.add(normalized);
    }
  }

  const pre = parsedTx?.meta?.preTokenBalances || [];
  const post = parsedTx?.meta?.postTokenBalances || [];

  for (const item of [...pre, ...post]) {
    const owner = normalizePubkey(item?.owner);
    if (owner) result.add(owner);
  }

  return result;
}

function parseDepositFromParsedTx(parsedTx, merchantTokenAccount) {
  const byInstruction = extractDepositFromInstructions(parsedTx, merchantTokenAccount);
  if (byInstruction) return byInstruction;

  const byDiff = parseDepositFromBalanceDiff(parsedTx, merchantTokenAccount);
  if (byDiff) return byDiff;

  return null;
}

async function scanAndCreditUserDeposits(prisma, user) {
  if (!user?.wallet?.solanaAddress) {
    throw new Error('User has no linked Solana address');
  }

  const userWallet = String(user.wallet.solanaAddress);
  const merchantAta = await getMerchantTokenAccount();
  const sigs = await getSignaturesForAddress(merchantAta, 50);
  const created = [];

  for (const s of sigs) {
    const sig = s.signature;
    if (!sig || s.err) continue;

    const existingGlobal = await prisma.deposit.findUnique({
      where: { txSignature: sig }
    });
    if (existingGlobal) continue;

    const parsed = await getParsedTransaction(sig);
    if (!parsed) continue;

    const info = parseDepositFromParsedTx(parsed, merchantAta);
    if (!info) continue;

    const possibleSenders = extractRealSenderAddresses(parsed);

    const matchesUser =
      (info.sourceOwner && String(info.sourceOwner) === userWallet) ||
      possibleSenders.has(userWallet);

    if (!matchesUser) {
      continue;
    }

    const amountAtomic = BigInt(String(info.amountAtomic || '0'));
    if (amountAtomic <= 0n) continue;

    const dep = await prisma.$transaction(async (tx) => {
      const exists = await tx.deposit.findUnique({
        where: { txSignature: sig }
      });

      if (exists) return null;

      const createdDep = await tx.deposit.create({
        data: {
          userId: user.id,
          status: 'CONFIRMED',
          txSignature: sig,
          amountAtomic,
          sourceAddress: info.sourceOwner || userWallet,
          detectedAt: new Date(),
          confirmedAt: new Date(),
          meta: {
            parser: info.parser,
            sourceOwner: info.sourceOwner || null,
            sourceTokenAccount: info.sourceTokenAccount || null,
            rpc: {
              slot: parsed.slot,
              blockTime: parsed.blockTime || null
            }
          }
        }
      });

      await tx.wallet.update({
        where: { userId: user.id },
        data: {
          balanceAtomic: { increment: amountAtomic }
        }
      });

      await tx.ledgerEntry.create({
        data: {
          userId: user.id,
          type: 'DEPOSIT',
          amountAtomic,
          reference: `deposit:${createdDep.id}`,
          txSignature: sig,
          meta: {
            parser: info.parser,
            sourceOwner: info.sourceOwner || null,
            sourceTokenAccount: info.sourceTokenAccount || null
          }
        }
      });

      return tx.deposit.update({
        where: { id: createdDep.id },
        data: {
          status: 'CREDITED',
          creditedAt: new Date()
        }
      });
    });

    if (dep) {
      created.push(dep);
    }
  }

  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.id }
  });

  return {
    deposits: created,
    balanceAtomic: wallet.balanceAtomic
  };
}

module.exports = { scanAndCreditUserDeposits };