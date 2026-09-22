// charOrder: char-initiated orders paid from the char's own bank card.
// Phase 4: the chat directive LIFE:ORDER deducts the char's default card
// (owner='char', ownerId=charId) instead of the user's card, so the
// CheckPhone bank ledger (ownerId-filtered, Phase 3) stays consistent.
// Money-only module: order document building stays in lifeRecords.ts;
// this file owns balance mutation + transaction writes + idempotency.
//
// Idempotency: outflow id = tx-order-<orderId>, refund id = tx-refund-<orderId>.
// IndexedDB put() is an upsert, but we check existence BEFORE mutating balance
// so replaying the same orderId never double-deducts.
import { DB } from './db';
import type { BankTransaction } from '../types';
import { charDefaultCard } from './charLedger';
import { getLocalDateKey } from './localDate';

export const charOrderTxnId = (orderId: string): string => `tx-order-${orderId}`;
export const charRefundTxnId = (orderId: string): string => `tx-refund-${orderId}`;

export interface CharOrderPaymentInput {
  orderId: string;
  charId: string;
  charName?: string;
  shop: string;
  total: number;
}

export type CharOrderDenyReason = 'invalid' | 'no_bank' | 'no_card' | 'insufficient';

export interface CharOrderPaymentResult {
  ok: boolean;
  txnId?: string;
  cardId?: string;
  cardLabel?: string;
  reason?: CharOrderDenyReason;
  balance?: number;
  replay?: boolean;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Deduct the char's default card once per orderId (idempotent). */
export async function debitCharCardForOrder(input: CharOrderPaymentInput): Promise<CharOrderPaymentResult> {
  const total = round2(input.total);
  const orderId = (input.orderId || '').trim();
  if (!orderId || !(total > 0)) return { ok: false, reason: 'invalid' };
  const outId = charOrderTxnId(orderId);
  try {
    const prev = await DB.getAllTransactions().catch(() => [] as BankTransaction[]);
    const hit = (prev || []).find(t => t.id === outId);
    if (hit) return { ok: true, txnId: hit.id, replay: true };
  } catch { /* fall through to normal path */ }
  const bank = await DB.getBankState().catch(() => null);
  if (!bank) return { ok: false, reason: 'no_bank' };
  const cards = bank.cards || [];
  const payCard = charDefaultCard(cards, input.charId);
  if (!payCard) return { ok: false, reason: 'no_card' };
  if (round2(payCard.balance) < total) return { ok: false, reason: 'insufficient', balance: payCard.balance };
  const cardId = payCard.id;
  const cardLabel = `${payCard.name}·${payCard.tailNo}`;
  const nextCards = cards.map(c => (c.id === cardId ? { ...c, balance: round2(c.balance - total) } : c));
  await DB.saveBankState({ ...bank, cards: nextCards });
  const now = Date.now();
  const who = (input.charName || '').trim();
  const tx: BankTransaction = {
    id: outId,
    amount: -total,
    category: 'shopping',
    note: who ? `${input.shop}（${who}点的）` : `${input.shop}`,
    timestamp: now,
    dateStr: getLocalDateKey(new Date(now)),
    ownerId: input.charId,
    linkedPurchaseId: orderId,
    cardId,
  };
  await DB.saveTransaction(tx);
  return { ok: true, txnId: outId, cardId, cardLabel };
}

/** Explicit merchant-style refund: restores balance + writes an inflow txn (idempotent). */
export async function refundCharOrder(
  orderId: string,
  charId: string,
  opts?: { shop?: string; total?: number; cardId?: string },
): Promise<{ refunded: boolean; txnId?: string; replay?: boolean }> {
  const oid = (orderId || '').trim();
  if (!oid) return { refunded: false };
  const outId = charOrderTxnId(oid);
  const refId = charRefundTxnId(oid);
  const txs = await DB.getAllTransactions().catch(() => [] as BankTransaction[]);
  const list = txs || [];
  const already = list.find(t => t.id === refId);
  if (already) return { refunded: true, txnId: already.id, replay: true };
  const orig = list.find(t => t.id === outId);
  if (!orig) return { refunded: false };
  const amount = round2(opts?.total ?? -orig.amount);
  if (!(amount > 0)) return { refunded: false };
  const bank = await DB.getBankState().catch(() => null);
  if (!bank) return { refunded: false };
  const cards = bank.cards || [];
  const target = (opts?.cardId && cards.find(c => c.id === opts.cardId && c.owner === 'char' && c.ownerId === charId))
    || charDefaultCard(cards, charId)
    || cards.find(c => c.owner === 'char' && c.ownerId === charId);
  if (!target) return { refunded: false };
  const nextCards = cards.map(c => (c.id === target.id ? { ...c, balance: round2(c.balance + amount) } : c));
  await DB.saveBankState({ ...bank, cards: nextCards });
  const now = Date.now();
  await DB.saveTransaction({
    id: refId,
    amount,
    category: 'income',
    note: `${opts?.shop || orig.note}退款`,
    timestamp: now,
    dateStr: getLocalDateKey(new Date(now)),
    ownerId: charId,
    linkedPurchaseId: oid,
    cardId: target.id,
  });
  return { refunded: true, txnId: refId };
}

/** Reject-rollback helper: user denial means "never happened" — give the money back. */
export async function restoreCharCardBalance(charId: string, amount: number, cardId?: string): Promise<boolean> {
  const amt = round2(amount);
  if (!(amt > 0)) return false;
  const bank = await DB.getBankState().catch(() => null);
  if (!bank) return false;
  const cards = bank.cards || [];
  const target = (cardId && cards.find(c => c.id === cardId)) || charDefaultCard(cards, charId);
  if (!target) return false;
  const nextCards = cards.map(c => (c.id === target.id ? { ...c, balance: round2(c.balance + amt) } : c));
  await DB.saveBankState({ ...bank, cards: nextCards });
  return true;
}

