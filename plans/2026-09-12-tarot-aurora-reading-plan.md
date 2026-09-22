# 塔罗「极光流星 + 散文解读」增强 — 设计 spec + 执行计划

日期：2026-09-12
状态：用户已批准方向（同日对话终稿：解读展示=内联改星空风、极光配色=紫罗兰+青玉绿+少量金、提示词=输出改连贯散文）。本文件同时是 spec 与弱执行者清单。

## 触碰文件清单（其他窗口请避开）

| 操作 | 文件 |
|------|------|
| 改 | `apps/tarot/TarotParticles.tsx` |
| 改 | `apps/TarotApp.tsx` |
| 改 | `apps/tarot/ReadingView.tsx` |
| 改 | `utils/tarotLlm.ts` |
| 改 | `utils/tarotLlm.test.ts` |
| 新增 | `plans/2026-09-12-tarot-aurora-reading-plan.md`（本文件） |
| 收尾 | `notes/ethernet-features.md`（塔罗条目补一笔） |
| 不动 | `apps/tarot/RitualView.tsx`、`apps/tarot/LibraryView.tsx`、`apps/tarot/TarotCards.tsx`、`utils/tarotData.ts`、`utils/tarotEngine.ts`、`utils/tarotReading.ts`、`utils/db.ts`、注册点 |

---

# Part 1 · 设计 spec

## 1.1 目标

1. 流星从「左上角偶发细线」升级为「全屏斜掠、双线拖尾、2.5-5s 一颗、可同屏两颗」。
2. 新增极光层：紫罗兰 + 青玉绿 + 少量金的慢速光带（纯 CSS，零依赖，参照 VRWorldApp.tsx:348-357 的「大径向渐变 + blur + 漂移」写法，节奏调慢调淡）。
3. 解读提示词从「按位置逐张 + 总述」改为「连贯散文、自然过渡」；注入资料与红线不变。
4. 角色解读卡从亮色羊皮纸改为深紫星空金边卡（内联，三处入口自动同款，不新增弹窗组件）。

## 1.2 风格 token（塔罗 App 私有，不外借）

- 极光色：紫罗兰 `rgba(122,92,205,α)`、青玉绿 `rgba(74,160,140,α)`（呼应占卜台丝绒绿 `#0f231d`）、金 `rgba(232,201,106,α)`（沿用本 App 金色纪律，仅作顶端微光）。
- 解读卡：底 `bg-[#181231]/90`，边 `border-[#c9a227]/45`，阴影复用本 App 既有值 `shadow-[0_16px_36px_rgba(0,0,0,0.55)]`（TarotApp.tsx:177 同款），正文 `#f5f0e1`，标题/印章金 `#e8c96a` 与 `#c9a227`。
- 圆角沿用现状（卡 `rounded`），不发明新弧度；极光动画 26-42s，属既有漂移档位（60-80s）与呼吸循环（2.4-4s）之间的新增慢速档，仅本 App 使用。
- reduced-motion：极光动画禁用（静态保留），流星本就退化为静态帧。

## 1.3 流星参数（`apps/tarot/TarotParticles.tsx`）

- 星尘：36 → 52 颗；半径 0.5-1.6 → 0.5-1.8px；基础透明度上限 0.45 → 0.47；其余（上升 6-14px/s、正弦摆动/闪烁、70% 金）不变。
- 流星：`Meteor` 单对象 → `Meteor[]`，同屏上限 2。
  - 出发：全域顶部，x ∈ 宽 -5%~65%（向右下，70% 概率）或 35%~105%（向左下，30%）；y ∈ 高 -5%~35%。
  - 速度 280-460 px/s，俯角 26°-42°；寿命 1.2-1.7s（斜穿大半屏）。
  - 首颗 1.2-3.2s 内出现，此后每 2.5-5s 一颗；30% 概率一次补第二颗。
  - 视觉：渐变双段拖尾（头白金 `rgba(255,244,214,·)` → 金 → 透明，长度 = 速度×0.4s，lineWidth 1.6）+ 头部径向光点（半径 3.2px，白金光），透明度包络 `sin(π·progress)`。
- 工程约束原样保留：DPR 上限 2、ResizeObserver 跟随父容器（resize 时清空在飞流星）、`document.hidden` 暂停、reduced-motion 只画静态星点、卸载 cleanup。

## 1.4 极光层（`apps/TarotApp.tsx`）

- 位置：根容器现有星云光斑（323-325 行）之后、`<TarotParticles />`（326 行）之前，新增 `pointer-events-none absolute inset-0 overflow-hidden` 包裹层，三团：
  1. 紫罗兰：`-top-[12%] -left-[18%] h-[52%] w-[86%]`，径向 `rgba(122,92,205,0.24) 0% → transparent 70%`，`blur(48px)`，34s。
  2. 青玉绿：`-top-[6%] -right-[22%] h-[46%] w-[80%]`，径向 `rgba(74,160,140,0.17) 0% → transparent 70%`，`blur(54px)`，42s、`animationDirection: reverse`、`animationDelay: -14s`。
  3. 金色微光：`-top-[4%] left-[8%] h-[30%] w-[70%]`，径向 `rgba(232,201,106,0.10) 0% → transparent 70%`，`blur(40px)`，26s、`animationDelay: -8s`。
