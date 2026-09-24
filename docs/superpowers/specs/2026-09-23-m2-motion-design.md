# M2 Motion 设计文档：跟手物理转场 + M2 曲线

- 日期：2026-09-23
- 状态：Plan-only，只写文档，不做业务改动，不执行计划。已被新 spec 部分取代：零库路线保留，Motion 仅试点（见 2026-09-23-motion-lib-jank-fix-spec.md）。
- 范围：PhoneShell 整机动效对齐 Material Design 2 motion，保留现有 reduced-motion 与性能底线
- 前置：M2 规范值由 @librarian 已验证，本文直接引用，不重查

## 1. 意图与成功标准

### 1.1 意图

小手机现在没有 JS 动画库，动效全靠 CSS token 和 keyframes。目标是让页面切换、淡入淡出、弹窗退场有统一的 M2 质感：进入与退出用不同的曲线和时长，退出更快；横向页面用 shared axis，弹窗用 fade，列表到详情预留 container transform 方向。

本次只做 token 与现有 class 的映射，不引入新手势库，不做真正的跟手拖拽物理。名称里的“跟手”指进入用 decel、退出用 accel/sharp，让视觉上有跟手起停的感觉，不是真的手指驱动。

非目标：

- 不引入 framer-motion、react-spring 等 JS 动画库
- 不新增弹窗类型，不改弹窗打开关闭的业务逻辑
- 不改布局结构，不改 Launcher 分页逻辑，不改路由逻辑
- 不动 transform / opacity 之外的属性，不碰 width、height、left、top、filter、blur

### 1.2 成功标准

1. 进入 225ms，退出 195ms，退出更快。小档位 150-225ms，大档位 300ms，桌面端取 150-200ms。超过 400ms 的动效视为失败。
2. 曲线四枚固定：standard `cubic-bezier(0.4,0,0.2,1)`、decel `cubic-bezier(0,0,0.2,1)`、accel `cubic-bezier(0.4,0,1,1)`、sharp `cubic-bezier(0.4,0,0.6,1)`。进入只用 decel 或 standard，永久退出用 accel，临时退出用 sharp。
3. 现有 `page-in-l/r`、`fade-soft`、Modal / Confirm 退场全部引用新 `--m2-*` 变量，不再散落硬编码时长和曲线。
4. reduced-motion 名单行为不变：命中名单时直接跳切或只保留 opacity，不过渡位移。名单只增不减。
5. 性能底线：只用 transform 与 opacity 做动画；60fps 下无肉眼卡顿；localhost 验证通过；`npm run build` 通过。

## 2. 备选与主方案

### 2.1 三个备选（一句话）

- A. 跟手物理转场 + M2 曲线（主方案）：零库，保持 CSS 方案，只把 token、keyframes、退场 hook 对齐 M2，进入 decel、退出 accel/sharp，进入 225ms、退出 195ms。
- B. 纯 token 对齐（最小改）：只把现有时长曲线换成 standard，不区分进入退出，不做 shared-axis / fade / container 映射。改动最小，但没有 M2 的进出差异感。
- C. 引入 JS 动画库：用库做弹簧和手势跟手，效果上限高，但违背 package.json 零库现状，增加包体积与维护成本，本次不选。

本文只细化 A。

### 2.2 主方案详述

#### 原则

- 进入慢、退出快。进入 225ms，退出 195ms。
- 进入用 decel，屏内变化用 standard，永久退出用 accel，临时退出（弹窗关闭、菜单收起）用 sharp。
- 位移与透明度一起做，位移距离小（8-32px 量级），桌面端时长取短。
- scrim 进入用 decel，退出用 accel，点击外部关闭视为 dismiss，逻辑不变。

#### 现有到 M2 的映射

| 现有 | M2 模式 | 曲线与时长 | 说明 |
| --- | --- | --- | --- |
| `page-in-l/r`（横向页面进入） | shared axis X | 进入 decel 225ms，桌面 150-200ms；退出 sharp 195ms | 只做 `translateX + opacity`，不改路由与分页逻辑。左进右出方向保持现有语义，只是时长曲线换 M2 值 |
| `fade-soft`（弱淡入淡出） | fade / fade through | 小元素 fade：standard 或 decel 150ms；无关 tab 互换用 fade through：先出 195ms（accel/sharp）再进 225ms（decel），中间不停顿过长 | 不新增 keyframe 名，能复用就复用 `fade-soft`，只换内部 token |
| Modal / Confirm + `useExitPresence` 退场 | fade + scrim | 内容 fade 150-200ms；scrim 进入 decel 150-225ms，退出 accel 195ms | hook 只管时长与 class 切换，不管打开关闭条件。弹窗内容不做缩放之外的位移，scrim 只有 opacity |
| Launcher FitPage（`apps/Launcher.tsx:299-362` 列表到详情方向） | container transform（预留） | 大档 300ms，standard；scrim 保持 TRANSPARENT | 本次只预埋 token，不改 Launcher 布局与翻页逻辑。真 container morph 需要后续单独方案 |

