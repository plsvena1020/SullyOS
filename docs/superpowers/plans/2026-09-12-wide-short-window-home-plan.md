# 宽而矮窗口 · 主页布局修正执行计划（2026-09-12）

> **执行者须知**：本计划按弱执行者标准写。行号来自 2026-09-12 工作区快照；
> 若工作区被其他窗口改过导致对不上，先 Read 核对再改，遇到计划含糊就停下来问，不要自行猜。
> 设计依据：`docs/superpowers/specs/2026-09-12-wide-short-window-home-design.md`。
> 手机端正常尺寸（页面可视区 >= 540px）外观必须零变化。

**Goal:** 电脑端判定只看宽度（宽而矮的窗口留电脑版）；手机形态页面可视区 < 540px 时自动紧凑，
仍装不下时每页可纵向滚动（到边后滚轮继续翻页）。

---

## 一、会触碰的文件

- `utils/layoutMode.ts`（判定改宽度驱动）
- `utils/layoutMode.test.ts`（用例同步）
- `components/desktop/DesktopDock.tsx`（Dock 可滚兜底）
- `components/desktop/DesktopHost.tsx`（注释同步）
- `apps/Launcher.tsx`（紧凑档 + 页内纵滚 + 安全居中）
- `docs/design-system.md`（布局形态规则条目）
- `notes/ethernet-branch-context.md`（收尾记录）
- 本 spec 与计划两份文档

---

## 二、步骤

### Task 1 `utils/layoutMode.ts`：半屏规则 + 绝对下限 + 移动端护栏（最终定稿）

```ts
export const LAYOUT_MIN_WIDTH = 900;          // 电脑版能成立的最小窗口宽
export const LAYOUT_MIN_SCREEN = 1000;        // 电脑级屏幕最小宽；低于它的屏幕不参与半屏比例
export const LAYOUT_TABLET_MIN_WIDTH = 1024;  // 手机/平板屏幕沿用旧口径

export const isDesktopLayoutViewport = (width: number, screenWidth = 0): boolean => {
    if (screenWidth >= LAYOUT_MIN_SCREEN) {
        return width >= LAYOUT_MIN_WIDTH || width * 2 >= screenWidth;  // 超过半屏（含正好半屏贴靠）
    }
    return width >= LAYOUT_TABLET_MIN_WIDTH;
};
```

- `resolveLayoutMode(desktopMode, width, screenWidth)` 透传；`useLayoutMode` 额外读 `window.screen.width`。
- 手机/平板屏幕（screen.width < 1000）不参与半屏比例：移动端全屏窗口永远「长于半屏」，
  否则会被误判成电脑版；高度不参与判定。

### Task 2 `utils/layoutMode.test.ts`：用例同步（全文件替换）

覆盖：手机/平板竖屏与手机横屏 → phone；电脑屏幕上正好半屏 / 1017 实测窗口 / 超半屏 → desktop；
不到半屏且不足 900 → phone；半屏比例小于 900 时的 900 下限；手机/平板屏幕回到 1024 口径；
手动覆盖优先；边界值（半屏与绝对下限、屏幕门槛 1000）。

### Task 3 `components/desktop/DesktopDock.tsx`：极矮窗 Dock 可滚

- `aside` 的 className 里加 `overflow-y-auto no-scrollbar`（5 个图标约 381px，窗口更矮时图标仍可滚到）。
- `components/desktop/DesktopHost.tsx` 头部注释改为「电脑屏幕上宽于半屏或 >= 900」。

### Task 4 `apps/Launcher.tsx`：高度测量 + 紧凑档开关

1. 模块级常量（`let _lastPageIndex = 0;` 之后）：
   ```ts
   // 手机版页面可视区（横向翻页容器）高度低于此值 → 启动紧凑档：
   // 缩小时钟/组件/图标并收紧页面留白；仍装不下时页面自身可纵向滚动（见页容器 class）。
   const PHONE_COMPACT_MAX_HEIGHT = 540;
   ```
