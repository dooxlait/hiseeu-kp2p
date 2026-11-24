# hiseeu-kp2p

**Local RTSP for Hiseeu / EseeCloud Wi-Fi NVR kits, without the cloud.** Works with Frigate, go2rtc and Home Assistant.

Many cheap Wi-Fi camera kits (Hiseeu and other brands built on the Juan / EseeCloud firmware) come with an NVR
that offers **no RTSP and no ONVIF**: the cameras talk only to the NVR, often over its own Wi-Fi network, and the NVR
is only reachable through the **EseeCloud** app. The NVR does however speak a proprietary protocol, **kp2p**,
on WebSocket port **10000** of the local network. This project reads the video from that port and turns it into
standard RTSP streams.

[🇫🇷 Résumé en français plus bas](#-en-français)

```
cameras ──Wi-Fi──> NVR ──kp2p (ws://nvr:10000)──> kp2p.js ──H.265──> ffmpeg (copy) ──> mediamtx (rtsp://127.0.0.1:8654)
                                                                                         └──> go2rtc / Frigate / VLC / Home Assistant
```

- **`kp2p.js`**: a single file, **no dependencies** (Node.js ≥ 22). Logs in to the NVR and writes the raw H.264/H.265
  video of one channel to stdout or a file. It can also move PTZ cameras (moves and presets).
- **`relay/`**: [mediamtx](https://github.com/bluenviron/mediamtx) configuration that starts `kp2p.js` **on demand**
  (only while someone watches) and serves it as RTSP, **without re-encoding** (almost no CPU).
- **`frigate/`**: example Frigate / go2rtc configuration.
- **`docs/PROTOCOL.md`**: notes on the protocol.

Only the NVR is contacted: no cloud account, nothing leaves your network.

## Tested hardware

| Device | Model | Firmware |
|---|---|---|
| NVR (4 channels, Wi-Fi, built-in screen) | Hiseeu **K8510-W** | 3.5.5.0M (2022-12-22) |
| Cameras (PTZ, Wi-Fi) | 5323-W-Q | 3.8.0.5720106 |

Streams obtained: main 2304x1296 H.265, sub 640x360 H.265, 15 fps. Running 24/7 with Frigate 0.18 (4 cameras) since November 2026.

**Other models:** if your NVR is managed with the EseeCloud app, run the connection test below. It needs no password
and only takes a second. Please open an issue with the result (model + firmware), working or not.

## Quick test

On any computer of the same network, with [Node.js](https://nodejs.org) 22 or newer:

```sh
# 1. Does the NVR speak kp2p? (no password)
node kp2p.js --host 192.168.1.50 --hello

# 2. Record 10 s of camera 1, sub stream (asks for the NVR password)
node kp2p.js --host 192.168.1.50 --ch 0 --stream 1 --seconds 10 --out cam1.h265

# 3. Play it
ffplay cam1.h265        # or open it with VLC
```

`--ch` starts at **0** (camera 1 = `--ch 0`). `--stream 0` = HD, `--stream 1` = SD.
The password can also come from `--passfile <file>` or the `NVR_PASS` environment variable.

PTZ: `node kp2p.js --host 192.168.1.50 --ch 0 --ptz left --ms 500` (moves: `up down left right zoomin zoomout auto stop`;
presets: `--ptz preset-go --preset 2`).

## Installation (Linux, e.g. in the Frigate container or LXC)

1. **Install Node.js** (22 or newer; with Node 20, keep the `--experimental-websocket` flag that `push.sh` already passes).
2. **Copy the files:**
   ```sh
   mkdir -p /opt/kp2p && cp kp2p.js relay/push.sh /opt/kp2p/ && chmod +x /opt/kp2p/push.sh
   ```
3. **Store the NVR password** (readable by root only):
   ```sh
   (umask 077; printf '%s' 'YOUR_NVR_PASSWORD' > /etc/kp2p.pass)
   ```
   Typing the password on the command line leaves it in the shell history: you can type `read -s P` and then
   `printf '%s' "$P" > /etc/kp2p.pass` instead.
4. **Edit the top of `/opt/kp2p/push.sh`:** NVR IP address, path of `ffmpeg`, codec (`hevc` or `h264`).
5. **Install [mediamtx](https://github.com/bluenviron/mediamtx/releases)** in `/opt/mediamtx`, copy
   `relay/mediamtx.yml` there, then `relay/mediamtx.service` to `/etc/systemd/system/` and:
   ```sh
   systemctl daemon-reload && systemctl enable --now mediamtx
   ```
6. **Test:** `ffprobe rtsp://127.0.0.1:8654/hiseeu_1_sd` (camera 1, SD). The first connection takes a few seconds.
7. **Frigate / go2rtc:** see [`frigate/config-example.yml`](frigate/config-example.yml).
   Home Assistant then gets the cameras through the Frigate integration.

Stream names: `hiseeu_N` = camera N in HD, `hiseeu_N_sd` = camera N in SD (N starts at 1).

**Why not `exec:` in go2rtc?** It would be simpler, but Frigate 0.18 disables go2rtc `exec` sources by default
for security reasons. mediamtx's `runOnDemand` does the same job without enabling arbitrary commands.

## Limits

- **The NVR limits simultaneous streams.** On the tested K8510-W, two HD streams worked fine with Frigate; a third
  was sometimes refused, and opening the HD **and** SD stream of the *same* camera got the "busy" picture. The exact
  rule is unclear (per camera? total bandwidth?). Recommendation: **one stream per camera**, HD for the important
  cameras, SD for the others. The EseeCloud app and the NVR's own screen may also use slots.
- When the NVR is busy it answers `-40`, or sends a placeholder picture (H.264 704x480, 0 fps). `kp2p.js` drops it,
  waits 8 s and exits (code 7), and mediamtx retries. A stream that freezes is cut after 8 s (code 6) and reopened.
  This usually costs a few seconds of video.
- Video only: audio frames are ignored.
- Live view only: no playback of the NVR's recordings (let Frigate record instead).

## Security

- `kp2p.js` connects **only** to the address given with `--host`.
- Keep port 10000 of the NVR **off the Internet** (no port forwarding): the protocol has no encryption apart from the login.
- The login fields are encrypted with a key that is the same on every device, so treat the NVR password as
  readable by anyone on your LAN. Use a password you do not use elsewhere.
- The relay listens on `127.0.0.1` only. Frigate's port 5000 has no authentication: do not expose it either.

## Credits

The protocol framing was understood with the help of
[ingresoloterias-star/esee-visor](https://github.com/ingresoloterias-star/esee-visor). `kp2p.js` is an independent,
dependency-free rewrite. Thanks to the [mediamtx](https://github.com/bluenviron/mediamtx),
[go2rtc](https://github.com/AlexxIT/go2rtc) and [Frigate](https://github.com/blakeblackshear/frigate) projects.

Not affiliated with Hiseeu, Juan or EseeCloud. All trademarks belong to their owners.
This project was written for interoperability, to use your own cameras on your own network.

## License

[MIT](LICENSE)

---

## 🇫🇷 En français

**Flux RTSP locaux pour les kits caméras Wi-Fi Hiseeu / EseeCloud, sans passer par le cloud.**

Les enregistreurs (NVR) de ces kits n'offrent **ni RTSP ni ONVIF** : seule l'appli **EseeCloud** permet de voir les
caméras. Mais l'enregistreur parle un protocole propriétaire, **kp2p**, sur le port WebSocket **10000** du réseau
local. `kp2p.js` (un seul fichier Node.js, sans dépendance) s'y connecte et récupère la vidéo. mediamtx la publie
en RTSP à la demande, sans réencodage, pour Frigate, go2rtc, VLC ou Home Assistant.

- **Test rapide** (sans mot de passe) : `node kp2p.js --host <IP de l'enregistreur> --hello`
- **Enregistrer 10 s de la caméra 1 en SD :** `node kp2p.js --host <IP> --ch 0 --stream 1 --seconds 10 --out cam1.h265`
- **Installation :** voir la section *Installation* ci-dessus (étapes 1 à 7).
- **Testé avec** un enregistreur Hiseeu K8510-W (firmware 3.5.5.0M) et 4 caméras PTZ 5323-W-Q, en service 24 h/24
  avec Frigate.
- **Limite principale :** l'enregistreur limite le nombre de flux simultanés. Utilisez **un seul flux par caméra**
  (HD pour les plus importantes, SD pour les autres).

Questions, retours ou autres modèles testés : ouvrez une *issue* (en français ou en anglais).