#### 新 token 命名与落点

命名统一前缀 `--m2-`，与现有 token 并存，旧 token 不删除，只把引用逐步切到新变量。

曲线：

```css
--m2-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
--m2-ease-decel: cubic-bezier(0, 0, 0.2, 1);
--m2-ease-accel: cubic-bezier(0.4, 0, 1, 1);
--m2-ease-sharp: cubic-bezier(0.4, 0, 0.6, 1);
```

时长：

```css
--m2-dur-150: 150ms;
--m2-dur-195: 195ms;
--m2-dur-200: 200ms;
--m2-dur-225: 225ms;
--m2-dur-250: 250ms;
--m2-dur-300: 300ms;
--m2-dur-375: 375ms;
--m2-dur-enter: 225ms;
--m2-dur-leave: 195ms;
--m2-dur-desktop-enter: 150ms;
```

落点（按现有 index.html 行区）：

- `index.html:30-65` animation token 区：新增上面全部 `--m2-ease-*` 与 `--m2-dur-*`。放在该区末尾，注释写 `M2 motion tokens`，不删旧变量。
- `index.html:66-142` keyframes 区：不新增 keyframe 名。把 `page-in-l/r` 的 duration/easing 改为引用 `--m2-dur-enter/leave` 与 `--m2-ease-decel/sharp`；`fade-soft` 改为引用 `--m2-dur-150/200` 与 `--m2-ease-standard`。位移只保留 `translateX/translateY`，透明度保留 `opacity`。
- `index.html:265-280` button 兜底区：把硬编码 `cubic-bezier(0.4,0,0.2,1)` 换成 `var(--m2-ease-standard)`，时长换成 `var(--m2-dur-200)` 或 `var(--m2-dur-150)`。行为不变，只换引用。
- `index.html:313-324` reduced-motion 名单区：在现有名单做法上追加新 class（`page-in-l/r`、`fade-soft`、modal/scrim 相关 class）。命中时 `animation: none` 或只保留 `opacity` 过渡，位移直接跳切。名单不缩减。

#### Reduced-motion 门控

M2 没有全局 reduced-motion 值，按现有 index.html 名单做法处理：

- 名单内的 class 一律 jump-cut 或纯 opacity。
- 新增的 `--m2-*` 变量不改变门控逻辑，门控写在 media query 里，覆盖 duration 为 `0.01ms` 或 `none`。
- 验收时用系统减少动态 + 浏览器模拟两遍验证。

#### 性能底线

- 只允许 `transform` 与 `opacity` 参与过渡与动画。
- 不加 `box-shadow`、`filter`、`backdrop-filter` 的过渡。
- keyframes 里不出现 `width/height/left/top/margin`。

## 3. 本次会触碰的文件清单（含行号）

| 文件 | 行区 | 改动意图 | 不碰的部分 |
| --- | --- | --- | --- |
| `index.html` | 30-65 | 新增 `--m2-ease-*`、`--m2-dur-*` token | 不删旧 token，不改其他变量 |
| `index.html` | 66-142 | `page-in-l/r`、`fade-soft` 改引用 M2 时长曲线，只留 transform/opacity | 不新增 keyframe 名，不改选择器结构 |
| `index.html` | 265-280 | button 兜底曲线换 `var(--m2-ease-standard)` | 不改按钮样式与交互逻辑 |
| `index.html` | 313-324 | reduced-motion 名单追加新 class，jump-cut/纯 opacity | 不缩减名单，不改 media 条件 |
| `hooks/useExitPresence.ts` | 7-38 | 退场时长对齐：临时退出 sharp 195ms，永久退出 accel 195ms，进入 decel 225ms | 不改 hook 入参与返回形状，不改调用方逻辑 |
| `components/os/Modal.tsx` | 15-21 | 内容 fade 与 scrim 引用新 token，scrim decel 进 accel 出 | 不新增弹窗类型，不改打开关闭条件 |
| `components/os/ConfirmDialog.tsx` | 26-69 | 同 Modal，退场走 sharp 195ms | 不改确认取消回调逻辑 |
| `components/PhoneShell.tsx` | 452、717、885-940 | 引用新 class/token，确认转场触发点不变 | 不改整机布局与状态机 |
| `App.tsx` | 40-51 | DesktopHost 入口确认，不改结构 | 不改路由与挂载逻辑 |
| `utils/layoutMode.ts` | 30-44 | 确认桌面端取短时长（150-200ms）的判断点 | 不改断点数值与返回形状 |
| `apps/Launcher.tsx` | 299-362 | FitPage 只确认方向，预埋 container token，不改翻页 | 不改分页、拖拽、点击逻辑 |
| `docs/design-system.md` | 45-55 | 更新契约：入场 350-400ms 改为进入 225ms/退出 195ms，easing 从单一值改为四曲线分工 | 不改契约外章节 |
| `package.json` | 14-39 | 只读确认零库现状，不改依赖 | 不新增任何依赖 |

