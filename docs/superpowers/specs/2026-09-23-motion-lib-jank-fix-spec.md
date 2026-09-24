# Motion 卡顿治本 + 试点引库 Spec

- 日期：2026-09-23
- 状态：Plan-only。只写文档，不碰业务代码，不安装依赖，写完停下等用户说执行。
- 关系：部分取代 `2026-09-23-m2-motion-design.md`。旧 spec 的零库路线保留，M2 token 沿用旧 spec 2.2 节；本 spec 新增的是卡顿治本动作和 Motion 试点范围。旧 spec 第 5 节里的零库结论不再是最终结论，以本文 ADR 为准。
- M2 token 来源：沿用旧 spec 2.2 节（`--m2-ease-*` 四曲线，进入 225ms、退出 195ms），本文不重定义数值。

## 1. 意图与成功标准

### 1.1 意图

治本加试点，不做全量替换。

治本：去掉 App 切换首帧卡顿的根因。根因已经验证：`fadeIn` keyframes 带 `scale(0.97)+translateY(4px)`（`index.html:67-70`），挂在 `key={activeApp}` 整树重挂载层（`PhoneShell.tsx:930`），首帧和 lazy 解析加几十张头像解码抢主线程。`git c9083135` 已经证明纯 opacity 可以绕过。App 容器保持纯 opacity，不放 transform。

试点引库：只在小范围试 Motion，验证手感和包体积，再决定是否扩大。Motion 只做现有 CSS 做不到的部分（退场编排、开合共享元素），不接管整机动效。

### 1.2 成功标准

1. App 切换首帧不再卡：重 App（以 CheckPhone 为代表）连续切换 5 次，无超过一秒的停顿感，localhost 目检通过。
2. App 容器保持纯 opacity：`PhoneShell.tsx:930` 那层 animation 只含 opacity，不出现 scale、translate。
3. 图片不再首帧抢主线程：TokenImg 默认带解码与懒加载声明，列表头像有固定宽高，重 App 空闲时预取已验证有效。
4. Motion 试点范围不擴散：只有 ConfirmDialog、page-in-l/r、Modal 三处走 Motion，其余走现有 CSS。PhoneShell 容器与 Launcher morph 不在试点内。
5. reduced-motion 行为不变：命中名单直接跳切或只留 opacity。Motion 侧用 `reducedMotion="user"`，和现有名单对齐。
6. 构建与回归通过：`npm run build` 成功，现有动效测试与全量测试不新增失败。

## 2. 背景结论（已验证，直接用，不重查）

- 卡顿链：`index.html:67-70` 的 fadeIn 含 transform，加在 `PhoneShell.tsx:930` 整树重挂载层，首帧与 lazy 解析加头像解码冲突。`PhoneShell.tsx:925-929` 注释已写明 App 容器禁 transform。`c9083135` 实证纯 opacity 绕过有效。
- 图片侧：`components/os/TokenImg.tsx:10-13` 是裸 img，无 decoding、loading、宽高声明。`apps/CheckPhone.tsx:2399-2428` 这类列表逐行挂头像，每行一个 TokenImg。`useBlobRefUrl`（`utils/blobRef.ts:351-355`）对 blobref 令牌是异步解析，会多一轮挂载，首帧先空再出图。
- Motion 选型结论：`motion@13.2.0`，`import { motion } from "motion/react"`，MIT 协议。全量约 35KB，LazyMotion 可压到 5-17KB。`MotionConfig reducedMotion="user"` 对接现有名单。`layoutId` 加 `AnimatePresence` 覆盖开合切页。GSAP 出局，不用。

## 3. 两阶段方案

### 阶段一：治本 C（不装包，先做）

目标是让现有 CSS 动效不再卡。全部是小改，不改业务逻辑。

C1. TokenImg 加默认图片属性（`components/os/TokenImg.tsx:10-13`）

