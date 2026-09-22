# 塔罗「星空华彩」增强 — 设计 spec + 执行计划

日期：2026-09-12（第二波，接上篇 `plans/2026-09-12-tarot-aurora-reading-plan.md`）
状态：用户已批准方向（同日对话终稿：星座=真实连线+十二宫符号环；牌库文案=按端尺寸设计；极光=幕帘流光+柔光团）。本文件同时是 spec 与弱执行者清单。

## 触碰文件清单（其他窗口请避开）

| 操作 | 文件 |
|------|------|
| 新增 | `apps/tarot/ZodiacRing.tsx` |
| 改 | `apps/tarot/TarotParticles.tsx` |
| 改 | `apps/TarotApp.tsx` |
| 改 | `apps/tarot/RitualView.tsx` |
| 改 | `apps/tarot/LibraryView.tsx` |
| 新增 | `plans/2026-09-12-tarot-sky-constellation-plan.md`（本文件） |
| 收尾 | `notes/ethernet-features.md` |
| 不动 | `apps/tarot/TarotCards.tsx`、`apps/tarot/ReadingView.tsx`、`utils/tarot*.ts`、数据结构/存储/注册点 |

---

# Part 1 · 设计 spec

## 1.1 天空渲染器（`apps/tarot/TarotParticles.tsx`，仍单 canvas 单 rAF）

绘制顺序：银河带（离屏预渲染）→ 三层视差星 → 星座连线 → 流星/火流星/火花。

### 银河带
- resize 时用 `document.createElement('canvas')` 离屏预渲染：沿对角带（A=(5%W,-10%H) → B=(105%W,75%H)）撒 260 颗点，法向偏移取双随机均值近似高斯，半宽 = `min(W,H)*0.22`；半径 0.3-0.9px；透明度 `(1-|g|)*(0.05+rand*0.10)`；颜色 25% 金 `rgba(232,201,106,·)`、30% 淡紫 `rgba(190,180,235,·)`、其余白。
- 每帧 `globalAlpha=0.9; drawImage(off,0,0,width,height)`，不位移（深度感由星层运动提供）。

### 三层视差星（合计 82 颗，替换原 52 颗单层）
- far 40：r 0.4-0.8、上移 3-6px/s、alpha 0.08-0.20、无星芒
- mid 28：r 0.7-1.2、上移 6-10px/s、alpha 0.15-0.35、8% 星芒
- near 14：r 1.1-1.9、上移 9-15px/s、alpha 0.25-0.50、35% 星芒
- 共通：正弦摆动/闪烁、70% 金；星芒=十字两条渐变线（长 r*3.2，仅当脉冲 >0.55 时绘制），闪灭与 alpha 同步。

### 星座连线（内置 4 组归一化坐标，中心 (0,0)，范围约 ±0.5）
- 北斗七星：7 点，连线 [0,1][1,2][2,3][3,0][3,4][4,5][5,6]
- 仙后座（W 形）：5 点，[0,1][1,2][2,3][3,4]
- 猎户座（简化）：7 点，[0,2][1,4][2,3][3,4][2,6][4,5]
- 天鹅座（十字）：5 点，[0,4][4,1][2,4][4,3]（点序：0 天津四(0,-0.38)、1 辇道增七(0,0.38)、2 左翼(-0.28,0.06)、3 右翼(0.28,0.10)、4 天津一(0,0)）
- 生命周期：同屏仅 1 个；`scale = min(W,H)*(0.30+rand*0.12)`、中心 `x∈28%-72%W`、`y∈22%-56%H`、旋转 ±25°；3s 淡入 → 停留 16-22s → 3s 淡出；结束后 5-9s 换一下个（不与上一个同名）。
- 绘制：星点坐标手动做 rotate+scale 变换后再画（避免 ctx.scale 把描边放大）；连线 `rgba(232,201,106,0.26*env)`、1px；星点 r 1.2-2.2px，每点独立闪烁，`env` 为整体包络；图形下方 16px 处画星座名（10px serif、`rgba(232,201,106,0.22*env)`、textAlign center）。

