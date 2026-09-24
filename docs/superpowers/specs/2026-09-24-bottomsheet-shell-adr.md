# ADR：公共 BottomSheet 壳 + 拖拽关闭

- 日期：2026-09-24
- 状态：Plan-only。只写文档，不碰业务代码，不安装依赖，写完停下等用户说执行。
- 关系：落实 `docs/motion-design.md` 第 5 条试点扩展（弹层拖拽是 CSS 做不到、必须走 Motion 的第一项）；M2 token 与 reduced-motion 双保险沿用 `utils/motion.ts`，本文不重定义数值。

## 1. 背景与决策

全仓 0 个弹层支持拖拽关闭，视觉把手全是装饰（`CallPreferencesSheet.tsx:41`、`HandbookCharPicker.tsx:88`）。所有 sheet 都是进场一次性 CSS，进场后无退场、无手势。CSS transition/keyframe 无指针输入，做不到跟手，必须上 Motion。

决策：新建唯一公共壳 `components/os/BottomSheet.tsx`，首批只收底部 sheet；右侧抽屉（`slide-in-right`）不在本次范围，继续走 CSS。居中弹窗（Modal/Confirm）明确不加拖拽。

备选（已否决）：每个 sheet 各自加 Motion——重复七八遍同样的 drag 约束与退场，将来改阈值要改七八处。

## 2. 规范源头（已实读，直接用）

`components/call/CallPreferencesSheet.tsx:23-41` 是全仓 sheet 惯例源头，新壳照抄它的结构语义：

- 外层：`absolute inset-0 z-[80] flex items-end`，scrim `bg-black/60 backdrop-blur-sm`，点击外层关闭，`role="dialog" aria-modal="true"`。
- 面板：`w-full rounded-t-[1.75rem] border-t`，`paddingBottom: max(1.25rem, var(--safe-bottom))`，内容点击 stopPropagation。
- 把手：顶部居中 `h-1 w-10 rounded-full` 装饰条——新壳里它升级为真正的拖拽手柄。
- 旧动效：私有 keyframe 220ms `cubic-bezier(.2,.8,.2,1)`，reduced-motion 降为 .01ms——新壳改走 `--m2-*` token。

## 3. 新壳设计（`components/os/BottomSheet.tsx`，新建）

Props（只收必需，拒绝膨胀）：

```tsx
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  titleId?: string;          // aria-labelledby，有标题时传
  dismissible?: boolean;     // 默认 true；false 时无把手、不可拖、点外层不关（错误类场景备用）
  maxHeight?: string;        // 默认 '82vh'
  testId?: string;
}
```

结构（完整代码意图）：

- 外层 `AnimatePresence` 包 `m.div` scrim：复用 `utils/motion.ts` 的 `scrimVariants()`（只动 opacity，进入 decel 225ms、退出 accel 195ms），点击关闭（`dismissible` 为 false 时不绑）。
- 面板 `m.section`：初始 `y: 48, opacity: 0.6`，进入 decel 225ms（对齐 M2，比旧 220ms 私有值只差 5ms，视觉一致）；退出 sharp 195ms。
- 拖拽：`drag="y"`（只动 transform，合规）+ `dragConstraints={{ top: 0 }}` + `dragElastic={0.12}`；关闭判定走 `onDragEnd`：`offset.y > 120 || velocity.y > 800` 即 `onClose()`，否则弹回（spring默认手感）。
- 手柄限定：用 `dragControls`，`dragListener={false}`，仅把手条与 header 区绑 `onPointerDown={controls.start}`；内容区（含 textarea 的调用方）永远不触发拖拽，避免 MemoryRepairPortal 类深编辑抽屉的滚动冲突。
- reduced-motion：入口调 `isReducedMotion()`，命中则 drag 禁用、进出跳切；顶层已有 `MotionConfig reducedMotion="user"` 双保险。
- 桌面端：v1 保持底部 sheet（与移动端一致）；PerCharAvatarPicker 的桌面居中变体本次不迁移，留待 v2。

## 4. 迁移顺序（只许 6 步，每步独立可回滚）

