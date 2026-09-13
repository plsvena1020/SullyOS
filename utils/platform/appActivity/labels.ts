/** SullyOS 内部 App 的展示名解析（透视窗会话用）。纯函数。 */
export function labelOfSullyosApp(
  appId: string,
  installed: Array<{ id: string; name: string }>,
  hiddenNames: Partial<Record<string, string>>,
): string {
  return installed.find((a) => a.id === appId)?.name ?? hiddenNames[appId] ?? appId;
}