### 流星 / 火流星 / 流星雨
- 普通流星：沿用（2.5-5s、280-460px/s、ttl 1.2-1.7s、双段渐变拖尾 + 头部光点，30% 双发）。
- 火流星：生成时 25% 概率 `fire=true`；速度 340-460、ttl 1.4-1.8s、线宽 2.2、头部半径 5px；飞行中每帧撒 1-2 颗火花（`MAX_SPARKS=120`，火花 vx≈主速*0.08±30、vy 下坠 + 重力 60px/s²、ttl 0.3-0.7s，0.8-1.4px 金白点）。
- 流星雨：计时器 55-95s；触发时生成 6-8 颗，共享辐射点（x∈10%-90%W、y∈0-25%H），在 2.6s 内错峰释放（每颗 delay 随机 0-2.6s），扇形角 25°-50°；雨期间普通流星照常。`MAX_METEORS=8`。
- reduced-motion：静态帧画银河 + 三层星 + 一个星座（env=1），无流星/火花。

## 1.2 极光幕帘（`apps/TarotApp.tsx`）

- 保留现有三团柔光 + 新增两层幕帘（在 Aurora 包裹层内、柔光之后）：
  - 幕帘层：宽 120%、高 58%、skewX(-6deg)、`repeating-linear-gradient(90deg, 紫0.14→透明→青玉0.11→透明→金0.05→透明→紫0.14)` 周期 240px，`background-size:240px 100%`，上向下渐隐 mask（0.95→0.35@48%→transparent@80%），`blur(12px)`，`mix-blend-mode:screen`；动画 `tarotCurtain`（background-position-x 0→240px，26s linear infinite）
  - 反向层：同结构、青玉/金为主、38s reverse、delay -12s、高 48%、skewX(5deg)
- TAROT_CSS 新增 `@keyframes tarotCurtain` 与 `.tarot-curtain`/`.tarot-curtain-rev`；reduced-motion 名单加 `.tarot-curtain`。

## 1.3 十二宫符号环（新组件 `apps/tarot/ZodiacRing.tsx`）

- Props：`size`（px，必填）、`durationS?=140`、`reverse?`、`glyphColor?`、`className?`。
- 12 符号 `♈♉♊♋♌♍♎♏♐♑♒♓`，每个绝对定位 `left-1/2 top-1/2`，`transform: translate(-50%,-50%) rotate(i*30deg) translateY(-size/2) rotate(-i*30deg)`（符号保持正立）；字号 `max(9, size*0.055)`。
- 容器复用 TAROT_CSS 的 `.tarot-ring-spin`（keyframes 已带 `translate(-50%,-50%)`），用内联 `animationDuration`/`animationDirection` 覆盖时长与方向；`aria-hidden`；`pointer-events-none`。
- 用法：
  1) `apps/TarotApp.tsx` 头部背景：外层 `pointer-events-none absolute inset-x-0 top-0 z-0 h-72 overflow-hidden` 内放 `size=300`、`durationS=140`、`glyphColor="rgba(201,162,39,0.55)"`、`className="opacity-[0.13]"`。
  2) `apps/TarotView` 占卜台 `TableFelt`：`size=230`、`durationS=90`、`reverse`、`glyphColor="rgba(232,201,106,0.75)"`、`className="opacity-25"`（与现有两层虚线环同心）。
- reduced-motion 由既有 `.tarot-ring-spin { animation:none !important }` 覆盖（静态环）。

## 1.4 牌库网格修复（`apps/tarot/LibraryView.tsx`）

