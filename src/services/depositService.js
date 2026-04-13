const { getMerchantTokenAccount, getSignaturesForAddress, getParsedTransaction } = require('../utils/solana_rpc');
const { BLKR_DECIMALS } = require('../config');

// Аккуратно извлекаем pubkey по индексу (учёт разных форматов accountKeys)
function accountPubkeyByIndex(parsedTx, idx) {
  const ak = parsedTx?.transaction?.message?.accountKeys?.[idx];
  if (!ak) return null;
  if (typeof ak === 'string') return ak;
  if (typeof ak === 'object') {
    if (ak.pubkey) return ak.pubkey;
    // В редких случаях поле может называться иначе; вернём строку если есть toString
    if (typeof ak.toString === 'function') return ak.toString();
  }
  return null;
}

// Извлечь изменения токен-балансов для ATA и определить источник перевода и сумму
function parseDepositFromParsedTx(parsedTx, merchantTokenAccount) {
  const meta = parsedTx?.meta;
  if (!meta) return null;

  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];

  // Найдём состояние до/после для аккаунта мерчанта
  const before = pre.find(b => accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount);
  const after  = post.find(b => accountPubkeyByIndex(parsedTx, b.accountIndex) === merchantTokenAccount);

  if (!after) return null;

  const afterAmt = BigInt(after.uiTokenAmount?.amount || '0');
  const beforeAmt = BigInt(before?.uiTokenAmount?.amount || '0');
  const diff = afterAmt - beforeAmt;

  if (diff <= 0n) return null;

  // Определить источник — владелец токен-аккаунта, чей баланс уменьшился
  let sourceOwner = null;
  for (const p of pre) {
    const postMatch = post.find(x => x.accountIndex === p.accountIndex);
    if (!postMatch) continue;
    const delta = BigInt(postMatch.uiTokenAmount?.amount || '0') - BigInt(p.uiTokenAmount?.amount || '0');
    if (delta < 0n) {
      sourceOwner = p.owner;
      break;
    }
  }

  return {
    amountAtomic: diff,
    sourceOwner
  };
}

// Сканировать последние N транзакций на ATA, создать депозиты, начислить средства для конкретного пользователя
async function scanAndCreditUserDeposits(prisma, user) {
  if (!user?.wallet?.solanaAddress) {
    throw new Error('User has no linked Solana address');
  }
  const merchantAta = await getMerchantTokenAccount();
  const sigs = await getSignaturesForAddress(merchantAta, 50);

  const known = new Set(
    (await prisma.deposit.findMany({
      where: { userId: user.id },
      select: { txSignature: true }
    })).map(x => x.txSignature)
  );

  const created = [];

  for (const s of sigs) {
    const sig = s.signature;
    if (known.has(sig)) continue;

    const parsed = await getParsedTransaction(sig);
    if (!parsed) continue;

    const info = parseDepositFromParsedTx(parsed, merchantAta);
    if (!info) continue;

    if (!info.sourceOwner || info.sourceOwner !== user.wallet.solanaAddress) continue;

    const amountAtomic = BigInt(info.amountAtomic);

    const dep = await prisma.$transaction(async (tx) => {
      const exists = await tx.deposit.findUnique({ where: { txSignature: sig } });
      if (exists) return exists;

      const createdDep = await tx.deposit.create({
        data: {
          userId: user.id,
          status: 'CONFIRMED',
          txSignature: sig,
          amountAtomic,
          sourceAddress: info.sourceOwner,
          detectedAt: new Date(),
          confirmedAt: new Date(),
          meta: { rpc: { slot: parsed.slot } }
        }
      });

      await tx.wallet.update({
        where: { userId: user.id },
        data: { balanceAtomic: { increment: amountAtomic } }
      });

      await tx.ledgerEntry.create({
        data: {
          userId: user.id,
          type: 'DEPOSIT',
          amountAtomic,
          reference: `deposit:${createdDep.id}`,
          txSignature: sig,
          meta: { sourceOwner: info.sourceOwner }
        }
      });

      await tx.deposit.update({
        where: { id: createdDep.id },
        data: { status: 'CREDITED', creditedAt: new Date() }
      });

      return { ...createdDep, status: 'CREDITED' };
    });

    created.push(dep);
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
  return { deposits: created, balanceAtomic: wallet.balanceAtomic };
}

module.exports = { scanAndCreditUserDeposits };