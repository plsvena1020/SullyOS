// ============================================================
// 生成购物数据集：OSM 店铺 × 品牌 SKU 名录/OFF 真实商品 → shops.json + dishes.json
// 消费: public/shopping/shops-raw.json + public/shopping/off-products.json
// 产出: public/shopping/shops.json / dishes.json
// 用法: node scripts/gen-shopping-data.mjs
import fs from 'node:fs';
import { dedupShoppingDataset } from './dedup-shopping-json.mjs';
import { assignDishCat } from './assign-dish-cat.mjs';

const RAW = 'public/shopping/shops-raw.json';
const OFF = 'public/shopping/off-products.json';
const OUT_SHOPS = 'public/shopping/shops.json';
const OUT_DISHES = 'public/shopping/dishes.json';

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
let offProducts = [];
try { offProducts = JSON.parse(fs.readFileSync(OFF, 'utf8')).products || []; } catch { console.log('OFF products missing, skip real-goods layer'); }

// ── 确定性哈希（同一店铺每次生成结果一致）──
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
const jitter = (seed, pct) => 1 + (((hash32(seed) % 200) / 1000) * pct * 2 - pct); // ±pct

// ── 品牌 SKU 名录（真实连锁品牌的公开常见商品与价格锚点）──
const BRAND_SKUS = {
  '蜜雪冰城': [['冰鲜柠檬水', 4], ['蜜桃四季春', 7], ['珍珠奶茶', 6], ['摇摇奶昔', 6], ['圣代', 4], ['摩天脆脆冰淇淋', 3], ['满杯百香果', 7], ['红豆奶茶', 7], ['芋圆奶茶', 8], ['新鲜冰淇淋咖啡', 6]],
  '瑞幸': [['生椰拿铁', 9.9], ['厚乳拿铁', 10.9], ['标准美式', 9.9], ['橙C美式', 12.9], ['焦糖标准美式', 11.9], ['丝绒拿铁', 12.9], ['澳瑞白', 11.9], ['摇摇冻拿铁', 13.9]],
  '库迪': [['生椰拿铁', 9.9], ['米乳拿铁', 10.9], ['标准美式', 8.9], ['杨枝甘露', 12.9]],
  '星巴克': [['拿铁', 30], ['美式', 27], ['焦糖玛奇朵', 33], ['星冰乐', 36], ['冷萃', 32], ['馥芮白', 32]],
  '茶百道': [['杨枝甘露', 16], ['豆乳玉麒麟', 14], ['茉莉奶绿', 13], ['芋泥啵啵', 15], ['西柚粒粒橙', 14]],
  '沪上阿姨': [['血糯米奶茶', 13], ['五福桃桃', 15], ['芋圆波波奶茶', 14], ['茉莉奶绿', 12]],
  '古茗': [['芝士葡萄', 16], ['超级杯水果茶', 15], ['珍珠奶茶', 11], ['芝士奶盖', 14]],
  'CoCo': [['奶茶三兄弟', 15], ['鲜芋青稞奶茶', 16], ['百香果双响炮', 14]],
  '书亦烧仙草': [['烧仙草奶茶', 12], ['芋泥啵啵鲜奶茶', 15], ['杨枝甘露', 15]],
  '益禾堂': [['烤奶', 9], ['益禾烤奶', 12], ['珍珠奶茶', 8]],
  '麦当劳': [['巨无霸', 23.9], ['麦辣鸡腿堡', 20.9], ['板烧鸡腿堡', 23.9], ['麦乐鸡(5块)', 10.5], ['薯条(大)', 11.5], ['麦香鱼', 18.5], ['可口可乐', 8], ['圆筒冰淇淋', 4], ['麦乐鸡(10块)', 19.5], ['不素之霸', 24.9]],
  '肯德基': [['香辣鸡腿堡', 21.5], ['黄金鸡块(5块)', 11.5], ['薯条(大)', 12], ['吮指原味鸡(1块)', 13.5], ['葡式蛋挞', 8.5], ['香辣鸡腿堡套餐', 38], ['可乐', 8.5], ['疯狂星期四黄金鸡块', 9.9]],
  '华莱士': [['全鸡汉堡', 16], ['香辣鸡腿堡', 13.5], ['鸡米花', 10], ['可乐', 5], ['香辣鸡翅', 9]],
  '塔斯汀': [['北京烤鸭汉堡', 15.9], ['多汁牛肉汉堡', 17.9], ['龙岩麻椒鸡汉堡', 16.9], ['藤椒鸡腿堡', 15.9]],
  '必胜客': [['铁盘玛格丽特披萨', 49], ['超级至尊披萨', 69], ['意式肉酱面', 36], ['鸡翅(4只)', 26], ['小食拼盘', 45]],
  '沙县小吃': [['蒸饺', 6], ['拌面', 5], ['云吞', 8], ['炖罐', 9], ['妙香扁食', 9], ['茶叶蛋', 2]],
  '兰州拉面': [['牛肉面', 12], ['凉面', 11], ['烤羊肉串', 5], ['加蛋', 1.5], ['牛肉炒面', 15]],
  '黄焖鸡': [['黄焖鸡米饭(中)', 24], ['黄焖鸡米饭(大)', 30], ['加金针菇', 3], ['加土豆', 3], ['加宽粉', 3]],
  '张亮麻辣烫': [['荤素搭配(500g)', 26], ['冒菜', 28], ['麻辣拌', 25], ['加牛肉丸', 5]],
  '杨国福': [['荤素搭配(500g)', 27], ['番茄汤底', 2], ['麻辣拌', 26], ['加午餐肉', 5]],
  '老乡鸡': [['老母鸡汤', 20], ['辣椒炒肉', 28], ['咸鸭蛋蒸肉', 26], ['米饭', 3], ['手撕鸡', 32]],
  '吉野家': [['牛肉饭', 22], ['鸡肉饭', 20], ['小碗牛肉饭', 15], ['煎蛋', 3]],
  '真功夫': [['排骨饭', 28], ['香菇滑鸡饭', 26], ['冬菇肉饼饭', 25]],
  '李先生': [['加州牛肉面', 18], ['凉拌黄瓜', 8], ['卤蛋', 2.5]],
  '海底捞': [['番茄火锅(单人)', 89], ['麻辣香锅', 68], ['捞派毛肚', 48], ['虾滑', 39]],
  '好利来': [['半熟芝士', 19.8], ['脏脏包', 15.8], ['玫瑰芝士蛋糕', 22], ['毛毛虫面包', 12.8]],
  '鲍师傅': [['肉松小贝', 15], ['提子麻薯', 13], ['蛋黄酥', 8.8], ['凤梨酥', 9.9]],
  '幸福西饼': [['芒果千层(6寸)', 98], ['榴莲千层(6寸)', 128], ['爆浆巧克力蛋糕', 88]],
  '味多美': [['天然奶油蛋糕(小)', 38], ['菠萝包', 9.8], ['老婆饼', 7.5]],
  '同仁堂': [['感冒清热颗粒', 15.5], ['板蓝根颗粒', 12.8], ['藿香正气水', 9.9], ['六味地黄丸', 29.9], ['阿胶糕', 59]],
  '老百姓大药房': [['布洛芬缓释胶囊', 19.9], ['感冒灵颗粒', 15.5], ['医用外科口罩(50只)', 19.9], ['维生素C咀嚼片', 29.9], ['创可贴(20片)', 6.5]],
  '大参林': [['蒙脱石散', 16.8], ['碘伏消毒液', 8.5], ['体温计', 12.9], ['开塞露', 7.9], ['氯雷他定片', 18.5]],
  '益丰大药房': [['阿莫西林胶囊', 13.5], ['连花清瘟胶囊', 14.8], ['健胃消食片', 11.9], ['风油精', 6.8]],
  '一心堂': [['金银花露', 6.9], ['藿香正气胶囊', 12.5], ['维生素B族', 19.9]],
};

