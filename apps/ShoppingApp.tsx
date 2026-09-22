// ============================================================
// 购物 App 主组件 —— 淘宝式电商 UI（真实店铺 × 品牌 SKU · 虚拟下单）
// 数据: mall-shops.json / mall-goods.json（OSM 真实购物店铺 + 品牌真实 SKU，与外卖数据完全分离）
// 商品图统一本地 SVG（GoodsSvg imgKey）；下单/支付/订单/转发复用外卖链路（ShoppingOrder 类型）
// ============================================================
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  ShoppingCart, ShoppingOrder, CartItem,
  MallCategory, MALL_CATEGORIES, MALL_CATEGORY_EMOJI,
  MallShop, MallGood, MallOrder, ORDER_STATUS_LABEL,
} from '../utils/shoppingTypes';
import { loadMallData, searchMallGoods, MallDataset } from '../utils/shoppingData';
import GoodsSvg from '../components/GoodsSvg';
import { buildShoppingOrderTag } from '../utils/shoppingFormat';
import { roundMoney, sumMoney, formatMoney } from '../utils/format';
import { LoaderDots } from '../utils/appLoaderDots';
import { CHAT_GEN_EVENTS } from '../utils/chatGenEvents';
import { useLayoutMode } from '../utils/layoutMode';

// ── 视图状态：首页 / 店铺 / 商品详情 / 购物车 / 结算 / 订单 ──
type View = 'home' | 'shop' | 'good' | 'cart' | 'checkout' | 'orders' | 'orderDetail';

/** 收货人（地址 pill 切换：我 / char） */
interface TargetInfo {
  type: 'user' | 'char';
  charId?: string;
  name: string;
  addressText: string;
  cityTag?: string;
}

const genOrderId = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return 'ORD' + ymd + Math.random().toString(36).slice(2, 8).toUpperCase();
};

/** 购物物流周期：付款后 2 分钟发货(delivering)，5 分钟送达(delivered)（模拟 2-3 天，可手动「确认收货」） */
function computeStatus(o: MallOrder, now = Date.now()): MallOrder['status'] {
  if (o.status === 'cancelled' || o.status === 'delivered') return o.status;
  const t = now - o.createdAt;
  if (t > 5 * 60_000) return 'delivered';
  if (t > 2 * 60_000) return 'delivering';
  return o.status === 'pending_pay' ? 'pending_pay' : o.status === 'paid' ? 'paid' : o.status;
}

