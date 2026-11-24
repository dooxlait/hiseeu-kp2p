# kp2p protocol notes

What `kp2p.js` implements, as observed on a Hiseeu K8510-W NVR (firmware 3.5.5.0M). Every integer is **little-endian**.
These notes describe what works, not a complete specification.

## 1. Transport

- WebSocket, `ws://<nvr>:10000`, binary messages, no TLS, no HTTP authentication.
- **Opening:** the client sends 20 bytes: the 16-byte magic `d9ffcc028c38eed2d199ac6026947fae` followed by a random
  session id (`uint32`). The NVR's first message starts with `96d5390d12fcbe8f4790d932ccd849f3`.
- **Framing:** after that, every client message is sent as **two** WebSocket messages: an 8-byte prefix
  `cefaeffe` + `uint32 length`, then the payload. Incoming messages that start with `cefaeffe` are prefixes and can be ignored.

## 2. "IoT" layer (32-byte header)

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `abbccdde` |
| 4 | 1 | command |
| 11 | 1 | `1` |
| 16 | 4 | session id |
| 24 | 4 | error code (`int32`, answers only, 0 = OK) |
| 28 | 4 | payload length |

Commands: `17` ping (the client sends one every 10 s with a 96-byte zero payload), `18` pong, `19` data,
`20` open session (payload: 8 bytes, session id low and high bytes, then zeros), `21` open answer, `43` priority data.

## 3. API layer (inside IoT `data`, 24-byte header)

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `0x4b503250` (bytes `P2PK`) |
| 4 | 4 | `1` |
| 8 | 4 | request counter |
| 12 | 4 | command |
| 16 | 4 | result (`int32`, answers only, 0 = OK) |
| 20 | 4 | payload length |

| Request → answer | Payload |
|---|---|
| `10` → `11` login | AES-128-ECB(user, zero-padded to 32 bytes) + AES-128-ECB(password, 32 bytes). Fixed key `~!JUAN*&Vision-=`, no padding. |
| `30` → `31` live video | `uint32 channel` (from 0), `uint32 stream` (0 = main/HD, 1 = sub/SD), `uint32 2` |
| `20` → `21` PTZ | `uint32 channel`, `uint32 action`, `uint32 param1` (speed, 4 by default in kp2p.js, or preset number), `uint32 param2` |
| `80` → `81`, `150` → `151` settings | JSON text (experimental, same JSON API as the EseeCloud app) |

PTZ actions: 0 stop, 1 auto, 2 up, 3 down, 4 left, 5 right, 6/7 iris open/close, 8/9 zoom in/out,
10/11 focus far/near, 12 aux, 13 set preset, 14 go to preset, 15 clear preset.
A move continues until a `stop` is sent.

## 4. Media frames (inside IoT `data`)

A media message starts with `MARF` (`0x4652414d`) or `NARF` (`0x4652414e`, which has 40 extra bytes to skip first).

| Offset | Size | Content |
|---|---|---|
| 8 | 4 | head type (0 = media frame) |
| 12 | 4 | frame size |
| 24 | 4 | frame type: 0 audio, 1 key frame, 2 inter frame |
| 28 | 4 | channel |
| 32 | 8 | codec name, zero-padded (`H264`, `H265`) |
| 40 | 4 | frames per second |
| 44 | 4 | width |
| 48 | 4 | height |
| 64 | … | Annex-B video data |

A frame bigger than one message continues in the following `data` messages, which carry raw bytes only,
until `frame size` bytes have been received.

## 5. Behaviours worth knowing

- **Refusal:** when the NVR has no free slot, the live answer (`31`) has result `-40`. The NVR then still sends a
  **placeholder picture** (H.264, 704x480, 0 fps).
- **Silent refusal:** sometimes the live answer is `0` but the stream is that same placeholder (0 fps).
  `kp2p.js` treats both cases the same way: it drops the placeholder, waits 8 s, and exits with code 7.
- **Frozen stream:** the NVR can keep the connection open while sending no more frames. `kp2p.js` exits with code 6
  after 8 s without a frame, so the relay reconnects.
- After a disconnection, the NVR can take a few seconds to free the slot: an immediate reconnection may get `-40`.
