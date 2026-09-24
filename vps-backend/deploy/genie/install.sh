#!/usr/bin/env bash
# 把适配层装到 /opt/genie-tts 并让 systemd 指向它。幂等。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/genie-tts
UNIT=/etc/systemd/system/genie-tts.service

install -d -m 0755 "$DEST/refs"
install -m 0644 "$SRC_DIR/genie_server.py" "$DEST/genie_server.py"
install -m 0644 "$SRC_DIR/emotions.json"   "$DEST/refs/emotions.json"
install -m 0644 "$SRC_DIR/test_speak.py"   "$DEST/test_speak.py"

grep -q 'genie_server.py' "$UNIT" || {
  echo "ERROR: $UNIT 的 ExecStart 未指向 genie_server.py" >&2
  exit 1
}

systemctl daemon-reload
systemctl restart genie-tts

# 自检：先删旧文件，避免拿上一次的残留假通过；curl 必须带 --max-time，
# 否则适配层挂死时这个循环会永久卡住。
probe=/tmp/genie-install-check.wav
rm -f "$probe"
ready=0
for _ in $(seq 1 30); do
  if curl --max-time 130 -fsS -X POST http://127.0.0.1:9882/speak \
      -H 'content-type: application/json' \
      -d '{"text":"安装自检。","emotion":"calm"}' \
      -o "$probe"; then
    ready=1
    break
  fi
  sleep 10
done

if [ "$ready" -ne 1 ] || [ ! -s "$probe" ]; then
  echo "ERROR: /speak 自检未通过，见 journalctl -u genie-tts" >&2
  exit 1
fi
head -c 4 "$probe" | grep -q 'RIFF' || { echo "ERROR: 返回的不是合法 WAV" >&2; exit 1; }
rm -f "$probe"
echo "OK: /speak 就绪，WAV 头合法"
