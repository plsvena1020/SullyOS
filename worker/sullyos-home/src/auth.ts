export function checkAuth(req: Request, env: any): boolean {
  const token = env.AMSG_CLIENT_TOKEN as string | undefined;
  if (!token) return true; // 开发放行，生产必须配置（沿全仓惯例）
  const h = req.headers.get('x-client-token')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return h === token;
}