- 给底层 img 加 `decoding="async"` 和 `loading="lazy"`，让头像解码与加载不挡首帧。
- 调用方已写死 `w-12 h-12` 这类 class 的，保持不动；没有固定尺寸的调用点，补上宽高或 aspect 占位，避免加载后跳动。
- 允许调用方透传覆盖（比如首屏大头像要 `eager`），TokenImg 只给默认值，不锁死。
- 验 blob URL 交互：`useBlobRefUrl` 首帧返回 undefined 时，img 不带空 src 闪烁，不把已回收的 objectURL 吐给渲染层。语义以 `utils/blobRefHook.contract.test.ts` 为准，不改 hook 本身。

C2. 重 App 空闲预取（以 `apps/CheckPhone.tsx:2399-2428` 为样本）

- 在进入重 App 前，用 `requestIdleCallback`（无则 `setTimeout 0`）预热头像解析或预取关键图，不在首帧同步做。
- 长列表保持现有分页与渲染保护（比如 transcript 只渲染最新 50 行这类逻辑），不动分页数量与截断规则。
- 本阶段不改 CheckPhone 的布局、跳转、删除确认回调，只动图片加载时机。

C3. App 容器保持纯 opacity（`PhoneShell.tsx:922-933` 只读确认为主）

- `PhoneShell.tsx:930` 的 `appEnterFade` 保持纯 opacity 200ms，不加回 scale/translate。
- `Modal.tsx` / `ConfirmDialog.tsx` 里残留的 `animate-fade-in`（含 transform 的旧 fadeIn）要换成纯 opacity 的 fade-soft 或等价项，不让 transform 从弹窗侧漏回首帧路径。具体换法见执行计划 Step 3。

### 阶段二：Motion 试点（装包，小范围）

目标是验证 Motion 手感与成本，范围锁死三处。

M1. 安装与隔离

- 装 `motion@13.2.0`，`package.json:14-39` 依赖区新增一行。包名是 `motion`，引用写 `import { motion } from "motion/react"`。
- 新建单一 `utils/motion.ts`（若仓库已有同名文件则复用，不另起名）。所有 Motion 配置只从这个文件出：时长与曲线只读 `--m2-*` token（读 CSS 变量或常量镜像，不在 JS 里另起一套数值）；只许 `transform` / `opacity`；入口先判 reduced-motion，命中直接短路为跳切。
- 用 `LazyMotion` 按需加载，目标 5-17KB 区间。全量引入视为失败，需要回退到 LazyMotion。
- 顶层包 `MotionConfig reducedMotion="user"`，和 `index.html:313-324` 名单对齐。名单只增不减。

M2. 试点范围（只许三处）

- `ConfirmDialog.tsx:26-69`：退场走 Motion，退出 sharp 195ms。打开关闭条件、确认取消回调不动。
- 横向切页 `page-in-l/r`（`index.html:60-62` 定义，`122-129` keyframes）：进入 decel 225ms、退出 sharp 195ms，`translateX + opacity`。路由与分页逻辑不动。
- `Modal.tsx:15-21`：内容 fade 加 scrim（scrim 只动 opacity，进入 decel、退出 accel）。打开关闭条件不动。
- 明确不在试点：PhoneShell App 容器（`PhoneShell.tsx:922-933`）、Launcher morph（`apps/Launcher.tsx:299-362`）。这两处保持现有 CSS，任何想做 morph 的需求另开方案。

M3. 退场编排

- `hooks/useExitPresence.ts:7-38` 保持 API 形状（`{ mounted, phase }`）不变。试点内允许把内部 timeout 时长对齐到 195/225，或换成 `AnimatePresence`，但调用方看到的入参与返回不变。
- 弹窗内容不做缩放之外的位移，scrim 只有 opacity。

## 4. 本次会触碰的文件清单（含行号）

