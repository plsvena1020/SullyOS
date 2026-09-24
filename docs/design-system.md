# SullyOS 设计与动效风格契约

> 目标：新增功能不引入新视觉语言，只在既有模式上扩展。动手前先对照本表，找不到对应条目就复用同类 App 的既有写法。
> 取证日期 2026-09-06，ethernet 分支实况。番茄钟手绘风是唯一例外专区，细节见 `notes/ethernet-branch-context.md`。

## 一、全局基座

- 无 `tailwind.config.*` / 独立全局 CSS。Tailwind 走 CDN，配置内联在 `index.html:30-45`。
- 主题是 HSL 三轴 + 壁纸 + 文字色，不是固定色板。类型 `OSTheme` 见 `types.ts:220-238`，默认值见 `context/OSContext.tsx:458-484`，生效见 `context/OSContext.tsx:1851-1861` / `components/PhoneShell.tsx:770-803`。
- 桌面默认暖米纸渐变 + 白光 + 极细纤维纹理，`body` 底色 `#0f1115`。换主题只改 hue/sat/light + wallpaper + contentColor，不手写新底色体系。
- 安全区不用手写 padding，用 `var(--safe-top)` / `var(--safe-bottom)` / `.pb-safe`，定义见 `index.html:238-240`。

## 二、玻璃风（两套，不混用）

浅玻璃用于顶栏、卡片、输入栏、底部动作表、节日弹窗：

- 顶栏标准：`bg-white/70 backdrop-blur-md border-b border-white/40`（见 `apps/Appearance.tsx:927`）。
- 卡片浮层：`bg-white/80 backdrop-blur-xl` / `bg-white/95 backdrop-blur-xl rounded-3xl border-white/60`（见 `apps/Gallery.tsx:463` / `apps/Chat.tsx:4573`）。
- 输入栏：`bg-white/80 backdrop-blur-2xl border-t border-white/60`（见 `components/chat/ChatInputArea.tsx:305`）。

深玻璃用于通话、见面、遮罩、调试、角标：

- 卡片：`bg-white/[0.04] backdrop-blur-md border-white/15 rounded-3xl`（见 `apps/CallApp.tsx:3078`）。
- 输入盒：`bg-white/10 backdrop-blur-xl border-white/20 rounded-2xl`（见 `components/date/DateSession.tsx:1339`）。
- 遮罩：`bg-black/60 backdrop-blur-sm` / `bg-black/35 backdrop-blur-sm`（见 `components/call/CallPreferencesSheet.tsx:24`）。
- 调试面板：`bg-zinc-950/90 backdrop-blur-xl border-white/12 rounded-2xl`（见 `components/DevDebugPanel.tsx:388`）。

## 三、圆角 / 阴影 / 间距

- 圆角按层级递减：页面大卡 `rounded-3xl`，内卡输入弹窗 `rounded-2xl`，小按钮小图标 `rounded-xl`，药丸头像开关 `rounded-full`。头像形状可在设置里切 `rounded-sm` / `rounded-xl` / `rounded-full`。
- 特殊值只出现在已有点位：节日弹窗 `rounded-[2.5rem]`，聊天气泡 `rounded-[26px]` / `rounded-[22px]`，像素风 `rounded-[4px] border-2`。新功能不发明新弧度。
- 阴影三档：默认卡 `shadow-sm`，CTA `shadow-md/lg + shadow-primary/30`，浮层 `shadow-2xl`。浅浮层定制只用 `shadow-[0_12px_40px_rgba(15,23,42,0.22)]`，深浮层只用 `shadow-[0_18px_60px_rgba(0,0,0,.58)]`。
- 页面模板：`flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar` + 头部 `flex items-center px-4 py-3` + 分组 `divide-y divide-slate-100`（见 `apps/Appearance.tsx:947-950`）。
- 桌面形态信息密度（2026-09-11 起）：手机版式 App 的卡片/清单网格（相册人物、照片墙、书架、商品、日记选本等）在桌面档走 `useLayoutMode` 分支改 `grid-cols-[repeat(auto-fill,minmax(132-176px,1fr))]` 自适应小卡；空占位页限宽限高居中（日记空白角色页 `max-w-sm max-h-[420px] m-auto`）；手机端类名必须零变化。
- 布局形态与矮窗规则（2026-09-12 起）：电脑屏幕上，窗口宽于半屏（`width * 2 >= screen.width`，贴靠半屏也算）或达到 900 宽即进电脑版；手机/平板屏幕（`screen.width < 1000`）不参与半屏比例，仍按宽度 ≥ 1024 判定。高度不参与——宽而矮的窗口留电脑版，靠左栏/网格/Dock 各自内部滚动托底（见 `utils/layoutMode.ts`）。手机形态主页有「紧凑档 + 整页缩放到一屏」两级兜底：页面可视区高度 < 540px 时缩小时钟/角色卡/图标并收紧留白（`apps/Launcher.tsx` 的 `phoneCompact`）；仍装不下时由 `FitPage` 等比缩小整页（scale = 可视高 / 内容自然高），**不做纵向滚动**，所有按钮组件始终一屏可见。手机正常尺寸与装得下的窗口 scale=1、外观零变化。

