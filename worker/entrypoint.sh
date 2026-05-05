#!/usr/bin/env bash
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
CAPTURE_SIZE="${CAPTURE_SIZE:-1280x720}"
FPS="${FPS:-30}"
VIDEO_BITRATE="${VIDEO_BITRATE:-2500k}"

export DISPLAY CAPTURE_SIZE

Xvfb "$DISPLAY" -screen 0 "${CAPTURE_SIZE}x24" -ac +extension RANDR &
XVFB_PID=$!

fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 >/tmp/novnc.log 2>&1 &

node /app/src/server.js &
NODE_PID=$!

if [[ -n "${RTSP_URL:-}" ]]; then
  while kill -0 "$NODE_PID" >/dev/null 2>&1; do
    ffmpeg \
      -hide_banner \
      -loglevel info \
      -f x11grab \
      -draw_mouse 0 \
      -video_size "$CAPTURE_SIZE" \
      -framerate "$FPS" \
      -i "$DISPLAY.0" \
      -vf "format=yuv420p" \
      -c:v libx264 \
      -preset veryfast \
      -tune zerolatency \
      -b:v "$VIDEO_BITRATE" \
      -f rtsp \
      -rtsp_transport tcp \
      "$RTSP_URL" || true
    sleep 2
  done
else
  echo "RTSP_URL is not set; FFmpeg capture is disabled."
  wait "$NODE_PID"
fi

kill "$XVFB_PID" >/dev/null 2>&1 || true

