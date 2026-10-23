# REDFlipper — project notes

Premiere Pro UXP panel that finds upside-down sections of RED clips (camera flipped on the
gimbal) from the camera's accelerometer data, read straight from the .R3D files, and corrects
them with a Transform effect (Rotation 180°, Hold keyframes where a take flips mid-way).
Owner: Jacob (video editor). Windows PC, Premiere Pro 26.5.2. Footage: V-RAPTOR 8K VV, mostly
119.88 fps slow motion played at 23.976, but formats vary, so frame rates are read per clip.

## Files
- Panel size (2.4.6): minimum/floating/docked all 700x450 (Premiere 26.5 ignores the preferred size on first open but
  respects the minimum, so the minimum is the opening size).
- `manifest.json` — id `com.jacobchristiansen.redflip`, name `REDFlipper`, version (bump every release;
  the panel shows it next to the title), host `premierepro` min 25.6.0, `localFileSystem: fullAccess`
  (needed: the plugin opens R3Ds itself), `launchProcess` (open backup folders).
- `index.html` — panel UI: icon + title/version + "by Jacob J. Christiansen"; "Selected clips only" toggle
  switch (a styled div, `.on` class = selected only; off = whole sequence); Analyze & Flip, Undo (= Remove Rotation, renamed 2.4.7),
  Stop, Advanced, all in one row; Advanced starts with the "Apply Rotation to:" dropdown (2.6.6, `applyTo`:
  transform | motion | source, replaced the optMotion/optSource checkboxes; old saved checkboxes carried over; its
  warning shows on its own line under it), then option checkboxes (styled divs `.opt`, `.on` = checked, saved in
  localStorage as `redflipper.<id>`; each label's warning is on its own line below it): in order `optCuts`, `optStabilize`, `optForceFbf`, `optAutoSave`; `showOverrides()` greys out
  overridden ones (Source mode or Stabilize → Cuts off; `forcedState()`), showing the forced state in a
  grey box (no tick when forced off) and ignoring clicks; the saved `.on` state returns when the override ends. Only
  colours change when greyed (no tags since 2.5.1: Jacob found the layout shift jarring); status line, per-clip
  progress bar, log (fills remaining height, scrolls, never cleared: each run appends under a dim header; a new run
  jumps the log to the bottom and the log follows new lines until the editor scrolls up).
  Colours: "Fast Analysis" blue (`.fast`), "Frame-by-Frame Analysis" yellow (`.fbf`; `log()` colours both
  phrases automatically via `appendColoured()`, also used for the main button, undo and backup text), "stabiliz…"
  words purple (`.stab`, 2.5.7), warnings orange (`.warning`, log class `warn`; option warnings only show while the
  option is ticked, `.opt.shown`). Preview was removed in 2.3.0.
- `index.js` — everything else (R3D reader, analysis, Premiere edits). Plain JS, no build step.
- `icons/` — plugin + panel icons. `redflipper.svg` is the source (flippers icon by Anna Pasechnaia,
  Noun Project, CC BY 3.0, credited in README); the PNGs (panel 23/46, plugin 48/96, header 64) are rendered
  from it, cropped to a square. `README.txt` — user-facing notes.
- Logo animation (2.5.8): UXP runs no CSS animations/transitions/transforms, so `icons/spin/r000.png`…`r357.png`
  (120 frames, 3° steps, 84×84, clockwise, rendered from the SVG matched to header.png) are stacked in `#logoBox` and
  swapped with `style.opacity` by `animateLogo()` (setTimeout ~16 ms; 2.5.8 used `display`, which made frames flash at
  the wrong size now and then: re-showing a display:none image re-lays it out). Fixed width/height attributes too. Analyze & Flip: one clockwise turn with a
  back-out overshoot (1.1 s); Analyze & Stabilize: a small decaying rock (±15°, 1.4 s). Ends on the static header.png.
- The panel itself never auto-scrolls (removed in 2.5.10 at Jacob's request; only the log box follows new lines).
  If analysis finishes before the logo animation, `analyseAndFlip` waits until `logoAnimEnd` before the backup and
  the first edit (2.5.10).
- Auto-Backup Project label carries a grey "(Recommended)" (`.dim`), 2.5.8.
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
  Gyro values don't integrate to the real rotation in any standard unit — ignored here (flip detection);
  Stabilize calibrates them per clip since 2.6.0.
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
- Apply modes (2.4.0; one `applyTo` dropdown since 2.6.6, `applyMode()`): Transform (default), Motion (Motion > Rotation; a 0/180-only Motion rotation
  counts as REDFlipper's, `isMotionFlip`), Source (Transform on the master clip via
  `ClipProjectItem.getComponentChain(MediaType.VIDEO)`, all instances). Each run first removes REDFlipper rotation
  that would double-flip (Transform in Motion mode, Motion flip in Transform mode, timeline flips in Source mode);
  in Transform/Motion mode a source that already has a Source Transform is skipped with a warning. Upright clips
  get every level cleaned. Remove Rotation (2.4.1) only undoes the current mode's level: Transform by default,
  Motion flip in Motion mode, Source Transform in Source mode; `#undoInfo` (bottom of Advanced, `undoText()`)
  explains the current undo and updates on every option change.
- Auto-Backup Project (`optAutoSave` id kept for the saved setting; on by default via `DEFAULT_ON` since 2.4.3,
  renamed in 2.4.4): no API triggers Premiere's own auto-save. `autoBackup()` (Analyze & Flip only, right before the
  first edit) logs "Backing up current project...", calls `project.save()`, copies `project.path` (UXP fs `copyFile`,
  fallback read/write; `\` or `/` paths) to `<project folder>/Adobe Premiere Pro Auto-Save/<name>-REDFlipper-
  YYYY-MM-DD_HH-MM-SS.prproj`, then logs "Backup saved to <path>". Failures are logged and the run continues.
  `#backupInfo` under the undo text (`refreshBackupInfo()`: folder + newest backup file name, both clickable) refreshes on option change,
  Advanced open and after each run.
- Clickable paths (2.4.5): `pathLink()` spans (`.link`) open a folder with `uxp.shell.openPath` (a backup file's link
  opens its folder, not the .prproj). Needs manifest `requiredPermissions.launchProcess.extensions: [""]` (empty
  extension = folders); UXP may show a consent prompt per folder. Used for "Backup saved to" and the backup folder.
- Cuts (`optCuts`, not in Source mode): the UXP API has no razor (Adobe: not planned for 1.0). `cutAt` uses
  `SequenceEditor.createCloneTrackItemAction(item, offset, 0, 0, true, isInsert=true)` at the flip point (an insert
  splits the clip there), then finds the copy (starts at the cut with the original's in point) plus any audio at the
  same span and ripple-deletes it with `createRemoveItemsAction(sel, true, MediaType.ANY, false)`, then checks the
  left/right halves and the next clip's position. Done after rotation, so both halves keep the keyframes. Skipped
  for speed-changed clips. Premiere test of 2.4.6 (Jacob, 2026-10-22): the insert split the clip but the copy was NOT
  removed. 2.4.7 finds the copy by start time only, tries the remove as ANY+audio, VIDEO, ANY and checks the timeline
  after each, logs which failed (with Premiere's error), and stops further cuts after a failure.

## Stabilize (2.5.0, `optStabilize`; label "Lock to Horizon (Stabilize Rotation)" and button "Analyze & Stabilize" via `runLabel()` since 2.5.3)
- `rollKeys(clip)`: per frame, roll = ROLL_SIGN · atan2(Y, Z) of gravity averaged over ±50 ms (prefix sums over the
  10 ms bins), held while hypot(Y,Z) < 0.35, unwrapped (no 360° jumps). One key on every frame, no minimum change (2.5.6, Jacob; 2.5.0–2.5.5 dropped keys
  within 0.05° of a straight line), LINEAR interpolation. `stabPlan(result)` caches it on the analysis result (which keeps `clip`
  rows). Plan kind "stab" flows through the same apply path as "mixed" (any mode), cuts off. Fast Analysis is fine
  (same motion samples as Frame-by-Frame); 2.5.0 forced FBF, dropped in 2.5.1 at Jacob's request.
- Gyro fusion (2.6.0, reworked 2.6.1): reader keeps gyro X/Y/Z per bin (rows = [t, ax, ay, az, gx, gy, gz], gyro = raw/100).
  RED's raw gyro is 0.1 deg/s on the accelerometer's axes (Gyroflow reads it as raw/10 deg/s, orientation "zyx" for
  both); confirmed on Jacob's A002 clips (K:\01_VIDEO\2026_09_29): fitted slope ~10 per row unit, identity axes.
  2.6.0 tried to calibrate unit/axes per clip over 0.5 s windows and failed on real footage (fits 33-73%): gravity is
  too shaken at that timescale (handheld/gimbal footage barely rolls; lateral accelerations dominate).
  Roll rate from the gyro must account for tilt: `gyroRate` = gx + ty·gy + tz·gz with (ty, tz) = −ax·(ay, az)/(ay²+az²)
  (from da/dt = −ω×a); without it pans leak into roll on tilted shots (A016, ax 0.64: fit 0.96 with, −0.56 without).
  `checkGyro`: correlation of gravity vs gyro roll change over 2 s windows (A012–A026: 0.6–0.96) + constant bias;
  gyro dropped only if no gyro data, or the clip rolls ≥ 2° (std per window) and fit < 0.3. `fusedRoll`: gyro angle G +
  gravity offset (gravity − G) averaged over ±1 s, leaving out bins with |accel| > 0.08 g off 1 g and readings straying
  from the gyro track (iterated 8°/4°/2°); tilt held over strays and G recomputed. On Jacob's clips the fused roll is
  ~10× less jittery than gravity alone; gravity was off by up to 16.5° during shoves (A026). Tests in scratchpad:
  gyrotest.js, gyro3d.js (3D rotations), real.js/realfuse.js (Jacob's CSVs). `tools/extract-motion.ps1` in project
  files dumps a clip's motion data to CSV (index + RDX blocks only).
- ROLL_SIGN = 1 is a guess
  (axis direction of +Y unconfirmed; 2.5.4 tried -1, reverted in 2.5.5 at Jacob's request). Confirm on a tilted shot.
- Undo in Motion mode with Stabilize on treats any keyframed Motion rotation as REDFlipper's (`isMotionFlip(..., true)`).
- Keyframe interpolation/stray matching walks sorted lists (thousands of keys per clip).
- Sub-options (2.6.4, `#stabOptions`, shown while Stabilize is ticked; compact div dropdowns `.dd` since 2.6.5 (native `<select>` was too tall; Jacob wants them about two text lines in all), saved as
  `redflipper.stabMethod` "gyro"|"accel" and `redflipper.stabFraming` "fill"|"none"; `sub(id)`): method picks
  `stabPlan(result, method)` (cached per method in `result.stabs`). Framing step 5b after the keyframes: `fillScale`
  = max over used frames (timeline in/out) of max((A·cos φ + sin φ)/A, A·sin φ + cos φ), φ = tilt from nearest
  0/180, no zoom limit since 2.6.5 (Jacob): skips only flips (runs of frames > 30° in which the camera passes 90°) and 0.5 s around them, so up to √(A²+1) ≈ 204% on 16:9; A from `sequence.getFrameSize()`
  (16:9 fallback). Transform/Source: REDFlipper Transform's "Scale" set absolute (100 when not filling, also on
  flip runs). Motion: Motion > Scale multiplied; factor remembered in localStorage
  `redflipper.motionScale.<path>|<inPoint ticks>` and divided out on re-run/Undo. On Jacob's A002 clips the fill
  would be 108–137% (A016, 23° tilt: 162%).
- Cmd vs Ctrl (2.6.4): `appendColoured` swaps "Ctrl" for "Cmd" on macOS (`require("os").platform()`), so all panel
  text and log lines follow; strings stay written with Ctrl.
- Premiere objects go stale after an edit plus a host event-loop turn ("The script object is no longer valid",
  Jacob's 2.6.2 run). Since 2.6.3 the apply loop re-fetches the Rotation param (`refetch`: chain → component at the
  index recorded by `scanChain`) after every pause, and builds keyframes/actions inside each batch's transaction.
  The mock harness models this (objects/actions made before an edit + macrotask throw); 2.6.1 passes under it.
- Stop (2.6.2): `checkStop()` between steps before the first edit ("Stopped. Nothing was changed."; after the backup
  says the backup was saved). Keyframes are applied clip by clip in batches of `KEY_BATCH` (300) per transaction,
  with a `setTimeout(0)` pause after each so the Stop click is handled (one huge transaction blocked the UI). On Stop,
  unfinished clips (incl. the one in progress) get no REDFlipper rotation: the Transform added/reused for them is
  removed, Motion rotation reset to 0; then "Stopped. X of N clip(s) were stabilized/flipped…". Cuts: remaining cuts
  skipped. Mock test 13 covers stop mid-clip and stop before any edit.

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