## 四、字体 / 图标

- 主字体运行时切换，默认 `Quicksand`，`--app-font` 见 `index.html:123-159`。用户字体走 `utils/userFonts.ts` 的 `@font-face` + `:root --app-font` 覆盖，不直接改 body。
- 情景字体各归其位：小说梦境用衬线栈，像素家园用 `ZCOOL KuaiLe`，手账用手写体栈，锁屏用 `Inter`。不跨区借用。
- 图标只用 Phosphor（`@phosphor-icons/react`，见 `package.json` / `vite.config.ts:181`）。常态 `regular`，操作键 `bold`，通话播放状态 `fill`，`duotone` 极少用。尺寸一般 13-22。

## 五、动效（CSS 为主 + Motion 三处试点）

全仓以 CSS 动效为主，Motion 只试点三处。中央 token 在 `index.html` 的 `:root`（`--m2-*`）与 tailwind.config animation 区，各 App 自带一次性内联 `@keyframes`（CDN 版 Tailwind 自定义 `animate-*` 不可靠，见 `components/os/BootSequence.tsx:13` / `apps/Chat.tsx:4292`）。

- 进入 225ms（`--m2-dur-enter`）、退出 195ms（`--m2-dur-leave`），退出更快。小档 150-225ms，大档 300ms，桌面端进入取 150-200ms（`--m2-dur-desktop-enter`）。超过 400ms 的动效视为失败。
- 曲线四枚固定：standard `cubic-bezier(0.4, 0, 0.2, 1)`（`--m2-ease-standard`，屏内变化）、decel `cubic-bezier(0, 0, 0.2, 1)`（`--m2-ease-decel`，只进）、accel `cubic-bezier(0.4, 0, 1, 1)`（`--m2-ease-accel`，永久退出）、sharp `cubic-bezier(0.4, 0, 0.6, 1)`（`--m2-ease-sharp`，临时退出如弹窗关闭）。
- 只允许 `transform` / `opacity` 参与过渡与动画；不加 `box-shadow` / `filter` / `backdrop-filter` 的过渡；keyframes 里不出现 `width/height/left/top/margin`。
- App 容器禁 transform：`components/PhoneShell.tsx:930` 的 `appEnterFade` 永久只许纯 opacity（200ms），`key={activeApp}` 整树重挂载层挂 transform 会让重 App 首帧卡顿（已实证）。
- Motion 试点范围仅四处（`utils/motion.ts` 唯一入口，只读 `--m2-*`，`MotionConfig reducedMotion="user"`）：`ConfirmDialog` 退场、`page-in-l/r` 横向切页、`Modal` 内容 fade + scrim、`BottomSheet` 底部弹层拖拽关闭。PhoneShell 容器与 Launcher morph 不在试点内。
- 加载呼吸秒级循环：三点 dots `dot-pulse 1.2s + 0/0.2/0.4s` 错峰，`shimmer 2.5s`，`glow-pulse 3s`，`float 4s`。spinner 只用 `border-t` 圆环 + `animate-spin`，开机不用 spinner（呼吸等待，见 `BootSequence.tsx:11`）。
- 弹窗两套固定封装：通用居中 `Modal.tsx`（遮罩淡入 + 卡片上滑），确认错误 `ConfirmDialog.tsx` / `ErrorDialog.tsx`（遮罩淡入 + 卡片弹入）。移动端上滑、桌面端弹入见 `PerCharAvatarPicker.tsx:193`。
- 按下全仓统一 `active:scale-* + transition`：图标 `active:scale-95`，小按钮 `active:scale-90`，卡片轻压 `active:scale-[0.98]`。桌面图标 hover 上浮 `group-hover:-translate-y-0.5`。
- 按钮状态过渡统一（2026-09-11 起）：`index.html` 中央兜底 `button, button *` ——颜色/描边/阴影/透明度 200ms、transform/scale 150ms（已声明 `transition-*` 的按钮保留自己的，类选择器优先）；没有 `active:` 档位的按钮统一 `scale: 0.98` 轻压（用 `scale` 属性，不与定位 transform 冲突；整屏遮罩 `inset-0` 跳过）；reduced-motion 在同一块里降为 0.01ms。选中态按钮只声明了 `transition-transform` 的，一律改 `transition-all duration-200`（有显式时长则保留时长）。
- 聊天单聊新消息一次性 `animate-fade-in`（播完从 `animatingIds` 删除，流式交接不播），群聊行无入场动画，只有 padding / 手势过渡。不要给群聊套单聊那套。
- App 启动拟真：真 App 用 `animate-app-open`（底部弹起），普通页用 `animate-fade-in`（见 `apps/PersonaSim.tsx:563-564`）。
- 页面/面板切换统一语言（2026-09-11 起，2026-09-23 对齐 M2）：有方向的翻页用 `animate-page-in-l/r`（keyed 换新页，进入 `--m2-dur-enter` 225ms + `--m2-ease-decel`；`PerCharAvatarPicker` 旧私有 `pcaSlide*` 已并入）；整页 / tab 切换用 `animate-fade-soft`（**纯 opacity**，进入 225ms + `--m2-ease-standard`，重树 App 禁 transform）；弹层退场用 `animate-fade-out-soft`（`--m2-dur-leave` 195ms + `--m2-ease-sharp` forwards）+ `hooks/useExitPresence.ts`（默认 195ms）保持挂载到动画结束；长按编辑态图标轻摆是拖拽样式里的 `jiggleEdit`（仅 `.launcher-edit-item`）。这些动画全部在 `index.html` 的 `prefers-reduced-motion` 降级名单里。