- 新 keyframes 进 `TAROT_CSS`：
  `@keyframes tarotAurora { 0%,100% { transform: translate(0,0) scale(1); opacity:.7; } 50% { transform: translate(6%,4%) scale(1.14); opacity:1; } }`，类 `.tarot-aurora { animation: tarotAurora 34s ease-in-out infinite; }`。
- reduced-motion 块把 `.tarot-aurora` 加进 `animation: none !important` 名单。
- 层次（自下而上）：底色渐变 → 星云光斑 → 极光 → 星尘/流星 canvas → 内容(z-10) → 晕影(z-20)。

## 1.5 解读卡重绘（`apps/tarot/ReadingView.tsx:91-98`）

- 外层：`tarot-reveal relative overflow-hidden rounded border border-[#c9a227]/45 bg-[#181231]/90 p-4 shadow-[0_16px_36px_rgba(0,0,0,0.55)]`。
- 卡内顶部金色柔光：`pointer-events-none absolute -top-10 left-1/2 h-24 w-44 -translate-x-1/2 rounded-full`，径向 `rgba(232,201,106,0.16) → transparent`，`blur(18px)`。
- 标题行：印章改金环金字（`h-6 w-6 rounded-full border border-[#c9a227]/70 bg-[#c9a227]/15 text-[#e8c96a]`，保留「印」字）；标题 `text-[#e8c96a]`；行尾加 `Sparkle size={12} weight="fill"`，class `tarot-twinkle ml-auto text-[#e8c96a]/80`（`tarot-twinkle` 由 TarotApp 注入的 TAROT_CSS 提供）。
- 正文：`relative mt-2 whitespace-pre-wrap font-serif text-sm leading-loose text-[#f5f0e1]/95`。
- 新增 import：`Sparkle`（`@phosphor-icons/react`）。只动展示，不动 `askReader`、落库、文案、三处调用方。

## 1.6 提示词（`utils/tarotLlm.ts:72-73`）

替换指令（红线与注入格式不动）：

```
请你像面对面坐在桌前一样，用自己的语气为${querentName}娓娓道来。不要分点、不要小标题、
不要逐张机械复述牌义；把这几张牌串成一段连贯的话，让牌与牌之间自然过渡，先回应${querentName}
的疑问，再顺着牌面展开，最后收拢成你的劝慰或提醒。位置含义可以融进叙述里，但别把它们当标题
一条条念出来。你只能基于上面给出的牌义资料叙述，不得发明资料之外的牌义，也不要复读指令。
只输出解读本身。
```

测试：现有 4 条断言继续成立（`只能|不得|禁止` 仍在）；新增一条「要求连贯散文、禁止逐张」。

## 1.7 边界与禁止

- 不引入依赖、不动数据结构/IndexedDB/抽牌算法/注册点/版本号。
- 不新建弹窗组件，不改三处入口的调用方式。
- 不把塔罗的星空/极光语言扩散到其他 App。
- 写文件 UTF-8 无 BOM；中文注释不新增。

## 1.8 验收标准

1. `corepack pnpm@9.15.9 vitest run utils/tarot`：全绿（含新增断言）。
2. `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`：全绿。
3. `corepack pnpm@9.15.9 exec tsc --noEmit`：触碰文件零命中（存量 ~45）。
4. 本次 5 个改动文件字节扫 `EF BF BD` = 0。
5. `pnpm dev` 肉眼：流星全屏可见、极光三团慢速起伏、解读卡星空金边、reduced-motion 无循环动画。
6. 收尾全量 `corepack pnpm@9.15.9 vitest run` 全绿（storageOptimize 为已知并发抖动，单跑复核）。

---

# Part 2 · 执行清单（按序）

## Step 1 重写 `apps/tarot/TarotParticles.tsx`

按 Part 1.3 改：`STAR_COUNT=52`、`MAX_METEORS=2`、`spawnMeteor()`、`meteors` 数组更新与双段拖尾 + 头部光点、`nextMeteor` 节奏、resize 清空流星。其余骨架（reduce/dpr/resize/drawStatic/start/stop/visibility/cleanup）保持原样。
验收：`tsc --noEmit` 对该文件无报错。

## Step 2 改 `apps/TarotApp.tsx`

按 Part 1.4：TAROT_CSS 加 `tarotAurora`/`.tarot-aurora`；reduced-motion 名单加 `.tarot-aurora`；326 行前插极光层。
验收：`tsc --noEmit`；层次顺序目检。

## Step 3 改 `apps/tarot/ReadingView.tsx`

按 Part 1.5：import Sparkle；替换 91-98 行卡片 JSX。
验收：`tsc --noEmit`；三处入口（今日/占卜/记录）渲染同款无需改动。

## Step 4 改 `utils/tarotLlm.ts` + `utils/tarotLlm.test.ts`

按 Part 1.6 替换指令；测试新增「连贯散文」断言。
验收：`vitest run utils/tarotLlm.test.ts` 全绿。

## Step 5 门禁与收尾

1. `utils/tarot` 全跑、mojibakeGuard、tsc、FFFD 字节扫（Part 1.8 的 1-4）。
2. `notes/ethernet-features.md` 塔罗条目补一句（星空增强 + 散文解读 + 星空解读卡）。
3. 全量 vitest（Part 1.8-6）。临时文件清零。
