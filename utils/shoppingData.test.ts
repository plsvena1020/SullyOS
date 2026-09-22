import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shopDedupKey, dedupShopsByName } from './shoppingData';

const mkShop = (id: string, name: string, rating = 4.5, monthlySales = 500) => ({
  id,
  name,
  cat: '美食外卖',
  rating,
  monthlySales,
});

describe('shopDedupKey 同名店面归并键', () => {
  it('括号分店后缀归一', () => {
    expect(shopDedupKey('肯德基(五道口店)')).toBe(shopDedupKey('肯德基'));
    expect(shopDedupKey('7-Eleven（新闸路店）')).toBe('7-eleven');
  });

  it('连锁品牌变体名归并', () => {
    expect(shopDedupKey('星巴克咖啡')).toBe('星巴克');
    expect(shopDedupKey('星巴克Star')).toBe('星巴克');
    expect(shopDedupKey('星巴克S')).toBe('星巴克');
    expect(shopDedupKey('CoCo都可')).toBe(shopDedupKey('CoCo'));
    expect(shopDedupKey('联华超市')).toBe(shopDedupKey('联华'));
    expect(shopDedupKey('可的•KEDI')).toBe(shopDedupKey('可的'));
  });

  it('不误伤独立店', () => {
    expect(shopDedupKey('Coco Cafe')).not.toBe(shopDedupKey('CoCo'));
    expect(shopDedupKey('Coconut Paradise')).not.toBe(shopDedupKey('CoCo'));
    // 联华与世纪联华是不同店
    expect(shopDedupKey('世纪联华庆春店')).toBe('世纪联华');
    expect(shopDedupKey('世纪联华庆春店')).not.toBe(shopDedupKey('联华'));
  });
});

describe('dedupShopsByName 保留规则', () => {
  it('同名只留一家，取（月销+评分×1000）高者', () => {
    const out = dedupShopsByName([
      mkShop('a', '肯德基', 4.2, 100),
      mkShop('b', '肯德基', 4.9, 2000),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('b');
  });

  it('变体组取出现最多的原始店名（即使分数更低）', () => {
    const out = dedupShopsByName([
      mkShop('a', '星巴克', 4.2, 100),
      mkShop('b', '星巴克', 4.3, 200),
      mkShop('c', '星巴克Star', 5.0, 9999),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('星巴克');
  });

  it('不同名互不干扰，输出顺序按首现', () => {
    const out = dedupShopsByName([
      mkShop('b', '麦当劳'),
      mkShop('a', '肯德基'),
      mkShop('c', '星巴克'),
    ]);
    expect(out.map(s => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('shopping dataset 数据护栏', () => {
  const shops = JSON.parse(readFileSync(
    fileURLToPath(new URL('../public/shopping/shops.json', import.meta.url)), 'utf8'));
  const dishes = JSON.parse(readFileSync(
    fileURLToPath(new URL('../public/shopping/dishes.json', import.meta.url)), 'utf8'));

  it('shops.json 已无同名重复组（去重幂等）', () => {
    expect(shops.length).toBeGreaterThan(3000);
    expect(dedupShopsByName(shops)).toHaveLength(shops.length);
  });

  it('连锁大牌各只剩一家', () => {
    const count = (n: string) => shops.filter((s: any) => s.name === n).length;
    expect(count('肯德基')).toBe(1);
    expect(count('星巴克')).toBe(1);
    expect(count('麦当劳')).toBe(1);
  });

  it('dishes 的 shopId 全部存在于 shops', () => {
    const ids = new Set(shops.map((s: any) => s.id));
    expect(dishes.length).toBeGreaterThan(0);
    expect(dishes.every((d: any) => ids.has(d.shopId))).toBe(true);
  });

  it('同店无完全重复菜品，每店至少 3 道菜', () => {
    const byShop = new Map<string, any[]>();
    for (const d of dishes as any[]) {
      const list = byShop.get(d.shopId) || [];
      list.push(d);
      byShop.set(d.shopId, list);
    }
    expect(byShop.size).toBeGreaterThan(3000);
    for (const [shopId, list] of byShop) {
      const keys = list.map(d => [d.name, d.brand || '', d.qty || ''].join('|'));
      expect(new Set(keys).size, `店 ${shopId} 有重复菜品`).toBe(keys.length);
      expect(list.length, `店 ${shopId} 菜单过短`).toBeGreaterThanOrEqual(3);
    }
  });

  it('品类丰富度：美食外卖多数店有多个菜品品类，肯德基 ≥4 类', () => {
    const catOf = new Map(shops.map((s: any) => [s.id, s.cat]));
    const byShop = new Map<string, Set<string>>();
    for (const d of dishes as any[]) {
      const set = byShop.get(d.shopId) || new Set<string>();
      set.add(d.cat);
      byShop.set(d.shopId, set);
    }
    const food = [...byShop.entries()].filter(([id]) => catOf.get(id) === '美食外卖');
    const rich = food.filter(([, set]) => set.size >= 3).length;
    expect(rich / food.length).toBeGreaterThan(0.6);
    const kfc = (shops as any[]).find(s => s.name === '肯德基');
    expect(byShop.get(kfc.id)!.size).toBeGreaterThanOrEqual(4);
  });
});

describe('assignDishCat 菜品品类标注', () => {
  it('美食外卖按菜名归类', async () => {
    const { assignDishCat } = await import('../scripts/assign-dish-cat.mjs');
    expect(assignDishCat('美食外卖', '香辣鸡腿堡', '招牌推荐')).toBe('主食');
    expect(assignDishCat('美食外卖', '黄金鸡块(5块)', '热销')).toBe('小吃');
    expect(assignDishCat('美食外卖', '可乐', '热销')).toBe('饮品');
    expect(assignDishCat('美食外卖', '葡式蛋挞', '热销')).toBe('甜品');
    expect(assignDishCat('美食外卖', '香辣鸡腿堡套餐', '热销')).toBe('套餐');
    expect(assignDishCat('美食外卖', '水煮肉片', '热销')).toBe('热菜');
    expect(assignDishCat('美食外卖', '加州牛肉面', '热销')).toBe('主食');
    expect(assignDishCat('美食外卖', '加金针菇', '热销')).toBe('小吃');
  });

  it('医药健康分药品/用品', async () => {
    const { assignDishCat } = await import('../scripts/assign-dish-cat.mjs');
    expect(assignDishCat('医药健康', '感冒清热颗粒', '招牌推荐')).toBe('药品');
    expect(assignDishCat('医药健康', '医用口罩(50只)', '招牌推荐')).toBe('用品');
  });

  it('超市 OFF 商品分类与生鲜店标签原样保留', async () => {
    const { assignDishCat } = await import('../scripts/assign-dish-cat.mjs');
    expect(assignDishCat('超市便利', '纯牛奶', '乳品')).toBe('乳品');
    expect(assignDishCat('生鲜果蔬', '土豆(500g)', '热销')).toBe('热销');
  });
});
