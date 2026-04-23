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

function logTxDebug(sig, parsedTx, merchantTokenAccount) {
  try {
    console.log('--- DEPOSIT DEBUG START ---');
    console.log('signature:', sig);
    console.log('merchantTokenAccount:', merchantTokenAccount);
    console.log('BLKR_MINT:', BLKR_MINT);
    console.log('slot:', parsedTx?.slot);
    console.log('blockTime:', parsedTx?.blockTime);

    const instructions = parsedTx?.transaction?.message?.instructions || [];
    console.log('instructionCount:', instructions.length);

    instructions.forEach((ix, idx) => {
      console.log(`instruction[${idx}] program:`, ix?.program || ix?.programId || null);
      console.log(`instruction[${idx}] parsed:`, JSON.stringify(ix?.parsed || null, null, 2));
    });

    const pre = parsedTx?.meta?.preTokenBalances || [];
    const post = parsedTx?.meta?.postTokenBalances || [];

    console.log('preTokenBalances:', JSON.stringify(pre, null, 2));
    console.log('postTokenBalances:', JSON.stringify(post, null, 2));

    const merchantPre = pre.find(
      (b) =>
        accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount &&
        (!BLKR_MINT || b.mint === BLKR_MINT)
    );

    const merchantPost = post.find(
      (b) =>
        accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount &&
        (!BLKR_MINT || b.mint === BLKR_MINT)
    );

    console.log('merchantPre:', JSON.stringify(merchantPre || null, null, 2));
    console.log('merchantPost:', JSON.stringify(merchantPost || null, null, 2));

    const preAmt = getTokenAmountAtomic(merchantPre?.uiTokenAmount);
    const postAmt = getTokenAmountAtomic(merchantPost?.uiTokenAmount);
    console.log('merchantPreAtomic:', preAmt.toString());
    console.log('merchantPostAtomic:', postAmt.toString());
    console.log('merchantDiffAtomic:', (postAmt - preAmt).toString());

    console.log('--- DEPOSIT DEBUG END ---');
  } catch (e) {
    console.error('DEPOSIT DEBUG LOG ERROR:', e);
  }
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

    console.log('transferChecked candidate:', {
      mint,
      destination,
      source,
      authority,
      tokenAmount
    });

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

    console.log('transfer candidate:', {
      mint,
      destination,
      source,
      authority,
      amountRaw
    });

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

  console.log('balanceDiff candidate:', {
    beforeAmt: beforeAmt.toString(),
    afterAmt: afterAmt.toString(),
    diff: diff.toString(),
    sourceOwner,
    sourceTokenAccount
  });

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

  console.log('scanAndCreditUserDeposits start:', {
    userId: user.id,
    externalId: user.externalId,
    userWallet,
    merchantAta,
    signaturesFound: sigs.length
  });

  for (const s of sigs) {
    const sig = s.signature;
    if (!sig || s.err) continue;

    const existingGlobal = await prisma.deposit.findUnique({
      where: { txSignature: sig }
    });
    if (existingGlobal) continue;

    const parsed = await getParsedTransaction(sig);
    if (!parsed) continue;

    logTxDebug(sig, parsed, merchantAta);

    const info = parseDepositFromParsedTx(parsed, merchantAta);
    if (!info) {
      console.log('skip tx: no deposit info parsed for signature', sig);
      continue;
    }

    const possibleSenders = extractRealSenderAddresses(parsed);

    const matchesUser =
      (info.sourceOwner && String(info.sourceOwner) === userWallet) ||
      possibleSenders.has(userWallet);

    console.log('deposit parse result:', {
      signature: sig,
      parser: info.parser,
      amountAtomic: String(info.amountAtomic),
      sourceOwner: info.sourceOwner,
      sourceTokenAccount: info.sourceTokenAccount,
      matchesUser,
      userWallet,
      possibleSenders: Array.from(possibleSenders)
    });

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
      console.log('deposit credited:', {
        signature: sig,
        depositId: dep.id,
        amountAtomic: dep.amountAtomic?.toString?.() || String(dep.amountAtomic)
      });
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