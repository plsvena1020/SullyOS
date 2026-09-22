// 一次性修复：菜单被池子取菜步长卡住的店铺。
//
// 背景：gen-shopping-data.mjs 的独立小店菜单用 `pool[(h + i * 3) % len]` 取菜，
// 当池长与 3 不互质（len 6/9）时每店只能取到 2-3 种菜并重复多遍，运行时同店去重后
// 菜单只剩两三道。本脚本按修正后的步长 `(h + i) % len` 重建这些店的菜单：
// 同名菜复用原对象（保留 id/价格，购物车引用不失效），缺的按原公式补新菜。
// gen-shopping-data.mjs 已同步修正步长，再生数据不会再出现该问题。
//
// 用法（仓库根目录）：node scripts/repair-shopping-menus.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignDishCat } from './assign-dish-cat.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOPS_PATH = path.join(ROOT, 'public', 'shopping', 'shops.json');
const DISHES_PATH = path.join(ROOT, 'public', 'shopping', 'dishes.json');

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
const jitter = (seed, pct) => 1 + (((hash32(seed) % 200) / 1000) * pct * 2 - pct);

// 与 gen-shopping-data.mjs 的 CAT_POOLS 逐项对应（[菜名, 价格锚点]，只需小店用到的池子）
const CAT_POOLS = {
  '美食外卖': [
    [['红烧肉套餐饭', 28], ['鱼香肉丝饭', 22], ['宫保鸡丁饭', 23], ['番茄炒蛋饭', 18], ['青椒肉丝饭', 21], ['麻婆豆腐饭', 20], ['回锅肉饭', 24], ['酸辣土豆丝', 17], ['紫菜蛋花汤', 6], ['可乐', 3]],
    [['牛肉面', 15], ['炸酱面', 14], ['酸辣粉', 12], ['米线', 13], ['刀削面', 14], ['饺子(12只)', 15], ['鲜肉馄饨', 11], ['葱油拌面', 12], ['卤蛋', 2.5]],
    [['烤羊肉串', 5], ['烤韭菜', 6], ['烤茄子', 15], ['烤鸡翅', 8], ['锡纸花甲', 28], ['烤面筋', 5], ['蒜蓉生蚝', 32], ['冰镇酸梅汤', 6]],
    [['韩式炸鸡(半只)', 32], ['蜂蜜芥末酱', 2], ['薯饼', 8], ['鸡米花', 12], ['芝士球', 15], ['可乐', 4], ['柠檬茶', 9]],
    [['酸菜鱼(单人)', 36], ['水煮肉片', 32], ['毛血旺', 38], ['小炒黄牛肉', 42], ['干锅花菜', 22], ['米饭', 3]],
  ],
  '奶茶饮品': [
    [['珍珠奶茶', 10], ['茉莉奶绿', 11], ['杨枝甘露', 14], ['柠檬水', 6], ['四季春茶', 7], ['布丁奶茶', 10], ['奶盖茶', 13]],
    [['美式咖啡', 12], ['拿铁', 15], ['生椰拿铁', 16], ['手冲咖啡', 22], ['抹茶拿铁', 17], ['燕麦拿铁', 18]],
  ],
  '甜品蛋糕': [
    [['生日蛋糕(6寸)', 128], ['提拉米苏', 28], ['泡芙', 12], ['曲奇饼干', 18], ['蛋挞', 6], ['芝士蛋糕', 32], ['戚风蛋糕', 45]],
    [['牛角包', 9], ['全麦吐司', 12], ['肉松面包', 10], ['红豆面包', 8], ['蛋糕卷', 16], ['司康', 8]],
  ],
  '超市便利': [
    [['桶装面', 5.5], ['矿泉水', 2], ['可乐', 3.5], ['卤蛋', 2.5], ['关东煮', 6], ['饭团', 7.5], ['三明治', 9.9], ['酸奶', 6.5], ['纸巾', 8], ['电池', 10]],
  ],
  '生鲜果蔬': [
    [['苹果(500g)', 7.9], ['香蕉(500g)', 5.9], ['西红柿(500g)', 6.8], ['土豆(500g)', 4.5], ['鸡蛋(10枚)', 13.9], ['五花肉(500g)', 26.8], ['草莓(盒装)', 19.9], ['绿叶菜(份)', 4.9]],
    [['三文鱼刺身', 39.9], ['基围虾(500g)', 35], ['鲈鱼(条)', 28], ['花甲(500g)', 12.9], ['海带结(份)', 5.9]],
  ],
  '医药健康': [
    [['布洛芬缓释胶囊', 19.9], ['感冒灵颗粒', 15.5], ['创可贴(20片)', 6.5], ['医用口罩(50只)', 19.9], ['维生素C咀嚼片', 29.9], ['体温计', 12.9], ['碘伏消毒液', 8.5], ['风油精', 6.8]],
  ],
  '鲜花绿植': [
    [['红玫瑰花束(11朵)', 99], ['向日葵花束', 79], ['康乃馨花束', 69], ['多肉盆栽', 15.9], ['绿萝', 25], ['干花花束', 59], ['花瓶', 39.9]],
  ],
};
const FOOD_IMGKEY = {
  '美食外卖': 'food', '奶茶饮品': 'drink', '甜品蛋糕': 'dessert',
  '超市便利': 'snack', '生鲜果蔬': 'fresh', '医药健康': 'health', '鲜花绿植': 'flower',
};

