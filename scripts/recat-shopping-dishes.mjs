// 一次性重标 dishes.json 的菜品品类（存量数据瘦身修复：原先只有招牌推荐/热销两种）。
// 规则见 scripts/assign-dish-cat.mjs（gen-shopping-data.mjs 再生数据时用同一函数）。
//
// 用法（仓库根目录）：node scripts/recat-shopping-dishes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recatDishes } from './assign-dish-cat.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOPS_PATH = path.join(ROOT, 'public', 'shopping', 'shops.json');
const DISHES_PATH = path.join(ROOT, 'public', 'shopping', 'dishes.json');

function catDist(dishes) {
  const byShop = new Map();
  for (const d of dishes) {
    const set = byShop.get(d.shopId) || new Set();
    set.add(d.cat);
    byShop.set(d.shopId, set);
  }
  const dist = {};
  for (const set of byShop.values()) dist[set.size] = (dist[set.size] || 0) + 1;
  const catCount = {};
  for (const d of dishes) catCount[d.cat] = (catCount[d.cat] || 0) + 1;
  return { dist, catCount };
}

const shops = JSON.parse(fs.readFileSync(SHOPS_PATH, 'utf8'));
const dishes = JSON.parse(fs.readFileSync(DISHES_PATH, 'utf8'));
const shopCat = new Map(shops.map(s => [s.id, s.cat]));

const out = recatDishes(dishes, id => shopCat.get(id) || '');

const before = catDist(dishes);
const after = catDist(out);
console.log('每店品类数分布(前):', before.dist);
console.log('每店品类数分布(后):', after.dist);
console.log('品类计数(后):', after.catCount);

fs.writeFileSync(DISHES_PATH, JSON.stringify(out));

const kfc = shops.find(s => s.name === '肯德基');
if (kfc) {
  const menu = out.filter(d => d.shopId === kfc.id).map(d => `${d.cat}:${d.name}`);
  console.log('肯德基菜单:', menu.join(' | '));
}
