## voice-relay（语音中转，8839）
1. `.env` 配好上面三个变量（值从 Vercel 面板抄，钥匙不用配）。
2. `cp deploy/voice-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now voice-relay`
3. Caddy 见 Task 5（切换前不动）。
4. `curl 127.0.0.1:8839/api/health` → `{"ok":true}`。