// 品牌匹配别名（店名包含即命中）
const BRAND_ALIAS = {
  '瑞幸': ['瑞幸', 'luckin', 'Luckin'], '库迪': ['库迪', 'Cotti'], '星巴克': ['星巴克', 'Starbucks'],
  'CoCo': ['coco', 'CoCo', '都可'], '麦当劳': ['麦当劳', 'McDonald'], '肯德基': ['肯德基', 'KFC'],
  '李先生': ['李先生'], '杨国福': ['杨国福'], '海底捞': ['海底捞'],
};

// ── 外卖品类 → SVG imgKey（GoodsSvg 渲染，无外链图）──
const FOOD_IMGKEY = {
  '美食外卖': 'food', '奶茶饮品': 'drink', '甜品蛋糕': 'dessert',
  '超市便利': 'snack', '生鲜果蔬': 'fresh', '医药健康': 'health', '鲜花绿植': 'flower',
  '休闲零食': 'snack', '粮油米面': 'snack', '饮料冲调': 'drink', '方便速食': 'food',
  '乳制品烘焙': 'dessert', '调味品': 'snack', '糖果巧克力': 'snack',
};
const shopCatImgKeyMap = new Map();
function shopCatImgKey(shopId) {
  const c = shopCatImgKeyMap.get(shopId) || '';
  return FOOD_IMGKEY[c] || 'food';
}

