// ============================================================
// 外卖 App 主组件 —— 美团外卖式 UI（真实店面 × 品牌 SKU · 模拟点单）
// 数据: OSM 真实店铺 (ODbL) + 品牌 SKU 名录；商品图统一本地 SVG
// ============================================================
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  ShoppingShop, ShoppingDish, ShoppingCart, ShoppingOrder, CartItem,
  ShopCategory, SHOP_CATEGORIES, CATEGORY_EMOJI, ORDER_STATUS_LABEL,
} from '../utils/shoppingTypes';
import { loadShoppingData, sortShopsForAddress } from '../utils/shoppingData';
import GoodsSvg from '../components/GoodsSvg';
import { buildShoppingOrderTag, sanitizeOrderField } from '../utils/shoppingFormat';
import { roundMoney, sumMoney, formatMoney } from '../utils/format';
import { LoaderDots } from '../utils/appLoaderDots';
import { CHAT_GEN_EVENTS } from '../utils/chatGenEvents';

// ── 视图状态 ──
type View = 'list' | 'shop' | 'orders' | 'orderDetail' | 'checkout';

/** 当前点单目标（右上角地点 pill 切换） */
interface TargetInfo {
  type: 'user' | 'char';
  charId?: string;
  name: string;
  addressText: string; // 收货地址（char 未填时为空 → 置灰）
  cityTag?: string;
}

const EMOJI_FALLBACK: Record<string, string> = {
  '美食外卖': '🍜', '奶茶饮品': '🧋', '甜品蛋糕': '🍰', '超市便利': '🏪',
  '生鲜果蔬': '🥬', '医药健康': '💊', '鲜花绿植': '💐',
};

const STATUS_FLOW: ShoppingOrder['status'][] = ['pending_pay', 'paid', 'accepted', 'delivering', 'delivered'];

/** 按下单时间推进状态：接单 8 分钟、配送 32 分钟后送达（纯时间驱动） */
function computeStatus(o: ShoppingOrder, now = Date.now()): ShoppingOrder['status'] {
  if (o.status === 'cancelled' || o.status === 'delivered') return o.status;
  const t = now - o.createdAt;
  if (t > 40 * 60_000) return 'delivered';
  if (t > 8 * 60_000) return 'delivering';
  return o.status === 'pending_pay' ? 'pending_pay' : o.status === 'paid' ? 'paid' : 'accepted';
}

const genOrderId = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return 'ORD' + ymd + Math.random().toString(36).slice(2, 8).toUpperCase();
};