export default function ShoppingApp() {
  const { userProfile, characters, openApp, closeApp, updateCharacter, updateUserProfile, theme } = useOS();
  const isDesktop = useLayoutMode(theme.desktopMode) === 'desktop';
  const [view, setView] = useState<View>('home');
  const [ds, setDs] = useState<MallDataset | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<MallCategory | 'all'>('all');
  const [visibleCount, setVisibleCount] = useState(16);
  const shopSentinelRef = useRef<HTMLDivElement | null>(null);
  const [activeShop, setActiveShop] = useState<MallShop | null>(null);
  const [activeGood, setActiveGood] = useState<MallGood | null>(null);
  const [carts, setCarts] = useState<Record<string, ShoppingCart>>({});
  const [orders, setOrders] = useState<MallOrder[]>([]);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [targetSel, setTargetSel] = useState(false);
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [editAddr, setEditAddr] = useState(false);
  const [addrDraft, setAddrDraft] = useState('');
  const [payErr, setPayErr] = useState('');
  // 操作身份（'user' | charId）：查手机入口以 char 身份打开时，下单扣 char 名下卡
  const [actor, setActor] = useState<string>('user');
  const [lastOrder, setLastOrder] = useState<MallOrder | null>(null);

  // ── 数据加载 ──
  useEffect(() => { loadMallData().then(setDs).catch(() => setLoadErr(true)); }, []);

  // ── 订单加载 + 物流时间驱动刷新 ──
  useEffect(() => {
    DB.getAllShoppingOrders().then(list => {
      const fixed = list.map(o => {
        const st = computeStatus(o);
        if (st !== o.status) {
          const next = { ...o, status: st, statusHistory: [...o.statusHistory, { status: st, at: Date.now() }], deliveredAt: st === 'delivered' ? Date.now() : o.deliveredAt };
          DB.saveShoppingOrder(next);
          return next;
        }
        return o;
      });
      setOrders(fixed.sort((a, b) => b.createdAt - a.createdAt));
    }).catch(() => {});
    const iv = setInterval(() => {
      setOrders(prev => prev.map(o => {
        const st = computeStatus(o);
        return st === o.status ? o : { ...o, status: st, statusHistory: [...o.statusHistory, { status: st, at: Date.now() }], deliveredAt: st === 'delivered' ? Date.now() : o.deliveredAt };
      }));
    }, 30_000);
    return () => clearInterval(iv);
  }, []);

  // ── 购物车持久化（按收货人隔离） ──
  useEffect(() => {
    try { setCarts(JSON.parse(localStorage.getItem('sullyos_mall_carts') || '{}')); } catch { setCarts({}); }
  }, []);
  const persistCarts = (next: Record<string, ShoppingCart>) => {
    setCarts(next);
    try { localStorage.setItem('sullyos_mall_carts', JSON.stringify(next)); } catch { /* ignore */ }
  };

  const cartKeyOf = (t: TargetInfo) => (t.type === 'user' ? 'user' : `char:${t.charId || t.name}`);
  const cart = target ? carts[cartKeyOf(target)] : undefined;

  // ── 收货人：默认 user，可切到有地址的 char ──
  const targets: TargetInfo[] = useMemo(() => {
    const me: TargetInfo = {
      type: 'user', name: userProfile.name || '我',
      addressText: (userProfile as any).delivery?.addressText || '',
      cityTag: (userProfile as any).delivery?.cityTag || '',
    };
    const chars = characters.map(c => ({
      type: 'char' as const, charId: c.id, name: c.name,
      addressText: (c as any).delivery?.addressText || '',
      cityTag: (c as any).delivery?.cityTag || (c as any).location?.city || '',
    }));
    return [me, ...chars];
  }, [userProfile, characters]);

  useEffect(() => {
    if (!target && targets.length > 0) {
      // 查手机入口带上下文（placedBy=charId）→ 默认收货人切到该 char（TA 给自己点单/买东西）
      let ctxCharId: string | null = null;
      try {
        const raw = sessionStorage.getItem('sullyos_app_context_shopping');
        if (raw) {
          sessionStorage.removeItem('sullyos_app_context_shopping');
          const ctx = JSON.parse(raw);
          if (ctx?.placedBy) {
            ctxCharId = String(ctx.placedBy);
            setActor(String(ctx.placedBy));
          }
        }
      } catch { /* ignore */ }
      const fromCtx = ctxCharId ? targets.find(t => t.charId === ctxCharId) : undefined;
      setTarget(fromCtx && fromCtx.addressText ? fromCtx : targets[0]);
    }
  }, [targets]);

  const updateTargetAddress = async (text: string, cityTag?: string) => {
    if (!target) return;
    if (target.type === 'user') {
      const cur = (userProfile as any).delivery || {};
      updateUserProfile({ delivery: { ...cur, addressText: text, cityTag: cityTag ?? cur.cityTag } } as any);
      setTarget({ ...target, addressText: text, cityTag: cityTag ?? target.cityTag });
    } else if (target.charId) {
      const ch = characters.find(c => c.id === target.charId);
      if (ch) {
        const cur = (ch as any).delivery || {};
        updateCharacter(ch.id, { delivery: { ...cur, addressText: text, cityTag: cityTag ?? cur.cityTag } } as any);
        setTarget({ ...target, addressText: text, cityTag: cityTag ?? target.cityTag });
      }
    }
    setEditAddr(false);
  };

  // ── 搜索：商品名/品牌全城搜（确定性前 80 条） ──
  const q = query.trim().toLowerCase();
  const goodHits = useMemo(() => {
    if (!ds || q.length < 1) return [];
    return searchMallGoods(ds, q);
  }, [ds, q]);
  const goodHitShopIds = useMemo(() => new Set(goodHits.map(g => g.shopId)), [goodHits]);

  // ── 店铺列表：全量展示，城市标签匹配者优先，品类过滤 ──
  const visibleShops = useMemo(() => {
    if (!ds) return [];
    let list = ds.shops;
    if (activeCat !== 'all') list = list.filter(s => s.cat === activeCat);
    // 去地域：仅按评分排序
    const sorted = [...list].sort((a, b) => {
      return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
    });
    if (q) {
      const nameHit = sorted.filter(s => s.name.toLowerCase().includes(q) || (s as any).brand?.toLowerCase?.().includes(q));
      const goodShopHit = sorted.filter(s => goodHitShopIds.has(s.id) && !nameHit.includes(s));
      return [...nameHit, ...goodShopHit];
    }
    return sorted;
  }, [ds, activeCat, target, q, goodHitShopIds]);
  useEffect(() => { setVisibleCount(16); }, [activeCat, q]);
  const pagedShops = useMemo(() => visibleShops.slice(0, visibleCount), [visibleShops, visibleCount]);
  useEffect(() => {
    const el = shopSentinelRef.current;
    if (!el) return;
    const ob = new IntersectionObserver((es) => {
      if (es.some(e => e.isIntersecting)) setVisibleCount(v => Math.min(visibleShops.length, v + 16));
    }, { rootMargin: '200px' });
    ob.observe(el);
    return () => ob.disconnect();
  }, [pagedShops.length, visibleShops.length]);

  const shopGoods = useMemo(() => {
    if (!ds || !activeShop) return [];
    return ds.goods.filter(g => g.shopId === activeShop.id);
  }, [ds, activeShop]);

  // ── 购物车操作（淘宝式：跨店合并，不设单一店铺限制） ──
  const addToCart = (good: MallGood, qty = 1) => {
    if (!target) return;
    const key = cartKeyOf(target);
    const cur: ShoppingCart = carts[key] || {
      key, recipientType: target.type, charId: target.charId, recipientName: target.name,
      addressText: target.addressText, cityTag: target.cityTag, items: [], updatedAt: Date.now(),
    };
    const items = [...cur.items];
    const idx = items.findIndex(i => i.dishId === good.id);
    if (idx >= 0) items[idx] = { ...items[idx], qty: items[idx].qty + qty, lineTotal: roundMoney((items[idx].qty + qty) * items[idx].unitPrice) };
    else items.push({ dishId: good.id, name: good.name, unitPrice: good.price, qty, imgKey: good.imgKey, lineTotal: roundMoney(good.price * qty) });
    persistCarts({ ...carts, [key]: { ...cur, items, addressText: target.addressText, updatedAt: Date.now() } });
  };
  const changeQty = (dishId: string, delta: number) => {
    if (!target) return;
    const key = cartKeyOf(target);
    const cur = carts[key];
    if (!cur) return;
    const items = cur.items.map(i => ({ ...i }))
      .map(i => { if (i.dishId === dishId) { i.qty += delta; i.lineTotal = roundMoney(i.qty * i.unitPrice); } return i; })
      .filter(i => i.qty > 0);
    persistCarts({ ...carts, [key]: { ...cur, items, updatedAt: Date.now() } });
  };
  const cartCount = cart?.items.reduce((a, i) => a + i.qty, 0) || 0;
  const cartTotal = cart ? sumMoney(cart.items.map(i => i.lineTotal)) : 0;

  // ── 下单：银行卡扣款（虚拟支付，存钱罐 BankFullState.cards 默认卡优先） ──
  const placeOrder = async () => {
    if (!target || !cart || cart.items.length === 0) return;
    setPayErr('');
    const bank = await DB.getBankState();
    let cards = bank?.cards || [];
    if (cards.length === 0) {
      cards = [{ id: 'card_' + Date.now(), name: '零花钱卡', tailNo: '8888', balance: 520, isDefault: true, owner: 'user' }];
    }
    // 按操作身份选卡：char 操作只用 char 名下卡；user 操作用非 char 卡
    const actorIsChar = actor !== 'user';
    const scoped = actorIsChar
      ? cards.filter(c => c.owner === 'char' && c.ownerId === actor)
      : cards.filter(c => !(c.owner === 'char'));
    if (scoped.length === 0) {
      setPayErr(actorIsChar
        ? '还没给 TA 办银行卡，去查手机→银行卡先办一张'
        : '还没有银行卡，去存钱罐添加一张吧');
      return;
    }
    const payCard = scoped.find(c => c.isDefault) || scoped[0];
    if (payCard.balance < cartTotal) {
      setPayErr(`「${payCard.name}·${payCard.tailNo}」余额不足（¥${formatMoney(payCard.balance)}），去存钱罐充值或换卡`);
      return;
    }
    const order: ShoppingOrder = {
      id: genOrderId(),
      charId: target.type === 'char' ? target.charId : undefined,
      placedBy: actorIsChar ? 'char' : 'user', recipientType: target.type, recipientName: target.name,
      addressText: target.addressText || '（未填地址）',
      shopId: 'multi', shopName: itemsToShopLabel(cart.items),
      shopCat: '购物',
      items: cart.items, itemCount: cart.items.reduce((a, i) => a + i.qty, 0),
      subtotal: cartTotal, deliveryFee: 0,
      total: cartTotal,
      payMethod: 'bank_card', cardLabel: `${payCard.name}·${payCard.tailNo}`,
      status: 'paid',
      statusHistory: [{ status: 'paid', at: Date.now() }],
      createdAt: Date.now(),
    };
    // 扣款 + 流水
    const nextCards = cards.map(c => c.id === payCard.id ? { ...c, balance: roundMoney(c.balance - order.total) } : c);
    const nextBank = { ...(bank || { config: { dailyBudget: 100, currencySymbol: '¥' }, shop: {} as any, goals: [] }), cards: nextCards };
    await DB.saveBankState(nextBank as any);
    await DB.saveTransaction({
      id: 'tx_' + Date.now(), amount: -order.total, category: 'shopping', ownerId: actorIsChar ? actor : undefined,
      cardId: payCard.id,
      note: `购物订单 × ${order.itemCount} 件（${target.type === 'char' ? '给' + target.name + '买的' : '自购'}）`,
      timestamp: order.createdAt, dateStr: new Date(order.createdAt).toISOString().slice(0, 10),
    });
    await DB.saveShoppingOrder(order);

    // 给 char 买 → 落一条带标签的消息（聊天界面渲染订单卡）
    if (target.type === 'char' && target.charId) {
      await DB.saveMessage({
        charId: target.charId, role: 'user', type: 'shopping_order', metadata: { orderId: order.id, status: order.status, shop: order.shopName, total: order.total, recipient: order.recipientName },
        content: `我给你买了${order.shopName}的东西～\n${buildShoppingOrderTag(order)}`,
      } as any);
      window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.replyEnd, { detail: { charId: target.charId, charName: target.name } }));
    }
    // 清购物车
    const nextCarts = { ...carts };
    delete nextCarts[cartKeyOf(target)];
    persistCarts(nextCarts);
    setOrders(prev => [order, ...prev]);
    setLastOrder(order);
    setView('orderDetail'); setDetailOrderId(order.id);
  };

  // 购物车 items → 「华为Mate70×iPhone16」店铺名标签（多店合并展示）
  function itemsToShopLabel(items: CartItem[]): string {
    const names = items.map(i => i.name.replace(/[（(].*?[)）]/g, '').slice(0, 8));
    return names.slice(0, 2).join('、') + (names.length > 2 ? ' 等' : '');
  }

  // ── 深链回跳（聊天订单卡 CustomEvent + sessionStorage 兜底） ──
  useEffect(() => {
    const openOrder = (e: Event) => {
      const id = (e as CustomEvent).detail?.orderId;
      if (id) { setDetailOrderId(id); setView('orderDetail'); }
    };
    window.addEventListener('sullyos:open-shopping-order', openOrder);
    try {
      const pending = sessionStorage.getItem('sullyos_shopping_open_order');
      if (pending) {
        sessionStorage.removeItem('sullyos_shopping_open_order');
        setDetailOrderId(pending);
        setView('orderDetail');
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('sullyos:open-shopping-order', openOrder);
  }, []);

  // ── 订单转发到聊天 ──
  const forwardOrder = async (o: MallOrder, charId: string) => {
    await DB.saveMessage({
      charId, role: 'user', type: 'shopping_order', metadata: { orderId: o.id, status: o.status, shop: o.shopName, total: o.total, recipient: o.recipientName },
      content: `（转发订单）${o.shopName} 的订单～\n${buildShoppingOrderTag(o)}`,
    } as any);
    const ch = characters.find(c => c.id === charId);
    window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.replyEnd, { detail: { charId, charName: ch?.name || '' } }));
  };

  if (loadErr) {
    return <div className="h-full flex items-center justify-center text-sm text-slate-400">数据加载失败，请稍后重试</div>;
  }
  if (!ds || !target) {
    return <div className="h-full flex items-center justify-center text-slate-400"><LoaderDots /></div>;
  }

  // ════════ 渲染 ════════
  const backBtn = (label: string, onBack: () => void) => (
    <button onClick={onBack} className="flex items-center gap-1 text-[13px] text-slate-500 py-1">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-[#f5f6f7] text-slate-800">
      {/* 顶栏：返回 + 退出 + 收货地址 pill */}
      <div className="shrink-0 px-3 pt-2 pb-1 bg-gradient-to-r from-orange-400 to-red-400">
        <div className="flex items-center justify-between">
          {view === 'home' ? (
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-white">购物</span>
              <button onClick={closeApp} title="退出购物" className="flex items-center gap-0.5 px-2 py-1 rounded-full bg-white/25 text-white text-[11px] font-bold hover:bg-white/40">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                退出
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {backBtn(view === 'shop' ? '返回首页' : view === 'orders' ? '返回首页' : view === 'cart' ? '返回首页' : '返回', () => {
                if (view === 'shop' || view === 'good') setView('home');
                else if (view === 'checkout') setView('cart');
                else if (view === 'orderDetail') setView('orders');
                else setView('home');
              })}
              <button onClick={closeApp} title="退出购物" className="flex items-center gap-0.5 px-2 py-1 rounded-full bg-white/25 text-white text-[11px] font-bold hover:bg-white/40">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                退出
              </button>
            </div>
          )}
          <button onClick={() => setTargetSel(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-white/25 backdrop-blur text-white text-[12px] font-bold max-w-[62%]">
            <span>📍</span>
            <span className="truncate">{target.type === 'user' ? '我的地址' : `给 ${target.name}`}</span>
            {!target.addressText && target.type === 'char' && <span className="text-[10px] opacity-90">（未填）</span>}
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
        </div>
      </div>

      {view === 'home' && (
        <>
          {/* 搜索框（淘宝式：橙红圆角） */}
          <div className="shrink-0 px-3 pt-2 pb-2 bg-gradient-to-r from-orange-400 to-red-400">
            <div className="flex items-center gap-2 bg-white rounded-full px-3 py-2 shadow-sm">
              <svg className="w-4 h-4 text-orange-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" /></svg>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜商品/品牌/店铺，如：iPhone、优衣库、周大福"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-300"
              />
              {query && (
                <button onClick={() => setQuery('')} className="w-5 h-5 rounded-full bg-slate-300 text-white flex items-center justify-center text-[11px] shrink-0">×</button>
              )}
              <button onClick={() => setView('cart')} className="relative shrink-0 text-slate-500">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2 4h14M9 21a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm8 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" /></svg>
                {cartCount > 0 && <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">{cartCount}</span>}
              </button>
            </div>
          </div>
          {/* 品类宫格（8 品类 + 全部） */}
          <div className="shrink-0 grid grid-cols-5 gap-y-2 px-2 pt-3 pb-2 bg-white">
            <button onClick={() => setActiveCat('all')} className={`flex flex-col items-center gap-1 ${activeCat === 'all' ? 'opacity-100' : 'opacity-70'}`}>
              <span className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xl ${activeCat === 'all' ? 'bg-orange-100 ring-2 ring-orange-300' : 'bg-slate-50'}`}>🧭</span>
              <span className="text-[10px]">全部</span>
            </button>
            {MALL_CATEGORIES.map(c => (
              <button key={c} onClick={() => setActiveCat(c)} className={`flex flex-col items-center gap-1 ${activeCat === c ? 'opacity-100' : 'opacity-70'}`}>
                <span className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xl ${activeCat === c ? 'bg-orange-100 ring-2 ring-orange-300' : 'bg-slate-50'}`}>{MALL_CATEGORY_EMOJI[c]}</span>
                <span className="text-[10px]">{c}</span>
              </button>
            ))}
          </div>
          {/* 店铺列表 */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 animate-fade-soft">
            {q && goodHits.length > 0 && (
              <div className="bg-white rounded-2xl p-3">
                <div className="text-[12px] font-bold text-slate-700 mb-2">🎁 找到 {goodHits.length} 件商品（全城）</div>
                <div className="space-y-1.5">
                  {goodHits.map(g => {
                    const shop = ds.shops.find(s => s.id === g.shopId);
                    return (
                      <div key={g.id} onClick={() => { setActiveGood(g); if (shop) setActiveShop(shop); setView('good'); }}
                        className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-slate-50 cursor-pointer">
                        <GoodsSvg imgKey={g.imgKey} name={g.name} className="w-10 h-10 rounded-lg" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-bold truncate">{g.name}</div>
                          <div className="text-[10px] text-slate-400 truncate">{g.brand} · {shop?.name}</div>
                        </div>
                        <span className="text-[13px] font-bold text-red-500 shrink-0">¥{formatMoney(g.price)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {q && visibleShops.length === 0 && goodHits.length === 0 && (
              <div className="text-center text-[12px] text-slate-400 py-10">没找到「{query}」相关的商品或店铺</div>
            )}
            {pagedShops.map(s => (
              <div key={s.id} onClick={() => { setActiveShop(s); setView('shop'); }}
                className="flex gap-3 bg-white rounded-2xl p-3 shadow-sm active:scale-[0.99] transition-transform cursor-pointer">
                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-orange-100 to-red-100 flex items-center justify-center text-2xl shrink-0">
                  {(MALL_CATEGORY_EMOJI[s.cat as MallCategory] || '🛍')}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-bold truncate">{s.name}</span>
                    {q && goodHitShopIds.has(s.id) && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-600 shrink-0">有你要的货</span>
                    )}
                  </div>
                  <div className="text-[11px] text-orange-500 font-bold mt-0.5">★ {s.rating} <span className="text-slate-400 font-normal">月销{s.monthlySales} · {s.fanCount}粉丝</span></div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{s.cat} · 7天无理由退货 · {s.returnDays}天价保</div>
                </div>
                <div className="self-center text-slate-300 shrink-0">›</div>
              </div>
            ))}
            {visibleShops.length === 0 && !q && <div className="text-center text-[12px] text-slate-400 py-10">该品类暂无店铺</div>}
            {pagedShops.length < visibleShops.length ? (
              <div ref={shopSentinelRef} className="flex items-center justify-center py-4 text-slate-400"><LoaderDots /></div>
            ) : (
              visibleShops.length > 0 && <div className="text-center text-[11px] text-slate-400 py-3">已全部加载</div>
            )}
          </div>
          {/* 底部：购物车 + 订单入口 */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-t border-slate-100">
            <button onClick={() => setView('cart')} className="relative text-[12px] text-slate-500 shrink-0">
              🛒 购物车
              {cartCount > 0 && <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">{cartCount}</span>}
            </button>
            <div className="flex-1" />
            <button onClick={() => setView('orders')} className="text-[12px] text-slate-500 shrink-0">📋 订单</button>
          </div>
        </>
      )}

      {view === 'shop' && activeShop && (
        <>
          <div className="flex-1 overflow-y-auto animate-page-in-l">
            <div className="px-4 pt-3 pb-3 bg-gradient-to-br from-orange-50 to-red-50">
              <div className="text-[16px] font-bold">{activeShop.name}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">★ {activeShop.rating} · 月销{activeShop.monthlySales} · {activeShop.fanCount}粉丝</div>
            </div>
            {/* 商品两列瀑布流（淘宝式） */}
            <div className={`px-3 pb-24 grid gap-2 ${isDesktop ? 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]' : 'grid-cols-2'}`}>
              {shopGoods.map(g => (
                <div key={g.id} onClick={() => { setActiveGood(g); setView('good'); }} className="bg-white rounded-xl overflow-hidden shadow-sm active:scale-[0.98] transition-transform cursor-pointer">
                  <GoodsSvg imgKey={g.imgKey} name={g.name} className="w-full aspect-square" />
                  <div className="p-2">
                    <div className="text-[12px] font-bold leading-snug line-clamp-2">{g.name}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{g.brand}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[14px] font-bold text-red-500">¥{formatMoney(g.price)}</span>
                      <span className="text-[9px] text-slate-400">月销{hashSales(g.id)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {shopGoods.length === 0 && <div className="col-span-full text-center text-[12px] text-slate-400 py-10">店铺上新中…</div>}
            </div>
          </div>
          {cart && cart.items.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-t border-slate-100">
              <button onClick={() => setView('cart')} className="flex-1 flex items-center gap-2 px-4 py-2 rounded-full bg-red-500 text-white text-[13px] font-bold justify-center">
                🛒 {cartCount} 件 · ¥{formatMoney(cartTotal)} 去结算
              </button>
            </div>
          )}
        </>
      )}

      {view === 'good' && activeGood && (() => {
        const shop = ds.shops.find(s => s.id === activeGood.shopId) || activeShop;
        return (
          <div className="flex-1 overflow-y-auto animate-page-in-l">
            <GoodsSvg imgKey={activeGood.imgKey} name={activeGood.name} className="w-full aspect-[1.5] rounded-none" />
            <div className="px-4 py-3 space-y-2">
              <div className="text-[17px] font-bold leading-snug">{activeGood.name}</div>
              <div className="text-[20px] font-bold text-red-500">¥{formatMoney(activeGood.price)} <span className="text-[11px] text-slate-400 font-normal">{activeGood.brand}官方正品</span></div>
              <div className="text-[11px] text-slate-400">{shop?.name} · 7天无理由退货 · 顺丰包邮</div>
              <div className="text-[11px] text-slate-500 bg-white rounded-xl p-2.5">📍 送货至：{target.type === 'user' ? '我的地址' : `${target.name} 的地址`} · {target.addressText || '（未填地址）'}</div>
            </div>
            {/* 加入购物车条 */}
            <div className="shrink-0 sticky bottom-0 flex items-center gap-2 px-3 py-2 bg-white border-t border-slate-100">
              <button onClick={() => { addToCart(activeGood); setView('shop'); }} className="flex-1 py-2.5 rounded-full bg-orange-100 text-orange-600 text-[13px] font-bold">加入购物车</button>
              <button onClick={() => { addToCart(activeGood); setView('cart'); }} className="flex-1 py-2.5 rounded-full bg-red-500 text-white text-[13px] font-bold">立即购买</button>
            </div>
          </div>
        );
      })()}

      {view === 'cart' && (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 animate-page-in-l">
          {cart && cart.items.length > 0 ? (
            <>
              <div className="text-[11px] text-slate-400 px-1">送至：{target.type === 'user' ? '我' : target.name} · {target.addressText || '（未填地址）'}</div>
              {cart.items.map(i => (
                <div key={i.dishId} className="flex gap-3 bg-white rounded-2xl p-3">
                  <GoodsSvg imgKey={i.imgKey} name={i.name} className="w-14 h-14 rounded-lg shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold leading-snug line-clamp-2">{i.name}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">¥{formatMoney(i.unitPrice)}/件</div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[15px] font-bold text-red-500">¥{formatMoney(i.lineTotal)}</span>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => changeQty(i.dishId, -1)} className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold">−</button>
                        <span className="text-[12px] font-bold w-4 text-center">{i.qty}</span>
                        <button onClick={() => changeQty(i.dishId, 1)} className="w-6 h-6 rounded-full bg-orange-400 text-white flex items-center justify-center font-bold">+</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-slate-400 text-center">合计 ¥{formatMoney(cartTotal)} · 免运费（虚拟物流 2-3 天送达）</div>
            </>
          ) : (
            <div className="text-center text-[12px] text-slate-400 py-10">购物车是空的，去逛逛吧～</div>
          )}
          {cart && cart.items.length > 0 && (
            <button onClick={() => setView('checkout')} className="w-full py-3 rounded-full bg-red-500 text-white text-[14px] font-bold">去结算（¥{formatMoney(cartTotal)}）</button>
          )}
        </div>
      )}

      {view === 'checkout' && cart && cart.items.length > 0 && (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 animate-page-in-l">
          <div className="bg-white rounded-2xl p-4">
            <div className="text-[13px] font-bold mb-1">收货信息</div>
            <div className="text-[12px] text-slate-500">{target.type === 'user' ? '送给我自己' : `送给 ${target.name}`}</div>
            <div className="text-[12px] text-slate-500">📍 {target.addressText || '（未填地址）'}</div>
          </div>
          <div className="bg-white rounded-2xl p-4 space-y-2">
            <div className="text-[13px] font-bold">购物清单（{cart.items.length} 件商品）</div>
            {cart.items.map(i => (
              <div key={i.dishId} className="flex justify-between text-[12px]">
                <span className="truncate mr-2">{i.name} × {i.qty}</span>
                <span className="shrink-0">¥{formatMoney(i.lineTotal)}</span>
              </div>
            ))}
            <div className="border-t border-slate-100 pt-2 flex justify-between text-[13px] font-bold">
              <span>合计（免运费）</span>
              <span className="text-red-500">¥{formatMoney(cartTotal)}</span>
            </div>
          </div>
          {payErr && <div className="text-[12px] text-red-500 bg-red-50 rounded-xl px-3 py-2">{payErr}</div>}
          <button onClick={placeOrder} className="w-full py-3 rounded-full bg-red-500 text-white text-[14px] font-bold">
            银行卡支付 ¥{formatMoney(cartTotal)}
          </button>
          <div className="text-[10px] text-slate-300 text-center">模拟支付 · 扣款走存钱罐银行卡 · 不真实付款</div>
        </div>
      )}

      {view === 'orders' && (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 animate-page-in-l">
          {orders.map(o => (
            <div key={o.id} onClick={() => { setDetailOrderId(o.id); setView('orderDetail'); }} className="bg-white rounded-2xl p-3 cursor-pointer">
              <div className="flex justify-between items-center">
                <span className="text-[13px] font-bold truncate">{o.shopName}</span>
                <span className="text-[11px] text-orange-500 shrink-0">{ORDER_STATUS_LABEL[o.status]}</span>
              </div>
              <div className="text-[11px] text-slate-400 truncate mt-0.5">{o.items.map(i => `${i.name}×${i.qty}`).join('、')}</div>
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-slate-400">{o.recipientType === 'char' ? `给${o.recipientName}买的` : '自购'} · {o.cardLabel}</span>
                <span className="text-[13px] font-bold">¥{formatMoney(o.total)}</span>
              </div>
            </div>
          ))}
          {orders.length === 0 && <div className="text-center text-[12px] text-slate-400 py-10">还没有订单</div>}
        </div>
      )}

      {view === 'orderDetail' && (() => {
        const o = orders.find(x => x.id === detailOrderId) || lastOrder;
        if (!o) return <div className="flex-1" />;
        return (
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 animate-page-in-l">
            <div className="bg-white rounded-2xl p-4">
              <div className="flex justify-between items-center">
                <span className="text-[15px] font-bold">{ORDER_STATUS_LABEL[o.status]}</span>
                <span className="text-[13px] font-bold text-red-500">¥{formatMoney(o.total)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">订单号 {o.id} · {o.cardLabel}</div>
              {o.status !== 'delivered' && o.status !== 'cancelled' && (
                <>
                  <button
                    onClick={() => {
                      const next: MallOrder = { ...o, status: 'delivered', statusHistory: [...o.statusHistory, { status: 'delivered', at: Date.now() }], deliveredAt: Date.now() };
                      DB.saveShoppingOrder(next); setOrders(prev => prev.map(x => x.id === o.id ? next : x));
                    }}
                    className="mt-3 w-full py-2.5 rounded-full bg-emerald-400 text-white text-[13px] font-bold">确认收货</button>
                  <div className="text-[10px] text-slate-300 text-center mt-1">虚拟物流 2-3 天送达，也可立即确认收货</div>
                </>
              )}
            </div>
            <div className="bg-white rounded-2xl p-4 space-y-1">
              <div className="text-[13px] font-bold">商品清单</div>
              {o.items.map(i => (
                <div key={i.dishId} className="flex justify-between text-[12px]">
                  <span className="truncate mr-2">{i.name} × {i.qty}</span><span>¥{formatMoney(i.lineTotal)}</span>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-2xl p-4 text-[12px] text-slate-500 space-y-1">
              <div>📍 {o.addressText}</div>
              <div>{o.recipientType === 'char' ? `送给 ${o.recipientName}` : '送给我自己'}</div>
              <div>下单时间 {new Date(o.createdAt).toLocaleString()}</div>
            </div>
            {/* 转发订单到聊天 */}
            <div className="bg-white rounded-2xl p-4">
              <div className="text-[13px] font-bold mb-2">转发订单</div>
              <div className="space-y-1.5">
                {characters.filter(c => c.id !== o.charId || o.recipientType === 'user').map(c => (
                  <button key={c.id} onClick={() => forwardOrder(o, c.id)}
                    className="w-full text-left px-3 py-2 rounded-xl bg-slate-50 hover:bg-orange-50 flex items-center gap-2">
                    <span>💬</span>
                    <span className="text-[12px] font-bold">发给 {c.name}</span>
                    <span className="ml-auto text-[10px] text-slate-400">发送订单卡，对方可一键复制购物车</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 收货人切换弹层 */}
      {targetSel && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-end animate-fade-in" onClick={() => setTargetSel(false)}>
          <div className="w-full bg-white rounded-t-3xl p-4 space-y-2 animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[14px] font-bold">选择收货地址</div>
              <button onClick={() => { setAddrDraft(target?.addressText || ''); setEditAddr(true); }} className="text-[11px] text-orange-500 font-bold">编辑当前地址</button>
            </div>
            {editAddr && (
              <div className="flex gap-2 mb-2">
                <input value={addrDraft} onChange={e => setAddrDraft(e.target.value)}
                  placeholder="如：北京市朝阳区望京SOHO T1 2501（城市标签可写开头）"
                  className="flex-1 text-[12px] px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-orange-300" />
                <button onClick={() => updateTargetAddress(addrDraft.trim())} className="px-3 py-2 rounded-xl bg-orange-400 text-white text-[12px] font-bold shrink-0">保存</button>
              </div>
            )}
            {targets.map(t => {
              const disabled = t.type === 'char' && !t.addressText;
              return (
                <button key={cartKeyOf(t)} disabled={disabled}
                  onClick={() => { setTarget(t); setTargetSel(false); }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-2 ${disabled ? 'opacity-40' : 'hover:bg-slate-50'} ${target && cartKeyOf(t) === cartKeyOf(target) ? 'bg-orange-50 ring-1 ring-orange-300' : 'bg-slate-50'}`}>
                  <span>{t.type === 'user' ? '🏠' : '💌'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold">{t.type === 'user' ? '我的地址' : `${t.name} 的地址`}</div>
                    <div className="text-[11px] text-slate-400 truncate">{t.addressText || '未填写'}</div>
                  </div>
                  {disabled && <span className="text-[10px] text-slate-400">先去角色卡填地址</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 商品月销数（hash32 确定性，展示用） */
function hashSales(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h + id.charCodeAt(i)) | 0; }
  return 50 + Math.abs(h) % 2000;
}