## 六、分 App 隔离清单（只在其 App 内延续）

| App | 底色与组件语言 | 不外借的东西 |
|-----|----------------|--------------|
| 外卖 / 购物 | 浅灰底 `bg-[#f5f6f7]` + 白卡，顶栏橙渐变，价格 `text-orange-500`，商品图走 `components/GoodsSvg.tsx` | 橙渐变顶栏、价格橙 |
| 存钱罐 Bank | 奶油底渐变，深咖顶栏，CTA 橙绿蓝三色渐变，银行卡渐变走 `utils/bankIcons.ts` | 咖啡馆奶油色系、娃娃屋场景件 |
| 聊天 Message | 浅灰底可配（soft/pixel/flat/floating），背景 plain/grid/paper/mesh 四档，思考链 12 套预设锁 bg/border/accent/radius | 思考链预设、气泡定制 CSS |
| 设置 / 外观 | `bg-slate-50` 底 + `bg-white rounded-3xl border-slate-100` 分组卡 | 系统卡片分组语言 |
| 自习室 | CSS 变量隔离范本：`.epub-r + data-theme` 驱动 `--er-*`，课堂另起 `--cc-*`，组件内禁硬编码主题色 | `--er-*` / `--cc-*` 变量域 |
| 桌面伴侣 | 每套主题一 CSS + 独立变量命名空间（猫 / 乙女 / 杂志 / 卡册 / 偶像），TSX 只 import 对应 CSS | 各主题变量与 clip-path 造型 |
| 动森主题 | 横切整机：奶油底 + 大地棕文字 + 草绿薄荷点缀，以 `acnh` 布尔分叉渲染 | `acnh` 分支不漏进非动森路径 |

CSS 组织方式：独立 CSS 文件只有自习室两件、伴侣主题系列、节日事件卡；其余 App 全部 Tailwind inline + 偶发 inline `<style>`。串味主要靠复制类名发生，复用时连底色圆角描边阴影字体动效时长整组搬运，不单抄一句。

## 七、例外与禁区

- 番茄钟铅笔手绘风只属于番茄钟：纸底墨字虚线框手绘圆角排线阴影，禁渐变纯白玻璃模糊，动效短促，原子件只从 `apps/pomodoro/SketchKit.tsx` 取，颜色只来自 `utils/pomodoroPrefs.ts`。其他 App 不许引用，番茄钟内部不许散写新样式。
- Bank 也有虚线边框（添加卡语义），与番茄钟手绘虚线形似神不似，不互相借用。
- 动森是唯一的跨 App 覆盖，改动时重点检查 `acnh` 分支是否漏进默认路径。

## 八、新功能对照流程（稳定风格用）

1. 先定归属：同类界面在哪个 App，直接复用该 App 的底色、圆角、描边、阴影、动效时长整组写法。
2. 再定容器：居中弹窗抄 `Modal`，确认框抄 `ConfirmDialog`，底部弹层用 `components/os/BottomSheet` 壳（进出走 `--m2-*`，把手拖拽关闭），右侧抽屉用 `slide-in-right`，不新造第 N 种弹窗。
3. 动效只从中央 token 取时长，不发明新 easing；新动效默认走 CSS，只有 `utils/motion.ts` 试点三处（ConfirmDialog 退场 / page-in-l/r 横向切页 / Modal 内容 fade）允许引 Motion，扩大试点前先开 ADR；加载态优先三点 dots 或 spinner 二选一。
4. 需要主题隔离（阅读器、皮肤、舞台）时抄自习室模式：根容器 + `data-theme` + CSS 变量域，不向全局漏样式。
5. 完工自查：渐变、纯白底、backdrop-blur 是否出现在不该出现的地方；`acnh` / 手绘风元素是否漏进其他 App；圆角阴影是否有新发明值。