| 文件 | 行区 | 改动意图 | 不碰的部分 |
| --- | --- | --- | --- |
| `index.html` | 46-65 animation token 区 | 新增 `--m2-ease-*`、`--m2-dur-*`（沿用旧 spec 2.2 节值） | 不删旧 token |
| `index.html` | 60-62、67-70、122-133 | `page-in-l/r` 对齐 M2；`fadeIn` 保留但不再挂 App 容器；`fade-soft` 保持纯 opacity | 不新增 keyframe 名（试点外） |
| `index.html` | 265-280 button 兜底 | 硬编码曲线换 `var(--m2-ease-standard)` | 不改按钮样式与交互 |
| `index.html` | 313-324 reduced-motion 名单 | 追加新 class，jump-cut 或纯 opacity | 不缩减名单，不改 media 条件 |
| `components/PhoneShell.tsx` | 922-933 | 只读确认 App 容器纯 opacity，默认不改 | 不改布局、状态机、挂载 key |
| `components/os/TokenImg.tsx` | 10-13 | 加 `decoding="async"`、`loading="lazy"` 默认值 | 不改解析逻辑，不锁死覆盖 |
| `apps/CheckPhone.tsx` | 2399-2428（列表头像区） | 空闲预取，不改行结构 | 不改路由、回调、分页数量 |
| `utils/blobRef.ts` | 351-355 `useBlobRefUrl` | 只读确认异步语义，不改 | 不改签名与回收逻辑 |
| `components/os/Modal.tsx` | 15-21 | 退场对齐 M2 / 试点 Motion其一 | 不新增弹窗类型，不改打开条件 |
| `components/os/ConfirmDialog.tsx` | 26-69 | 退场 sharp 195ms，试点 Motion | 不改确认取消回调 |
| `hooks/useExitPresence.ts` | 7-38 | 时长对齐 195/225，API 不变 | 不改入参与返回形状 |
| `docs/design-system.md` | 43-55 动效节 | 更新为进入 225 / 退出 195、四曲线分工、Motion 试点范围 | 不改契约外章节 |
| `package.json` | 14-39 | 阶段二新增 `motion@13.2.0` | 阶段一不碰 |
| `utils/motion.ts` | 新建 | Motion 唯一隔离入口，只读 `--m2-*`，reduced-motion 短路 | 不放业务逻辑 |

预计写操作文件：阶段一是 `index.html`、`components/os/TokenImg.tsx`、`apps/CheckPhone.tsx`、`docs/design-system.md`；阶段二加 `package.json`、`utils/motion.ts`、`components/os/Modal.tsx`、`components/os/ConfirmDialog.tsx`、`hooks/useExitPresence.ts`。其余为只读确认。

## 5. 执行计划清单（按序，可勾选）

全局边界与禁止：不动路由、回调、分页数量、布局断点；不新增弹窗类型；只动 transform/opacity；PhoneShell 容器与 Launcher morph 不进试点。每步做完先 `rg` 自查，再跑构建，最后 localhost 目检。

- [ ] Step 0：只读确认，不改代码
  - 文件路径与行号：`package.json:14-39`、`docs/design-system.md:43-55`、`index.html:46-70,122-133,313-324`、`components/PhoneShell.tsx:922-933`、`components/os/TokenImg.tsx:10-13`、`apps/CheckPhone.tsx:2399-2428`、`utils/blobRef.ts:351-355`、`hooks/useExitPresence.ts:7-38`、`components/os/Modal.tsx:15-21`、`components/os/ConfirmDialog.tsx:26-69`。
  - 完整代码意图：不写文件，只记录现有 class 名（`animate-fade-in`、`page-in-l/r`、`fade-soft`）、hook 签名（`useExitPresence(open, duration)` 返回 `{ mounted, phase }`）、TokenImg 现状（裸 img 无 decoding/loading）。确认 `npm run dev` 与 `npm run build` 可用。
  - 验收命令与预期输出：`git status --porcelain` 预期为空；`rg -n "page-in|fade-soft|useExitPresence|TokenImg" --glob '!node_modules'` 预期列出上述文件。
  - localhost 验证：`npm run dev` 打开小手机，切 App 与开关弹窗各 2 次，记下当前卡顿基线。
  - 边界：本步零写操作。

