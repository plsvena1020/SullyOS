# 塔罗「星空秘夜」改版 — 设计 spec + 执行计划

日期：2026-09-11
状态：用户已批准方向并要求执行（同日对话：风格=星空秘夜、牌库=双列大图+高低错落、粒子=全局星尘+占卜光尘、桌面端 3-4 列手机 2 列）。
本文件同时是 spec 与弱执行者执行清单；后续会话按 Part 2 逐步执行，不需要回看对话历史。

## 触碰文件清单（其他窗口请避开）

| 操作 | 文件 |
|------|------|
| 改 | `apps/TarotApp.tsx` |
| 改 | `apps/tarot/LibraryView.tsx` |
| 改 | `apps/tarot/RitualView.tsx` |
| 新增 | `apps/tarot/TarotParticles.tsx` |
| 不动 | `apps/tarot/TarotCards.tsx`、`apps/tarot/ReadingView.tsx`、`utils/tarot*.ts`、`utils/db.ts`、`components/PhoneShell.tsx`、`constants.tsx` |

---

# Part 1 · 设计 spec

## 1.1 目标

在保留现有金色 `#c9a227` / 亮金 `#e8c96a` / 羊皮纸 `#f5f0e1` / 古董铜描边 `#8b7355` / 衬线字的前提下，把塔罗 App 从「旧书房木质棕」升级为「深夜星空秘仪」：

1. 牌库从 48px 缩略图单列列表改为大图瀑布流（手机 2 列、桌面 4 列限宽）。
2. 全 App 背景加星空层次与缓慢动效。
3. 粒子：全局 canvas 星尘（含偶发流星）+ 占卜流程金色光尘。

## 1.2 风格 token（本 App 私有，不外借）

- 背景基底：`radial-gradient(130% 100% at 50% 0%, #2b2249 0%, #1a1428 45%, #0b0914 100%)`
- 占卜台丝绒：底 `#0f231d`，中心径向高光 `rgba(32,62,52,0.55)`，金色台缘 `#c9a227` 低透明度
- 星云光斑：金 `rgba(201,162,39,0.18)`、紫 `rgba(92,70,160,0.22)` 与 `rgba(92,70,160,0.16)`，60s 漂移
- 晕影：`radial-gradient(120% 95% at 50% 42%, transparent 58%, rgba(0,0,0,0.42) 100%)`，pointer-events-none，压在内容之上（z-20）
- 金色辉光统一用 `rgba(232,201,106,α)`，禁止新增其他色相
- 圆角沿用现状（卡 `rounded-md`、小件 `rounded`/`rounded-[3px]`、pills `rounded-full`），不发明新弧度
- 动效时长沿用仓库档位：交互 200/300ms、一次性 500-650ms、循环 2.4-4s、漂移 60-80s

## 1.3 牌库布局规则

- 判定桌面：`useLayoutMode(theme.desktopMode) === 'desktop'`，与 `apps/Gallery.tsx:21` 同写法。
- 手机：`columns-2`；桌面：`columns-4` + 容器 `mx-auto w-full max-w-[1180px]`。
- 分组：仍按 `SUITS`（大阿尔卡纳/权杖/圣杯/宝剑/星币）分 section，section 头 `sticky top-0 z-10` 不透明底 `bg-[#141020]`，避免牌块透出。
- Hero 特写（每 section 一张，渲染在 section 头下方、瀑布流上方，水平居中）：
  - 大阿尔卡纳 → 愚者（`arcana === 'major' && num === 0`）
  - 各花色 → Ace（`arcana !== 'major' && num === 1`）
  - 宽度：手机 `max-w-[260px]`、桌面 `max-w-[340px]`；带金色光环背景、罗马数字徽记、中英文名、关键词
- 瀑布流卡片（`CardTile`）分四档文案高度，形成确定性的高低错落：
  - tier2：大阿尔卡纳 10（命运之轮）、21（世界）→ 名/英文名/关键词/元素·星象 4 行
  - tier1：其余大阿尔卡纳、各花色宫廷牌（`num >= 11`）→ 名/英文名/关键词 3 行
  - tier0：其余小阿卡纳 → 名/关键词 2 行
