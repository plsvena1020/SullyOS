/**
 * 自主背景生活的反刍闸（autonomy B2）——纯函数，零 import。
 *
 * 挡的是「同一件小事被翻来覆去写」：模型报上来的选题先过这一层，跟最近 96 小时里
 * 写过的页比对——中文连续段拆二元组、拉丁收 ≥3 字符的词，撞到 ≥2 页就算冷饭，拦住，
 * 并把命中页的最新搜索词原样交出去（换题时指名道姓列进禁区，别让模型再挑同一个）。
 *
 * 判定全注入（pages / nowMs 都是入参）：D1 读取留在调用方（autonomyFire），这一层
 * 才能在 vitest 里确定性地钉死。撞满 RUMIN_HIT_PAGES 与只允许换一次题的收敛规则都在
 * 这里，调用方拿 verdict 决定换题还是收成 rest。
 */

export interface RuminationVerdict {
  /** true = 这个选题最近撞得太多，不该再写。 */
  blocked: boolean;
  /** 命中页的最新搜索词（去重、最新在前）——换题提示里原样列出的禁区。 */
  burntLines: string[];
}

/** 反刍窗口：只看最近 96 小时的经历。 */
export const RUMIN_WINDOW_H = 96;
/** 只在最近 12 页里比对（再旧的不算，写过的早该淡了）。 */
export const RUMIN_PAGES = 12;
/** 撞到 2 页即拦（第二回放行，第三回拦住）。 */
export const RUMIN_HIT_PAGES = 2;
/** 被拦后允许换题一次。 */
export const REPICK_ONCE = 1;

/** 反刍比对用的页：一次写下的经历（q = 触发它的搜索词/选题，缺了就是不可读的页）。 */
export interface RuminationPage {
  q?: string | null;
  createdAt: number;
}

const WINDOW_MS = RUMIN_WINDOW_H * 60 * 60 * 1000;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const LATIN_WORD = /[a-z0-9]{3,}/g;

/**
 * 分词：中文连续段逐字切二元组（单字段落就收它自己），拉丁只收 ≥3 字符的词。
 * 二元组而不是整段：同一件事换个说法也该撞得上；短词（<3 的拉丁、单个汉字）太容易
 * 误撞，不收。
 */
export function tokenizeRumination(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  for (const word of lowered.match(LATIN_WORD) ?? []) tokens.add(word);
  return [...tokens];
}

/**
 * 判一个选题是不是冷饭。命中数只看**页数**（同一页里重复不算多撞），撞满
 * `RUMIN_HIT_PAGES` 即拦。窗口外的页、q 缺失的页、时间戳坏掉的页一律忽略。
 */
export function ruminationVerdict(
  query: string,
  pages: readonly RuminationPage[],
  nowMs: number,
): RuminationVerdict {
  const tokens = new Set(tokenizeRumination(query));
  if (tokens.size === 0) return { blocked: false, burntLines: [] };

  const recent = pages
    .filter((page): page is RuminationPage => !!page)
    .filter((page) => typeof page.createdAt === 'number' && Number.isFinite(page.createdAt))
    .filter((page) => {
      const age = nowMs - page.createdAt;
      return age >= 0 && age <= WINDOW_MS;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RUMIN_PAGES);

  const burntLines: string[] = [];
  let hits = 0;
  for (const page of recent) {
    const line = typeof page.q === 'string' ? page.q.trim() : '';
    if (!line) continue;
    const pageTokens = tokenizeRumination(line);
    if (!pageTokens.some((token) => tokens.has(token))) continue;
    hits += 1;
    if (!burntLines.includes(line)) burntLines.push(line);
  }

  return { blocked: hits >= RUMIN_HIT_PAGES, burntLines };
}

/**
 * 换题收敛：首次选题 + 至多 `REPICK_ONCE` 次换题，只要有一次不撞就放行，全撞就 rest。
 * 没有可用的尝试（空数组）按 rest 处理。
 */
export function resolveRumination(attempts: readonly RuminationVerdict[]): 'ok' | 'rest' {
  const capped = attempts.slice(0, REPICK_ONCE + 1);
  if (capped.length === 0) return 'rest';
  return capped.some((attempt) => !attempt.blocked) ? 'ok' : 'rest';
}

/**
 * 把 burnt lines 拼成一行禁区说明（换题提示用），指名道姓。没有就回空串——
 * 空串的槽位由调用方整段抹掉，不留一句空话。
 */
export function buildRuminationBanLine(burntLines: readonly string[]): string {
  const terms = burntLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (terms.length === 0) return '';
  return `这几个方向最近已经写过了，这次别再碰：${terms.map((term) => `「${term}」`).join('、')}。`;
}