- [ ] Step 1：`index.html:46-65` 新增 M2 token（沿用旧 spec 2.2 节）
  - 文件路径与行号：`index.html:46-65` animation token 区末尾（tailwind.config 内）。
  - 完整代码意图：在该区追加 `--m2-ease-standard/decel/accel/sharp`（4 个）与 `--m2-dur-150/195/200/225/250/300/375/enter/leave/desktop-enter`（10 个），包在 `/* M2 motion tokens */` 注释下。旧变量一行不删。值与旧 spec 2.2 节逐字一致。
  - 验收命令与预期输出：`rg -n "m2-ease-standard|m2-dur-enter|m2-dur-leave" index.html` 预期命中 3 行以上；`git diff --stat` 预期只有 `index.html` 有改动。
  - localhost 验证：`npm run dev` 切一页，视觉应与改前一致（本步只加变量未引用）。
  - 边界：不改 keyframes 与名单区。

- [ ] Step 2：TokenImg 加默认值（`components/os/TokenImg.tsx:10-13`）
  - 文件路径与行号：`components/os/TokenImg.tsx:10-13` 的 img 返回行。
  - 完整代码意图：把 `return <img src={src} {...rest} />` 改为带默认值的版本，大意是 `decoding` 默认 `async`、`loading` 默认 `lazy`，调用方透传优先（`rest` 覆盖默认值）。同步确认 `src` 为 undefined 时不渲染空 src（沿用现有 `useBlobRefUrl` 返回 undefined 即首帧无图的语义，不改 hook）。
  - 验收命令与预期输出：`rg -n "decoding|loading" components/os/TokenImg.tsx` 预期命中；`npx tsc --noEmit` 预期零报错（无 tsc 脚本则改跑 `npm run build`，预期成功）。
  - localhost 验证：`npm run dev` 打开 CheckPhone 列表页，滚动看头像，后续行应懒加载，首屏无布局跳动（有跳动则回头补宽高）。
  - 边界：不改 `utils/blobRef.ts`；不锁死 `eager` 覆盖；不动业务逻辑。

- [ ] Step 3：弹窗与退场对齐 M2（CSS 侧，先不装 Motion）
  - 文件路径与行号：`hooks/useExitPresence.ts:7-38` 时长常量；`components/os/Modal.tsx:19,21` 的 `animate-fade-in` / `animate-slide-up`；`components/os/ConfirmDialog.tsx:67,69` 的 `animate-fade-in` / `animate-pop-in`。
  - 完整代码意图：hook 内进入时长取 225、退出取 195（进入语义 decel，临时退出 sharp、永久退出 accel），入参与返回形状不变。Modal 与 Confirm 的外层遮罩换成纯 opacity 的 fade（引用 `--m2-dur-*`），去掉含 scale/translate 的旧 `animate-fade-in`；面板侧 Modal 用 slide-up（只留 translateY 小位移加 opacity），Confirm 用 pop-in 但只在试点外保持 CSS，位移量级 8-32px。打开关闭条件与回调一行不改。
  - 验收命令与预期输出：`rg -n "195|225" hooks/useExitPresence.ts components/os/Modal.tsx components/os/ConfirmDialog.tsx` 预期命中新时长；`rg -n "animate-fade-in" components/os/Modal.tsx components/os/ConfirmDialog.tsx` 预期零命中（已换成 fade-soft 或等价纯 opacity 项）。
  - localhost 验证：`npm run dev` 开关 Modal 与 Confirm 各 2 次，退出应比进入快，scrim 无闪烁。
  - 边界：禁止新增弹窗类型；只动 transform/opacity。

