
import React, { useMemo, useState, useEffect } from 'react';
import { BankCard, BankTransaction, SavingsGoal, APIConfig } from '../../types';
import { safeResponseJson } from '../../utils/safeApi';
import { getLocalDateKey } from '../../utils/localDate';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { formatMoney, roundMoney, sumMoney } from '../../utils/format';
import { EXPENSE_CATEGORIES, categoryMeta, resolveCategory } from '../../utils/bankCategories';
import { expenseOf, incomeOf } from '../../utils/bankTx';

interface Props {
    transactions: BankTransaction[];
    goals: SavingsGoal[];
    currency: string;
    onDeleteTx: (id: string) => void;
    apiConfig?: APIConfig;
    dailyBudget?: number;
    cards?: BankCard[];
}

const BankAnalytics: React.FC<Props> = ({ transactions, goals, currency, onDeleteTx, apiConfig, dailyBudget = 100, cards = [] }) => {
    const [viewMode, setViewMode] = useState<'today' | 'week' | 'month'>('today');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [categorizedTx, setCategorizedTx] = useState<Record<string, string>>({});
    const [aiSummary, setAiSummary] = useState<string>('');

    // Get date ranges
    const today = getLocalDateKey();
    const currentMonth = today.slice(0, 7);

    // Calculate week start (Monday)
    const getWeekStart = () => {
        const now = new Date();
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
        const weekStart = new Date(now.setDate(diff));
        return getLocalDateKey(weekStart);
    };
    const weekStart = getWeekStart();

    // Filter transactions by time period
    const filteredTx = useMemo(() => {
        return transactions.filter(tx => {
            if (viewMode === 'today') return tx.dateStr === today;
            if (viewMode === 'week') return tx.dateStr >= weekStart;
            if (viewMode === 'month') return tx.dateStr.startsWith(currentMonth);
            return true;
        });
    }, [transactions, viewMode, today, weekStart, currentMonth]);

    // 分类解析：AI 会话内覆盖只作用于支出笔（收入按注册表解析，绿色语义由符号决定）
    const resolveTx = (tx: BankTransaction) => {
        const aiKey = categorizedTx[tx.id];
        if (aiKey && EXPENSE_CATEGORIES[aiKey] && tx.amount < 0) {
            return { key: aiKey, meta: EXPENSE_CATEGORIES[aiKey], isIncome: false };
        }
        return resolveCategory(tx);
    };

    // Calculate totals（收支分离：收入不再冲减支出）
    const totalExpense = useMemo(() => sumMoney(filteredTx.map(expenseOf)), [filteredTx]);
    const totalIncome = useMemo(() => sumMoney(filteredTx.map(incomeOf)), [filteredTx]);
    const filteredExpenseTx = useMemo(() => filteredTx.filter(t => t.amount < 0), [filteredTx]);

    // CSV Export
    const handleExportCSV = async () => {
        if (transactions.length === 0) return;
        const BOM = '\uFEFF';
        const header = '日期,时间,收支,金额,分类,银行卡,备注\n';
        const rows = [...transactions]
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(tx => {
                const date = tx.dateStr;
                const time = new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const resolved = resolveTx(tx);
                const card = tx.cardId ? cards.find(c => c.id === tx.cardId) : undefined;
                const note = (tx.note || resolved.meta.label).replace(/,/g, '，').replace(/"/g, '""');
                return `${date},${time},${tx.amount < 0 ? '支出' : '收入'},${formatMoney(Math.abs(tx.amount))},"${resolved.meta.label}","${card ? `${card.name}·${card.tailNo}` : ''}","${note}"`;
            })
            .join('\n');
        const csv = BOM + header + rows;
        await shareOrDownloadFile({
            content: csv,
            fileName: `记账记录_${new Date().toISOString().split('T')[0]}.csv`,
            mimeType: 'text/csv;charset=utf-8',
            shareTitle: 'SullyOS 记账记录',
        });
    };

    // Group by category（只统计支出）
    const categoryData = useMemo(() => {
        const groups: Record<string, { total: number; count: number; items: BankTransaction[] }> = {};

        filteredExpenseTx.forEach(tx => {
            const cat = resolveTx(tx).key;
            if (!groups[cat]) groups[cat] = { total: 0, count: 0, items: [] };
            groups[cat].total += expenseOf(tx);
            groups[cat].count++;
            groups[cat].items.push(tx);
        });

        return Object.entries(groups)
            .map(([key, data]) => ({ category: key, ...data, total: roundMoney(data.total), percentage: totalExpense > 0 ? (data.total / totalExpense) * 100 : 0 }))
            .sort((a, b) => b.total - a.total);
    }, [filteredExpenseTx, categorizedTx, totalExpense]);

    // AI categorization and summary（只分析支出笔，收入不参与消费分析）
    const analyzeWithAI = async () => {
        if (!apiConfig?.apiKey || filteredExpenseTx.length === 0) return;

        setIsAnalyzing(true);
        try {
            const txList = filteredExpenseTx.map(tx => `- ${tx.note || resolveTx(tx).meta.label}: ${currency}${formatMoney(expenseOf(tx))}`).join('\n');
            const periodLabel = viewMode === 'today' ? '今天' : viewMode === 'week' ? '本周' : '本月';

            const prompt = `作为一个财务分析助手，分析以下消费记录：

${txList}

任务：
1. 为每笔消费分配类别 (food/transport/shopping/entertainment/bills/health/education/other)
2. 写一段简短有趣的总结（2-3句话），用轻松的语气评价${periodLabel}的消费习惯

输出JSON格式：
{
  "categories": { "消费备注1": "类别", "消费备注2": "类别" },
  "summary": "总结文字"
}`;

            const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }] })
            });

            if (res.ok) {
                const data = await safeResponseJson(res);
                let jsonStr = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
                const result = JSON.parse(jsonStr);

                // Map categories to transaction IDs
                const newCategories: Record<string, string> = { ...categorizedTx };
                filteredExpenseTx.forEach(tx => {
                    if (result.categories[tx.note]) {
                        newCategories[tx.id] = result.categories[tx.note];
                    }
                });
                setCategorizedTx(newCategories);
                setAiSummary(result.summary || '');
            }
        } catch (e) {
            console.error('AI analysis failed:', e);
        } finally {
            setIsAnalyzing(false);
        }
    };

    // Total savings progress
    const totalSaved = useMemo(() => sumMoney(goals.map(g => g.currentAmount)), [goals]);
    const nextGoal = useMemo(() => goals.find(g => !g.isCompleted) || goals[0], [goals]);

    // Budget status for today（只看支出，收入不占也不还预算）
    const budgetRemaining = roundMoney(dailyBudget - (viewMode === 'today' ? totalExpense : 0));
    const budgetStatus = budgetRemaining >= 0 ? 'good' : 'over';

    return (
        <div className="min-h-full pb-24" style={{ background: 'linear-gradient(180deg, #FDF6E3 0%, #FFF8E1 100%)' }}>

            {/* Hero Section - Summary Card */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[#6D4C41] via-[#5D4037] to-[#4E342E]"></div>
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full blur-3xl -mr-20 -mt-20"></div>
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -ml-10 -mb-10"></div>

                <div className="relative z-10 p-5 pt-3">
                    {/* Period Selector */}
                    <div className="flex bg-white/10 backdrop-blur-sm p-1 rounded-2xl mb-5">
                        {[
                            { key: 'today', label: '今日', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png' },
                            { key: 'week', label: '本周', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c6.png' },
                            { key: 'month', label: '本月', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c5.png' }
                        ].map(p => (
                            <button
                                key={p.key}
                                onClick={() => setViewMode(p.key as any)}
                                className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all duration-300 flex items-center justify-center gap-1.5 ${
                                    viewMode === p.key
                                        ? 'bg-white text-[#5D4037] shadow-lg'
                                        : 'text-white/70 hover:text-white'
                                }`}
                            >
                                <img src={p.icon} className="w-4 h-4" alt="" />
                                <span>{p.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Main Stats */}
                    <div className="text-center mb-4">
                        <div className="text-xs text-white/60 uppercase tracking-widest mb-1">
                            {viewMode === 'today' ? '今日支出' : viewMode === 'week' ? '本周支出' : '本月支出'}
                        </div>
                        <div className="text-5xl font-black text-white font-mono tracking-tight">
                            {currency}{totalExpense.toFixed(0)}
                        </div>
                        {totalIncome > 0 && (
                            <div className="text-sm mt-1 font-mono font-bold text-[#A5D6A7]">
                                收入 +{currency}{formatMoney(totalIncome)}
                            </div>
                        )}
                        <div className="text-sm text-white/50 mt-1">
                            共 {filteredTx.length} 笔
                        </div>
                    </div>

                    {/* Budget Status (Today only) */}
                    {viewMode === 'today' && (
                        <div className={`p-4 rounded-2xl backdrop-blur-md border ${
                            budgetStatus === 'good'
                                ? 'bg-green-500/20 border-green-400/30'
                                : 'bg-red-500/20 border-red-400/30'
                        }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <img src={budgetStatus === 'good' ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4aa.png' : 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f631.png'} className="w-6 h-6" alt="" />
                                    <span className="text-sm text-white font-medium">
                                        {budgetStatus === 'good' ? '预算还剩' : '已超支'}
                                    </span>
                                </div>
                                <span className={`text-2xl font-black font-mono ${budgetStatus === 'good' ? 'text-green-300' : 'text-red-300'}`}>
                                    {budgetStatus === 'good' ? '+' : ''}{currency}{Math.abs(budgetRemaining).toFixed(0)}
                                </span>
                            </div>
                            <div className="mt-2 h-2 bg-black/20 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        budgetStatus === 'good' ? 'bg-green-400' : 'bg-red-400'
                                    }`}
                                    style={{ width: `${Math.min(100, (totalExpense / dailyBudget) * 100)}%` }}
                                ></div>
                            </div>
                            <div className="text-[10px] text-white/50 mt-1 text-right">
                                预算 {currency}{dailyBudget}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Content Area */}
            <div className="p-5 space-y-5">

                {/* AI Summary Card */}
                {(aiSummary || filteredExpenseTx.length > 0) && (
                    <div className="bg-white rounded-3xl p-5 shadow-lg border border-[#E8DCC8] relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-[#FFE0B2]/30 to-transparent rounded-full -mr-8 -mt-8"></div>

                        <div className="flex items-center justify-between mb-3 relative z-10">
                            <div className="flex items-center gap-2">
                                <span className="w-8 h-8 bg-gradient-to-br from-[#FFD54F] to-[#FFB300] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f916.png" className="w-5 h-5" alt="" /></span>
                                <span className="text-sm font-bold text-[#5D4037]">AI 消费分析</span>
                            </div>
                            <button
                                onClick={analyzeWithAI}
                                disabled={isAnalyzing || !apiConfig?.apiKey || filteredExpenseTx.length === 0}
                                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                                    isAnalyzing
                                        ? 'bg-[#EFEBE9] text-[#BCAAA4]'
                                        : 'bg-gradient-to-r from-[#42A5F5] to-[#1E88E5] text-white shadow-md hover:shadow-lg active:scale-95'
                                }`}
                            >
                                {isAnalyzing ? (
                                    <span className="flex items-center gap-1.5">
                                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                                        分析中
                                    </span>
                                ) : '生成总结'}
                            </button>
                        </div>

                        {aiSummary ? (
                            <div className="bg-gradient-to-r from-[#FFF8E1] to-[#FFF3E0] p-4 rounded-2xl text-sm text-[#5D4037] leading-relaxed relative z-10">
                                <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a1.png" className="w-5 h-5 inline mr-2" alt="" />
                                {aiSummary}
                            </div>
                        ) : (
                            <div className="text-center py-4 text-[#BCAAA4] text-xs">
                                点击"生成总结"让 AI 分析你的消费习惯
                            </div>
                        )}
                    </div>
                )}

                {/* Category Breakdown */}
                {categoryData.length > 0 && (
                    <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="w-8 h-8 bg-gradient-to-br from-[#AB47BC] to-[#7B1FA2] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ca.png" className="w-5 h-5" alt="" /></span>
                            <span className="text-sm font-bold text-[#5D4037]">消费分类</span>
                        </div>

                        <div className="space-y-3">
                            {categoryData.map(({ category, total, count, percentage }) => {
                                const cat = categoryMeta(category, false);
                                return (
                                    <div key={category} className="group">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <div className="flex items-center gap-2">
                                                <img src={cat.icon} className="w-5 h-5" alt="" />
                                                <span className="text-sm font-bold text-[#5D4037]">{cat.label}</span>
                                                <span className="text-[10px] text-[#A1887F] bg-[#FDF6E3] px-2 py-0.5 rounded-full">{count}笔</span>
                                            </div>
                                            <span className="font-mono font-bold text-[#5D4037]">{currency}{total.toFixed(0)}</span>
                                        </div>
                                        <div className="h-3 bg-[#EFEBE9] rounded-full overflow-hidden">
                                            <div
                                                className={`h-full bg-gradient-to-r ${cat.gradient} rounded-full transition-all duration-700 relative`}
                                                style={{ width: `${percentage}%` }}
                                            >
                                                <div className="absolute inset-0 bg-gradient-to-b from-white/30 to-transparent"></div>
                                            </div>
                                        </div>
                                        <div className="text-right text-[10px] text-[#A1887F] mt-0.5">{percentage.toFixed(1)}%</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Transaction List */}
                <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <span className="w-8 h-8 bg-gradient-to-br from-[#66BB6A] to-[#43A047] rounded-xl flex items-center justify-center text-lg shadow-md"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5" alt="" /></span>
                            <span className="text-sm font-bold text-[#5D4037]">收支明细</span>
                        </div>
                        {transactions.length > 0 && (
                            <button onClick={handleExportCSV} className="flex items-center gap-1 px-3 py-1.5 bg-[#FDF6E3] hover:bg-[#FFF8E1] border border-[#E8DCC8] rounded-xl text-[10px] font-bold text-[#8D6E63] active:scale-95 transition-all">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                                导出全部CSV
                            </button>
                        )}
                    </div>

                    {filteredTx.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="mb-3 opacity-40"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ed.png" className="w-16 h-16 mx-auto" alt="" /></div>
                            <div className="text-sm text-[#A1887F]">
                                {viewMode === 'today' ? '今天还没有收支记录' : viewMode === 'week' ? '本周暂无记录' : '本月暂无记录'}
                            </div>
                            <div className="text-xs text-[#BCAAA4] mt-1">点击右上角开始记账吧！</div>
                        </div>
                    ) : (
                        <div className="space-y-3 max-h-[400px] overflow-y-auto no-scrollbar">
                            {filteredTx.map(tx => {
                                const resolved = resolveTx(tx);
                                const isExpense = tx.amount < 0;
                                const card = tx.cardId ? cards.find(c => c.id === tx.cardId) : undefined;
                                return (
                                    <div key={tx.id} className="flex items-center justify-between p-3 rounded-2xl bg-[#FDF6E3] hover:bg-[#FFF8E1] transition-colors group relative">
                                        <div className="flex items-center gap-3">
                                            <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center shadow-inner">
                                                <img src={resolved.meta.icon} className="w-6 h-6" alt="" />
                                            </div>
                                            <div>
                                                <div className="font-bold text-[#5D4037] text-sm">{tx.note || resolved.meta.label}</div>
                                                <div className="text-[10px] text-[#A1887F] flex items-center gap-2">
                                                    <span>{new Date(tx.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                                                    <span className="px-1.5 py-0.5 bg-white rounded text-[9px]" style={{ color: resolved.meta.color }}>{resolved.meta.label}</span>
                                                    {card && <span className="px-1.5 py-0.5 bg-white rounded text-[9px] text-[#7986CB]">{card.name}·{card.tailNo}</span>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className={`font-mono font-bold ${isExpense ? 'text-[#E64A19]' : 'text-[#43A047]'}`}>
                                            {isExpense ? '−' : '+'}{currency}{formatMoney(Math.abs(tx.amount))}
                                        </div>

                                        <button
                                            onClick={() => onDeleteTx(tx.id)}
                                            className="absolute right-1 top-1 w-5 h-5 rounded-full bg-red-50 text-red-400 hover:bg-red-100 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-xs"
                                        >
                                            ×
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Savings Progress */}
                {goals.length > 0 && (
                    <div className="bg-gradient-to-br from-[#8D6E63] to-[#5D4037] rounded-3xl p-5 shadow-lg text-white relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-10 -mt-10"></div>

                        <div className="flex items-center gap-2 mb-3 relative z-10">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3af.png" className="w-5 h-5" alt="" />
                            <span className="text-sm font-bold">储蓄进度</span>
                        </div>

                        <div className="text-3xl font-black font-mono mb-3 relative z-10">{currency}{totalSaved.toFixed(0)}</div>

                        {nextGoal && (
                            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 relative z-10">
                                <div className="flex justify-between text-xs mb-2">
                                    <span className="opacity-80">下一目标: {nextGoal.name}</span>
                                    <span className="font-bold">{currency}{formatMoney(nextGoal.targetAmount - nextGoal.currentAmount)}</span>
                                </div>
                                <div className="h-2 bg-black/20 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-[#FFE0B2] to-[#FFAB91] rounded-full"
                                        style={{ width: `${Math.min(100, (nextGoal.currentAmount / nextGoal.targetAmount) * 100)}%` }}
                                    ></div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};

export default BankAnalytics;