预计触碰写操作文件：`index.html`、`hooks/useExitPresence.ts`、`components/os/Modal.tsx`、`components/os/ConfirmDialog.tsx`、`docs/design-system.md`。其余为只读确认。

## 4. 执行计划清单（按序，可勾选）

全局禁止：不引入新弹窗类型；不动 transform/opacity 之外的属性；不改业务逻辑（路由、弹窗条件、回调、分页、布局断点）。每步做完先 `rg` 自查，再跑构建，最后 localhost 目检。

- [ ] Step 0：只读确认，不改代码
  - 读文件路径与行号：`package.json:14-39`、`docs/design-system.md:45-55`、`index.html:30-65,66-142,265-280,313-324`、`hooks/useExitPresence.ts:7-38`、`components/os/Modal.tsx:15-21`、`components/os/ConfirmDialog.tsx:26-69`、`components/PhoneShell.tsx:452,717,885-940`、`App.tsx:40-51`、`utils/layoutMode.ts:30-44`、`apps/Launcher.tsx:299-362`。
  - 完整意图：记录现有 token 名、keyframe 名、hook 入参、弹窗 class 名，确认 `npm run` 可用脚本。不写任何文件。
  - 完成判据：能说出每个文件的现有动画 class 名与硬编码时长，且未产生 git diff。
  - 验收命令与预期输出：`git status --porcelain` 预期为空；`rg -n "page-in|fade-soft|useExitPresence" --glob '!node_modules'` 预期列出上述文件。
  - localhost 验证：`npm run dev` 启动后打开小手机，记录当前页面切换与弹窗速度，作为改后对比基线，不操作源码。
  - 边界：本步零写操作。

- [ ] Step 1：`index.html:30-65` 新增 M2 token
  - 文件路径与行号：`index.html:30-65` animation token 区末尾。
  - 完整代码意图：在该区末尾追加 2.2 节全部 `--m2-ease-*`（4 个）与 `--m2-dur-*`（10 个），包在 `/* M2 motion tokens */` 注释下。旧变量一行不删。示例意图（变量名与值必须一致）：
    ```css
    /* M2 motion tokens */
    --m2-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
    --m2-ease-decel: cubic-bezier(0, 0, 0.2, 1);
    --m2-ease-accel: cubic-bezier(0.4, 0, 1, 1);
    --m2-ease-sharp: cubic-bezier(0.4, 0, 0.6, 1);
    --m2-dur-150: 150ms;
    --m2-dur-195: 195ms;
    --m2-dur-200: 200ms;
    --m2-dur-225: 225ms;
    --m2-dur-250: 250ms;
    --m2-dur-300: 300ms;
    --m2-dur-375: 375ms;
    --m2-dur-enter: 225ms;
    --m2-dur-leave: 195ms;
    --m2-dur-desktop-enter: 150ms;
    ```
  - 完成判据：`rg` 能查到 14 个新变量，旧变量仍在。
  - 验收命令与预期输出：`rg -n "m2-ease-standard|m2-dur-enter|m2-dur-leave" index.html` 预期命中 3 行以上；`git diff --stat` 预期只有 `index.html` 有改动。
  - localhost 验证：`npm run dev` 打开小手机，随便切一页，视觉应与改前一致（本步只加变量未引用）。
  - 边界：不改 66-142、265-280、313-324；不动 transform/opacity 之外属性。