// ── 品类级菜单词库（独立小店，按 cuisine/店名关键词选池）──
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

// 店名/cuisine → 美食子池
function pickFoodPool(shop) {
  const key = (shop.cuisine || '') + '|' + (shop.name || '');
  if (/noodle|ramen|noodle|面|粉|拉面/.test(key)) return 1;
  if (/barbecue|bbq|烧烤|串/.test(key)) return 2;
  if (/chicken|burger|炸鸡|汉堡|fried/.test(key)) return 3;
  if (/sichuan|chinese|中餐|川|湘/.test(key)) return 4;
  return 0;
}

function brandOf(shop) {
  const hay = (shop.name || '') + '|' + (shop.brand || '');
  for (const [brand, aliases] of Object.entries(BRAND_ALIAS)) {
    if (aliases.some(a => hay.toLowerCase().includes(a.toLowerCase()))) return brand;
  }
  for (const brand of Object.keys(BRAND_SKUS)) {
    if (hay.includes(brand)) return brand;
  }
  return null;
}

// ── 店铺拟真字段 ──
const CAT_CONFIG = {
  '美食外卖': { minOrder: 20, feeMax: 4 },
  '奶茶饮品': { minOrder: 0, feeMax: 3 },
  '甜品蛋糕': { minOrder: 15, feeMax: 4 },
  '超市便利': { minOrder: 0, feeMax: 2 },
  '生鲜果蔬': { minOrder: 25, feeMax: 5 },
  '医药健康': { minOrder: 0, feeMax: 3 },
  '鲜花绿植': { minOrder: 0, feeMax: 6 },
};

function enrichShop(s) {
  const h = hash32(s.id);
  const cfg = CAT_CONFIG[s.cat] || { minOrder: 15, feeMax: 4 };
  return {
    id: s.id,
    name: s.name,
    cat: s.cat,
    // 去地域：不再输出city
    rating: 4.2 + (h % 8) / 10,
    monthlySales: 80 + (h % 2400),
    minOrder: cfg.minOrder,
    deliveryFee: h % 3 === 0 ? 0 : 1 + (h % cfg.feeMax),
    deliveryTime: (20 + (h % 25)) + '-' + (35 + (h % 30)) + '分钟',
  };
}

