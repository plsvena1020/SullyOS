// scripts/assign-dish-cat.mjs 的类型声明（供 utils/shoppingData.test.ts 等 TS 侧导入）
export function assignDishCat(shopCat: string, dishName: string, origCat?: string): string;
export function recatDishes<T extends { shopId: string; name: string; cat?: string }>(
  dishes: T[],
  shopCatOf: (shopId: string) => string,
): T[];