2. 组件内 `const scrollContainerRef = useRef<HTMLDivElement>(null);` 之后插入：
   ```tsx
   // 量出页面可视区高度（桌面分支没有这个容器，切回手机形态时再挂观察器）。
   const [pageViewportHeight, setPageViewportHeight] = useState(0);
   useEffect(() => {
       if (desktop) {
           setPageViewportHeight(0);
           return;
       }
       const el = scrollContainerRef.current;
       if (!el) return;
       const measure = () => setPageViewportHeight(el.clientHeight);
       measure();
       const ro = new ResizeObserver(measure);
       ro.observe(el);
       return () => ro.disconnect();
   }, [desktop]);
   const phoneCompact = !desktop && pageViewportHeight > 0 && pageViewportHeight < PHONE_COMPACT_MAX_HEIGHT;
   ```
   要点：deps 必须是 `[desktop]`（切形态时重新挂观察器）；不要在桌面分支里量（ref 为 null）。

### Task 5 `apps/Launcher.tsx`：`AppGridPage` 支持紧凑

`AppGridPage`（约 256-287 行）签名加 `compact = false`，gaps 与图标尺寸按档位：
```tsx
const gapClass = (apps.length > 8)
    ? (compact ? 'gap-y-3.5 gap-x-2 content-center' : 'gap-y-5 gap-x-2 content-center')
    : (compact ? 'gap-y-4 gap-x-2' : 'gap-y-6 gap-x-2');
return (
    <div
        className={`grid place-items-center animate-fade-in relative ${columns === 6 ? 'grid-cols-6' : 'grid-cols-4'} ${gapClass}`}
        style={compact ? ({ '--app-icon-size': 'clamp(2.5rem, calc((100vw - 6.5rem) / 4), 2.875rem)' } as React.CSSProperties) : undefined}
    >
```
（原根 div 的 className 表达式整段替换；`apps.map` 内容不动。）

### Task 6 `apps/Launcher.tsx`：FitPage 缩放兜底 + 首屏紧凑

1. 新增 `FitPage`（模块级，AppGridPage 之后）：外层页容器保持原 class/style，
   内层 `w-full h-full flex flex-col`；`scale = min(1, 内层可视高 / 内层内容自然高)`，
   `transform-origin: top center`；RO 观察外层、MO 观察子树，激活页补量（rAF + 180ms）。
2. `appPages.map` 与末页 `WidgetsPage` 均改用 `FitPage` 包裹；末页去掉内部 `overflow-y-auto`。
3. 首屏（idx === 0）：
   - `<DesktopClock />` → `<DesktopClock compact={phoneCompact} />`
   - `CharacterWidget` 补 `compact={phoneCompact}`（原有 `paper` 等不动）
   - `<AppGridPage ... editing={layoutEditing} />` 补 `compact={phoneCompact}`

### Task 7 `apps/Launcher.tsx`：第 2 页安全居中 + 紧凑限宽

把 `justify-center` 换安全居中（溢出时顶部可滚到）：
```tsx
<div className="flex-1 min-h-0 w-full flex flex-col">
  <div className="w-full my-auto flex flex-col gap-5">
    {scheduleChar && (<ScheduleHomeWidget ... />)}
    <div className={`grid grid-cols-2 gap-x-3 w-full mx-auto ${phoneCompact ? 'gap-y-4 max-w-[19rem]' : 'gap-y-5 max-w-[24.75rem]'}`}>
      {pinwheelOrder.map(...)}
    </div>
  </div>
</div>
```
注意：比现状多一层 div，收尾处要补一个 `</div>`（原内层 grid 与前两个组件被新内层包裹）。

### Task 8 `apps/Launcher.tsx`：第 3 页起紧凑

- 页根：`pt-10 flex-1 flex flex-col relative` → `flex-1 flex flex-col relative ${phoneCompact ? 'pt-6' : 'pt-10'}`。
- 顶部图组容器：加 `${phoneCompact ? 'mx-auto w-full max-w-[22rem]' : ''}`；两张方图行改 `flex justify-center gap-2`、每张 `flex-1 max-w-[11rem]`。
- 横图：`w-full h-32` → 按档位 `h-32 / h-24`。
- 该页 `AppGridPage` 补 `compact={phoneCompact}`。
- 末页 `WidgetsPage` 不动（本就 `overflow-y-auto`）。

### Task 9 文档同步

- `docs/design-system.md` 第三节末尾加一条「布局形态判定（2026-09-12 起）」，写明：
  只看宽度 `width >= 900` 进电脑版；宽而矮窗口留电脑版；手机形态页面可视区 < 540px
  启动紧凑档，仍装不下时页内纵滚、到边继续翻页。
