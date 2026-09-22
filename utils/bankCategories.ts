// ============================================================
// bankCategories: 记账分类注册表（支出 8 类 / 收入 6 类）。
// 存储值 BankTransaction.category 是这里的 key；旧数据的
// 'general'/'购物'/'income' 由 resolveCategory 兼容解析。
// 图标沿用 Twemoji CDN（与账本原分类图标同源）。
// ============================================================
import type { BankTransaction } from '../types';

export interface BankCategoryMeta {
    icon: string;
    label: string;
    color: string;
    gradient: string;
}

export const EXPENSE_CATEGORIES: Record<string, BankCategoryMeta> = {
    food: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f354.png', label: '餐饮', color: '#FF7043', gradient: 'from-orange-400 to-red-500' },
    transport: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f697.png', label: '交通', color: '#42A5F5', gradient: 'from-blue-400 to-indigo-500' },
    shopping: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6cd.png', label: '购物', color: '#AB47BC', gradient: 'from-purple-400 to-pink-500' },
    entertainment: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3ae.png', label: '娱乐', color: '#66BB6A', gradient: 'from-green-400 to-teal-500' },
    bills: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f1.png', label: '账单', color: '#FFA726', gradient: 'from-yellow-400 to-orange-500' },
    health: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f48a.png', label: '医疗', color: '#EF5350', gradient: 'from-red-400 to-rose-500' },
    education: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4da.png', label: '学习', color: '#5C6BC0', gradient: 'from-indigo-400 to-purple-500' },
    other: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4e6.png', label: '其他', color: '#78909C', gradient: 'from-gray-400 to-slate-500' },
};

export const INCOME_CATEGORIES: Record<string, BankCategoryMeta> = {
    salary: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4bc.png', label: '工资', color: '#66BB6A', gradient: 'from-green-400 to-emerald-500' },
    redpacket: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9e7.png', label: '红包', color: '#EF5350', gradient: 'from-red-400 to-rose-500' },
    refund: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/21a9.png', label: '退款', color: '#42A5F5', gradient: 'from-blue-400 to-cyan-500' },
    parttime: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6e0.png', label: '兼职', color: '#FFA726', gradient: 'from-amber-400 to-orange-500' },
    investment: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c8.png', label: '理财', color: '#26A69A', gradient: 'from-teal-400 to-emerald-600' },
    income_other: { icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4b0.png', label: '其他', color: '#78909C', gradient: 'from-gray-400 to-slate-500' },
};

export const EXPENSE_CATEGORY_ORDER: string[] = ['food', 'transport', 'shopping', 'entertainment', 'bills', 'health', 'education', 'other'];
export const INCOME_CATEGORY_ORDER: string[] = ['salary', 'redpacket', 'refund', 'parttime', 'investment', 'income_other'];

export const DEFAULT_EXPENSE_CATEGORY = 'other';
export const DEFAULT_INCOME_CATEGORY = 'income_other';

/** 历史存储值的兼容别名（'购物' 来自购物/外卖/角色点单旧写入） */
export const LEGACY_CATEGORY_ALIASES: Record<string, string> = {
    '购物': 'shopping',
    'income': 'income_other',
};

/** 按备注关键词猜支出分类（原 BankAnalytics.tsx 的 guessCategory，旧记录展示兼容） */
export function guessExpenseCategory(note: string): string {
    const lower = (note || '').toLowerCase();
    if (/饭|餐|吃|外卖|食|奶茶|咖啡|早|午|晚|火锅|烧烤|面|饮/.test(lower)) return 'food';
    if (/车|地铁|公交|打车|油|加油|停车|出租/.test(lower)) return 'transport';
    if (/买|购|淘宝|京东|拼多多|商场|超市|衣服/.test(lower)) return 'shopping';
    if (/游戏|电影|娱乐|ktv|酒吧|玩/.test(lower)) return 'entertainment';
    if (/话费|水电|房租|网费|会员|订阅/.test(lower)) return 'bills';
    if (/医|药|健康|体检|看病/.test(lower)) return 'health';
    if (/书|课|学习|培训|教育/.test(lower)) return 'education';
    return 'other';
}

export function categoryMeta(key: string, isIncome: boolean): BankCategoryMeta {
    if (isIncome) return INCOME_CATEGORIES[key] || INCOME_CATEGORIES[DEFAULT_INCOME_CATEGORY];
    return EXPENSE_CATEGORIES[key] || EXPENSE_CATEGORIES[DEFAULT_EXPENSE_CATEGORY];
}

/**
 * 解析一笔流水的分类：
 * 已知键 → 旧值别名 → 未分类（general/未知）：支出按备注猜、收入归 income_other。
 */
export function resolveCategory(tx: Pick<BankTransaction, 'amount' | 'category' | 'note'>): { key: string; meta: BankCategoryMeta; isIncome: boolean } {
    const isIncome = (Number(tx.amount) || 0) > 0;
    const raw = String(tx.category || '');
    const key = LEGACY_CATEGORY_ALIASES[raw] || raw;
    if (isIncome) {
        const hit = INCOME_CATEGORIES[key] ? key : DEFAULT_INCOME_CATEGORY;
        return { key: hit, meta: INCOME_CATEGORIES[hit], isIncome: true };
    }
    const hit = EXPENSE_CATEGORIES[key] ? key : guessExpenseCategory(tx.note || '');
    return { key: hit, meta: EXPENSE_CATEGORIES[hit], isIncome: false };
}