// ── 菜单生成 ──
const dishes = [];
let dishSeq = 0;
function pushDish(shopId, name, price, cat) {
  dishSeq++;
  dishes.push({ id: 'd' + dishSeq, shopId, name, price: Math.round(price * 10) / 10, cat, imgKey: shopCatImgKey(shopId) });
}

const shopsOut = [];
for (const s of raw) {
  const shop = enrichShop(s);
  shopsOut.push(shop);
  shopCatImgKeyMap.set(s.id, s.cat);
  const h = hash32(s.id);
  const brand = brandOf(s);

  if (brand && BRAND_SKUS[brand]) {
    // 品牌店 → 品牌 SKU（确定性抖动 ±8%）
    for (const [name, base] of BRAND_SKUS[brand]) {
      pushDish(shop.id, name, Math.round(base * jitter(s.id + name, 0.08) * 10) / 10, assignDishCat(s.cat, name, '招牌推荐'));
    }
  } else if (s.cat === '超市便利' && offProducts.length > 0) {
    // 超市便利 → OFF 真实商品轮转池（每店 12-18 件真实条码商品）
    const per = 8 + (h % 5);
    for (let i = 0; i < per; i++) {
      const p = offProducts[(h + i * 97) % offProducts.length];
      const base = 3.5 + (hash32(p.code) % 2200) / 100; // 3.5-25.5 元锚点
      const d = { id: 'd' + (++dishSeq), shopId: shop.id, name: p.name, price: Math.round(base * 10) / 10, cat: assignDishCat(s.cat, p.name, p.cat || '休闲零食') };
      // OFF 图存短路径（前缀在 dishImgUrl 里重建），省 ~1.3MB
      // v2: 弃 OFF 实拍图，改用品类 SVG imgKey（GoodsSvg 渲染）
      d.imgKey = FOOD_IMGKEY[p.cat] || 'snack';
      if (p.qty) d.qty = p.qty;
      if (p.brand) d.brand = p.brand;
      dishes.push(d);
    }
  } else {
    // 独立小店 → 品类词库
    let pool;
    if (s.cat === '美食外卖') pool = CAT_POOLS['美食外卖'][pickFoodPool(s)];
    else {
      const pools = CAT_POOLS[s.cat] || CAT_POOLS['美食外卖'];
      pool = pools[h % pools.length];
    }
    const per = Math.min(pool.length, 7 + (h % 4)); // 7-10 件
    for (let i = 0; i < per; i++) {
      // 步长 1（i 递增取池内相邻菜）：步长与池长不互质会只取到 2-3 种菜并重复
      const [name, base] = pool[(h + i) % pool.length];
      pushDish(shop.id, name, Math.round(base * jitter(s.id + name, 0.12) * 10) / 10, assignDishCat(s.cat, name, i === 0 ? '招牌推荐' : '热销'));
    }
  }
}

// ── 同名店面去重：连锁品牌分店归并为一家（规则见 dedup-shopping-json.mjs）──
const deduped = dedupShoppingDataset(shopsOut, dishes);
const shopsFinal = deduped.shops;
const dishesFinal = deduped.dishes;
console.log(`dedup shops: ${shopsOut.length} -> ${shopsFinal.length}, dishes: ${dishes.length} -> ${dishesFinal.length}`);

fs.writeFileSync(OUT_SHOPS, JSON.stringify(shopsFinal));
fs.writeFileSync(OUT_DISHES, JSON.stringify(dishesFinal));
const mb = n => (n / 1024 / 1024).toFixed(2) + 'MB';
console.log('shops:', shopsFinal.length, '->', OUT_SHOPS, mb(fs.statSync(OUT_SHOPS).size));
console.log('dishes:', dishesFinal.length, '->', OUT_DISHES, mb(fs.statSync(OUT_DISHES).size));
const realGoods = dishesFinal.filter(d => d.imgKey).length;
console.log('dishes with imgKey (SVG):', realGoods);
