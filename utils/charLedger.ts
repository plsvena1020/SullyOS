// ============================================================
// charLedger: char-owned bank bookkeeping.
// 选卡共享 charDefaultCard，写入各走各的（CheckPhone 随机 tx-char-* vs char 下单幂等 tx-order-<orderId>）。
// Shared by CheckPhone purchase simulation (Phase 3) and char-placed
// orders (Phase 4). Every char purchase writes exactly one outflow
// BankTransaction with ownerId=charId, so:
//   - CheckPhone bank view reads the same ledger (no second balance),
//   - BankApp user view hides char txns (it filters out ownerId txns),
//   - purchase <-> bank_txn linkage is stored both ways
//     (PhoneEvidence.linkedBankTxnId / BankTransaction.linkedPurchaseId).
// ============================================================
import { DB } from './db';
import type { BankCard, BankTransaction } from '../types';

export interface CharPurchaseLink {
  bankTxnId: string;
  cardId: string; // '' when char has no card (txn still written, no deduction)
  cardLabel: string;
  deducted: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function charCardsOf(cards: BankCard[] | undefined, charId: string): BankCard[] {
  return (cards || []).filter(c => c.owner === 'char' && c.ownerId === charId);
}

export function charDefaultCard(cards: BankCard[] | undefined, charId: string): BankCard | undefined {
  const mine = charCardsOf(cards, charId);
  return mine.find(c => c.isDefault) || mine[0];
}

export async function appendCharPurchaseTxn(
  charId: string,
  p: { amount: number; merchant: string; item: string; category: string; purchaseId: string; timestamp: number },
): Promise<CharPurchaseLink> {
  const total = Math.max(0, Math.round((Number(p.amount) || 0) * 100) / 100);
  const at = p.timestamp || Date.now();
  const d = new Date(at);
  const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const bankTxnId = `tx-char-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const bank = await DB.getBankState().catch(() => null);
  const cards = bank?.cards || [];
  const payCard = charDefaultCard(cards, charId);
  let deducted = false;
  let cardId = '';
  let cardLabel = '';
  if (bank && payCard && total > 0 && payCard.balance >= total) {
    cardId = payCard.id;
    cardLabel = `${payCard.name}·${payCard.tailNo}`;
    const nextCards = cards.map(c => c.id === payCard.id
      ? { ...c, balance: Math.round((c.balance - total) * 100) / 100 }
      : c);
    await DB.saveBankState({ ...bank, cards: nextCards });
    deducted = true;
  }
  const tx: BankTransaction = {
    id: bankTxnId,
    amount: -total,
    category: p.category,
    note: `${p.merchant}·${p.item}`,
    timestamp: at,
    dateStr,
    ownerId: charId,
    linkedPurchaseId: p.purchaseId,
    cardId: cardId || undefined,
  };
  await DB.saveTransaction(tx);
  return { bankTxnId, cardId, cardLabel, deducted };
}
