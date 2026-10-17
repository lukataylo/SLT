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

## Pages

| Page | What it's for |
|---|---|
| `/` | Phone/web app: live video through walls, 3D minimap |
| `/admin.html` | Bird's-eye 3D view of every device, room, LiDAR point cloud and door/window (`?mock=1` for demo data) |
| `/designer.html` | Upload a PDF/JPG floor plan, set its scale, draw and name rooms, place it on the scanned map |

Set `ADMIN_TOKEN` to require `?token=…` on the admin view and for plan uploads.

## iOS LiDAR app (`ios/`)

ARKit world tracking + LiDAR on iPhone Pro. The phone:

- **grounds first**: nothing is mapped until it has found the floor, which becomes y = 0;
- merges the plane fragments ARKit reports for one wall into a single wall;
- finds doors and windows from ARKit's per-face mesh classification (and
  door/window planes) and snaps them onto their wall;
- streams poses, frames, walls/openings/floor outline, and a 10 cm voxel
  LiDAR point cloud (new voxels only) in its own ARKit frame.

The server aligns each phone by matching its walls to the shared map.

**Rooms.** The first scan founds the fixed map origin and Room 1. "Start new
room here" creates a room whose origin is where you stand; optionally link it
to a room drawn on the uploaded floor plan, whose outline then shows as a
dashed target. Rooms can be switched or reset; "Reset entire map" clears every
room and the origin for everyone.

**Recognising a room.** In the background, located phones photograph each
room's 4 wall directions, square-on and from well back (`WallReferences.swift`).
A phone that isn't located matches its camera against them
(`ViewMatcher.swift`); once several views agree it sends its heading, the
server puts it in that room straight away, and its LiDAR walls then fit only
that way round (`register` with `yaw`), which places it exactly even in a
room that looks the same both ways. Nothing is shown on screen. Photos are
served from `/api/references/<room>/<id>.jpg`.

**Floor plans.** Upload in `/designer.html`. Once enough walls are scanned
the server places the plan automatically by matching scanned walls into the
plan's room outlines (or place it by hand in the designer).

Build: `cd ios && xcodegen generate`, open `SeeThrough.xcodeproj`, pick your
team, run on the phone. `node tools/fake-lidar.mjs` simulates a LiDAR phone.

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
