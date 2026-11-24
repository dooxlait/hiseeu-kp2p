#!/bin/sh
# Publishes one NVR camera to the local mediamtx RTSP server, without re-encoding.
# Started on demand by mediamtx (runOnDemand) and stopped by it when nobody watches the stream anymore.
# Usage: push.sh hiseeu_<N>[_sd]    (N = 1..number of channels; "_sd" suffix = sub stream)

# --- settings ------------------------------------------------------------------
NVR_HOST=192.168.1.50                 # IP address of the NVR (give it a static DHCP lease)
PASSFILE=/etc/kp2p.pass               # NVR password, one line (chmod 600, owned by root)
KP2P=/opt/kp2p/kp2p.js
NODE="node --experimental-websocket --no-warnings"   # the flag is only needed on Node 20
FFMPEG=ffmpeg                         # e.g. /usr/lib/ffmpeg/7.0/bin/ffmpeg inside the Frigate container
CODEC=hevc                            # hevc for H.265 cameras, h264 for H.264 cameras
RTSP=rtsp://127.0.0.1:8654
# --------------------------------------------------------------------------------

name="$1"
n=${name#hiseeu_}; n=${n%_sd}
ch=$((n - 1))
case "$name" in *_sd) st=1 ;; *) st=0 ;; esac

$NODE "$KP2P" --host "$NVR_HOST" --passfile "$PASSFILE" --ch "$ch" --stream "$st" --out - |
  "$FFMPEG" -hide_banner -loglevel warning \
    -use_wallclock_as_timestamps 1 -f "$CODEC" -i - \
    -c copy -f rtsp -rtsp_transport tcp "$RTSP/$name" &
# When mediamtx stops us, also stop the client and ffmpeg (children of this script).
trap 'pkill -P $$; exit 0' INT TERM
wait $!
pkill -P $$ 2>/dev/null
exit 0