- 根因：`columns-4/2` 为 CSS 多列瀑布流，卡片文案行数不同（`captionTier` 三档）导致列内错位、阅读顺序按列走。
- 改法：
  - 容器：`isDesktop ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-2 gap-3'`；删除 `captionTier`。
  - `CardTile`：删除 `mb-3 break-inside-avoid`，改 `flex h-full flex-col`（网格内等高拉伸）；内容区 `flex-1` 顶部对齐；保留图片比例/圆角/描边/灰化/hover 上浮金环。
  - 文案按端：手机=`中文名` + `关键词`（2 行）；桌面=`中文名` + `英文名` + `关键词` + `元素·星象`（4 行），全部 `truncate`，同端所有卡同构、行行对齐。
  - hover 金色流光：卡内绝对层 `tarot-sweep`（w-1/3、`-skew-x-12`、金渐变、初始 opacity-0），`.group:hover .tarot-sweep` 触发 `.7s` 扫过 keyframes；TAROT_CSS 新增 `tarotSweep`。
  - 入场：`CardTile` 挂 `tarot-reveal`，`animationDelay = min(index*18, 320)ms`（筛选后新卡错峰，已有卡不重播）。
- 桌面容器宽度维持 `max-w-[1180px]`（4 列每张约 283px，保持大图）。

## 1.5 边界与禁止

- 不加依赖、不动数据/存储/抽牌/注册点/版本号；不新建弹窗。
- 所有新 keyframes 进 `TAROT_CSS`；星空只属塔罗 App。
- 写文件 UTF-8 无 BOM；新代码注释从简。

## 1.6 验收标准

1. `corepack pnpm@9.15.9 vitest run utils/tarot` 全绿。
2. `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts` 全绿。
3. `corepack pnpm@9.15.9 exec tsc --noEmit`：触碰文件零命中（存量基线）。
4. 本次改动文件字节扫 `EF BF BD` = 0。
5. `pnpm dev` 肉眼：桌面牌库 4 列对齐且大图；银河/三层星/星座连线可辨；火流星与流星雨偶发；极光幕帘流动；标题与占卜台十二宫环；reduced-motion 静态无循环动画。
6. 收尾全量 vitest：本次相关全绿（已知 imageGen/storageOptimize 负载抖动单独复跑）。

---

# Part 2 · 执行清单（按序）

## Step 1 新增 `apps/tarot/ZodiacRing.tsx`
按 Part 1.3 实现。验收：`tsc --noEmit` 对该文件无报错。

## Step 2 重写 `apps/tarot/TarotParticles.tsx`
按 Part 1.1 实现：保留 reduce/dpr/ResizeObserver/visibility/cleanup 骨架；新增 `Star`/`Meteor{fire}`/`Spark`/星座类型与数据；`makeMilkyWay` 离屏预渲染；`makeStars` 三层；`spawnConstellation` 生命周期；`spawnMeteor(origin?)` + 火花 + 流星雨计时。验收：`tsc --noEmit` 无报错。

## Step 3 改 `apps/TarotApp.tsx`
按 Part 1.2/1.3：TAROT_CSS 加 `tarotCurtain`/`.tarot-curtain`/`.tarot-curtain-rev`/`tarotSweep`；reduced-motion 名单加 `.tarot-curtain`；Aurora 层内加两层幕帘；Aurora 层与 `<TarotParticles />` 之间加背景十二宫环容器。验收：`tsc --noEmit`；层次「底色→星云→极光→星座环→星尘→内容→晕影」目检。

## Step 4 改 `apps/tarot/RitualView.tsx`
`TableFelt` 内 import 并渲染 `ZodiacRing`（Part 1.3 用法 2）。验收：`tsc --noEmit`；dealing/revealing 两处共用 TableFelt 自动生效。

## Step 5 改 `apps/tarot/LibraryView.tsx`
按 Part 1.4：删 `captionTier`、改网格与 CardTile（isDesktop prop）、hover 流光与错峰入场。验收：`tsc --noEmit`；静态目检 4 列等高、文案按端。

## Step 6 门禁与收尾
1. `vitest run utils/tarot` + `mojibakeGuard` + `tsc --noEmit` + FFFD 字节扫。
2. `notes/ethernet-features.md` 塔罗条目补一笔（银河/星座/火流星/极光幕帘/十二宫环/牌库网格）。
3. 全量 vitest；临时文件清零。
