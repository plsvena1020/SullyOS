#!/usr/bin/env bash
# 重新部署 camofox-browser 容器(幂等):读 /opt/sullyos/.env,重建容器。
# 用法: bash vps-backend/deploy/xhs-camofox-run.sh
set -euo pipefail
set -a; . /opt/sullyos/.env; set +a

: "${CAMOFOX_API_KEY:?missing in /opt/sullyos/.env}"
: "${XHS_CAMOFOX_VNC_PASSWORD:?missing in /opt/sullyos/.env}"

IMAGE_TAG="${CAMOFOX_IMAGE_TAG:-camofox-browser:152.0.4-beta.28}"
mkdir -p /var/lib/sullyos-xhs/camofox/profiles /var/lib/sullyos-xhs/camofox/cookies

docker rm -f camofox-browser 2>/dev/null || true
docker run -d --restart unless-stopped --name camofox-browser --shm-size=2g \
  -p 127.0.0.1:9377:9377 -p 127.0.0.1:6080:6080 \
  -e CAMOFOX_API_KEY="$CAMOFOX_API_KEY" \
  -e ENABLE_VNC=1 -e VNC_PASSWORD="$XHS_CAMOFOX_VNC_PASSWORD" -e NOVNC_PORT=6080 \
  -e CAMOFOX_CRASH_REPORT_ENABLED=false \
  -e SESSION_TIMEOUT_MS=0 -e BROWSER_IDLE_TIMEOUT_MS=0 -e TAB_INACTIVITY_MS=0 \
  -e CAMOFOX_PROFILE_DIR=/data/profiles -e CAMOFOX_COOKIES_DIR=/data/cookies \
  -v /var/lib/sullyos-xhs/camofox/profiles:/data/profiles \
  -v /var/lib/sullyos-xhs/camofox/cookies:/data/cookies \
  "$IMAGE_TAG"

echo "camofox-browser restarted ($IMAGE_TAG)"
curl -fsS http://127.0.0.1:9377/health && echo
