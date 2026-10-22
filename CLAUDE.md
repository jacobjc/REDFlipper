# REDFlipper — project notes

Premiere Pro UXP panel that finds upside-down sections of RED clips (camera flipped on the
gimbal) from the camera's accelerometer data, read straight from the .R3D files, and corrects
them with a Transform effect (Rotation 180°, Hold keyframes where a take flips mid-way).
Owner: Jacob (video editor). Windows PC, Premiere Pro 26.5.2. Footage: V-RAPTOR 8K VV, mostly
119.88 fps slow motion played at 23.976, but formats vary, so frame rates are read per clip.

## Files
- `manifest.json` — id `com.jacobchristiansen.redflip`, name `REDFlipper`, version (bump every release;
  the panel shows it next to the title), host `premierepro` min 25.6.0, `localFileSystem: fullAccess`
  (needed: the plugin opens R3Ds itself).
- `index.html` — panel UI: icon + title/version + "by Jacob J. Christiansen"; "Selected clips only" toggle
  switch (a styled div, `.on` class = selected only; off = whole sequence); Analyze & Flip, Remove Rotation,
  Stop; Advanced button revealing four option checkboxes (styled divs `.opt`, `.on` = checked, saved in
  localStorage as `redflipper.<id>`): `optForceFbf`, `optMotion`, `optSource`, `optCuts`; status line, per-clip
  progress bar, log (fills remaining height, scrolls, never cleared: each run appends under a dim header).
  Colours: "Fast Analysis" blue (`.fast`), "Frame-by-Frame Analysis" yellow (`.fbf`; `log()` colours both
  phrases automatically), warnings orange (`.warning`, log class `warn`). Preview was removed in 2.3.0.
- `index.js` — everything else (R3D reader, analysis, Premiere edits). Plain JS, no build step.
- `icons/` — plugin + panel icons. `redflipper.svg` is the source (flippers icon by Anna Pasechnaia,
  Noun Project, CC BY 3.0, credited in README); the PNGs (panel 23/46, plugin 48/96, header 64) are rendered
  from it, cropped to a square. `README.txt` — user-facing notes.
- Builds are named `REDFlipper-v<version>.ccx` and saved one folder up (`C:\Users\Jacob\Videos\Plugins`);
  the newest one is attached to the matching GitHub release.

## Build & install (Windows)
A .ccx is a zip with manifest.json at the root. Use bsdtar (forward-slash entry names);
avoid PowerShell's Compress-Archive, which can write backslash paths.
```powershell
cd C:\Users\Jacob\Videos\Plugins\RedFlip
$v = (Get-Content manifest.json | ConvertFrom-Json).version
tar -a -c -f ..\REDFlipper.zip manifest.json index.html index.js icons
Move-Item -Force ..\REDFlipper.zip "..\REDFlipper-v$v.ccx"
# verify the version inside before installing (a stale package was installed once)
tar -xOf "..\REDFlipper-v$v.ccx" manifest.json | Select-String '"version"'
# install (close Premiere first)
$upia = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
& $upia /remove "REDFlipper"
& $upia /install "C:\Users\Jacob\Videos\Plugins\REDFlipper-v$v.ccx"
& $upia /list all | Select-String "REDFlipper"
```
On this machine: UXP Developer Tool never saw Premiere ("No applications are connected"), and
double-clicking the .ccx in Creative Cloud said "Compatible app required". The UPIA command line
above works. So there is no live debugger: the panel's log is the only runtime feedback.

## R3D format (as used; checked against REDline on real files)
Each chunk file (`<clip>_001.R3D`, `_002`, … in the `.RDC` folder) is a chain of blocks:
`[u32 BE size][4-byte name]…`, each padded to a multiple of 4096 bytes.
- `RED2` at offset 0: clip header. Metadata found after the pattern
  `"rdx\x02" 00×7 01 "RED "` (or `"rdx\x01" 00×7 05 "REDT"`): u16 size, then entries
  `[u16 size][type][id][value]` (type 0x60 = u32, 0x20 = f32, 0x10 = string).
  id 0xB0 = playback fps × 1001 (24000 → 23.976), 0xBF = record fps × 1001 (120000 → 119.88),
  0x66 = record fps as f32.
- `RDI\x01`: one frame. Frame timestamp (u64 BE, µs) at block offset +64. First frame block is right
  after RED2 (offset 4096).
- `RDX\x02`: motion samples from block offset +4096, 20 bytes each:
  u64 timestamp µs, i16 accel X/Y/Z in 1/1000 g, i16 gyro X/Y/Z (/100). Same clock as frame timestamps.
  Motion data starts ~0.1 s (real time) before frame 0.
- Index blocks at the end of every chunk (last ~20 KB): `RII\x01`, `RIX\x01`, `RIX\x02`, then
  `REOF` (or `REOC` on the last chunk). All share a 64-byte header.
  - `RIX\x02`: after 64-byte header + 4 bytes (`01 01 0f a0`), entries `[u32 offset in 4096-byte pages][u32 size]`,
    one per RDX block in that chunk.
  - `REOF`/`REOC`: u32 frame count of the chunk at block offset +92.
- Fast path = "Fast Analysis" (index.js `readChunkIndexed`): read last 64 KB, parse RIX\x02 + REOF/REOC, read only the listed
  RDX blocks (verified to start with `RDX\x02`). Fallback `readChunkWalk` = "Frame-by-Frame Analysis" steps
  through every block header (~1000 reads per 4 GB chunk; very slow through UXP fs); logged once per clip when it
  kicks in, or forced by the `optForceFbf` option. Chunks read 6 in parallel. Results cached per method + path.