const shops = JSON.parse(fs.readFileSync(SHOPS_PATH, 'utf8'));
const dishes = JSON.parse(fs.readFileSync(DISHES_PATH, 'utf8'));
const shopCat = new Map(shops.map(s => [s.id, s.cat]));
const shopName = new Map(shops.map(s => [s.id, s.name]));

const tupleKey = d => [d.name, d.brand || '', d.qty || ''].join('|');

// 1) 圈定受影响店铺：同店存在完全重复菜品（与运行时去重键同口径）
const byShop = new Map();
for (const d of dishes) {
  const list = byShop.get(d.shopId) || [];
  list.push(d);
  byShop.set(d.shopId, list);
}
const affected = new Set();
for (const [id, list] of byShop) {
  const ks = list.map(tupleKey);
  if (new Set(ks).size !== ks.length) affected.add(id);
}

// 2) 逐店重建菜单
let maxSeq = 0;
for (const d of dishes) {
  const m = /^d(\d+)$/.exec(d.id || '');
  if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
}
const replaced = new Map(); // shopId -> 新菜单
const dropped = [];
for (const id of affected) {
  const list = byShop.get(id);
  const names = [...new Set(list.map(d => d.name))];
  const cat = shopCat.get(id) || '';
  const pools = CAT_POOLS[cat] || [];
  const pool = pools.find(p => names.every(n => p.some(([pn]) => pn === n)));
  if (!pool) { // 认不出池子：只去重（保留首个）
    const seen = new Set();
    replaced.set(id, list.filter(d => (seen.has(tupleKey(d)) ? false : (seen.add(tupleKey(d)), true))));
    dropped.push({ id, name: shopName.get(id), names });
    continue;
  }
  const h = hash32(id);
  const per = Math.min(pool.length, 7 + (h % 4));
  const byName = new Map();
  for (const d of list) if (!byName.has(d.name)) byName.set(d.name, d);
  const imgKey = FOOD_IMGKEY[cat] || 'food';
  const menu = [];
  for (let i = 0; i < per; i++) {
    const [name, base] = pool[(h + i) % pool.length];
    const old = byName.get(name);
    if (old) { menu.push(old); continue; }
    menu.push({
      id: 'd' + (++maxSeq),
      shopId: id,
      name,
      price: Math.round(base * jitter(id + name, 0.12) * 10) / 10,
      cat: assignDishCat(cat, name, i === 0 ? '招牌推荐' : '热销'),
      imgKey,
    });
  }
  replaced.set(id, menu);
}

// 3) 回写：受影响店铺的新菜单放在其首道菜原位置，其余顺序不变
const out = [];
const done = new Set();
for (const d of dishes) {
  const id = d.shopId;
  if (!affected.has(id)) { out.push(d); continue; }
  if (done.has(id)) continue;
  done.add(id);
  out.push(...replaced.get(id));
}

// 4) 断言：无重复键
const byShop2 = new Map();
for (const d of out) {
  const list = byShop2.get(d.shopId) || [];
  list.push(d);
  byShop2.set(d.shopId, list);
}
let dupLeft = 0;
for (const [, list] of byShop2) {
  const ks = list.map(tupleKey);
  if (new Set(ks).size !== ks.length) dupLeft++;
}
if (dupLeft > 0) throw new Error(`repair failed: ${dupLeft} shops still have duplicate dishes`);

fs.writeFileSync(DISHES_PATH, JSON.stringify(out));
console.log(`repaired shops: ${affected.size} (unmatched fallback: ${dropped.length})`);
if (dropped.length) console.log('fallback sample:', JSON.stringify(dropped.slice(0, 5)));
console.log(`dishes: ${dishes.length} -> ${out.length}`);

const samples = [shops.find(s => s.name === '肯德基'), shops.find(s => affected.has(s.id))];
for (const shop of samples) {
  if (!shop) continue;
  const menu = out.filter(d => d.shopId === shop.id);
  console.log(`${shop.name}(${menu.length}):`, menu.map(d => `${d.cat}:${d.name}`).join(' | '));
}