export default function TakeoutApp() {
  const { userProfile, characters, openApp, closeApp, updateCharacter, updateUserProfile } = useOS();
  const [view, setView] = useState<View>('list');
  const [ds, setDs] = useState<{ shops: ShoppingShop[]; dishes: ShoppingDish[] } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<ShopCategory | 'all'>('all');
  const [visibleCount, setVisibleCount] = useState(12);
  const shopSentinelRef = useRef<HTMLDivElement | null>(null);
  const [activeShop, setActiveShop] = useState<ShoppingShop | null>(null);
  const [carts, setCarts] = useState<Record<string, ShoppingCart>>({});
  const [orders, setOrders] = useState<ShoppingOrder[]>([]);
  const [showAllOrders, setShowAllOrders] = useState(false); // 默认按店铺去重，只看每店最新一单
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [targetSel, setTargetSel] = useState(false);
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [editAddr, setEditAddr] = useState(false);
  const [addrDraft, setAddrDraft] = useState('');
  const [payErr, setPayErr] = useState('');
  // 操作身份（'user' | charId）：查手机入口以 char 身份打开时，下单扣 char 名下卡
  const [actor, setActor] = useState<string>('user');
  const [lastOrder, setLastOrder] = useState<ShoppingOrder | null>(null);

  // ── 数据加载 ──
  useEffect(() => { loadShoppingData().then(setDs).catch(() => setLoadErr(true)); }, []);

  // ── 订单加载 + 时间驱动状态刷新 ──
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

  // ── 购物车持久化（按「被点单人」隔离，key = type:charId|user）──
  useEffect(() => { refreshCarts(); }, []);
  const refreshCarts = () => {
    // 购物车暂存 BankFullState 之外的 localStorage 快路径（大 JSON 不进 IDB 也无妨）
    try { setCarts(JSON.parse(localStorage.getItem('sullyos_shopping_carts') || '{}')); } catch { setCarts({}); }
  };
  const persistCarts = (next: Record<string, ShoppingCart>) => {
    setCarts(next);
    try { localStorage.setItem('sullyos_shopping_carts', JSON.stringify(next)); } catch { /* ignore */ }
  };

  const cartKeyOf = (t: TargetInfo) => (t.type === 'user' ? 'user' : `char:${t.charId || t.name}`);
  const cart = target ? carts[cartKeyOf(target)] : undefined;

  // ── 点单目标：默认 user，可切到有地址的 char ──
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
        const raw = sessionStorage.getItem('sullyos_app_context_takeout');
        if (raw) {
          sessionStorage.removeItem('sullyos_app_context_takeout');
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

  // ── 搜索：店名/品牌 + 跨店商品名（确定性前 60 条，防大列表卡顿）──
  const q = query.trim().toLowerCase();
  const dishHits = useMemo(() => {
    if (!ds || q.length < 1) return [];
    const out: { dish: ShoppingDish; shop: ShoppingShop }[] = [];
    for (const d of ds.dishes) {
      if (d.name.toLowerCase().includes(q) || (d.brand || '').toLowerCase().includes(q)) {
        const shop = ds.shops.find(s => s.id === d.shopId);
        if (shop) out.push({ dish: d, shop });
        if (out.length >= 60) break;
      }
    }
    return out;
  }, [ds, q]);

  // 商品命中的店铺 id 集合：这些店在店铺列表里置顶
  const dishHitShopIds = useMemo(() => new Set(dishHits.map(h => h.shop.id)), [dishHits]);

  // ── 订单展示：默认按店铺名去重（保留每店最新一单），可展开全部 ──
  const visibleOrders = useMemo(() => {
    if (showAllOrders) return orders;
    const byShop = new Map<string, ShoppingOrder>();
    for (const o of orders) { // orders 已按 createdAt 倒序
      if (!byShop.has(o.shopName)) byShop.set(o.shopName, o);
    }
    return [...byShop.values()];
  }, [orders, showAllOrders]);

  // ── 店铺列表：全量展示，城市标签匹配者优先 ──
  const visibleShops = useMemo(() => {
    if (!ds) return [];
    let list = ds.shops;
    if (activeCat !== 'all') list = list.filter(s => s.cat === activeCat);
    let sorted = sortShopsForAddress(list, target?.cityTag || undefined);
    if (q) {
      const nameHit = sorted.filter(s => s.name.toLowerCase().includes(q) || (s.brand || '').toLowerCase().includes(q));
      const dishShopHit = sorted.filter(s => dishHitShopIds.has(s.id) && !nameHit.includes(s));
      return [...nameHit, ...dishShopHit];
    }
    return sorted;
  }, [ds, activeCat, target, q, dishHitShopIds]);
  useEffect(() => { setVisibleCount(12); }, [activeCat, q]);
  const pagedShops = useMemo(() => visibleShops.slice(0, visibleCount), [visibleShops, visibleCount]);
  useEffect(() => {
    const el = shopSentinelRef.current;
    if (!el) return;
    const ob = new IntersectionObserver((es) => {
      if (es.some(e => e.isIntersecting)) setVisibleCount(v => Math.min(visibleShops.length, v + 12));
    }, { rootMargin: '200px' });
    ob.observe(el);
    return () => ob.disconnect();
  }, [pagedShops.length, visibleShops.length]);

  const shopMenu = useMemo(() => {
    if (!ds || !activeShop) return [];
    return ds.dishes.filter(d => d.shopId === activeShop.id);
  }, [ds, activeShop]);

  // ── 购物车操作 ──
  const addToCart = (dish: ShoppingDish, qty = 1) => {
    if (!target || !activeShop) return;
    const key = cartKeyOf(target);
    const cur: ShoppingCart = carts[key] || {
      key, recipientType: target.type, charId: target.charId, recipientName: target.name,
      addressText: target.addressText, cityTag: target.cityTag, shopId: activeShop.id, shopName: activeShop.name, items: [], updatedAt: Date.now(),
    };
    if (cur.shopId && cur.shopId !== activeShop.id) {
      if (!confirm(`购物车里还有「${cur.shopName}」的商品，换店将清空，继续？`)) return;
    }
    const items = [...((cur.shopId === activeShop.id ? cur.items : []))];
    const idx = items.findIndex(i => i.dishId === dish.id);
    if (idx >= 0) items[idx] = { ...items[idx], qty: items[idx].qty + qty, lineTotal: roundMoney((items[idx].qty + qty) * items[idx].unitPrice) };
    else items.push({ dishId: dish.id, name: dish.name, unitPrice: dish.price, qty, imgKey: dish.imgKey, lineTotal: roundMoney(dish.price * qty) });
    persistCarts({ ...carts, [key]: { ...cur, shopId: activeShop.id, shopName: activeShop.name, items, addressText: target.addressText, updatedAt: Date.now() } });
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
  const cartShop = useMemo(() => {
    if (!ds || !cart?.shopId) return null;
    return ds.shops.find(s => s.id === cart.shopId) || null;
  }, [ds, cart?.shopId]);
  const cartCount = cart?.items.reduce((a, i) => a + i.qty, 0) || 0;
  const cartTotal = cart ? sumMoney(cart.items.map(i => i.lineTotal)) : 0;

  // ── 下单：银行卡扣款（存钱罐 BankFullState.cards，默认卡优先）──
  const placeOrder = async () => {
    if (!target || !cart || cart.items.length === 0) return;
    setPayErr('');
    const bank = await DB.getBankState();
    let cards = bank?.cards || [];
    if (cards.length === 0) {
      // 初始卡：余额 520（拟真），用户可在存钱罐里改
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
      shopId: cart.shopId!, shopName: cart.shopName!,
      shopCat: cartShop?.cat || '美食外卖',
      items: cart.items, itemCount: cart.items.reduce((a, i) => a + i.qty, 0),
      subtotal: cartTotal, deliveryFee: cartShop?.deliveryFee ?? 0,
      total: roundMoney(cartTotal + (cartShop?.deliveryFee ?? 0)),
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
      note: `${order.shopName} × ${order.itemCount} 件（${actorIsChar ? target.name + '自己点单的' : target.type === 'char' ? '给' + target.name + '点的' : '自购'}）`,
      timestamp: order.createdAt, dateStr: new Date(order.createdAt).toISOString().slice(0, 10),
    });
    await DB.saveShoppingOrder(order);

    // 给 char 点单 → 落一条带标签的 user 消息（聊天界面正则替换为订单卡）
    if (target.type === 'char' && target.charId) {
      await DB.saveMessage({
        charId: target.charId, role: 'user', type: 'shopping_order', metadata: { orderId: order.id, status: order.status, shop: order.shopName, total: order.total, recipient: order.recipientName },
        content: `我给你点了${order.shopName}的外卖～\n${buildShoppingOrderTag(order)}`,
      } as any);
      // bump lastMsgTimestamp：当前开着该聊天就实时刷新（user 消息不补未读/toast）
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

  // ── 深链回跳（?openApp=shopping&orderId=xxx / 聊天卡 CustomEvent）──
  useEffect(() => {
    const openOrder = (e: Event) => {
      const id = (e as CustomEvent).detail?.orderId;
      if (id) { setDetailOrderId(id); setView('orderDetail'); }
    };
    window.addEventListener('sullyos:open-takeout-order', openOrder);
    const url = new URL(window.location.href);
    const orderId = url.searchParams.get('orderId');
    if (url.searchParams.get('openApp') === 'takeout' && orderId) {
      setDetailOrderId(orderId); setView('orderDetail');
      url.searchParams.delete('openApp'); url.searchParams.delete('orderId');
      window.history.replaceState({}, '', url.toString());
    }
    // 深链兜底：事件可能在 App 挂载前派发（activeMsgRuntime 先清了 URL），
    // 那条路径会把 orderId 冻进 sessionStorage，这里补读一次。
    try {
      const pending = sessionStorage.getItem('sullyos_takeout_open_order');
      if (pending) {
        sessionStorage.removeItem('sullyos_takeout_open_order');
        setDetailOrderId(pending);
        setView('orderDetail');
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('sullyos:open-takeout-order', openOrder);
  }, []);

  // ── 订单转发到聊天（任意会话）──
  const forwardOrder = async (o: ShoppingOrder, charId: string) => {
    await DB.saveMessage({
      charId, role: 'user', type: 'shopping_order', metadata: { orderId: o.id, status: o.status, shop: o.shopName, total: o.total, recipient: o.recipientName },
      content: `（转发订单）${o.shopName} 的点单～\n${buildShoppingOrderTag(o)}`,
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
      {/* 顶栏：返回 + 地点 pill（右上角切换 点给谁）*/}
      <div className="shrink-0 px-3 pt-2 pb-1 bg-gradient-to-r from-amber-400 to-orange-400">
        <div className="flex items-center justify-between">
          {view === 'list' ? (
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-white">外卖</span>
              <button onClick={closeApp} title="退出外卖" className="flex items-center gap-0.5 px-2 py-1 rounded-full bg-white/25 text-white text-[11px] font-bold hover:bg-white/40">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                退出
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {backBtn(view === 'shop' ? '返回店铺列表' : view === 'orders' ? '返回首页' : '返回', () => {
                if (view === 'shop') setView('list');
                else if (view === 'orders' || view === 'checkout') setView('list');
                else setView('orders');
              })}
              <button onClick={closeApp} title="退出外卖" className="flex items-center gap-0.5 px-2 py-1 rounded-full bg-white/25 text-white text-[11px] font-bold hover:bg-white/40">
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

      {view === 'list' && (
        <>
          {/* 搜索框 */}
          <div className="shrink-0 px-3 pt-2 pb-2 bg-white">
            <div className="flex items-center gap-2 bg-slate-100 rounded-full px-3 py-2">
              <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" /></svg>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜店铺 / 商品，如：蜜雪冰城、柠檬水、布洛芬"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
              />
              {query && (
                <button onClick={() => setQuery('')} className="w-5 h-5 rounded-full bg-slate-300 text-white flex items-center justify-center text-[11px] shrink-0">×</button>
              )}
            </div>
          </div>
          {/* 品类宫格 */}
          <div className="shrink-0 grid grid-cols-4 gap-y-2 px-2 pt-3 pb-2 bg-white">
            <button onClick={() => setActiveCat('all')} className={`flex flex-col items-center gap-1 ${activeCat === 'all' ? 'opacity-100' : 'opacity-70'}`}>
              <span className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xl ${activeCat === 'all' ? 'bg-amber-100 ring-2 ring-amber-300' : 'bg-slate-50'}`}>🧭</span>
              <span className="text-[10px]">全部</span>
            </button>
            {SHOP_CATEGORIES.map(c => (
              <button key={c} onClick={() => setActiveCat(c)} className="flex flex-col items-center gap-1">
                <span className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xl ${activeCat === c ? 'bg-amber-100 ring-2 ring-amber-300' : 'bg-slate-50'}`}>{EMOJI_FALLBACK[c]}</span>
                <span className="text-[10px]">{c}</span>
              </button>
            ))}
          </div>
          {/* 店铺列表 */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 animate-fade-soft">
            {q && dishHits.length > 0 && (
              <div className="bg-white rounded-2xl p-3">
                <div className="text-[12px] font-bold text-slate-700 mb-2">🛒 找到 {dishHits.length} 件商品（含全城其它店）</div>
                <div className="space-y-1.5">
                  {dishHits.map(({ dish, shop }) => (
                    <div key={dish.id} onClick={() => { setActiveShop(shop); setView('shop'); }}
                      className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-slate-50 cursor-pointer">
                      <GoodsSvg imgKey={dish.imgKey} name={dish.name} className="w-9 h-9 rounded-lg" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-bold truncate">{dish.name}</div>
                        <div className="text-[10px] text-slate-400 truncate">{shop.name}{dish.qty ? ` · ${dish.qty}` : ''}</div>
                      </div>
                      <span className="text-[12px] font-bold text-orange-500 shrink-0">¥{formatMoney(dish.price)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {q && visibleShops.length === 0 && dishHits.length === 0 && (
              <div className="text-center text-[12px] text-slate-400 py-10">没找到「{query}」相关的店铺或商品</div>
            )}
            {pagedShops.map(s => (
              <div key={s.id} onClick={() => { setActiveShop(s); setView('shop'); }}
                className="flex gap-3 bg-white rounded-2xl p-3 shadow-sm active:scale-[0.99] transition-transform cursor-pointer">
                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center text-2xl shrink-0">
                  {EMOJI_FALLBACK[s.cat] || '🏪'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-bold truncate">{s.name}</span>
                    {q && dishHitShopIds.has(s.id) && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">有你要的货</span>
                    )}
                  </div>
                  <div className="text-[11px] text-amber-500 font-bold mt-0.5">★ {s.rating?.toFixed(1) || '4.5'} <span className="text-slate-400 font-normal">月售{s.monthlySales || 0}</span></div>
                  <div className="text-[10px] text-slate-400 mt-0.5">起送¥{formatMoney(s.minOrder || 0)} · 配送¥{formatMoney(s.deliveryFee || 0)} · {s.deliveryTime || '30分钟'} · {s.cat}</div>
                </div>
                <div className="self-center text-slate-300 shrink-0">›</div>
              </div>
            ))}
            {visibleShops.length === 0 && <div className="text-center text-[12px] text-slate-400 py-10">该品类暂无店铺</div>}
            {pagedShops.length < visibleShops.length ? (
              <div ref={shopSentinelRef} className="flex items-center justify-center py-4 text-slate-400"><LoaderDots /></div>
            ) : (
              visibleShops.length > 0 && <div className="text-center text-[11px] text-slate-400 py-3">已全部加载</div>
            )}
          </div>
          {/* 底部：购物车条 + 订单入口 */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-t border-slate-100">
            <button onClick={() => setView('orders')} className="text-[12px] text-slate-500 shrink-0">📋 订单</button>
            <div className="flex-1" />
            {cart && cart.items.length > 0 && (
              <button onClick={() => setView('checkout')} className="flex items-center gap-2 px-4 py-2 rounded-full bg-amber-400 text-white text-[13px] font-bold">
                🛒 {cartCount} 件 · ¥{formatMoney(cartTotal)} 去结算
              </button>
            )}
          </div>
        </>
      )}

      {view === 'shop' && activeShop && (
        <>
          <div className="flex-1 overflow-y-auto animate-page-in-l">
            <div className="px-4 pt-3 pb-3 bg-gradient-to-br from-amber-50 to-orange-50">
              <div className="text-[16px] font-bold">{activeShop.name}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">★ {activeShop.rating?.toFixed(1)} · 月售{activeShop.monthlySales} · {activeShop.deliveryTime}</div>
            </div>
            <div className="px-3 pb-24 space-y-2">
              {shopMenu.map(d => (
                <div key={d.id} className="flex gap-3 bg-white rounded-xl p-2.5">
                  <GoodsSvg imgKey={d.imgKey} name={d.name} className="w-14 h-14 rounded-lg" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold truncate">{d.name}</div>
                    <div className="text-[10px] text-slate-400 truncate">{d.qty || d.desc || d.cat}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[14px] font-bold text-orange-500">¥{formatMoney(d.price)}</span>
                      <div className="flex items-center gap-1.5">
                        {(() => {
                          const inCart = cart?.items.find(i => i.dishId === d.id);
                          return inCart ? (
                            <div className="flex items-center gap-1.5">
                              <button onClick={e => { e.stopPropagation(); changeQty(d.id, -1); }} className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold">−</button>
                              <span className="text-[12px] font-bold w-4 text-center">{inCart.qty}</span>
                            </div>
                          ) : null;
                        })()}
                        <button onClick={e => { e.stopPropagation(); addToCart(d); }} className="w-6 h-6 rounded-full bg-amber-400 text-white flex items-center justify-center font-bold">+</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {shopMenu.length === 0 && <div className="text-center text-[12px] text-slate-400 py-10">菜单整理中…</div>}
            </div>
          </div>
          {cart && cart.items.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-t border-slate-100">
              <button onClick={() => setView('checkout')} className="flex-1 flex items-center gap-2 px-4 py-2 rounded-full bg-amber-400 text-white text-[13px] font-bold justify-center">
                🛒 {cartCount} 件 · ¥{formatMoney(cartTotal)} 去结算
              </button>
            </div>
          )}
        </>
      )}

      {view === 'checkout' && cart && (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 animate-page-in-l">
          <div className="bg-white rounded-2xl p-4">
            <div className="text-[13px] font-bold mb-1">收货信息</div>
            <div className="text-[12px] text-slate-500">{target.type === 'user' ? '送给我自己' : `送给 ${target.name}`}</div>
            <div className="text-[12px] text-slate-500">📍 {target.addressText || '（未填地址）'}</div>
          </div>
          <div className="bg-white rounded-2xl p-4 space-y-2">
            <div className="text-[13px] font-bold">{cart.shopName}</div>
            {cart.items.map(i => (
              <div key={i.dishId} className="flex justify-between text-[12px]">
                <span className="truncate">{i.name} × {i.qty}</span>
                <span className="shrink-0 ml-2">¥{formatMoney(i.lineTotal)}</span>
              </div>
            ))}
            <div className="border-t border-slate-100 pt-2 flex justify-between text-[13px] font-bold">
              <span>合计{cartShop ? `（含配送费¥${formatMoney(cartShop.deliveryFee || 0)}）` : ''}</span>
              <span className="text-orange-500">¥{formatMoney(cartTotal + (activeShop?.deliveryFee || 0))}</span>
            </div>
          </div>
          {payErr && <div className="text-[12px] text-red-500 bg-red-50 rounded-xl px-3 py-2">{payErr}</div>}
          <button onClick={placeOrder} className="w-full py-3 rounded-full bg-amber-400 text-white text-[14px] font-bold">
            银行卡支付 ¥{formatMoney(cartTotal + (cartShop?.deliveryFee || 0))}
          </button>
          <div className="text-[10px] text-slate-300 text-center">模拟支付 · 扣款走存钱罐银行卡</div>
        </div>
      )}

      {view === 'orders' && (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 animate-page-in-l">
          {visibleOrders.map(o => (
            <div key={o.id} onClick={() => { setDetailOrderId(o.id); setView('orderDetail'); }} className="bg-white rounded-2xl p-3 cursor-pointer">
              <div className="flex justify-between items-center">
                <span className="text-[13px] font-bold truncate">{o.shopName}</span>
                <span className="text-[11px] text-amber-500 shrink-0">{ORDER_STATUS_LABEL[o.status]}</span>
              </div>
              <div className="text-[11px] text-slate-400 truncate mt-0.5">{o.items.map(i => `${i.name}×${i.qty}`).join('、')}</div>
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-slate-400">{o.recipientType === 'char' ? `给${o.recipientName}点的` : '自购'} · {o.cardLabel}</span>
                <span className="text-[13px] font-bold">¥{formatMoney(o.total)}</span>
              </div>
            </div>
          ))}
          {visibleOrders.length === 0 && <div className="text-center text-[12px] text-slate-400 py-10">还没有订单</div>}
          {orders.length > visibleOrders.length && (
            <button onClick={() => setShowAllOrders(true)} className="w-full text-center text-[12px] text-slate-500 py-2.5 bg-white rounded-2xl">展开全部 {orders.length} 条订单（含同店历史）</button>
          )}
          {showAllOrders && orders.length > visibleOrders.length - 1 && orders.length > 1 && (
            <button onClick={() => setShowAllOrders(false)} className="w-full text-center text-[12px] text-slate-500 py-2.5 bg-white rounded-2xl">收起，只看每店最新一单</button>
          )}
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
                <span className="text-[13px] font-bold text-orange-500">¥{formatMoney(o.total)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">订单号 {o.id} · {o.cardLabel}</div>
              {o.status !== 'delivered' && o.status !== 'cancelled' && (
                <button
                  onClick={() => {
                    const next: ShoppingOrder = { ...o, status: 'delivered', statusHistory: [...o.statusHistory, { status: 'delivered', at: Date.now() }], deliveredAt: Date.now() };
                    DB.saveShoppingOrder(next); setOrders(prev => prev.map(x => x.id === o.id ? next : x));
                  }}
                  className="mt-3 w-full py-2.5 rounded-full bg-emerald-400 text-white text-[13px] font-bold">立即送达</button>
              )}
            </div>
            <div className="bg-white rounded-2xl p-4 space-y-1">
              <div className="text-[13px] font-bold">{o.shopName}</div>
              {o.items.map(i => (
                <div key={i.dishId} className="flex justify-between text-[12px]">
                  <span className="truncate">{i.name} × {i.qty}</span><span>¥{formatMoney(i.lineTotal)}</span>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-2xl p-4 text-[12px] text-slate-500 space-y-1">
              <div>📍 {o.addressText}</div>
              <div>{o.recipientType === 'char' ? `送给 ${o.recipientName}` : '送给我自己'}</div>
              <div>下单时间 {new Date(o.createdAt).toLocaleString()}</div>
            </div>
          </div>
        );
      })()}

      {/* 地点切换弹层（我的地址 / char 的地址）*/}
      {targetSel && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-end animate-fade-in" onClick={() => setTargetSel(false)}>
          <div className="w-full bg-white rounded-t-3xl p-4 space-y-2 animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[14px] font-bold">选择收货地址</div>
              <button onClick={() => { setAddrDraft(target?.addressText || ''); setEditAddr(true); }} className="text-[11px] text-amber-500 font-bold">编辑当前地址</button>
            </div>
            {editAddr && (
              <div className="flex gap-2 mb-2">
                <input value={addrDraft} onChange={e => setAddrDraft(e.target.value)}
                  placeholder="如：北京市朝阳区望京SOHO T1 2501（城市标签可写开头）"
                  className="flex-1 text-[12px] px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-amber-300" />
                <button onClick={() => updateTargetAddress(addrDraft.trim())} className="px-3 py-2 rounded-xl bg-amber-400 text-white text-[12px] font-bold shrink-0">保存</button>
              </div>
            )}
            {targets.map(t => {
              const disabled = t.type === 'char' && !t.addressText;
              return (
                <button key={cartKeyOf(t)} disabled={disabled}
                  onClick={() => { setTarget(t); setTargetSel(false); }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-2 ${disabled ? 'opacity-40' : 'hover:bg-slate-50'} ${target && cartKeyOf(t) === cartKeyOf(target) ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-slate-50'}`}>
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