- [ ] Step 4：重 App 空闲预取（`apps/CheckPhone.tsx:2399-2428`）
  - 文件路径与行号：`apps/CheckPhone.tsx:2399-2428` 列表渲染区，及该文件顶部 effect 区（按实际行号就近放 effect）。
  - 完整代码意图：加一个空闲 effect，大意是 `requestIdleCallback || setTimeout` 里预热列表前 N 张头像的解析（只预热，不改渲染结构）。列表 `map` 结构、点击跳转、删除确认回调不动。分页数量与截断规则不动。
  - 验收命令与预期输出：`rg -n "requestIdleCallback|setTimeout" apps/CheckPhone.tsx` 预期命中新增 effect；`npm run build` 预期成功。
  - localhost 验证：`npm run dev` 反复进出 CheckPhone 5 次，首帧停顿应明显小于 Step 0 基线。
  - 边界：不动路由、回调、分页；不在首帧同步解码大图。

- [ ] Step 5：reduced-motion 与契约更新（`index.html:313-324`、`docs/design-system.md:43-55`）
  - 文件路径与行号：`index.html:313-324` 名单区；`docs/design-system.md:43-55` 动效节。
  - 完整代码意图：名单区把 `page-in-l/r`、`fade-soft`、modal/scrim 相关 class 追加进现有 media query，命中时 `animation-duration: 0.01ms` 或只留 opacity。契约段把旧时长（350-400ms、单一 easing）更新为进入 225ms、退出 195ms、四曲线分工，并注明 App 容器禁 transform、试点范围仅三处。
  - 验收命令与预期输出：`rg -n "prefers-reduced-motion" -A 10 index.html` 预期看到新增 class；`rg -n "225|195|m2-ease" docs/design-system.md` 预期命中。
  - localhost 验证：系统开启减少动态（或 DevTools 模拟），切页开弹窗应为跳切或极短淡入，无滑动感；关闭后恢复正常。
  - 边界：名单只增不减；不改 media 条件本身。

- [ ] Step 6：阶段一回归（不装包收尾）
  - 完整意图：全仓搜硬编码残留，跑构建，localhost 走切页、弹窗、按钮、Launcher，删临时文件。
  - 验收命令与预期输出：`rg -n "cubic-bezier\(0\.4,0,1,1\)|cubic-bezier\(0,0,0\.2,1\)" index.html` 预期只命中 token 定义行；`npm run build` 预期成功；`git status --porcelain` 预期只有阶段一 4 个文件有改动。
  - localhost 验证：按切页、弹窗、Confirm、Launcher、按钮顺序走一遍，记录体感，有问题回退到 Step 3-4。
  - 边界：本步不改源码，只验证与清理。若阶段一已达标，可以停在这里不进阶段二。

- [ ] Step 7：Motion 试点装包与隔离（阶段二入口）
  - 文件路径与行号：`package.json:14-39` 依赖区；新建 `utils/motion.ts`。
  - 完整代码意图：`pnpm add motion@13.2.0`（锁定 13.2.0）。`utils/motion.ts` 只做三件事：只读 `--m2-*` token（时长曲线与 CSS 同源）、导出 reduced-motion 短路判断（命中直接返回跳切配置）、导出受限的预设（只含 transform/opacity）。不放业务逻辑。
  - 验收命令与预期输出：`rg -n "\"motion\"" package.json` 预期命中 `13.2.0`；`node -e "import('motion/react').then(()=>console.log('ok'))"` 或构建时 resolve 成功；`npm run build` 预期成功且包体积增量在预期内（全量约 35KB，LazyMotion 目标 5-17KB）。
  - localhost 验证：`npm run dev` 打开小手机，不试点的位置视觉应与阶段一一致（本步只装包未接线）。
  - 边界：不用 GSAP；不用旧 `framer-motion` 包名；不动路由与弹窗逻辑。

