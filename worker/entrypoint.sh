#!/usr/bin/env bash
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
CAPTURE_SIZE="${CAPTURE_SIZE:-1280x720}"
FPS="${FPS:-30}"
VIDEO_BITRATE="${VIDEO_BITRATE:-2500k}"
ENABLE_BROWSER_AUDIO="${ENABLE_BROWSER_AUDIO:-1}"
AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
AUDIO_SOURCE=""

export DISPLAY CAPTURE_SIZE
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

Xvfb "$DISPLAY" -screen 0 "${CAPTURE_SIZE}x24" -ac +extension RANDR &
XVFB_PID=$!

if [[ "$ENABLE_BROWSER_AUDIO" == "1" ]]; then
  pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit=true >/tmp/pulseaudio.log 2>&1 || true
  sleep 1
  pactl load-module module-null-sink sink_name=rabbitclone sink_properties=device.description=RabbitClone >/tmp/pactl.log 2>&1 || true
  pactl set-default-sink rabbitclone >/tmp/pactl-default.log 2>&1 || true
  if pactl list short sources 2>/tmp/pactl-sources.log | grep -q "rabbitclone.monitor"; then
    AUDIO_SOURCE="rabbitclone.monitor"
  else
    echo "PulseAudio monitor source is not available; browser audio capture is disabled for this worker."
  fi
fi

fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 >/tmp/novnc.log 2>&1 &

node /app/src/server.js &
NODE_PID=$!

if [[ -n "${RTSP_URL:-}" ]]; then
  while kill -0 "$NODE_PID" >/dev/null 2>&1; do
    if [[ -n "$AUDIO_SOURCE" ]]; then
      ffmpeg \
        -hide_banner \
        -loglevel info \
        -thread_queue_size 1024 \
        -f x11grab \
        -draw_mouse 0 \
        -video_size "$CAPTURE_SIZE" \
        -framerate "$FPS" \
        -i "$DISPLAY.0" \
        -thread_queue_size 1024 \
        -f pulse \
        -i "$AUDIO_SOURCE" \
        -vf "format=yuv420p" \
        -c:v libx264 \
        -preset veryfast \
        -tune zerolatency \
        -b:v "$VIDEO_BITRATE" \
        -c:a aac \
        -b:a "$AUDIO_BITRATE" \
        -ar 48000 \
        -ac 2 \
        -f rtsp \
        -rtsp_transport tcp \
        "$RTSP_URL" || true
    else
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
    fi
    sleep 2
  done
else
  echo "RTSP_URL is not set; FFmpeg capture is disabled."
  wait "$NODE_PID"
fi

kill "$XVFB_PID" >/dev/null 2>&1 || true
