const { Prisma } = require('@prisma/client');

async function credit(prisma, userId, amountAtomic, meta = {}, reference = null, txSignature = null) {
  if (amountAtomic <= 0n) throw new Error('credit amount must be > 0');
  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');

    const updated = await tx.wallet.update({
      where: { userId },
      data: { balanceAtomic: wallet.balanceAtomic + BigInt(amountAtomic) }
    });

    const led = await tx.ledgerEntry.create({
      data: {
        userId,
        type: 'DEPOSIT',
        amountAtomic: BigInt(amountAtomic),
        reference,
        txSignature,
        meta
      }
    });
    return { wallet: updated, ledger: led };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function debit(prisma, userId, amountAtomic, meta = {}, reference = null, txSignature = null, ledgerType = 'WITHDRAWAL') {
  if (amountAtomic <= 0n) throw new Error('debit amount must be > 0');
  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    const bal = BigInt(wallet.balanceAtomic);
    if (bal < BigInt(amountAtomic)) throw new Error('Insufficient funds');

    const updated = await tx.wallet.update({
      where: { userId },
      data: { balanceAtomic: bal - BigInt(amountAtomic) }
    });

    const led = await tx.ledgerEntry.create({
      data: {
        userId,
        type: ledgerType,
        amountAtomic: BigInt(amountAtomic) * -1n,
        reference,
        txSignature,
        meta
      }
    });
    return { wallet: updated, ledger: led };
  });
}

module.exports = { credit, debit };