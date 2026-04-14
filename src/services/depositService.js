const {
  getMerchantTokenAccount,
  getSignaturesForAddress,
  getParsedTransaction
} = require('../utils/solana_rpc');
const { BLKR_MINT } = require('../config');

function accountPubkeyByIndex(parsedTx, idx) {
  const ak = parsedTx?.transaction?.message?.accountKeys?.[idx];
  if (!ak) return null;

  if (typeof ak === 'string') return ak;

  if (typeof ak === 'object') {
    if (ak.pubkey) return ak.pubkey;
    if (typeof ak.toString === 'function') return ak.toString();
  }

  return null;
}

function parseDepositFromParsedTx(parsedTx, merchantTokenAccount) {
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

  const afterAmt = BigInt(after.uiTokenAmount?.amount || '0');
  const beforeAmt = BigInt(before?.uiTokenAmount?.amount || '0');
  const diff = afterAmt - beforeAmt;

  if (diff <= 0n) return null;

  let sourceOwner = null;

  for (const p of pre) {
    const postMatch = post.find((x) => x.accountIndex === p.accountIndex);
    if (!postMatch) continue;

    if (BLKR_MINT && (p.mint !== BLKR_MINT || postMatch.mint !== BLKR_MINT)) {
      continue;
    }

    const delta =
      BigInt(postMatch.uiTokenAmount?.amount || '0') -
      BigInt(p.uiTokenAmount?.amount || '0');

    if (delta < 0n) {
      sourceOwner = p.owner || null;
      break;
    }
  }

  return {
    amountAtomic: diff,
    sourceOwner
  };
}

async function scanAndCreditUserDeposits(prisma, user) {
  if (!user?.wallet?.solanaAddress) {
    throw new Error('User has no linked Solana address');
  }

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

    if (!info.sourceOwner || info.sourceOwner !== user.wallet.solanaAddress) {
      continue;
    }

    const amountAtomic = BigInt(info.amountAtomic);

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
          sourceAddress: info.sourceOwner,
          detectedAt: new Date(),
          confirmedAt: new Date(),
          meta: {
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
            sourceOwner: info.sourceOwner
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