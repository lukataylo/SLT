# See Through Walls

People walk around a building holding phones. Every phone streams its camera
and pose into a shared 3D map of the space (a Gaussian splat). Point your
phone at a wall and you see, live, what the phones on the other side see.

```
 handheld phones (feed + viewer)            relay server             storage
 ┌───────────────┐  JPEG + pose  ┌──────────────────────────┐   ┌──────────────┐
 │ camera  ──────┼──────────────►│ Room: stamp id/time,     │──►│ RECORD_DIR   │
 │ pose (motion/ │◄──────────────┤ fan out, drop on backlog │   │ (VAST NFS/S3)│
 │  sim/6DoF)    │  peers' frames└──────────────────────────┘   └──────────────┘
 │ splat + cards │
 └───────────────┘
```

## Run

```sh
npm install
npm run dev          # relay on :8787 + Vite on https://<lan-ip>:5173
```

Open the Vite URL on each phone (accept the self-signed cert) and on a laptop.
Phones need HTTPS for camera and motion sensors.

- **Phone:** tracking "Phone (motion sensors)". Tap where you stand on the
  minimap, then tap what you're facing. Turn X-ray on and point at a wall.
- **Laptop:** "Desktop simulator": WASD to walk, drag to look.

Production: `npm run build && npm start` serves everything on `:8787`.
Set `RECORD_DIR=/mnt/vast/slt` to archive every frame + pose.

`npm test` runs the protocol, relay and alignment tests.

## Adding a real scan

1. Capture the space (Scaniverse / Polycam / Luma, or nerfstudio `splatfacto`).
2. Export `.spz` (preferred, small) or `.ply` into `client/public/splats/`.
3. In `client/public/maps/default.json` set
   `"splat": { "url": "splats/office.spz", "position": [0,0,0], "quaternion": [0,0,0,1], "scale": 1 }`
   and trace `walls` / `bounds` in the same metric frame (Y up, metres).

## Scan data layout (for VAST)

Keep the raw capture, not just the splat: splats are re-trainable and the raw
data is what makes relocalisation and better models possible later.

```
s3://slt/scans/<site>/<scan-id>/
  raw/frames/000123.jpg          RGB (or HEIC) per keyframe
  raw/depth/000123.png           16-bit PNG, depth in millimetres (LiDAR)
  raw/confidence/000123.png      8-bit ARKit confidence (0/1/2)
  raw/transforms.json            intrinsics + camera-to-world per frame (nerfstudio format)
  pointcloud.laz                 fused LiDAR cloud (LAS 1.4, compressed)
  splat/office.ply               3DGS training output (full precision)
  splat/office.spz               compressed (~10x) - what phones download
  manifest.json                  site, device, timestamps, map transform
s3://slt/sessions/<session>/<peer>/<ts>.jpg + poses.jsonl   live recordings
```

Index frames and poses as rows in a table (Parquet / VAST DataBase) keyed by
scan, frame and timestamp so you can query "frames that saw point X" for
replay and relocalisation.

## Roadmap

- [x] Relay, shared protocol, backpressure, recording hook
- [x] Viewer: splat or blockout, live video cards through walls, minimap
- [x] Pose: desktop simulator, phone rotation + tap-to-place
- [ ] Full 6DoF on handheld phones: WebXR `camera-access` (Android) or a
      native ARKit app (iOS, with LiDAR depth)
- [ ] Automatic relocalisation against the scan instead of tap-to-place
- [ ] Project video onto splat surfaces / person cut-outs instead of flat cards
- [ ] WebRTC media path for lower latency than JPEG-over-WebSocket