- [ ] Step 2：`index.html:66-142` keyframes 对齐 M2
  - 文件路径与行号：`index.html:66-142` keyframes 区，定位 `page-in-l/r` 与 `fade-soft` 定义处。
  - 完整代码意图：保持 keyframe 名与选择器不变，只把内部 `animation-duration` / `transition-duration` 改为 `var(--m2-dur-enter)`（进入）或 `var(--m2-dur-leave)`（退出），`animation-timing-function` 进入改为 `var(--m2-ease-decel)`、退出改为 `var(--m2-ease-sharp)`；`fade-soft` 改为 `var(--m2-dur-150)` + `var(--m2-ease-standard)`。位移只留 `translateX/translateY`，透明度只留 `opacity`，删除或不动其他属性过渡。桌面端媒体查询内的进入时长用 `var(--m2-dur-desktop-enter)`。
  - 完成判据：`page-in` 相关行引用 `--m2-ease-decel/sharp` 与 `--m2-dur-enter/leave`；`fade-soft` 引用 `--m2-dur-150` 与 `--m2-ease-standard`；无 `width/height/left/top/filter` 过渡。
  - 验收命令与预期输出：`rg -n "m2-ease-decel|m2-ease-sharp|m2-dur-enter|m2-dur-leave" index.html` 预期命中 keyframes 区多行；`rg -n "transition-property|animation" index.html` 人工确认无新增属性名。
  - localhost 验证：`npm run dev` 打开小手机，左右切页各 3 次，进入应比退出略慢且收尾更干脆；fade 元素应短促不拖沓。
  - 边界：不新增 keyframe 名；不改 JS；不改业务逻辑。

- [ ] Step 3：`index.html:265-280` button 兜底换变量
  - 文件路径与行号：`index.html:265-280` button 兜底区。
  - 完整代码意图：把该区的 `cubic-bezier(0.4,0,0.2,1)` 字面量换成 `var(--m2-ease-standard)`，时长字面量（200ms 或同区现有值）换成 `var(--m2-dur-200)`。选择器与声明顺序不变。
  - 完成判据：该区无 `cubic-bezier(0.4,0,0.2,1)` 硬编码，只剩变量引用，按钮行为不变。
  - 验收命令与预期输出：`rg -n "cubic-bezier\(0\.4,0,0\.2,1\)" index.html` 预期在该区零命中（其他区允许保留旧值做对比）；`rg -n "m2-ease-standard" index.html` 预期命中该区。
  - localhost 验证：`npm run dev` 打开小手机，点任意按钮，hover/active 反馈应与改前一致。
  - 边界：只换引用，不调时长数值语义；不动颜色边框等样式。

- [ ] Step 4：退场 hook 与弹窗对齐（`hooks/useExitPresence.ts:7-38`、`components/os/Modal.tsx:15-21`、`components/os/ConfirmDialog.tsx:26-69`）
  - 文件路径与行号：先改 `hooks/useExitPresence.ts:7-38` 的时长常量与 class 切换，再改 `components/os/Modal.tsx:15-21` 与 `components/os/ConfirmDialog.tsx:26-69` 的 class/过渡引用。
  - 完整代码意图：hook 内进入时长取 225（`var(--m2-dur-enter)` 对应 JS 常量 225），退出取 195（对应 195），进入 easing 语义为 decel，临时退出为 sharp、永久退出为 accel；hook 入参出参不变。Modal 内容 fade 用 150-200ms + standard，scrim 进入 decel 150-225ms、退出 accel 195ms，只过渡 opacity。Confirm 同 Modal，退出走 sharp 195ms。弹窗打开关闭条件、回调、外部点击 dismiss 逻辑一行不改。
  - 完成判据：弹窗打开 225ms 内完成进入，关闭 195ms 内完成退出且无位移残留；hook API 形状不变。
  - 验收命令与预期输出：`rg -n "195|225" hooks/useExitPresence.ts components/os/Modal.tsx components/os/ConfirmDialog.tsx` 预期命中新时长；`npx tsc --noEmit` 预期零报错（若仓库无 tsc 脚本则改跑 `npm run build`，预期构建成功）。
  - localhost 验证：`npm run dev` 打开小手机，打开关闭 Modal 与 Confirm 各 2 次，退出应比进入快，scrim 无闪烁。
  - 边界：禁止新增弹窗类型；禁止改动打开条件与回调；只动 transform/opacity。