1. CallPreferencesSheet（立惯例，验证壳 API 是否够用）。
2. VoiceFavoriteActionSheet（迷你 sheet，补 exit；`components/voice/VoiceFavoriteActionSheet.tsx:25-28`）。
3. HandbookCharPicker + Tracker/TrackerCreate（把手落差最大，立竿见影）。
4. Chat / GroupChat 高频 sheet（`apps/Chat.tsx:4639,4700` 镜像两处）。
5. MemoryRepairPortal 深抽屉（验证 textarea + handle 限定）。
6. story 系列 + CallApp 三连（批量套壳）。

每步只动对应调用方，不改业务逻辑（打开条件、回调、内容结构一行不动）；旧私有 keyframe 随迁移删除，不留双动效。

## 5. 会触碰的文件清单

| 文件 | 动作 |
| --- | --- |
| `components/os/BottomSheet.tsx` | 新建，唯一新增文件 |
| `components/call/CallPreferencesSheet.tsx:23-41` | 首个迁移，结构对齐壳 |
| `components/voice/VoiceFavoriteActionSheet.tsx`、`components/handbook/HandbookCharPicker.tsx` 等 | 按 §4 顺序套壳 |
| `utils/motion.ts` | 只读；如需新增 `sheetPanelVariants` 则追加导出，不改现有预设 |
| `docs/design-system.md:83`、 `docs/motion-design.md` | 更新 sheet 规范行（slide-up 改为 BottomSheet 壳 + drag） |
| `package.json` | 只读，不新增依赖（motion 已装） |

## 6. 执行计划清单（按序，可勾选）

全局禁止：不动打开条件/回调/内容结构；不碰右侧抽屉；不碰 Modal/Confirm；只动 transform/opacity；PhoneShell 与 Launcher 不在范围。

- [ ] Step 0：只读确认。读 `CallPreferencesSheet.tsx:1-167`、`VoiceFavoriteActionSheet.tsx:1-51`、`utils/motion.ts:92-130`，记录各 sheet 的 open 条件与 class；`git status --porcelain` 为空。验收：能说出每个 sheet 的关闭方式且零 diff。
- [ ] Step 1：新建 `components/os/BottomSheet.tsx`（§3 全量意图）。验收：`rg -n "dragControls|drag=\"y\"" components/os/BottomSheet.tsx` 命中；`npx tsc --noEmit` 相关文件零报错；localhost 空壳开关一次，进出 225/195ms。
- [ ] Step 2：迁移 CallPreferencesSheet。把 `:23-41` 外层+面板换成壳，内容原样搬入 children，删私有 keyframe。验收：`rg "sully-call-settings-in" CallPreferencesSheet.tsx` 零命中；`npm run build` 成功；localhost 开关 2 次 + 下滑关闭 1 次。
- [ ] Step 3-6：按 §4 顺序逐个套壳，每步验收同 Step 2（旧 keyframe 零残留 + build + localhost 下滑关闭）。
- [ ] Step 7：回归。`rg -n "animate-slide-up" components apps --glob '!node_modules'` 确认只剩非 sheet 用途；`npm run build` 成功；reduced-motion 下复验（拖拽禁用、跳切）；更新两处文档；删临时文件。

## 7. 回滚

每步独立 revert 即可；壳无人引用时零影响。整批回滚 = revert 到 Step 0 + `rg BottomSheet` 确认零引用 + build。

## 8. ADR 备注

- 为何是公共壳而非各自加：七八处同样的 drag 约束与退场，阈值以后只改一处。
- 为何首个是 CallPreferencesSheet：它是惯例源头，壳 API 照它定，后续迁移只是填空。
- 为何 textarea 限定手柄：深编辑抽屉里内容滚动与拖拽关闭手势互斥，手柄以外一律不触发。
- 右抽屉与居中弹窗不在范围：前者按钮关闭够用，后者加拖等于误触风险。

## 9. 落地追认（2026-09-24，合并时补记）

- 壳在锁定 7 props 外加了 `overlayClassName` / `panelClassName` 两个纯视觉透传：各调用方 scrim 底色、z、面板纸色渐变不同，无此则必改视觉，违反只动 transform/opacity。允许保留，今后新调用方优先用默认视觉，确需定制才透传。
- header 区拖拽未做（仅把手可拖）：与 §8 的 textarea 理由一致，范围缩小，接受。
- 空数据 sheet 关闭瞬间先空内容再滑出壳：系内层 guard 所致，195ms 内结束，可接受；若目检扎眼，后续给这类 sheet 加占位骨架而非改壳。