- 跑完门禁后把本次改动与结论追加到 `notes/ethernet-branch-context.md`「仓库现状与坑」。

---

## 三、验收

```powershell
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
corepack pnpm@9.15.9 vitest run utils/layoutMode.test.ts utils/wheelPager.test.ts
corepack pnpm@9.15.9 vitest run
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json   # 触碰文件零新增（存量 45）
```
预期：layoutMode 用例全绿；全量套件全绿（storageOptimize 等已知并发抖动项若红，单跑确认）；
mojibake 绿；tsc 输出里 `utils/layoutMode.ts`、`apps/Launcher.tsx`、`DesktopDock.tsx` 零命中；
触碰文件 FFFD/BOM 为 0。

手动（用户，dev + 拖窗口）：
- 1600×500 / 1024×500 / 1017×890：电脑形态；左栏与网格可滚；Dock 图标全部可达。
- 900×700：手机形态外观与改动前一致，首屏完整。
- 900×500 及更矮：紧凑档，首屏尽量完整；滚轮先滚页、到边翻页；所有按钮组件可见。
- 393×852：外观零变化、无多余纵滚、横向翻页正常；长按编辑拖拽不受影响。

---

## 四、边界与禁止

- 不改横向翻页 / 滚轮语义；不改 `utils/wheelPager.ts`；不改 `DesktopAppGrid` / `fitGrid`。
- 不改各皮肤主页（`MobileGameHome` / `TamagotchiHome` / `CompanionHome`）。
- 手机端正常尺寸（页面可视区 >= 540px）类名与外观零变化。
- 不 bump `APP_VERSION`（小修复）。
- 提交按项目惯例：英文 message，收尾统一提交，push 前用户确认（本轮不自动 push）。

---

## 五、执行状态（2026-09-12）

- [x] Task 1 layoutMode 最终规则（**电脑屏幕 `width * 2 >= screen.width` 或 `width >= 900`；手机/平板屏幕沿用 `width >= 1024`**）
- [x] Task 2 测试同步（半屏边界、1017 实测窗口、900 下限、移动端护栏、手动覆盖、屏幕门槛 1000）
- [x] Task 3 Dock 加固（aside 加 `overflow-y-auto no-scrollbar`）+ DesktopHost 注释
- [x] Task 4 紧凑档测量（`PHONE_COMPACT_MAX_HEIGHT = 540`，ResizeObserver deps `[desktop]`）
- [x] Task 5 AppGridPage compact（gap 档位 + `--app-icon-size` clamp 2.5-2.875rem）
- [x] Task 6 FitPage 缩放兜底 + 首屏紧凑（**用户实测后从「页内纵滚」修订为「整页等比缩放到一屏」**）
- [x] Task 7 第 2 页安全居中（外层 `flex-1 min-h-0` + 内层 `my-auto`；四宫格容器限宽 24.75rem / 紧凑 19rem）
- [x] Task 8 第 3 页紧凑（`pt-6`、图组限宽 22rem、方图各 11rem、横图 h-24）
- [x] Task 9 文档 + 门禁

门禁结果：`vitest run utils/layoutMode.test.ts utils/wheelPager.test.ts` 用例绿；
全量 `vitest run` 429 文件（storageOptimize 4 项为已知全量并发抖动，单跑 84/84 绿）；`mojibakeGuard` 绿；
`tsc --noEmit` 45 存量错误、触碰文件零命中；触碰文件 FFFD/BOM 0。
*修订说明（用户实测）*：首轮「页内纵滚 + 高度阈值 540」被否——用户明确要求「不要滚动，就要一屏放得下」，
且 1017×890 这类宽窗应直接进电脑版。最终：① 方块组件限宽 + `FitPage` 整页缩放（scale<1 时等比缩小），
滚动路径全部移除；② 电脑版门槛先由 1024 降到 900，再按用户「大于半屏就进电脑端」定稿为半屏规则：
电脑屏幕上 `width * 2 >= screen.width`（贴靠半屏也算）或 `width >= 900`，手机/平板屏幕（`screen.width < 1000`）
沿用 `width >= 1024`（`utils/layoutMode.ts`、`apps/Appearance.tsx` 文案、`DesktopHost` 注释同步）。
headless Edge 复验：1017×890 电脑版、899×500 手机版缩放兜底、393×852 零缩放。未提交。