- REDline equivalents for checking: `REDline -i <clip>_001.R3D -printMeta 1` (FPS, Record FPS, Total Frames),
  `-printMeta 5` (per-frame timestamps), `-printMeta 7` (motion CSV: Timestamp, Acceleration X/Y/Z, Rotation X/Y/Z).
- Format layout first learned from Gyroflow's telemetry-parser (MIT/Apache-2.0, src/red/mod.rs); the index
  (RIX/REOF) decoding was worked out from Jacob's files. No code copied.

## Orientation logic (index.js `classify`)
- Axes: Z ≈ +1 g when upright, −1 g when upside-down; X = lens axis (+X = pointing down); Y = side.
  Gyro values don't integrate to the real rotation in any standard unit — ignored.
- Average motion data into 10 ms bins, centred ~0.1 s moving average.
- State per bin: if hypot(Y, Z) < 0.35 (lens within ~20° of vertical, e.g. overheads) keep previous state;
  else UP if Z > 0, INV if Z < 0. Change point = where the camera passes sideways (mid-flip).
- Map bin time → frame: floor((t − frame0_us) · recordFps / 1e6). Each recorded frame = one playback frame.
- Debounce: repeatedly absorb the shortest segment shorter than 2 s of playback into its neighbours.
- Earlier ideas rejected: per-second sampling, 60/120° hysteresis (misclassified an overhead shot that sits
  at ~85° from upright). Plain 90° threshold + time debounce matched Jacob's labels on all test clips.

## Premiere UXP API notes (Premiere 26.x)
- All edits: `project.lockedAccess(() => project.executeTransaction(ca => ca.addAction(...), label))`.
  `runPhase` batches all clips per step and retries clip-by-clip if a batch fails (e.g. locked track).
- Keyframe positions are in source-media time (same base as `trackItem.getInPoint()`), not sequence time.
  Keys are placed at source frame numbers and cover the whole source clip, so trims/extends stay correct.
  Ticks: 254016000000 per second; computed with BigInt from frame × den / num.
- `param.getValueAtTime()` returns a wrapped value (`{value: …}`), not a number — use `num()`.
- Hold: `createSetInterpolationAtKeyframeAction(time, Constants.InterpolationMode.HOLD, false)` after adding
  keys. Enabling time-varying may add a stray key; strays are removed only when every planned key was found.
- Transform effect matchName `AE.ADBE Geometry2` (falls back to display name "Transform"); added with
  `VideoFilterFactory.createComponent` + `chain.createAppendComponentAction`.
- REDFlipper's own Transform = a Transform on a RED clip whose Rotation is 180 or keyframed (re-runs update it,
  Remove deletes it). Motion > Rotation is left for the editor. `isLegacyMotionFlip` cleans up v1.0, which
  used Motion rotation.
- After applying, a "Keyframe test PASSED/FAILED" line checks one mid-take clip holds its value up to the flip.
- Apply modes (2.4.0): Transform (default), Motion (`optMotion`: Motion > Rotation; a 0/180-only Motion rotation
  counts as REDFlipper's, `isMotionFlip`), Source (`optSource`: Transform on the master clip via
  `ClipProjectItem.getComponentChain(MediaType.VIDEO)`, all instances). Each run first removes REDFlipper rotation
  that would double-flip (Transform in Motion mode, Motion flip in Transform mode, timeline flips in Source mode);
  in Transform/Motion mode a source that already has a Source Transform is skipped with a warning. Upright clips
  get every level cleaned. Remove Rotation clears all three.
- Cuts (`optCuts`, not in Source mode): the UXP API has no razor (Adobe: not planned for 1.0). `cutAt` uses
  `SequenceEditor.createCloneTrackItemAction(item, offset, 0, 0, true, isInsert=true)` at the flip point (an insert
  splits the clip there), then finds the copy (starts at the cut with the original's in point) plus any audio at the
  same span and ripple-deletes it with `createRemoveItemsAction(sel, true, MediaType.ANY, false)`, then checks the
  left/right halves and the next clip's position. Done after rotation, so both halves keep the keyframes. Skipped
  for speed-changed clips. Not yet confirmed in Premiere (mock-tested only, 2.4.0).

## Test clips (H:\01_VIDEO\2026_10_01) and expected results
- `01_CARD\A001_1001MB.RDM\A001_A004_1001FB.RDC` — upright throughout (5660 frames, frame0 405245802).
- `01_CARD\A001_1001MB.RDM\A001_A027_100106.RDC` — upside-down throughout.
- `02_CARD\A004_1001JZ.RDM\A004_A011_1001HL.RDC` — upright → upside-down at 00:03:14:03 (frame 4659);
  20250 frames, 22 chunks, frame0 904095407. Jacob saw it sideways 3:13:09–3:15:09.
- `01_CARD\A001_1001MB.RDM\A001_A025_1001HZ.RDC` — upside-down → upright 00:03:37:22 → upside-down 00:05:16:06.
  The upright middle part is an overhead (lens pointing down, camera rolled upright).
Timecodes are clip-relative at 24-frame nominal.

## Testing approach
No way to run Premiere headless. Logic was tested in Node with mocks: `premierepro` mocked (components,
params, keyframes, transactions), `fs` mapped to Node fs, and synthetic R3Ds rebuilt from REDline motion CSVs
in the real block layout (including index blocks, and one chunk with its index removed to hit the fallback).
Then confirmed in Premiere on the four test clips.

## Releasing
Licensing is fine (own code; Gyroflow is MIT/Apache and only used as format reference). "RED", "R3D",
"KOMODO", "V-RAPTOR" are RED Digital Cinema trademarks — "RED" in the product name could draw objections if
sold. Planned README lines (not added yet): "Not affiliated with or endorsed by RED Digital Cinema or Adobe."
and "R3D motion data layout based on research from Gyroflow's telemetry-parser (MIT/Apache-2.0)."