- 卡片视觉：图占满列宽（比例保持 `800/1372` 不裁切）、左上角罗马数字徽记、hover 上浮 `-translate-y-0.5` + 金环 + 去灰 + 图 `scale-[1.03]`，全部 300ms。
- 搜索、筛选、`filtered` 过滤逻辑、`CardDetail` 入口逻辑零改动；`CardDetail` 大图 `w-52` → `w-60`，背后加金色径向光晕。

## 1.4 粒子系统（`apps/tarot/TarotParticles.tsx`）

- 全屏 canvas，`pointer-events-none absolute inset-0`，`aria-hidden`，DOM 位置在星云光斑之后、内容之前。
- 星尘：36 颗，70% 金 `rgba(232,201,106,·)` / 30% 白；半径 0.5-1.6px；上升 6-14px/s；横向摆动 6-18px；正弦闪烁；基础透明度 0.12-0.45；`globalCompositeOperation = 'lighter'`。
- 流星：每 7-14s 一颗；起点 x∈宽 10%-60%、y∈高 5%-35%；速度 (150-190, 90-130) px/s；寿命 0.7s；渐变拖尾 0.28s 长度；透明度包络 `sin(π·progress)`。
- 工程要求：DPR 上限 2；`ResizeObserver` 跟随父容器；`document.hidden` 暂停 rAF、恢复时重置计时；`prefers-reduced-motion: reduce` 时只画一帧静态星点、不启动循环；卸载时 `cancelAnimationFrame` + 断开 observer + 移除监听。
- 禁止：引入动画库、WebGL/three、外部资源。

## 1.5 占卜流程动效

- 占卜台（dealing/revealing 共用）：丝绒底加深 + 中心双层魔法阵环（外层虚线环 80s 旋转，内层静态环）+ 金色柔光。
- 洗牌：牌堆背后光晕脉冲（`tarotAuraPulse` 2.6s）+ 10 颗金色火花上浮（`tarotSpark` 2.4s，错峰 240ms）。
- 翻牌：牌容器在 `flipped[i]` 变 true 时挂 `tarot-lit`，一次性 650ms drop-shadow 光晕爆发后停在弱光。
- 所有新 keyframes 写进 `apps/TarotApp.tsx` 的 `TAROT_CSS`；reduced-motion 块里：位移/脉冲类动画置 `none !important`，`tarot-spark` 额外 `opacity: 0 !important`（避免静态残留光点）。

## 1.6 边界与禁止

- 不改任何文案 / 数据结构 / 抽牌算法 / IndexedDB / 注册点。
- 不引入依赖；不使用 `framer-motion` 等；不新增全局 CSS 文件。
- 不给 `ReadingView`、`TarotCards`、`DailyView`、`HistoryView` 的功能结构动手（Daily 的牌卡会自然继承新底色，无需改）。
- 桌面分支只影响牌库列数与容器宽度，手机端类名行为与现在一致。
- 新写代码注释从简，中文只出现在 UI 字符串；写文件必须 UTF-8 无 BOM。

## 1.7 验收标准

1. `pnpm vitest run utils/tarot`：6 个测试文件全绿。
2. `pnpm vitest run utils/mojibakeGuard.test.ts`：全绿。
3. `pnpm exec tsc --noEmit`：无错误。
4. 本次触碰的 4 个文件字节级无 U+FFFD（EF BF BD 序列）。
5. `pnpm dev` 手动检查：手机宽度牌库 2 列大图 + hero 特写；桌面宽度 4 列限宽；星尘与流星可见；洗牌有光尘、翻牌有光晕；系统 reduced-motion 下无循环动画。

---

# Part 2 · 执行清单（弱执行者版，按序执行）

## Step 1 新增 `apps/tarot/TarotParticles.tsx`

完整实现按 Part 1.4。要点自查：`useRef` canvas；`useEffect` 内 `getContext('2d')`；reduced-motion 分支；`makeMotes/resize/drawStatic/frame/start/stop` 函数齐全；cleanup 完整；组件返回 `<canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" />`。
验收：`pnpm exec tsc --noEmit` 对该文件无报错。

