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

function collectAllParsedInstructions(parsedTx) {
  const result = [];

  const outer = parsedTx?.transaction?.message?.instructions || [];
  for (const ix of outer) {
    result.push(ix);
  }

  const innerGroups = parsedTx?.meta?.innerInstructions || [];
  for (const group of innerGroups) {
    for (const ix of group.instructions || []) {
      result.push(ix);
    }
  }

  return result;
}

function getOwnerByTokenAccountFromBalances(parsedTx, tokenAccount) {
  if (!tokenAccount) return null;

  const balances = [
    ...(parsedTx?.meta?.preTokenBalances || []),
    ...(parsedTx?.meta?.postTokenBalances || [])
  ];

  for (const b of balances) {
    const acc = accountPubkeyByIndex(parsedTx, b.accountIndex);
    if (acc === tokenAccount) {
      return normalizePubkey(b.owner) || null;
    }
  }

  return null;
}

function extractDepositCandidates(parsedTx, merchantTokenAccount) {
  const instructions = collectAllParsedInstructions(parsedTx);
  const candidates = [];

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed) continue;

    if (parsed.type === 'transferChecked') {
      const info = parsed.info || {};
      const mint = normalizePubkey(info.mint);
      const destination = normalizePubkey(info.destination);
      const source = normalizePubkey(info.source);
      const authority = normalizePubkey(info.authority || info.owner);
      const amountAtomic = getTokenAmountAtomic(info.tokenAmount);

      if (destination !== merchantTokenAccount) continue;
      if (BLKR_MINT && mint !== BLKR_MINT) continue;
      if (amountAtomic <= 0n) continue;

      candidates.push({
        parser: 'instruction.transferChecked',
        mint,
        amountAtomic,
        sourceTokenAccount: source,
        sourceOwner: authority || getOwnerByTokenAccountFromBalances(parsedTx, source)
      });
    }

    if (parsed.type === 'transfer') {
      const info = parsed.info || {};
      const mint = normalizePubkey(info.mint);
      const destination = normalizePubkey(info.destination);
      const source = normalizePubkey(info.source);
      const authority = normalizePubkey(info.authority || info.owner);
      const amountRaw = info.amount;
      const amountAtomic = amountRaw ? BigInt(String(amountRaw)) : 0n;

      if (destination !== merchantTokenAccount) continue;
      if (BLKR_MINT && mint && mint !== BLKR_MINT) continue;
      if (amountAtomic <= 0n) continue;

      candidates.push({
        parser: 'instruction.transfer',
        mint: mint || BLKR_MINT || null,
        amountAtomic,
        sourceTokenAccount: source,
        sourceOwner: authority || getOwnerByTokenAccountFromBalances(parsedTx, source)
      });
    }
  }

  return candidates;
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

    const candidates = extractDepositCandidates(parsed, merchantAta);

    let info =
      candidates.find((c) => c.sourceOwner && String(c.sourceOwner) === userWallet) || null;

    if (!info) {
      const fallback = parseDepositFromBalanceDiff(parsed, merchantAta);
      if (fallback && fallback.sourceOwner && String(fallback.sourceOwner) === userWallet) {
        info = fallback;
      }
    }

    if (!info) continue;

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