- [ ] Step 5：PhoneShell / App / layoutMode / Launcher 只读接线确认
  - 文件路径与行号：`components/PhoneShell.tsx:452,717,885-940`、`App.tsx:40-51`、`utils/layoutMode.ts:30-44`、`apps/Launcher.tsx:299-362`。
  - 完整代码意图：默认不改。若发现某处仍引用旧硬编码时长曲线，才允许把该行换成 `--m2-*` 变量引用，且只换动画相关声明。布局、状态、断点、分页逻辑一律不动。Launcher 本次不做 container morph，只确认预留注释位置。
  - 完成判据：要么零改动，要么 diff 只有动画声明行的变量替换。
  - 验收命令与预期输出：`git diff -- components/PhoneShell.tsx App.tsx utils/layoutMode.ts apps/Launcher.tsx` 预期为空或仅含 `m2-` 引用行；`rg -n "m2-dur|m2-ease" components/PhoneShell.tsx App.tsx utils/layoutMode.ts apps/Launcher.tsx` 记录引用情况。
  - localhost 验证：`npm run dev` 打开小手机，桌面与手机两种宽度各切页一次，桌面进入应更短促（150-200ms 感）。
  - 边界：本步禁止改业务逻辑；有拿不准的引用宁可不改，记到 Step 6 备注。

- [ ] Step 6：reduced-motion 与契约更新（`index.html:313-324`、`docs/design-system.md:45-55`）
  - 文件路径与行号：`index.html:313-324` 名单区追加；`docs/design-system.md:45-55` 契约段重写。
  - 完整代码意图：名单区把 `page-in-l/r`、`fade-soft`、modal/scrim 相关 class 追加进现有 media query，命中时 `animation: none; transition-duration: 0.01ms` 或只保留 opacity。契约段把“入场 350-400ms、交互 200/300/500、单一 easing”更新为“进入 225ms、退出 195ms、小档 150-225ms、大档 300ms、四曲线分工”，并注明只允许 transform/opacity。
  - 完成判据：开 reduced-motion 后页面切换为跳切、无位移残留；契约无旧时长残留。
  - 验收命令与预期输出：`rg -n "prefers-reduced-motion" -A 10 index.html` 预期看到新增 class 名；`rg -n "225|195|m2-ease" docs/design-system.md` 预期命中。
  - localhost 验证：系统开启减少动态（或 DevTools 模拟），`npm run dev` 打开小手机切页开弹窗，应为跳切或极短淡入，无滑动感。关闭减少动态后恢复正常。
  - 边界：名单只增不减；不改 media 条件本身。

- [ ] Step 7：回归与收尾
  - 完整意图：全仓搜硬编码残留，跑构建，localhost 走一遍切页、弹窗、按钮、Launcher，删临时文件。
  - 完成判据：`rg` 无新增硬编码回退；构建成功；手动走查无卡顿闪烁；`git status` 无临时文件。
  - 验收命令与预期输出：`rg -n "cubic-bezier\(0\.4,0,1,1\)|cubic-bezier\(0,0,0\.2,1\)|cubic-bezier\(0\.4,0,0\.6,1\)" index.html` 预期只命中 token 定义行；`npm run build` 预期成功；`git status --porcelain` 预期只有 5 个预期文件有改动。
  - localhost 验证：`npm run dev` 按“切页→弹窗→Confirm→Launcher→按钮”顺序走一遍，每处记录进入退出体感（快/慢/闪），有问题回退到 Step 2-4。
  - 边界：本步不改源码，只验证与清理。

## 5. 与零库契约的冲突说明

- 零库现状在 `package.json:14-39`：无 JS 动画库。主方案不引入任何依赖，与该现状无冲突，不需要推翻。
- 契约在 `docs/design-system.md:45-55`：旧值（入场 350-400ms、交互 200/300/500、单一 `cubic-bezier(.2,.8,.2,1)`）与 M2 值冲突。处理方式是扩展不是推翻：保留“零库、只用 transform/opacity、reduced-motion 门控”三条底线，把时长曲线部分更新为 M2 四曲线与进入 225ms/退出 195ms。
- 需要 ADR 备注（记在 design-system 或单独 ADR 文件，由执行人补一小段）：说明为何保留零库（包体积、维护成本、当前动效复杂度不需要库）、为何选进入 decel 退出 accel/sharp、为何桌面取短。后续若要真跟手拖拽或弹簧物理，必须另开 ADR 并重新评估引入库，不在本方案内偷加。

## 附录：M2 速查（执行时对照）

- standard `cubic-bezier(0.4,0,0.2,1)`：屏内变化。
- decel `cubic-bezier(0,0,0.2,1)`：只进。
- accel `cubic-bezier(0.4,0,1,1)`：永久退出。
- sharp `cubic-bezier(0.4,0,0.6,1)`：临时退出。
- 时长刻度 150/200/250/300/375；进入 225，退出 195；大于 400 显慢；桌面取 150-200。
- container transform 大档 300ms，scrim 透明；shared axis X 横向/Y 纵向/Z 放大；fade through 先出后进；fade 给弹窗菜单 scrim 小档 150-225ms；scrim 进入 decel 退出 accel。
