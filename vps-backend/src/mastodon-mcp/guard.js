// vps-backend/src/mastodon-mcp/guard.js
// 写守卫 + jsonl 审计。红线：token 与正文全文永不落盘。
import { appendFile as fsAppendFile } from 'node:fs/promises';

export const WRITE_TOOLS = ['moments_post', 'moments_upload', 'moments_delete', 'status_favourite', 'status_unfavourite'];

export function createGuard({ readOnly, auditLogPath, appendFile = fsAppendFile, now = () => Date.now() } = {}) {
  return {
    assertAllowed(toolName, args = {}) {
      if (!WRITE_TOOLS.includes(toolName)) return;
      if (readOnly) throw new Error('只读模式：写操作被拒绝（READ_ONLY=1）');
      if (args.confirm !== true) throw new Error('写操作需要 confirm:true');
    },
    async audit({ tool, ownerId, ok, error, status }) {
      const line = JSON.stringify({
        ts: now(), tool, ownerId: ownerId || '', ok: !!ok,
        ...(error ? { error: String(error).slice(0, 200) } : {}),
        ...(status ? { statusPreview: String(status).slice(0, 40) } : {}),
      }) + '\n';
      try { await appendFile(auditLogPath, line); } catch { /* 审计失败不挡业务 */ }
    },
  };
}
