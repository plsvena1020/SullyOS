#!/usr/bin/env bash
# 登录入口说明(容器内 VNC)。VNC/6080 只绑 127.0.0.1,无公网暴露。
cat <<'EOF'
1) 本机执行:  ssh -L 6080:127.0.0.1:6080 root@<vps-ip>
2) 浏览器打开: http://localhost:6080/vnc.html  (密码 = /opt/sullyos/.env 的 XHS_CAMOFOX_VNC_PASSWORD)
3) 若无 xiaohongshu 标签页,在 VPS 执行:
   curl -s -X POST http://127.0.0.1:9377/tabs -H 'content-type: application/json' \
     -d '{"userId":"sullyos-xhs","sessionKey":"main","url":"https://www.xiaohongshu.com"}'
4) noVNC 画面内点「登录」→「扫码登录」,手机小红书 App 扫码确认。
EOF