- [ ] Step 8：Motion 试点接线（仅三处）
  - 文件路径与行号：`components/os/ConfirmDialog.tsx:26-69`、`components/os/Modal.tsx:15-21`、`index.html:60-62` 对应的切页触发点（按实际引用位置就近改）。
  - 完整代码意图：三处改用 `utils/motion.ts` 预设加 `motion` 组件（或 `AnimatePresence` 管退场），进入 decel 225ms、退出 sharp 195ms（scrim 退出 accel），只动 transform/opacity。顶层包 `MotionConfig reducedMotion="user"`。`useExitPresence` 的 API 形状不变，内部允许对齐时长。
  - 验收命令与预期输出：`rg -n "motion/react|MotionConfig|AnimatePresence|layoutId" components/os/Modal.tsx components/os/ConfirmDialog.tsx utils/motion.ts` 预期命中试点三处；`rg -n "from \"motion" components/PhoneShell.tsx apps/Launcher.tsx` 预期零命中（禁区未漏入）；`npm run build` 预期成功。
  - localhost 验证：`npm run dev` 开关 Confirm/Modal 各 2 次、左右切页各 3 次，退出比进入快且无闪烁；开 reduced-motion 后为跳切。
  - 边界：PhoneShell 容器与 Launcher morph 禁止接 Motion；不新增弹窗类型；有拿不准的引用宁可不改。

- [ ] Step 9：最终回归与收尾
  - 完整意图：查 Motion 残留扩散，跑构建，全量相关测试，localhost 全走查，删临时文件。
  - 验收命令与预期输出：`rg -n "from \"motion|from 'motion" --glob '!node_modules'` 预期只命中试点文件加 `utils/motion.ts`；`rg -n "m2-ease|m2-dur" index.html utils/motion.ts` 预期两边同源无分叉；`npm run build` 预期成功；`git status --porcelain` 预期只有清单内文件有改动。
  - localhost 验证：切页、弹窗、Confirm、Launcher、按钮全走一遍，桌面与手机两种宽度各切页一次。
  - 边界：本步不改源码，只验证与清理。

## 6. 回滚方案

1. 代码回滚：按阶段 `git revert` 对应提交（阶段一与阶段二分开提交，试点接线单独提交，方便单步回滚）。
2. 残留检查：`rg -n "m2-ease|m2-dur" index.html` 确认 token 是否残留（残留无害，未引用即等同无效果）；`rg -n "from \"motion|from 'motion|MotionConfig|AnimatePresence|layoutId" --glob '!node_modules'` 确认 Motion 无残留引用。
3. 删包即回 CSS：`pnpm remove motion` 后删 `utils/motion.ts`，试点三处改回 Step 3 的 CSS class，行为回到阶段一。
4. 构建加走查：`npm run build` 预期成功；`npm run dev` 按 Step 9 顺序走查一遍，确认回到阶段一手感。
5. 禁区回滚确认：`rg -n "appEnterFade|app-enter" components/PhoneShell.tsx` 确认容器仍是纯 opacity；`git diff -- components/PhoneShell.tsx apps/Launcher.tsx` 预期无业务逻辑改动。

## 7. ADR 备注

- 为何推翻零库：旧 spec 写于卡顿根因查明之前，当时认为 CSS 足够。现在根因明确（整树重挂载加 transform 首帧抢主线程），且退场编排与开合共享元素用 CSS 难做干净。推翻的不是整条零库路线，而是全仓零库一刀切：主体保持 CSS，Motion 只试点三处，用包体积换手感与可维护性。
- 为何选 Motion：`motion@13.2.0` 的 `motion/react` 入口为 React 优化，MIT 协议，全量约 35KB、LazyMotion 可压到 5-17KB；`MotionConfig reducedMotion="user"` 直接对接现有 reduced-motion 名单；`layoutId` 加 `AnimatePresence` 正好覆盖开合同类需求。GSAP 出局：能力过剩且与现有 token 体系不贴合。
- App 容器禁令保留：`PhoneShell.tsx:925-929` 注释与 `c9083135` 实证继续有效。无论是否引入 Motion，`key={activeApp}` 整树层永久禁 transform，只许 opacity。Launcher morph 同样不在试点，谁想做 morph 另开方案。