## Step 2 改 `apps/TarotApp.tsx`

1. 第 10 行后新增 `import { TarotParticles } from './tarot/TarotParticles';`。
2. `TAROT_CSS`（第 15-30 行）新增 keyframes/类：`tarotTwinkle/.tarot-twinkle`、`tarotDrift/.tarot-drift`、`tarotAuraPulse/.tarot-aura`、`tarotSpark/.tarot-spark`、`tarotLit/.tarot-lit`、`tarotSpin/.tarot-ring-spin`；reduced-motion 块按 Part 1.5 改写。
3. 根容器（第 303-305 行）：背景换 Part 1.2 的径向渐变。
4. 第 308 行原 `tarot-glow` 光斑保留；其后依次加入两团 `tarot-drift` 星云光斑（紫，`animationDelay` 分别 -30s/-14s）→ `<TarotParticles />` → 晕影层（z-20，pointer-events-none，Part 1.2 渐变）。
5. 头部（第 310 行）加 `relative z-10`；标题区（第 319-322 行）左右各加一颗 `Sparkle size={13} weight="fill"`，class `tarot-twinkle text-[#e8c96a]`，其一 `animationDelay: '-0.9s'`；`h1` 加 `textShadow: '0 0 18px rgba(232,201,106,0.35)'`。
6. 内容容器（第 326 行）与底部导航（第 343 行）各加 `relative z-10`。
7. 导航按钮（第 348-355 行）：激活项图标加 `filter: drop-shadow(0 0 6px rgba(232,201,106,0.7))`；图标下加一个 `h-1 w-1 rounded-full` 指示点（激活金色+光晕，非激活透明，`transition-all duration-200`）。
验收：`pnpm exec tsc --noEmit` 通过；肉眼检查背景层次顺序为「渐变底 → 星云 → 星尘 → 内容 → 晕影」。

## Step 3 改 `apps/tarot/LibraryView.tsx`

1. import 增加 `useOS`、`useLayoutMode`、`Sparkle`；`CardCell`（第 21-37 行）删除，替换为 `HeroTile` 与 `CardTile`（按 Part 1.3 四档文案）。
2. `SectionHead` 加一颗 `Sparkle size={11}` 前缀；`sticky` 包裹放在 section 渲染处。
3. `LibraryView` 内取 `theme` 与 `isDesktop`；根 div 加桌面限宽；section 渲染顺序：sticky 头 → hero（若有）→ `<div className={columns-2 / columns-4 + ' gap-3'}>` 内 `CardTile`（每个 `mb-3 break-inside-avoid`）。
4. `CardDetail` 大图 `w-52` → `w-60`，图后加径向金光层；其余逻辑不动。
验收：`pnpm exec tsc --noEmit`；手动或静态检查确认 78 张牌全部有渲染路径、搜索/筛选仍走 `filtered`。

## Step 4 改 `apps/tarot/RitualView.tsx`

1. 新增文件内小组件 `TableFelt`（魔法阵两层环 + 丝绒径向光），按 Part 1.5。
2. `shuffling` 块（第 186-200 行）：牌堆后加 `tarot-aura` 光晕 + 10 颗 `tarot-spark` 光点。
3. `dealing`（第 203-221 行）与 `revealing`（第 224-271 行）容器：底色/描边换新丝绒 token，首子元素渲染 `<TableFelt />`；`revealing` 的牌容器 className 增加 `flipped[i] ? 'tarot-lit' : ''`。
验收：`pnpm exec tsc --noEmit`；确认 phase 状态机、定时器、落库逻辑零改动（只动 className 与装饰 JSX）。

## Step 5 验证与收尾

1. `pnpm vitest run utils/tarot` 全绿。
2. `pnpm vitest run utils/mojibakeGuard.test.ts` 全绿。
3. `pnpm exec tsc --noEmit` 通过。
4. 用脚本扫本次 4 个文件的 `EF BF BD` 字节序列，必须为 0 命中。
5. 无临时文件遗留；不做未要求的版本号变更。
