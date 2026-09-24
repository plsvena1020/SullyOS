export async function verifyMigration(localCount: number, remoteCount: number): boolean {
  return remoteCount >= localCount; // 只允许多不允许少；切源由用户在 UI 手动确认
}
