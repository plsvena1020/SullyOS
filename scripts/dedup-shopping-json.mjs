// 同名店面去重 —— shops.json / dishes.json 源头瘦身 + 防再生。
//
// 背景：shops.json（OSM 抓取）里同一连锁品牌每个分店一条记录（肯德基 191 家、
// 星巴克 340 家……），不去重的话外卖列表会被同名店刷屏。运行时兜底见
// utils/shoppingData.ts（dedupShopsByName），规则与本脚本保持一致，改规则时两处同步。
//
// 用法（仓库根目录）：
//   node scripts/dedup-shopping-json.mjs
// gen-shopping-data.mjs 也会 import { dedupShoppingDataset }，再生数据时自动去重。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOPS_PATH = path.join(ROOT, 'public', 'shopping', 'shops.json');
const DISHES_PATH = path.join(ROOT, 'public', 'shopping', 'dishes.json');

// ── 以下规则与 utils/shoppingData.ts 的同名函数逐行对应 ──

/** 商品/店名归一化（去空白/全角/小写/剥括号后缀） */
export function normalizeGoodName(name) {
  let s = String(name || '').replace(/[　\s]+/g, '');
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.toLowerCase();
  s = s.replace(/[\(\[\{（【｛][^\)\]\}）】｝]*[\)\]\}）】｝]/g, '');
  return s;
}

const BRAND_EXACT = {
  'coco都可': 'coco',
  '联华超市': '联华',
  '可的•kedi': '可的',
};

const BRAND_PREFIX = [
  ['星巴克', '星巴克'],
  ['物美', '物美'],
  ['喜士多', '喜士多'],
  ['宏状元', '宏状元'],
  ['快客', '快客'],
  ['巴依老爷', '巴依老爷'],
  ['嘉和一品', '嘉和一品'],
  ['沃尔玛', '沃尔玛'],
  ['护国寺小吃', '护国寺小吃'],
  ['世纪联华', '世纪联华'],
  ['四季民福', '四季民福'],
  ['好邻居', '好邻居'],
  ['海王星辰', '海王星辰'],
  ['沙县小吃', '沙县小吃'],
  ['超市发', '超市发'],
];

/** 店面去重键：归一店名 → 品牌变体 → 默认归一店名本身 */
export function shopDedupKey(name) {
  const n = normalizeGoodName(name);
  const exact = BRAND_EXACT[n];
  if (exact) return exact;
  for (const [p, canon] of BRAND_PREFIX) {
    if (n.startsWith(p)) return canon;
  }
  return n;
}

function shopScore(s) {
  return (s.monthlySales || 0) + (s.rating || 0) * 1000;
}

/** 同名店面去重：同组只保留一家（组内出现最多的原始店名；平票取分高者） */
export function dedupShopsByName(shops) {
  const groups = new Map();
  const order = [];
  for (const s of shops) {
    const k = shopDedupKey(s.name);
    const g = groups.get(k);
    if (!g) { groups.set(k, [s]); order.push(k); }
    else g.push(s);
  }
  const out = [];
  for (const k of order) {
    const g = groups.get(k);
    if (g.length === 1) { out.push(g[0]); continue; }
    const nameCount = new Map();
    for (const s of g) nameCount.set(s.name, (nameCount.get(s.name) || 0) + 1);
    let best = g[0];
    for (const s of g) {
      const cn = nameCount.get(s.name);
      const bn = nameCount.get(best.name);
      if (cn > bn || (cn === bn && shopScore(s) > shopScore(best))) best = s;
    }
    out.push(best);
  }
  return out;
}

/** 店铺+菜品整体去重：被移除分店的菜品直接丢弃（同品牌各店菜单相同，无需合并） */
export function dedupShoppingDataset(shops, dishes) {
  const keptShops = dedupShopsByName(shops);
  const keptIds = new Set(keptShops.map(s => s.id));
  return { shops: keptShops, dishes: dishes.filter(d => keptIds.has(d.shopId)) };
}

function main() {
  const shops = JSON.parse(fs.readFileSync(SHOPS_PATH, 'utf8'));
  const dishes = JSON.parse(fs.readFileSync(DISHES_PATH, 'utf8'));

  // 合并组统计（Top 10）
  const groups = new Map();
  for (const s of shops) {
    const k = shopDedupKey(s.name);
    const g = groups.get(k);
    if (!g) groups.set(k, []);
    groups.get(k).push(s);
  }
  const merged = [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
  for (const g of merged.slice(0, 10)) {
    const names = [...new Set(g.map(s => s.name))];
    console.log(`merge ${g.length}x ${names.join(' / ')}`);
  }

  const { shops: out, dishes: dout } = dedupShoppingDataset(shops, dishes);

  // 完整性断言：去重后无重复键、菜品引用全部有效
  const keys = new Set(out.map(s => shopDedupKey(s.name)));
  if (keys.size !== out.length) throw new Error('dedup failed: duplicate keys remain');
  const keptIds = new Set(out.map(s => s.id));
  const orphan = dout.filter(d => !keptIds.has(d.shopId));
  if (orphan.length > 0) throw new Error(`dedup failed: ${orphan.length} orphan dishes`);

  const mb = n => (n / 1024 / 1024).toFixed(2) + 'MB';
  fs.writeFileSync(SHOPS_PATH, JSON.stringify(out));
  fs.writeFileSync(DISHES_PATH, JSON.stringify(dout));
  console.log(`shops: ${shops.length} -> ${out.length} (${SHOPS_PATH}, ${mb(fs.statSync(SHOPS_PATH).size)})`);
  console.log(`dishes: ${dishes.length} -> ${dout.length} (${DISHES_PATH}, ${mb(fs.statSync(DISHES_PATH).size)})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
