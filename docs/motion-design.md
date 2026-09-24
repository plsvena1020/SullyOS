# SullyOS 动效设计记录

- 日期：2026-09-24
- 性质：现状记录 + 约束清单。新增动效先对照本文，再看 `docs/design-system.md` 第五节与第八节。
- 配套 spec（过程文档）：`docs/superpowers/specs/2026-09-23-m2-motion-design.md`、`docs/superpowers/specs/2026-09-23-motion-lib-jank-fix-spec.md`。

## 1. 总览

全仓以 CSS 动效为主，JS 动效库只试点一处。原因：现有需求全是进 / 出二态切换，CSS 变量加退场 hook 已覆盖；弹簧、跟手拖拽、布局 morph 这类库的上限目前用不上。

- CSS 中央 token：`index.html` 的 `:root`（`--m2-*`，`index.html:162-175`）与 tailwind animation 区（`index.html:60-63`）。
- 退场保持挂载：`hooks/useExitPresence.ts:7`（默认 195ms，API 形状 `{ mounted, phase }` 不变）。
- Motion 试点唯一入口：`utils/motion.ts`（`motion@13.2.0`，`LazyMotion` + `domAnimation`，顶层 `MotionConfig reducedMotion="user"`）。
- 各 App 自带一次性内联 `@keyframes`（CDN 版 Tailwind 自定义 `animate-*` 不可靠）。

## 2. Token（M2 对齐，2026-09-23）

曲线四枚，进入与退出用不同曲线，退出更快：

| token | 值 | 用途 |
| --- | --- | --- |
| `--m2-ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | 屏内变化 |
| `--m2-ease-decel` | `cubic-bezier(0, 0, 0.2, 1)` | 只进 |
| `--m2-ease-accel` | `cubic-bezier(0.4, 0, 1, 1)` | 永久退出 |
| `--m2-ease-sharp` | `cubic-bezier(0.4, 0, 0.6, 1)` | 临时退出（弹窗关闭） |

时长：进入 225ms（`--m2-dur-enter`）、退出 195ms（`--m2-dur-leave`）；小档 150-225ms，大档 300ms，桌面端进入 150-200ms（`--m2-dur-desktop-enter`）。超过 400ms 视为失败。

现有 class 到 M2 的映射（`index.html:60-63`）：`page-in-l/r` 用进入时长加 decel（shared axis X 语义）；`fade-soft` 纯 opacity 加 standard；`fade-out-soft` 用退出时长加 sharp。按钮全局兜底引用同一套变量（`index.html:282-289`）。

## 3. 硬规则

1. 只允许 `transform` / `opacity` 参与过渡与动画。keyframes 里不出现 `width/height/left/top/margin`，不给 `box-shadow` / `filter` / `backdrop-blur` 加过渡。
2. App 容器禁 transform：`components/PhoneShell.tsx:930-931` 的 `appEnterFade` 永久只许纯 opacity（200ms）。`key={activeApp}` 整树重挂载层挂 transform，会把含大量头像的子树逼进合成层做全量栅格化，首帧卡顿约一秒（2026-06-23 提交 `c9083135` 已实证）。
3. 外壳背景两层禁过渡：壁纸层（`components/PhoneShell.tsx:894`）与白幕层（`:904`）不带 `transition`。背景只做瞬切，过渡只由 App 内容自己承担；否则新 App 半透明淡入时会透出中途的白幕，看着像闪白屏。
4. 透明底界面禁淡入：覆盖在外壳上的全屏界面若自身背景透明，根节点不挂淡入动画。查手机目标选择界面因此去掉 `animate-fade-soft`（`apps/CheckPhone.tsx:3999`，2026-09-24 白闪修复）。同理，任何从全透明开始的淡入都不许叠在浅色外壳背景上。
5. Motion 只许四处（`utils/motion.ts` 唯一入口）：`ConfirmDialog` 退场、横向切页 `page-in-l/r`、`Modal` 内容 fade 加 scrim、`BottomSheet` 底部弹层（含 `sheetPanelVariants` 把手拖拽关闭，2026-09-24 ADR）。PhoneShell 容器与 Launcher morph 禁止引用。扩大试点前先开 ADR。
6. 时长曲线只读 `--m2-*`：`utils/motion.ts` 运行时优先读 CSS 变量，读不到回退 JS 镜像（`M2_MIRROR`，值逐字一致）；Motion easing 用 bezier 数组（motion 不接受 CSS 字符串）。JS 里不另起一套数值。
7. 包体积：调用方一律走 `LazyMotion features={motionFeatures}`（domAnimation，目标 5-17KB）；全量引入视为失败。

## 4. Motion 试点预设（`utils/motion.ts:92-130`）

- 进入：decel 225ms；临时退出：sharp 195ms；永久退出：accel 195ms。
- `scrimVariants`：只动 opacity，进入 decel、退出 accel。
- `pageVariants(dir)`：`translateX ±24px + opacity`，进入 decel、退出 sharp。
- `modalPanelVariants`：`y 12px + opacity` 小位移；`confirmPanelVariants`：`scale 0.96→1 + opacity`，不做缩放之外的位移。
- `sheetPanelVariants`（2026-09-24 BottomSheet ADR）：`y 48px + opacity`（初始 `opacity 0.6`），进入 decel 225ms、退出 sharp 195ms；拖拽关闭（`offset.y > 120 || velocity.y > 800`）只动 transform，把手限定。

## 5. reduced-motion

双保险：`index.html` 的 `prefers-reduced-motion` 降级名单（命中 class 直接跳切或只留 opacity，名单只增不减）加 `utils/motion.ts` 的 `isReducedMotion()` 入口短路（命中返回 0.01s 跳切配置），顶层再包 `MotionConfig reducedMotion="user"`。M2 本身无全局 reduced-motion 值，这是本项目的实现选择。

## 6. 白闪排查结论（2026-09-24）

外壳背景（壁纸加白蒙层）碰上任何从全透明开始的淡入都会透白。三次修复都是同一病因的不同位置：App 切换时背景过渡（已摘）、角色界面根层多余淡入（已摘）、查手机选择界面透明底淡入（已摘）。以后看到闪白，先查淡入层的底是不是透明的，再查背景层有没有过渡。

## 7. 新增动效检查单

1. 时长曲线从 `--m2-*` 取，进入 decel、退出 accel/sharp，进入 225ms、退出 195ms。
2. 只动 transform/opacity；重树 App 只用纯 opacity。
3. 透明底全屏界面不挂根淡入；背景层不加过渡。
4. 进名单：`index.html` 的 reduced-motion 降级名单追加新 class。
5. 超出 CSS 能力（拖拽、弹簧、布局 morph）才考虑 Motion，且只走 `utils/motion.ts`，先开 ADR。
6. 验收：`pnpm build` 通过；localhost 走一遍切页、弹窗、按钮；reduced-motion 下复验一次。
