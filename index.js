// REDFlipper — finds upside-down sections of RED clips from the camera's own
// accelerometer data (read straight from the .R3D files) and corrects them with a
// Transform effect: Rotation 180°, keyframed with Hold where the camera flips mid-take.
// Motion > Rotation is left free for the editor unless the Motion option is on; the Source
// option puts the Transform on the source clip instead. Nothing is written to disk.
//
// R3D layout (as read by Gyroflow's telemetry-parser, checked against REDline):
//   the file is a chain of blocks: [u32 size][4-byte name], each padded to 4096 bytes.
//   RED2 = clip header (metadata: playback fps 0xB0, record fps 0xBF, both x1001)
//   RDI\x01 = one frame; its timestamp (µs, u64) sits 64 bytes into the block
//   RDX\x02 = motion samples from byte 4096: [u64 µs][i16 ax ay az][i16 gx gy gz], accel in 1/1000 g
// Motion samples and frame timestamps share one clock, so every sample maps to an exact frame.
//
// Keyframe times in Premiere are measured from the start of the clip's source media,
// so keys go at the source frame numbers directly and cover the whole clip.

const ppro = require("premierepro");
const fs = require("fs");

const TICKS_PER_SEC = 254016000000n;
const MOTION = "AE.ADBE Motion";
const UPSIDE_DOWN = 180;

// analysis settings
const BIN_US = 10000;            // average motion data into 10 ms bins
const SMOOTH_BINS = 5;           // ± bins for a centred ~0.1 s moving average
const LENS_VERTICAL_YZ = 0.35;   // lens within ~20° of straight up/down: keep previous state
const MIN_HOLD_S = 2.0;          // ignore orientation changes shorter than this (playback seconds)

// stabilize (level every frame) settings
const STAB_SMOOTH_US = 50000;    // level angle = gravity averaged over ± 50 ms around each frame
const ROLL_SIGN = 1;             // direction of the correction; -1 if leveling turns the wrong way
// gyro (2.6.0): RED stores it as 0.1°/s on the accelerometer's axes (as Gyroflow reads it, and as
// fitting it against gravity on Jacob's clips confirmed); motion rows hold the raw value / 100
const GYRO_DEG_PER_UNIT = 10;    // row gyro value -> degrees per second
const GYRO_CHECK_BINS = 200;     // sanity check: gyro vs gravity turning over 2 s windows
const GYRO_CHECK_SPREAD = 2;     // ... only judged when the clip rolls this much (degrees, std per window)
const GYRO_CHECK_FIT = 0.3;      // ... and the gyro is dropped if it agrees less than this
const FUSE_HALF_US = 1000000;    // level from gravity on average over ± 1 s; the gyro carries faster moves
const TILT_MIN_YZ = 0.1;         // tilt correction of the gyro until the lens is within ~6° of vertical
const SHAKEN_G = 0.08;           // total acceleration this far from 1 g: gravity's direction isn't trusted
const FUSE_OUTLIER_DEG = 2;      // gravity readings this far from the gyro's track are left out

let busy = false;
let stopRequested = false;
let transformMatch = null;
const analysisCache = new Map();  // analysis method + media path -> result, for this Premiere session only

// ------------------------------------------------------------------ ui helpers

const $ = (id) => document.getElementById(id);

// analysis method names are colour-coded wherever they appear (see .fast / .fbf in index.html)
// analysis methods and stabilizing are colour-coded wherever they appear (.fast / .fbf / .stab in index.html)
const FAST = "Fast Analysis", FBF = "Frame-by-Frame Analysis";
const COLOURED_RE = /(Fast Analysis|Frame-by-Frame Analysis|[Ss]tabiliz[a-z]*)/;

// Appends text to an element, wrapping the colour-coded words in spans.
function appendColoured(el, text) {
  for (const part of String(text).split(COLOURED_RE)) {
    if (!part) continue;
    const cls = part === FAST ? "fast" : part === FBF ? "fbf" : /^[Ss]tabiliz/.test(part) ? "stab" : null;
    if (!cls) { el.appendChild(document.createTextNode(part)); continue; }
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = part;
    el.appendChild(s);
  }
  return el;
}

// A clickable path: opens the folder in Explorer / Finder (a file's own folder, so a backup
// .prproj isn't opened in Premiere). Needs the launchProcess permission in manifest.json;
// UXP may ask the editor to allow it the first time.
function pathLink(path, folder) {
  const a = document.createElement("span");
  a.className = "link";
  a.textContent = path;
  a.addEventListener("click", () => openFolder(folder || path));
  return a;
}

async function openFolder(dir) {
  try {
    const err = await require("uxp").shell.openPath(dir);
    if (err) log(`Couldn't open ${dir}: ${err}`, "warn");
  } catch (e) { log(`Couldn't open ${dir}: ${e && e.message ? e.message : e}`, "warn"); }
}

// Lines are never deleted: each run appends below the last one. The log keeps following new
// lines unless the editor has scrolled up to read something. `link` = { path, folder } adds a
// clickable path at the end of the line.
let logSticky = true;   // follow new lines; off while the editor has scrolled up in the log

function log(msg, cls, link) {
  const box = $("log");
  const d = appendColoured(document.createElement("div"), msg);
  if (link) d.appendChild(pathLink(link.path, link.folder));
  if (cls) d.className = cls;
  box.appendChild(d);
  if (logSticky) box.scrollTop = box.scrollHeight;
}

// A new run jumps the log and the panel to the bottom, and the log sticks there again.
function startRun(label) {
  logSticky = true;
  if ($("log").childNodes.length) log(" ");
  log(`── ${label} · ${new Date().toLocaleTimeString()} ──`, "dim");
}

function status(msg) { $("status").textContent = msg || ""; }

// ------------------------------------------------------------------ logo animation

// CSS animations and transforms don't run in UXP panels, so the logo turns by flicking through
// pre-rotated frames (icons/spin/rNNN.png, every 3° clockwise), all loaded and laid out up front.
// Frames are swapped with opacity, not display: re-showing a display:none image made UXP lay it out
// again, and it sometimes flashed at the wrong size for a frame (the "zoom" flicker in 2.5.8).
const SPIN_STEP = 3, SPIN_FRAMES = 120;
let spinFrames = null, spinShown = -1, spinTimer = null, logoAnimEnd = 0;

function initLogo() {
  try {
    spinFrames = [];
    for (let i = 0; i < SPIN_FRAMES; i++) {
      const img = document.createElement("img");
      img.src = `icons/spin/r${String(i * SPIN_STEP).padStart(3, "0")}.png`;
      img.className = "spinFrame";
      img.width = 42; img.height = 42;
      img.style.opacity = "0";
      $("logoBox").appendChild(img);
      spinFrames.push(img);
    }
  } catch (e) { spinFrames = null; }   // no animation, the static logo stays
}

function showLogoAngle(deg) {
  const i = deg === null ? -1 : ((Math.round(deg / SPIN_STEP) % SPIN_FRAMES) + SPIN_FRAMES) % SPIN_FRAMES;
  if (i === spinShown) return;
  if (i >= 0) spinFrames[i].style.opacity = "1";
  if (spinShown >= 0) spinFrames[spinShown].style.opacity = "0";
  $("logo").style.opacity = i >= 0 ? "0" : "1";
  spinShown = i;
}

// Analyze & Flip: one full clockwise turn that overshoots a little and settles back.
// Analyze & Stabilize: a small rock back and forth that dies away.
function animateLogo(stabilize) {
  if (!spinFrames) return;
  if (spinTimer) clearTimeout(spinTimer);
  const dur = stabilize ? 1400 : 1100, t0 = Date.now();
  logoAnimEnd = t0 + dur;
  const backOut = (x) => { const c = 1.3; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
  const angle = (x) => (stabilize ? 15 * Math.sin(x * 4 * Math.PI) * (1 - x) : 360 * backOut(x));
  const tick = () => {
    const x = Math.min(1, (Date.now() - t0) / dur);
    if (x < 1) { showLogoAngle(angle(x)); spinTimer = setTimeout(tick, 16); }
    else { showLogoAngle(null); spinTimer = null; }
  };
  tick();
}

// ------------------------------------------------------------------ advanced options

const OPTIONS = ["optCuts", "optStabilize", "optMotion", "optSource", "optForceFbf", "optAutoSave"];
const DEFAULT_ON = new Set(["optAutoSave"]);   // Auto-Backup Project: checked until the editor unticks it
const opt = (id) => $(id).classList.contains("on");

function setOpt(id, on) {
  if (on) $(id).classList.add("on"); else $(id).classList.remove("on");
  try { localStorage.setItem(`redflipper.${id}`, on ? "1" : "0"); } catch (e) { /* not remembered */ }
  showOverrides();
  $("flip").textContent = "";
  appendColoured($("flip"), runLabel());
  $("undoInfo").textContent = "";
  appendColoured($("undoInfo"), undoText());
  refreshBackupInfo();
}

// Options another option overrides are greyed out and show the state they're forced to (a grey
// tick when forced on, no tick when forced off): Apply to Source Clip turns off Motion and cuts,
// Stabilize turns off cuts. The option's own setting (the .on class, which is what's saved) is
// kept, so it comes back once the override is gone.
const forcedState = () => ({
  optMotion: opt("optSource") ? false : null,
  optCuts: opt("optSource") || opt("optStabilize") ? false : null,
});

function showOverrides() {
  const forced = forcedState();
  for (const id of OPTIONS) {
    const f = id in forced ? forced[id] : null, shown = f === null ? opt(id) : f;
    if (f === null) $(id).classList.remove("overridden"); else $(id).classList.add("overridden");
    if (shown) $(id).classList.add("shown"); else $(id).classList.remove("shown");   // warnings show only while ticked
    const box = $(id).querySelector(".box");
    box.textContent = shown ? "✓" : "";
    box.className = `box${shown ? " checked" : ""}`;
    $(id).setAttribute("aria-checked", shown ? "true" : "false");
  }
}

function loadOptions() {
  for (const id of OPTIONS) {
    let on = DEFAULT_ON.has(id);
    try {
      const v = localStorage.getItem(`redflipper.${id}`);
      if (v !== null && v !== undefined) on = v === "1";
    } catch (e) { /* default */ }
    setOpt(id, on);
  }
}

// the main button: "Analyze & Stabilize" while Lock to Horizon is on
const runLabel = () => (opt("optStabilize") ? "Analyze & Stabilize" : "Analyze & Flip");

// where the rotation goes: "transform" (default), "motion" or "source"
const applyMode = () => (opt("optSource") ? "source" : opt("optMotion") ? "motion" : "transform");

// What "Undo" does with the current options; shown at the bottom of Advanced.
function undoText() {
  const mode = applyMode();
  let text = {
    transform: "removes REDFlipper's Transform effect from the clips in scope. Motion and Source Clip effects are left alone.",
    motion: "resets Motion > Rotation to 0° and clears its keyframes on the clips in scope (only where it holds a 0°/180° flip). " +
            "A rotation you had there before it was overwritten comes back only with Ctrl+Z. Transform effects are left alone.",
    source: "removes the Source Transform from the source clips of the clips in scope, so every instance in the project " +
            "goes back to upright. Timeline effects are left alone.",
  }[mode];
  if (opt("optStabilize")) {
    text += mode === "motion" ? " Stabilizing keyframes on Motion > Rotation are cleared too." : " This also removes stabilization.";
  }
  if (opt("optCuts") && mode !== "source" && !opt("optStabilize")) {
    text += " Cuts stay: use Ctrl+Z, or right-click a cut > Join Through Edits.\nCtrl + Left-click drag to select multiple cut points.";
  }
  return "Undo: " + text;
}

// scope switch: on = selected clips only, off = every clip in the active sequence
const selectedOnly = () => $("scopeSwitch").classList.contains("on");

function setSelectedOnly(on) {
  if (on) $("scopeSwitch").classList.add("on"); else $("scopeSwitch").classList.remove("on");
  $("scopeSwitch").setAttribute("aria-checked", on ? "true" : "false");
  $("scopeLabel").textContent = on ? "Selected clips only" : "All clips in the sequence";
  $("scopeHint").textContent = on ? "(switch off for the whole sequence)" : "(switch on for selected clips only)";
}

// per-clip progress bar: fraction 0..1 shows it, null hides it
function progress(frac) {
  if (frac === null || frac === undefined) { $("progressWrap").className = "hidden"; return; }
  $("progressWrap").className = "";
  $("progressBar").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

async function guarded(fn) {
  if (busy) return;
  busy = true;
  stopRequested = false;
  for (const id of ["flip", "remove"]) $(id).disabled = true;
  $("stop").disabled = false;
  try { await fn(); }
  catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.startsWith("Stopped")) log(msg, "warn");
    else { log(`Error: ${msg}`, "err"); console.error(e); }
  }
  finally {
    busy = false;
    status("");
    progress(null);
    for (const id of ["flip", "remove"]) $(id).disabled = false;
    $("stop").disabled = true;
    refreshBackupInfo();
  }
}

// ------------------------------------------------------------------ R3D reading

const sep = (p) => (p.includes("\\") ? "\\" : "/");

const asUrl = (p) => "file:/" + p.replace(/\\/g, "/").replace(/^\/+/, "");

async function openRead(path) {
  try { return await fs.open(path, "r"); } catch (e) { /* try the file:/ form */ }
  try { return await fs.open(asUrl(path), "r"); }
  catch (e) { throw new Error(`can't open ${path} (drive offline or file moved?)`); }
}

async function listDir(dir) {
  try { return await fs.readdir(dir); } catch (e) { /* try the file:/ form */ }
  try { return await fs.readdir(asUrl(dir)); }
  catch (e) { throw new Error(`can't open folder ${dir} (drive offline or media moved?)`); }
}

async function readAt(fd, position, length) {
  const buf = new ArrayBuffer(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fs.read(fd, buf, got, length - got, position + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return { view: new DataView(buf, 0, got), bytes: new Uint8Array(buf, 0, got), length: got };
}

const u64 = (v, o) => v.getUint32(o) * 4294967296 + v.getUint32(o + 4);

function findBytes(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const META_PATTERNS = [
  [0x72, 0x64, 0x78, 0x02, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x52, 0x45, 0x44, 0x20],   // "rdx\2 ... \1RED "
  [0x72, 0x64, 0x78, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x52, 0x45, 0x44, 0x54],   // "rdx\1 ... \5REDT"
];

function parseMeta(bytes, view) {
  const out = {};
  for (const pat of META_PATTERNS) {
    const o = findBytes(bytes, pat);
    if (o < 0) continue;
    const size = view.getUint16(o + 16);
    let i = o + 18;
    const end = Math.min(o + 18 + size, bytes.length);
    while (i + 4 <= end) {
      const s = view.getUint16(i);
      if (s <= 2 || i + s > end) break;
      const type = bytes[i + 2], id = bytes[i + 3], vo = i + 4;
      if (type === 0x60 && s >= 8) out[id] = view.getUint32(vo);
      else if (type === 0x20 && s >= 8) out[id] = view.getFloat32(vo);
      i += s;
    }
    break;
  }
  return out;
}

const RED2 = 0x52454432, RDI1 = 0x52444901, RDX2 = 0x52445802;   // block names as big-endian u32
const RIX2 = 0x52495802, REOF = 0x52454f46, REOC = 0x52454f43;
const TAIL_BYTES = 65536;          // the chunk's index blocks live in its last few 4 KB pages
const PARALLEL_CHUNKS = 6;

async function fileSize(path) {
  for (const p of [path, asUrl(path)]) {
    try { const st = await fs.lstat(p); if (st && st.size > 0) return st.size; } catch (e) { /* next */ }
  }
  try {
    const entry = await require("uxp").storage.localFileSystem.getEntryWithUrl(asUrl(path));
    const md = await entry.getMetadata();
    if (md && md.size > 0) return md.size;
  } catch (e) { /* no size */ }
  return null;
}

function addSamples(bins, b) {
  for (let o = 4096; o + 20 <= b.length; o += 20) {
    const k = Math.floor(u64(b.view, o) / BIN_US);
    let bin = bins.get(k);
    if (!bin) { bin = [0, 0, 0, 0, 0, 0, 0]; bins.set(k, bin); }
    bin[0] += b.view.getInt16(o + 8) / 1000;
    bin[1] += b.view.getInt16(o + 10) / 1000;
    bin[2] += b.view.getInt16(o + 12) / 1000;
    bin[3]++;
    bin[4] += b.view.getInt16(o + 14) / 100;   // gyro X/Y/Z, raw (unit unknown, calibrated later)
    bin[5] += b.view.getInt16(o + 16) / 100;
    bin[6] += b.view.getInt16(o + 18) / 100;
  }
}

// Fast path: the index at the end of the chunk lists every motion block (RIX\x02:
// [u32 offset in 4 KB pages][u32 size] from byte 68) and the end block (REOF/REOC)
// holds the chunk's frame count at byte 92. Returns null if the index isn't usable.
async function readChunkIndexed(fd, size, bins) {
  if (!size || size < 8192) return null;
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await readAt(fd, tailStart, size - tailStart);
  let rix = null, frames = null;
  for (let off = (4096 - (tailStart % 4096)) % 4096; off + 8 <= tail.length; off += 4096) {
    const bsize = tail.view.getUint32(off), kind = tail.view.getUint32(off + 4);
    if (bsize < 8 || off + bsize > tail.length) continue;
    if (kind === RIX2 && bsize >= 68) rix = { off, bsize };
    else if ((kind === REOF || kind === REOC) && bsize >= 96) frames = tail.view.getUint32(off + 92);
  }
  if (!rix || frames === null) return null;
  const entries = [];
  for (let o = rix.off + 68; o + 8 <= rix.off + rix.bsize; o += 8) {
    entries.push([tail.view.getUint32(o) * 4096, tail.view.getUint32(o + 4)]);
  }
  const blocks = [];
  for (const [pos, bsize] of entries) {
    if (bsize <= 4096 || pos + bsize > size) return null;
    const b = await readAt(fd, pos, bsize);
    if (b.length < bsize || b.view.getUint32(4) !== RDX2) return null;   // index doesn't match: don't trust it
    blocks.push(b);
  }
  for (const b of blocks) addSamples(bins, b);
  return frames;
}

// Slow path: walk every block header in the chunk.
async function readChunkWalk(fd, bins) {
  let frames = 0, pos = 0;
  for (;;) {
    if (stopRequested) throw new Error("stopped");
    const h = await readAt(fd, pos, 8);
    if (h.length < 8) break;
    const size = h.view.getUint32(0), kind = h.view.getUint32(4);
    if (size < 8) break;
    if (kind === RDI1) frames++;
    else if (kind === RDX2 && size > 4096) addSamples(bins, await readAt(fd, pos, size));
    pos += Math.ceil(size / 4096) * 4096;
  }
  return frames;
}

// Reads frame count, first frame time, frame rates and motion samples (binned) for one clip.
// Fast Analysis reads only the motion blocks listed in each chunk's index; Frame-by-Frame
// Analysis (forced, or the fallback when an index is missing) walks every block.
async function readClip(firstChunkPath, onProgress, forceWalk, onFallback) {
  const s = sep(firstChunkPath);
  const dir = firstChunkPath.slice(0, firstChunkPath.lastIndexOf(s));
  const file = firstChunkPath.slice(firstChunkPath.lastIndexOf(s) + 1);
  const base = file.replace(/_\d{3}\.r3d$/i, "_");
  const chunks = (await listDir(dir))
    .map((e) => (typeof e === "string" ? e : e.name))
    .filter((n) => n.startsWith(base) && /\.r3d$/i.test(n))
    .sort();
  if (!chunks.length) chunks.push(file);

  const bins = new Map();   // bin index -> [sx, sy, sz, n]
  let meta = {}, frame0 = null, frames = 0, walked = 0, fellBack = false;

  async function doChunk(name, index) {
    if (stopRequested) throw new Error("stopped");
    const path = dir + s + name;
    const fd = await openRead(path);
    try {
      if (index === 0) {
        // clip header (frame rates) and the first frame's timestamp
        const h = await readAt(fd, 0, 8);
        if (h.length === 8 && h.view.getUint32(4) === RED2) {
          const hs = h.view.getUint32(0);
          const b = await readAt(fd, 0, Math.min(hs, 1 << 20));
          meta = parseMeta(b.bytes, b.view);
          // first frame block: normally right after the header; step over anything else before it
          let pos = Math.ceil(hs / 4096) * 4096;
          for (let k = 0; k < 64 && frame0 === null; k++) {
            const f = await readAt(fd, pos, 72);
            if (f.length < 8) break;
            const bs = f.view.getUint32(0);
            if (bs < 8) break;
            if (f.view.getUint32(4) === RDI1 && f.length === 72) frame0 = u64(f.view, 64);
            pos += Math.ceil(bs / 4096) * 4096;
          }
        }
      }
      // the indexed read adds samples only if the index checks out
      let n = forceWalk ? null : await readChunkIndexed(fd, await fileSize(path), bins);
      if (n === null) {
        if (!forceWalk && !fellBack) { fellBack = true; if (onFallback) onFallback(); }
        n = await readChunkWalk(fd, bins);
        walked++;
      }
      frames += n;
    } finally {
      await fs.close(fd);
    }
  }

  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done / chunks.length); };
  if (onProgress) onProgress(0);
  for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
    await Promise.all(chunks.slice(i, i + PARALLEL_CHUNKS).map((name, j) => doChunk(name, i + j).then(tick)));
  }

  const fpsNum = meta[0xB0] || 24000, fpsDen = 1001;   // stored as fps x 1001
  const recordFps = meta[0xBF] ? meta[0xBF] / 1001 : (meta[0x66] || fpsNum / fpsDen);
  const rows = [...bins.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => [k * BIN_US, v[0] / v[3], v[1] / v[3], v[2] / v[3], v[4] / v[3], v[5] / v[3], v[6] / v[3]]);
  return { frames, frame0, fpsNum, fpsDen, recordFps, rows, chunks: chunks.length, walked };
}

// ------------------------------------------------------------------ orientation analysis

function classify(clip) {
  const { rows, frames: total, frame0, recordFps, fpsNum, fpsDen } = clip;
  if (!rows.length || frame0 === null || !total) return null;
  const usPerFrame = 1e6 / recordFps;
  const minHold = Math.max(1, Math.round(MIN_HOLD_S * fpsNum / fpsDen));

  // centred moving average
  const n = rows.length, sy = [0], sz = [0];
  for (const r of rows) { sy.push(sy[sy.length - 1] + r[2]); sz.push(sz[sz.length - 1] + r[3]); }

  const pts = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - SMOOTH_BINS), b = Math.min(n, i + SMOOTH_BINS + 1), k = b - a;
    const y = (sy[b] - sy[a]) / k, z = (sz[b] - sz[a]) / k;
    const frame = Math.floor((rows[i][0] + BIN_US / 2 - frame0) / usPerFrame);
    if (frame >= total) break;
    const state = Math.hypot(y, z) < LENS_VERTICAL_YZ ? prev : (z > 0 ? "UP" : "INV");
    if (!state) continue;
    prev = state;
    pts.push([Math.max(frame, 0), state]);
  }
  if (!pts.length) return [["UP", 0, total]];

  let segs = [];
  for (const [frame, state] of pts) {
    if (!segs.length) segs.push([state, 0, total]);
    else if (segs[segs.length - 1][0] !== state && frame > segs[segs.length - 1][1]) {
      segs[segs.length - 1][2] = frame;
      segs.push([state, frame, total]);
    } else if (segs[segs.length - 1][0] !== state) {
      segs[segs.length - 1][0] = state;
      if (segs.length > 1 && segs[segs.length - 2][0] === state) { segs[segs.length - 2][2] = total; segs.pop(); }
    }
  }
  // absorb the shortest too-short section until none remain
  while (segs.length > 1) {
    let k = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i][2] - segs[i][1] < segs[k][2] - segs[k][1]) k = i;
    if (segs[k][2] - segs[k][1] >= minHold) break;
    segs[k][0] = k > 0 ? segs[k - 1][0] : segs[k + 1][0];
    const merged = [];
    for (const sg of segs) {
      if (merged.length && merged[merged.length - 1][0] === sg[0]) merged[merged.length - 1][2] = sg[2];
      else merged.push(sg);
    }
    segs = merged;
  }
  return segs;
}

function tc(frame, fpsNum, fpsDen) { return tcNominal(frame, Math.round(fpsNum / fpsDen)); }

function tcNominal(frame, nominal) {
  const p = (x) => String(x).padStart(2, "0");
  return `${p(Math.floor(frame / (nominal * 3600)))}:${p(Math.floor(frame / (nominal * 60)) % 60)}:` +
         `${p(Math.floor(frame / nominal) % 60)}:${p(frame % nominal)}`;
}

async function analyse(path, onProgress, forceWalk, onFallback) {
  const key = (forceWalk ? "fbf|" : "fast|") + path;
  if (analysisCache.has(key)) return analysisCache.get(key);
  const clip = await readClip(path, onProgress, forceWalk, onFallback);
  const segs = classify(clip);
  let plan;
  if (!segs) plan = { kind: "nodata" };
  else if (!segs.some((x) => x[0] === "INV")) plan = { kind: "upright" };
  else if (!segs.some((x) => x[0] === "UP")) plan = { kind: "inverted" };
  else plan = {
    kind: "mixed",
    keys: segs.map(([state, start]) => ({ frame: start, value: state === "INV" ? UPSIDE_DOWN : 0, tc: tc(start, clip.fpsNum, clip.fpsDen) })),
  };
  const result = { plan, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen, walked: clip.walked,
                   clip: { rows: clip.rows, frames: clip.frames, frame0: clip.frame0, recordFps: clip.recordFps } };
  analysisCache.set(key, result);
  return result;
}

// Stabilize: the camera's roll for every frame (0° upright, 180° upside-down), unwrapped so it
// never jumps by 360°.
//
// Gravity (the accelerometer) always knows where level is, but hard moves push it around. The gyro
// follows fast turns cleanly but only measures turning speed, drifts when added up, and RED's
// gyro unit and axis order aren't documented. So each clip calibrates its gyro against gravity
// (which axis, what scale, what offset), then the two are combined: the gyro's turning, pulled
// towards gravity's level on average over ±1 s. Without a trustworthy calibration (a clip that
// barely turns, odd data) the last good calibration from this session is used, or gravity alone.

const wrap180 = (d) => d - 360 * Math.round(d / 360);

// roll from gravity per 10 ms bin, averaged over ±50 ms; null while the lens points nearly straight up/down.
// out.shaken[i] marks bins where the camera is being pushed around (total acceleration well off 1 g),
// when gravity's direction can't be trusted.
function gravityRoll(rows) {
  const n = rows.length, sx = [0], sy = [0], sz = [0], half = Math.round(STAB_SMOOTH_US / BIN_US);
  for (const r of rows) { sx.push(sx[sx.length - 1] + r[1]); sy.push(sy[sy.length - 1] + r[2]); sz.push(sz[sz.length - 1] + r[3]); }
  const out = new Array(n).fill(null);
  out.shaken = new Array(n).fill(false);
  out.tilt = new Array(n).fill(null);   // [ty, tz]: how much turning about the Y and Z axes changes the roll
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1), k = b - a;
    const x = (sx[b] - sx[a]) / k, y = (sy[b] - sy[a]) / k, z = (sz[b] - sz[a]) / k;
    const h = y * y + z * z;
    if (Math.sqrt(h) >= LENS_VERTICAL_YZ) out[i] = ROLL_SIGN * Math.atan2(y, z) * 180 / Math.PI;
    out.shaken[i] = Math.abs(Math.hypot(x, y, z) - 1) > SHAKEN_G;
    // tilt changes slowly; while the camera is shoved, keep the last steady reading
    if (out.shaken[i] && i > 0) out.tilt[i] = out.tilt[i - 1];
    else if (Math.sqrt(h) >= TILT_MIN_YZ) out.tilt[i] = [-x * y / h, -x * z / h];
  }
  return out;
}

// How fast the roll changes, from the gyro: with the lens level it's just the turning about the lens
// axis, but tilted up or down, turning about the other two axes rolls the picture too:
//   roll rate = ω_lens − a_lens·(a_side·ω_side + a_up·ω_up) / (a_side² + a_up²)   (a = gravity, ω = gyro)
function gyroRate(row, tilt) {
  return tilt ? row[4] + tilt[0] * row[5] + tilt[1] * row[6] : row[4];
}

// Checks the gyro against gravity (turning over 2 s windows, which averages out shoves) and
// estimates its small constant offset. Returns { fit, bias } or { fail }.
function checkGyro(rows, grav) {
  const n = rows.length;
  if (!rows.some((r) => r[4] || r[5] || r[6])) return { fail: "no gyro data" };
  const scale = ROLL_SIGN * GYRO_DEG_PER_UNIT, cy = [0], cx = [0], ok = [0];
  for (let i = 1; i < n; i++) {
    const good = grav[i] !== null && grav[i - 1] !== null && rows[i][0] - rows[i - 1][0] === BIN_US;
    cy.push(cy[i - 1] + (good ? wrap180(grav[i] - grav[i - 1]) : 0));
    cx.push(cx[i - 1] + (good ? scale * gyroRate(rows[i], grav.tilt[i]) * BIN_US / 1e6 : 0));
    ok.push(ok[i - 1] + (good ? 1 : 0));
  }
  const xs = [], ys = [], W = GYRO_CHECK_BINS;
  for (let i = 0; i + W < n; i += W / 4) if (ok[i + W] - ok[i] === W) { ys.push(cy[i + W] - cy[i]); xs.push(cx[i + W] - cx[i]); }
  const k = ys.length;
  if (k < 4) return { fit: null, bias: 0 };   // too short to judge
  const mx = xs.reduce((a, b) => a + b, 0) / k, my = ys.reduce((a, b) => a + b, 0) / k;
  let vx = 0, vy = 0, c = 0;
  for (let j = 0; j < k; j++) { vx += (xs[j] - mx) ** 2; vy += (ys[j] - my) ** 2; c += (xs[j] - mx) * (ys[j] - my); }
  const fit = vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : null;
  const bias = (my - mx) / (W * BIN_US / 1e6);   // degrees per second the gyro reads off
  if (fit !== null && Math.sqrt(vy / k) >= GYRO_CHECK_SPREAD && fit < GYRO_CHECK_FIT) {
    return { fail: `it doesn't agree with gravity (${Math.round(fit * 100)}%)`, fit };
  }
  return { fit, bias };
}

// roll per bin: gravity alone, or gyro + gravity when a calibration is given
function fusedRoll(rows, grav, cal) {
  const n = rows.length, out = new Array(n).fill(null);
  if (!cal) {
    let prev = null;
    for (let i = 0; i < n; i++) {
      if (grav[i] !== null) prev = prev === null ? grav[i] : prev + wrap180(grav[i] - prev);
      out[i] = prev;
    }
    return out;
  }
  // gyro angle (added up), and gravity's offset from it wherever gravity is usable
  const track = (tilt) => {
    const G = new Float64Array(n), D = new Array(n).fill(null);
    let off = null;
    for (let i = 0; i < n; i++) {
      if (i > 0) G[i] = G[i - 1] + (cal.scale * gyroRate(rows[i], tilt[i]) + cal.offset) * (rows[i][0] - rows[i - 1][0]) / 1e6;
      if (grav[i] === null) continue;
      let a = grav[i];
      if (off !== null) a += 360 * Math.round((G[i] + off - a) / 360);
      D[i] = off = a - G[i];
    }
    return { G, D };
  };
  // average the offset over ±1 s, so it changes slowly. Gravity is left out while the camera is
  // shoved around, and wherever it strays from the gyro's track (hard moves).
  const smooth = (D) => {
    const average = (use) => {
      const sw = [0], sd = [0];
      for (let i = 0; i < n; i++) { sw.push(sw[i] + (use(i) ? 1 : 0)); sd.push(sd[i] + (use(i) ? D[i] : 0)); }
      const avg = new Array(n).fill(null);
      let lo = 0, hi = 0;
      for (let i = 0; i < n; i++) {
        while (lo < n && rows[lo][0] < rows[i][0] - FUSE_HALF_US) lo++;
        while (hi < n && rows[hi][0] <= rows[i][0] + FUSE_HALF_US) hi++;
        const k = sw[hi] - sw[lo];
        if (k > 0) avg[i] = (sd[hi] - sd[lo]) / k;
      }
      return avg;
    };
    const steady = (i) => D[i] !== null && !grav.shaken[i];
    let avg = average(steady);
    if (avg.some((v) => v === null)) avg = average((i) => D[i] !== null);   // nothing steady nearby: take what there is
    // tighten step by step, so one big shove can't drag the average far enough to throw out good readings
    for (const lim of [4 * FUSE_OUTLIER_DEG, 2 * FUSE_OUTLIER_DEG, FUSE_OUTLIER_DEG]) {
      const prev = avg;
      avg = average((i) => steady(i) && prev[i] !== null && Math.abs(D[i] - prev[i]) < lim);
      for (let i = 0; i < n; i++) if (avg[i] === null) avg[i] = prev[i];
    }
    return avg;
  };
  let { G, D } = track(grav.tilt);
  let avg = smooth(D);
  // Where gravity strayed from the gyro (a shove the 1 g check missed), the tilt reading was off too:
  // hold the last good tilt over those spans (and the ±50 ms they were averaged into), then redo.
  const half = Math.round(STAB_SMOOTH_US / BIN_US), shoved = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (D[i] !== null && avg[i] !== null && Math.abs(D[i] - avg[i]) >= 2 * FUSE_OUTLIER_DEG) {
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) shoved[k] = true;
    }
  }
  if (shoved.some((x) => x)) {
    const tilt = grav.tilt.slice();
    for (let i = 1; i < n; i++) if (shoved[i]) tilt[i] = tilt[i - 1];
    ({ G, D } = track(tilt));
    avg = smooth(D);
  }
  // no usable gravity within ±1 s (e.g. a long overhead): keep the nearest offset, follow the gyro
  let last = null;
  for (let i = 0; i < n; i++) { if (avg[i] === null) avg[i] = last; else last = avg[i]; }
  last = null;
  for (let i = n - 1; i >= 0; i--) { if (avg[i] === null) avg[i] = last; else last = avg[i]; }
  if (avg[0] === null) return out;   // no gravity anywhere
  for (let i = 0; i < n; i++) out[i] = G[i] + avg[i];
  return out;
}

// One key on every frame, however small the change. Returns { keys, gyro } or null.
function rollKeys(clip, use) {
  const { rows, frames: total, frame0, recordFps } = clip;
  if (!rows || !rows.length || frame0 === null || !total) return null;
  const grav = clip.grav || (clip.grav = gravityRoll(rows));
  const roll = fusedRoll(rows, grav, use);
  if (roll.every((v) => v === null)) return null;

  // each frame: the roll at its middle, interpolated between bin centres
  const usPerFrame = 1e6 / recordFps, n = rows.length, vals = new Array(total).fill(null);
  let j = 0;
  for (let f = 0; f < total; f++) {
    const t = frame0 + (f + 0.5) * usPerFrame;
    while (j + 1 < n && rows[j + 1][0] + BIN_US / 2 <= t) j++;
    const t0 = rows[j][0] + BIN_US / 2, v0 = roll[j];
    if (j + 1 < n && roll[j + 1] !== null && v0 !== null && t > t0) {
      const t1 = rows[j + 1][0] + BIN_US / 2;
      vals[f] = v0 + (roll[j + 1] - v0) * Math.min(1, (t - t0) / (t1 - t0));
    } else vals[f] = v0;
  }
  let prev = vals.find((v) => v !== null);
  if (prev === undefined) return null;
  const keys = [];
  for (let f = 0; f < total; f++) {
    if (vals[f] !== null) prev = vals[f];
    keys.push({ frame: f, value: Math.round(prev * 1000) / 1000 });
  }
  return keys;
}

// The stabilize plan for an analysed clip (computed once, kept with the cached analysis).
function stabPlan(result) {
  const k = result.plan.kind;
  if (k === "error" || k === "nodata") return result.plan;
  if (!result.stab) {
    const clip = result.clip;
    let gyro = { fail: "no motion data" }, keys = null;
    if (clip && clip.rows && clip.rows.length) {
      const grav = clip.grav || (clip.grav = gravityRoll(clip.rows));
      gyro = clip.rows[0].length > 4 ? checkGyro(clip.rows, grav) : { fail: "no gyro data" };
      keys = rollKeys(clip, gyro.fail ? null : { scale: ROLL_SIGN * GYRO_DEG_PER_UNIT, offset: gyro.bias });
    }
    result.stab = keys ? { kind: "stab", gyro, keys: keys.map((x) => ({ ...x, tc: tc(x.frame, result.fpsNum, result.fpsDen) })) }
                       : { kind: "nodata" };
  }
  return result.stab;
}

// log line on how a clip's horizon was found
function gyroNote(name, g) {
  if (!g) return;
  if (!g.fail) log(`${name}: leveling uses gyro + gravity.`, "dim");
  else log(`${name}: gyro not used (${g.fail}). Leveling from gravity only.`, "warn");
}

// ------------------------------------------------------------------ Premiere helpers

const frameTicks = (frame, num, den) => (BigInt(frame) * TICKS_PER_SEC * BigInt(den)) / BigInt(num);
const tickTime = (ticks) => ppro.TickTime.createWithTicks(ticks.toString());
const tickTimeAt = (frame, num, den) => tickTime(frameTicks(frame, num, den));

// TickTime -> BigInt ticks
function ticksOf(t) {
  if (t === null || t === undefined) return 0n;
  if (t.ticks !== undefined) return BigInt(t.ticks);
  return BigInt(Math.round(Number(t.ticksNumber)));
}

// Premiere returns parameter values wrapped (e.g. { value: 180 } or { value: { value: 180 } }).
function num(v) {
  for (let i = 0; i < 4 && v !== null && v !== undefined; i++) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    if (typeof v === "object" && "value" in v) { v = v.value; continue; }
    break;
  }
  return NaN;
}

function describe(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

async function getTransformMatchName() {
  if (transformMatch) return transformMatch;
  const names = await ppro.VideoFilterFactory.getMatchNames();
  if (names.includes("AE.ADBE Geometry2")) return (transformMatch = "AE.ADBE Geometry2");
  const display = await ppro.VideoFilterFactory.getDisplayNames();
  const i = display.indexOf("Transform");
  if (i >= 0 && names[i]) return (transformMatch = names[i]);
  throw new Error("Couldn't find Premiere's Transform effect.");
}

function rotationOf(component) {
  const n = component.getParamCount();
  for (let j = 0; j < n; j++) {
    const p = component.getParam(j);
    if (p.displayName === "Rotation") return p;
  }
  return null;
}

async function isFlipRotation(param, inPoint) {
  if (param.isTimeVarying()) return true;
  return Math.abs(num(await param.getValueAtTime(inPoint)) - UPSIDE_DOWN) < 0.001;
}

// Motion > Rotation holding a REDFlipper flip (the "Motion" option, or version 1.0):
// static 180, or keyframed with only 0/180 values. With `stabilized`, any keyframed
// rotation counts too (stabilizing keys take every value).
async function isMotionFlip(param, inPoint, stabilized) {
  if (!param) return false;
  if (stabilized && param.isTimeVarying()) return true;
  if (!param.isTimeVarying()) return Math.abs(num(await param.getValueAtTime(inPoint)) - UPSIDE_DOWN) < 0.001;
  for (const time of param.getKeyframeListAsTickTimes()) {
    const v = num(await param.getValueAtTime(time));
    if (!(Math.abs(v) < 0.001 || Math.abs(v - UPSIDE_DOWN) < 0.001)) return false;
  }
  return true;
}

// A component chain's REDFlipper Transform (a Transform whose Rotation is 180° or keyframed),
// its last Transform, and Motion's rotation. Works for a timeline clip's chain and a source clip's.
async function scanChain(chain, inPoint) {
  const out = { chain, ours: null, lastTransform: null, motionRotation: null };
  if (!chain) return out;
  const tm = await getTransformMatchName();
  const n = chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const comp = chain.getComponentAtIndex(i);
    const mn = await comp.getMatchName();
    if (mn === MOTION) out.motionRotation = rotationOf(comp);
    if (mn !== tm) continue;
    const rot = rotationOf(comp);
    if (!rot) continue;
    out.lastTransform = { component: comp, rotation: rot };
    if (await isFlipRotation(rot, inPoint)) out.ours = { component: comp, rotation: rot };
  }
  return out;
}

// The source (master) clip's effects, which every instance of the clip in the project shows.
async function sourceChain(cpi) {
  try { return (await cpi.getComponentChain(ppro.Constants.MediaType.VIDEO)) || null; }
  catch (e) { return null; }
}

// One undoable step. Returns false if Premiere refused it (the reason, if any, in lastTxError).
let lastTxError = "";
function transact(project, label, makeActions) {
  let ok = false;
  lastTxError = "";
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((ca) => {
        for (const a of makeActions()) ca.addAction(a);
      }, `REDFlipper: ${label}`);
    });
  } catch (err) { ok = false; lastTxError = err && err.message ? err.message : String(err); }
  return ok;
}

// Run one undoable step for all entries; if the batch fails (e.g. a locked
// track), retry entry by entry so one bad clip doesn't block the rest.
function runPhase(project, label, entries, makeActions) {
  if (!entries.length) return [];
  if (transact(project, label, () => entries.flatMap((e) => makeActions(e)))) return [];
  return entries.filter((e) => !transact(project, label, () => makeActions(e)));
}

// ------------------------------------------------------------------ auto-save

async function makeDir(dir) {
  for (const p of [dir, asUrl(dir)]) {
    try { if ((await fs.lstat(p)).isDirectory()) return; } catch (e) { /* not there yet */ }
  }
  let err;
  for (const p of [dir, asUrl(dir)]) {
    try { await fs.mkdir(p, { recursive: true }); return; } catch (e) { err = e; }
  }
  throw err;
}

async function copyTo(src, dest) {
  for (const [a, b] of [[src, dest], [asUrl(src), asUrl(dest)]]) {
    try { await fs.copyFile(a, b); return; } catch (e) { /* next form */ }
  }
  let data = null;
  for (const a of [src, asUrl(src)]) {
    try { data = await fs.readFile(a); break; } catch (e) { /* next form */ }
  }
  if (!data) throw new Error(`can't read ${src}`);
  try { await fs.writeFile(dest, data); } catch (e) { await fs.writeFile(asUrl(dest), data); }
}

// Backups go in the "Adobe Premiere Pro Auto-Save" folder next to the project, where Premiere
// keeps its own auto-saves, named <project>-REDFlipper-YYYY-MM-DD_HH-MM-SS.prproj.
function backupLocation(projectPath) {
  const s = sep(projectPath);
  return { s, dir: projectPath.slice(0, projectPath.lastIndexOf(s)) + s + "Adobe Premiere Pro Auto-Save",
           prefix: projectPath.slice(projectPath.lastIndexOf(s) + 1).replace(/\.prproj$/i, "") + "-REDFlipper-" };
}

// Auto-Backup: saves the project (like Ctrl+S) and copies it into the backup folder. A plugin
// can't trigger Premiere's own auto-save, and only the saved file holds the project's current state.
async function autoBackup(project) {
  const p = project.path;
  if (!p) return log("Backup skipped: this project hasn't been saved yet.", "warn");
  log("Backing up current project...");
  status("Backing up current project…");
  let saved;
  try { saved = await project.save(); } catch (e) { saved = false; }
  if (saved === false) return log("Backup failed: Premiere didn't save the project. Continuing without a backup.", "warn");
  const { s, dir, prefix } = backupLocation(p);
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  const dest = `${dir}${s}${prefix}${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_` +
               `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}.prproj`;
  try {
    await makeDir(dir);
    await copyTo(p, dest);
    log("Backup saved to ", "dim", { path: dest, folder: dir });
  } catch (e) {
    log(`Project saved, but the backup copy failed (${e && e.message ? e.message : e}). Continuing.`, "warn");
  }
}

// Backup paragraph under the undo text in Advanced: folder and the newest backup's file name.
async function refreshBackupInfo() {
  let where = "(save the project first)", last = "none yet", folder = null;
  try {
    const project = await ppro.Project.getActiveProject();
    if (project && project.path) {
      const { dir, prefix } = backupLocation(project.path);
      folder = dir;
      let names = [];
      try { names = (await listDir(dir)).map((e) => (typeof e === "string" ? e : e.name)); } catch (e) { /* no folder yet */ }
      // names end in a sortable timestamp, so the last one is the newest
      const newest = names.filter((n) => n.startsWith(prefix) && /\.prproj$/i.test(n)).sort().pop();
      if (newest) last = pathLink(newest, dir);
    } else if (!project) where = "(no project open)";
  } catch (e) { /* keep defaults */ }
  const box = $("backupInfo");
  box.textContent = "";
  const line = (...parts) => {
    const d = document.createElement("div");
    for (const p of parts) if (typeof p === "string") appendColoured(d, p); else d.appendChild(p);
    box.appendChild(d);
  };
  line(`REDFlipper auto-backups your project every time “${runLabel()}” is used (unless disabled).`);
  line("Backups are located at: ", folder ? pathLink(folder) : where);
  line("Last backup: ", last);
}

// ------------------------------------------------------------------ collect + analyse

async function collect() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No project open.");
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("No active sequence.");

  let items = [];
  if (selectedOnly()) {
    const sel = await seq.getSelection();
    items = (await sel.getTrackItems()).filter((t) => t instanceof ppro.VideoClipTrackItem);
    if (!items.length) throw new Error("Nothing selected. Select clips, or switch off “Selected clips only”.");
  } else {
    const n = await seq.getVideoTrackCount();
    for (let i = 0; i < n; i++) {
      const track = await seq.getVideoTrack(i);
      items.push(...(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)));
    }
  }

  const targets = [];
  let nonRed = 0;
  for (const item of items) {
    let path = null, cpi = null;
    try {
      cpi = ppro.ClipProjectItem.cast(await item.getProjectItem());
      if (cpi) path = await cpi.getMediaFilePath();
    } catch (e) { /* adjustment layers, titles, nests */ }
    if (!path || !/\.r3d$/i.test(path)) { nonRed++; continue; }
    const inPoint = await item.getInPoint();
    targets.push({ item, cpi, path, name: await item.getName(), inPoint,
                   scan: await scanChain(await item.getComponentChain(), inPoint) });
  }
  log(`${items.length} video clip(s) in scope: ${targets.length} RED, ${nonRed} other.`, "dim");
  let seqName = "the sequence";
  try { seqName = seq.name || (seq.getName ? await seq.getName() : "") || seqName; } catch (e) { /* label only */ }
  return { project, seq, seqName, targets };
}

// Analyse every distinct source clip once (several timeline clips can share one source).
async function analyseTargets(targets, forceWalk) {
  const paths = [...new Set(targets.map((t) => t.path))];
  const method = forceWalk ? FBF : FAST;
  const t0 = Date.now();
  const results = new Map();
  let failed = 0;
  for (let i = 0; i < paths.length; i++) {
    if (stopRequested) throw new Error("Stopped. Nothing was changed.");
    const p = paths[i];
    const name = targets.find((t) => t.path === p).name;
    const cached = analysisCache.has((forceWalk ? "fbf|" : "fast|") + p);
    log(`Analyzing ${name} (${method})${cached ? ", already read this session" : ""}`);
    status(`Reading motion data ${i + 1} / ${paths.length}: ${name}`);
    progress(cached ? 1 : 0);
    try {
      results.set(p, await analyse(p, progress, forceWalk, () => log(`${FAST} failed, reverting to ${FBF} (Slow)`, "warn")));
    } catch (e) {
      if (stopRequested) throw new Error("Stopped. Nothing was changed.");
      failed++;
      results.set(p, { plan: { kind: "error", error: e && e.message ? e.message : String(e) } });   // not cached: retried next run
    }
  }
  progress(null);
  for (const t of targets) t.result = results.get(t.path);
  log(`Read motion data for ${paths.length} source clip(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
      (failed ? `, ${failed} couldn't be read` : "") + ".", "dim");
  const reported = new Set();
  for (const t of targets) {
    const k = t.result.plan.kind;
    if (reported.has(t.path) || (k !== "error" && k !== "nodata")) continue;
    reported.add(t.path);
    if (k === "error") log(`${t.name}: couldn't read the R3D, ${t.result.plan.error}. Skipped.`, "err");
    else log(`${t.name}: no motion data in this clip (older firmware?). Skipped.`, "warn");
  }
}

// ------------------------------------------------------------------ cuts at flip points

// Premiere's API has no razor, so a cut is made the way an insert edit splits a clip: insert a
// copy of the clip at the flip point (the insert cuts the clip there), then ripple-delete the
// copy. Both halves keep every effect and keyframe of the original. Two undo steps per cut.

async function seqTiming(seq) {
  let perFrame = 0n, zero = 0n;
  try { perFrame = BigInt(String(await seq.getTimebase()).trim()); } catch (e) { /* default below */ }
  try { zero = ticksOf(await seq.getZeroPoint()); } catch (e) { /* starts at 0 */ }
  if (perFrame <= 0n) perFrame = 10594584000n;   // 23.976
  const nominal = Math.round(Number(TICKS_PER_SEC) / Number(perFrame));
  return { perFrame, toTc: (ticks) => tcNominal(Number((ticks + zero) / perFrame), nominal) };
}

async function trackClips(seq, index) {
  const track = await seq.getVideoTrack(index);
  const out = [];
  for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
    out.push({ item, start: ticksOf(await item.getStartTime()), end: ticksOf(await item.getEndTime()),
               inP: ticksOf(await item.getInPoint()) });
  }
  return out;
}

function emptySelection() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("couldn't create a selection")), 5000);
    try {
      const ok = ppro.TrackItemSelection.createEmptySelection((s) => { clearTimeout(timer); resolve(s); });
      if (ok === false) { clearTimeout(timer); reject(new Error("couldn't create a selection")); }
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

// Cuts the clip covering `at` on a video track. Returns true, or { msg, stop } when it didn't
// work (stop: the timeline may be left in a half-done state, so no further cuts are tried).
async function cutAt(c, editor, trackIndex, at, tol) {
  const near = (a, b) => (a > b ? a - b : b - a) <= tol;
  const before = await trackClips(c.seq, trackIndex);
  const a = before.find((x) => x.start + tol < at && at + tol < x.end);
  if (!a) return { msg: "no clip covers that point" };
  const next = before.filter((x) => x.start + tol >= a.end).sort((x, y) => (x.start < y.start ? -1 : 1))[0];

  // 1. insert a copy of the clip at the flip point
  if (!transact(c.project, "cut at flip point", () =>
    [editor.createCloneTrackItemAction(a.item, tickTime(at - a.start), 0, 0, true, true)])) {
    return { msg: `Premiere refused the edit (locked track?)${lastTxError ? `: ${lastTxError}` : ""}` };
  }
  // 2. the copy is the clip that now starts at the cut (the rest of the original moved to after it)
  const copy = (await trackClips(c.seq, trackIndex)).find((x) => near(x.start, at));
  if (!copy) return { stop: true, msg: "the inserted copy wasn't found. Please check the timeline (Ctrl+Z undoes it)" };
  const audio = [];
  try {
    const n = await c.seq.getAudioTrackCount();
    for (let i = 0; i < n; i++) {
      const track = await c.seq.getAudioTrack(i);
      for (const ai of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        if (near(ticksOf(await ai.getStartTime()), at) && near(ticksOf(await ai.getEndTime()), copy.end)) audio.push(ai);
      }
    }
  } catch (e) { /* no audio */ }

  // 3. ripple-delete the copy. Premiere may refuse or ignore one form of the remove, so try a few
  // and check the timeline after each.
  const MT = ppro.Constants.MediaType;
  const attempts = [["video + audio", [copy.item, ...audio], MT.ANY], ["video only", [copy.item], MT.VIDEO],
                    ["video, any media", [copy.item], MT.ANY]];
  const tried = [];
  let removed = false;
  for (const [label, items, type] of attempts) {
    if (label === "video + audio" && !audio.length) continue;
    let selected = true;
    const sel = await emptySelection();
    for (const it of items) if (sel.addItem(it, false) === false) selected = false;
    const ok = transact(c.project, "cut at flip point", () => [editor.createRemoveItemsAction(sel, true, type, false)]);
    const now = await trackClips(c.seq, trackIndex);
    if (!now.some((x) => near(x.start, at) && near(x.end, copy.end))) { removed = true; break; }
    tried.push(`${label}: ${!selected ? "couldn't select it" : ok ? "ran, copy still there" : `refused${lastTxError ? ` (${lastTxError})` : ""}`}`);
  }
  if (!removed) {
    return { stop: true, msg: `Premiere didn't remove the inserted copy [${tried.join("; ")}]. ` +
                              "The clip is split with the copy in between: Ctrl+Z undoes it" };
  }
  // 4. check: the clip ends at the cut, the rest starts there, and whatever followed is back in place
  const after = await trackClips(c.seq, trackIndex);
  const left = after.some((x) => near(x.start, a.start) && near(x.end, at));
  const right = after.some((x) => near(x.start, at) && near(x.end, a.end));
  const nextOk = !next || after.some((x) => near(x.start, next.start) && near(x.inP, next.inP));
  if (!(left && right && nextOk)) {
    return { stop: true, msg: "the timeline didn't come out as expected. Please check it (Ctrl+Z undoes it)" };
  }
  return true;
}

async function addCuts(c, clips) {
  if (!clips.length) return 0;
  const editor = ppro.SequenceEditor.getEditor(c.seq);
  const { perFrame, toTc } = await seqTiming(c.seq);
  const cuts = [];
  for (const t of clips) {
    let speed = 1, reversed = false;
    try { speed = num(await t.item.getSpeed()); } catch (e) { /* assume normal speed */ }
    try { reversed = !!(await t.item.isSpeedReversed()); } catch (e) { /* assume forward */ }
    if (!(Math.abs(speed - 1) < 0.001) || reversed) {
      log(`${t.name}: clip speed is changed, so no cut was added (the keyframes still flip it).`, "warn");
      continue;
    }
    const track = await t.item.getTrackIndex();
    const start = ticksOf(await t.item.getStartTime()), inP = ticksOf(t.inPoint), outP = ticksOf(await t.item.getOutPoint());
    for (const k of t.plan.keys.slice(1)) {
      const src = frameTicks(k.frame, t.result.fpsNum, t.result.fpsDen);
      if (src <= inP || src >= outP) continue;   // flip falls outside the part of the clip that's used
      const at = ((start + (src - inP) + perFrame / 2n) / perFrame) * perFrame;   // on a sequence frame
      cuts.push({ t, track, at });
    }
  }
  // latest first on each track, so an earlier cut never moves a later one
  cuts.sort((x, y) => (x.track - y.track) || (x.at > y.at ? -1 : x.at < y.at ? 1 : 0));
  for (let i = 0; i < cuts.length; i++) {
    status(`Adding cuts ${i + 1} / ${cuts.length}…`);
    try { cuts[i].r = await cutAt(c, editor, cuts[i].track, cuts[i].at, perFrame / 2n); }
    catch (e) { cuts[i].r = { stop: true, msg: e && e.message ? e.message : String(e) }; }
    if (cuts[i].r !== true && cuts[i].r.stop) {
      for (const rest of cuts.slice(i + 1)) rest.r = { msg: "skipped because another cut failed" };
      break;
    }
  }
  // report in timeline order
  cuts.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.track - y.track));
  for (const { t, at, r } of cuts) {
    if (r === true) log(`Added cut point at ${toTc(at)}. (${t.name})`);
    else log(`${t.name}: couldn't add a cut at ${toTc(at)}: ${r.msg}.`, r.stop ? "err" : "warn");
  }
  return cuts.filter((x) => x.r === true).length;
}

// ------------------------------------------------------------------ actions

async function analyseAndFlip() {
  startRun(runLabel());
  const mode = applyMode(), stabilize = opt("optStabilize");
  const forceWalk = opt("optForceFbf"), withCuts = opt("optCuts") && mode !== "source" && !stabilize;
  if (stabilize) log("Option: Lock to Horizon (Stabilize Rotation), levels every frame.", "dim");
  if (mode === "motion") log("Option: Apply Rotation to Clip “Motion” Effect.", "dim");
  if (mode === "source") log("Option: Apply Rotation to Source Clip (all instances in the project).", "dim");
  if (withCuts) log("Option: Add Cut at each Flip Point.", "dim");
  const c = await collect();
  if (!c.targets.length) return log("Done: 0 clip(s) updated. No RED clips in scope.", "ok");
  await analyseTargets(c.targets, forceWalk);
  status("Applying rotation…");

  const project = c.project;
  const HOLD = ppro.Constants.InterpolationMode.HOLD;
  const interpOf = (t) => (t.plan.kind === "stab" ? ppro.Constants.InterpolationMode.LINEAR : HOLD);
  const tm = await getTransformMatchName();

  // one entry per source clip, holding its timeline clips in scope and its own (Source) effects
  const sources = new Map();
  for (const t of c.targets) {
    t.plan = stabilize ? stabPlan(t.result) : t.result.plan;
    if (!sources.has(t.path)) {
      if (stabilize) gyroNote(t.name, t.plan.gyro);
      sources.set(t.path, { name: t.name, cpi: t.cpi, inPoint: t.inPoint, result: t.result, plan: t.plan, targets: [],
                            scan: await scanChain(await sourceChain(t.cpi), t.inPoint) });
    }
    sources.get(t.path).targets.push(t);
  }

  // Decide what gets the rotation ("units": timeline clips, or source clips in Source mode), and
  // which REDFlipper rotation has to go first: anything on an upright clip, and anything that
  // would flip a clip twice once the new rotation is in place.
  const units = [], stripTransform = [], resetMotion = [], stripSource = [], cleaned = new Set();
  for (const s of sources.values()) {
    const kind = s.plan.kind;
    const rotates = kind === "inverted" || kind === "mixed" || kind === "stab";
    if (kind === "upright" || (mode === "source" && rotates)) {
      if (kind === "upright" && s.scan.ours) { stripSource.push(s); s.targets.forEach((t) => cleaned.add(t)); }
      for (const t of s.targets) {
        if (t.scan.ours) { stripTransform.push(t); if (kind === "upright") cleaned.add(t); }
        if (await isMotionFlip(t.scan.motionRotation, t.inPoint)) { resetMotion.push(t); if (kind === "upright") cleaned.add(t); }
      }
      if (kind !== "upright") units.push(s);
    } else if (rotates) {
      if (s.scan.ours) {
        log(`${s.name}: already flipped by a Source Transform (all instances). Skipped. ` +
            "Use “Undo” with “Apply Rotation to Source Clip” checked first to flip its timeline clips instead.", "warn");
        continue;
      }
      for (const t of s.targets) {
        units.push(t);
        if (mode === "transform" && await isMotionFlip(t.scan.motionRotation, t.inPoint)) resetMotion.push(t);
        if (mode === "motion" && t.scan.ours) stripTransform.push(t);
      }
    }
  }
  if (!units.length && !cleaned.size) {
    return log("Done: 0 clip(s) updated. All RED clips in scope are upright or skipped. Nothing to change.", "ok");
  }
  const nInv = units.filter((u) => u.plan.kind === "inverted").length;
  const what = mode === "source" ? "source clip(s)" : "clip(s)";
  if (stabilize) {
    const nKeys = units.reduce((a, u) => a + u.plan.keys.length, 0);
    log(`Applying: stabilization to ${units.length} ${what} (${nKeys} rotation keyframes) …`);
  } else {
    log(`Applying: ${nInv} whole-clip flip(s), ${units.length - nInv} mid-take flip ${what}` +
        (cleaned.size ? `, ${cleaned.size} upright clip(s) cleaned up` : "") + " …");
  }

  // a quick analysis waits for the logo to finish turning before anything in Premiere changes
  const wait = logoAnimEnd - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (opt("optAutoSave")) await autoBackup(project);
  status("Applying rotation…");

  const bad = new Set();
  const note = (list, what) => list.forEach((t) => { bad.add(t); log(`${t.name}: failed to ${what}`, "err"); });

  // 1. clean up
  note(runPhase(project, "remove Transform", stripTransform,
    (t) => [t.scan.chain.createRemoveComponentAction(t.scan.ours.component)]), "remove the old REDFlipper Transform");
  note(runPhase(project, "remove Source Transform", stripSource,
    (s) => [s.scan.chain.createRemoveComponentAction(s.scan.ours.component)]), "remove the Source Transform");
  const rm1 = runPhase(project, "reset Motion rotation", resetMotion, (t) => [t.scan.motionRotation.createSetTimeVaryingAction(false)]);
  const rm2 = runPhase(project, "reset Motion rotation", resetMotion.filter((t) => !rm1.includes(t)),
    (t) => [t.scan.motionRotation.createSetValueAction(t.scan.motionRotation.createKeyframe(0), true)]);
  [...rm1, ...rm2].forEach((t) => log(`${t.name}: couldn't reset Motion rotation, please check it`, "warn"));

  // 2. find the Rotation to set: Motion's, or REDFlipper's Transform (added where there isn't one)
  if (mode === "motion") {
    for (const u of units) {
      if (u.scan.motionRotation) u.rotation = u.scan.motionRotation;
      else note([u], "find the Motion effect's Rotation");
    }
  } else {
    const needs = units.filter((u) => !u.scan.ours);
    for (const u of needs) u.newTransform = await ppro.VideoFilterFactory.createComponent(tm);
    note(runPhase(project, mode === "source" ? "add Source Transform" : "add Transform", needs,
      (u) => [u.scan.chain.createAppendComponentAction(u.newTransform)]),
      mode === "source" ? "add the Source Transform effect" : "add Transform effect (locked track?)");
    for (const u of units) {
      if (bad.has(u)) continue;
      if (u.scan.ours) { u.rotation = u.scan.ours.rotation; continue; }
      const chain = mode === "source" ? await sourceChain(u.cpi) : await u.item.getComponentChain();
      const rescan = await scanChain(chain, u.inPoint);
      if (rescan.lastTransform) u.rotation = rescan.lastTransform.rotation;
      else note([u], "find the new Transform effect");
    }
  }
  const ready = units.filter((u) => !bad.has(u));
  const inverted = ready.filter((u) => u.plan.kind === "inverted");
  const anim = ready.filter((u) => u.plan.kind === "mixed" || u.plan.kind === "stab");

  // 3. clear previous rotation animation; whole-clip flips get a static 180°
  note(runPhase(project, "clear rotation", ready,
    (t) => [t.rotation.createSetTimeVaryingAction(false)]), "clear old rotation");
  note(runPhase(project, "set rotation", inverted.filter((t) => !bad.has(t)),
    (t) => [t.rotation.createSetValueAction(t.rotation.createKeyframe(UPSIDE_DOWN), true)]), "set rotation");

  // 4. mid-take flips get Hold keyframes
  note(runPhase(project, "enable rotation keyframes", anim.filter((t) => !bad.has(t)),
    (t) => [t.rotation.createSetTimeVaryingAction(true)]), "enable keyframes");

  for (const t of anim) {
    if (bad.has(t)) continue;
    t.kfs = [];
    for (const k of t.plan.keys) {
      const kf = t.rotation.createKeyframe(k.value);
      kf.position = tickTimeAt(k.frame, t.result.fpsNum, t.result.fpsDen);
      try { await kf.setTemporalInterpolationMode(interpOf(t)); } catch (e) { /* set again below */ }
      t.kfs.push(kf);
    }
  }
  note(runPhase(project, "add rotation keyframes", anim.filter((t) => !bad.has(t)),
    (t) => t.kfs.map((kf) => t.rotation.createAddKeyframeAction(kf))), "add keyframes");

  // 5. Hold interpolation (linear when stabilizing); remove any stray key Premiere added when
  // keyframing was switched on. A key is ours if it is the nearest to a planned time (within half a
  // frame). Strays are only removed when every planned key was found, so an unexpected time base
  // never wipes our keys. Both lists are walked in time order (stabilizing can mean thousands of keys).
  note(runPhase(project, "set keyframe interpolation", anim.filter((t) => !bad.has(t)), (t) => {
    const halfFrame = Number(TICKS_PER_SEC) * t.result.fpsDen / t.result.fpsNum / 2;
    const planned = t.plan.keys.map((k) => tickTimeAt(k.frame, t.result.fpsNum, t.result.fpsDen).ticksNumber);
    const existing = t.rotation.getKeyframeListAsTickTimes()
      .map((time) => ({ time, at: Number(time.ticksNumber) })).sort((x, y) => x.at - y.at);
    let allFound = true, j = 0;
    for (const p of planned) {
      while (j < existing.length && existing[j].at < p - halfFrame) j++;
      // nearest of the candidates within half a frame
      let best = -1;
      for (let k = j; k < existing.length && existing[k].at <= p + halfFrame; k++) {
        if (best < 0 || Math.abs(existing[k].at - p) < Math.abs(existing[best].at - p)) best = k;
      }
      if (best < 0) allFound = false;
      else { existing[best].ours = true; j = best + 1; }
    }
    const mode = interpOf(t), acts = [];
    for (const e of existing) {
      if (e.ours) acts.push(t.rotation.createSetInterpolationAtKeyframeAction(e.time, mode, false));
      else if (allFound) acts.push(t.rotation.createRemoveKeyframeAction(e.time, false));
    }
    if (!allFound) log(`${t.name}: keyframes didn't land where expected, please check this clip`, "warn");
    return acts;
  }), "set keyframe interpolation");

  // 6. keyframe test on the first mid-take clip (stabilizing: values at a few keys, and halfway between two)
  const check = anim.find((t) => !bad.has(t) && t.plan.keys.length > 1);
  if (check && check.plan.kind === "stab") {
    const fr = [check.result.fpsNum, check.result.fpsDen], ks = check.plan.keys;
    const probes = [0, Math.floor(ks.length / 3), Math.floor(2 * ks.length / 3), ks.length - 1].map((i) => ks[i]);
    let worst = 0;
    for (const k of probes) worst = Math.max(worst, Math.abs(num(await check.rotation.getValueAtTime(tickTimeAt(k.frame, ...fr))) - k.value));
    const keys = check.rotation.getKeyframeListAsTickTimes().length;
    if (worst < 0.01 && keys === ks.length) {
      log(`✓ Keyframe test PASSED. (Tested on ${check.name}: ${keys} stabilizing keyframes in place.)`, "ok");
    } else {
      log(`⚠ Keyframe test FAILED. (Tested on ${check.name}: expected ${ks.length} keyframes, got ${keys}; ` +
          `largest value error ${isNaN(worst) ? "unknown" : worst.toFixed(2) + "°"}.)`, "warn");
    }
  } else if (check) {
    const k0 = check.plan.keys[0], k1 = check.plan.keys[1];
    const fr = [check.result.fpsNum, check.result.fpsDen];
    const before = await check.rotation.getValueAtTime(tickTimeAt(Math.max(k0.frame, k1.frame - 1), ...fr));
    const at = await check.rotation.getValueAtTime(tickTimeAt(k1.frame, ...fr));
    const keys = check.rotation.getKeyframeListAsTickTimes().length;
    if (Math.abs(num(before) - k0.value) < 0.01 && Math.abs(num(at) - k1.value) < 0.01 && keys === check.plan.keys.length) {
      log(`✓ Keyframe test PASSED. ` +
          `(Tested on ${check.name}: stays ${k0.value}° until the flip at ${k1.tc}, then ${k1.value}°.)`, "ok");
    } else {
      log(`⚠ Keyframe test FAILED. ` +
          `(Tested on ${check.name}: expected ${k0.value}° → ${k1.value}° at ${k1.tc} ` +
          `with ${check.plan.keys.length} keyframes; got ${num(before).toFixed(1)}° → ${num(at).toFixed(1)}° with ${keys}.)` +
          (isNaN(num(before)) ? ` (raw value: ${describe(before)})` : ""), "warn");
    }
  }

  // 7. cuts at the flip points (after the rotation, so both halves carry it)
  const cutCount = withCuts ? await addCuts(c, anim.filter((t) => !bad.has(t))) : 0;

  // count timeline clips: a source clip stands for its timeline clips in scope
  const updated = new Set(cleaned);
  for (const u of ready) if (!bad.has(u)) (u.targets || [u]).forEach((t) => updated.add(t));
  const scope = selectedOnly() ? "Selected Clip(s)" : `All Clips in ${c.seqName}`;
  const how = { transform: "as Transform Effects with keyframes", motion: "in Clips' Motion Effects with keyframes",
                source: "as Source Transform Effects with keyframes" }[mode];
  log(`Done: ${updated.size} clip(s) updated. Applied to ${scope} ${how}` +
      (cutCount ? `, with ${cutCount} cut(s) at flip points` : "") +
      (bad.size ? ` (${bad.size} clip(s) failed, see above)` : "") +
      `. To undo, use “Undo”.`, bad.size ? "warn" : "ok");
}

// Undo (Remove Rotation) only undoes what the current options apply (see undoText): REDFlipper's
// Transform by default, Motion > Rotation with the Motion option, the Source Transform with the
// Source option. Cuts are never rejoined (the API has no way to).
async function removeRotation() {
  startRun("Undo");
  const mode = applyMode();
  const c = await collect();
  if (!c.targets.length) return log("Done: 0 clip(s) updated. No RED clips in scope.", "ok");
  const updated = new Set();
  let failed = [], found = 0, summary = "";

  if (mode === "transform") {
    const withTransform = c.targets.filter((t) => t.scan.ours);
    failed = runPhase(c.project, "remove Transform", withTransform,
      (t) => [t.scan.chain.createRemoveComponentAction(t.scan.ours.component)]);
    withTransform.filter((t) => !failed.includes(t)).forEach((t) => updated.add(t));
    found = withTransform.length;
    summary = `Removed the REDFlipper Transform from ${updated.size} clip(s).`;
  } else if (mode === "motion") {
    // Motion > Rotation holding a flip: static 180, or keyframed with only 0/180 values
    const motion = [];
    for (const t of c.targets) if (await isMotionFlip(t.scan.motionRotation, t.inPoint, opt("optStabilize"))) motion.push(t);
    const f1 = runPhase(c.project, "reset Motion rotation", motion, (t) => [t.scan.motionRotation.createSetTimeVaryingAction(false)]);
    const f2 = runPhase(c.project, "reset Motion rotation", motion.filter((t) => !f1.includes(t)),
      (t) => [t.scan.motionRotation.createSetValueAction(t.scan.motionRotation.createKeyframe(0), true)]);
    failed = [...f1, ...f2];
    motion.filter((t) => !failed.includes(t)).forEach((t) => updated.add(t));
    found = motion.length;
    summary = `Reset Motion rotation to 0° on ${updated.size} clip(s).`;
  } else {
    // removing a Source Transform affects every instance of that clip in the project
    const sources = new Map();
    for (const t of c.targets) {
      if (sources.has(t.path)) { sources.get(t.path).targets.push(t); continue; }
      sources.set(t.path, { name: t.name, targets: [t], scan: await scanChain(await sourceChain(t.cpi), t.inPoint) });
    }
    const withSource = [...sources.values()].filter((s) => s.scan.ours);
    failed = runPhase(c.project, "remove Source Transform", withSource,
      (s) => [s.scan.chain.createRemoveComponentAction(s.scan.ours.component)]);
    withSource.filter((s) => !failed.includes(s)).forEach((s) => s.targets.forEach((t) => updated.add(t)));
    found = withSource.length;
    summary = `Removed the Source Transform from ${withSource.length - failed.length} source clip(s) (all instances).`;
  }

  failed.forEach((t) => log(`${t.name}: failed (locked track?)`, "err"));
  const what = { transform: "REDFlipper Transform", motion: "REDFlipper Motion rotation", source: "Source Transform" }[mode];
  if (!found) log(`Done: 0 clip(s) updated. No ${what} found on RED clips in scope.`, "ok");
  else log(`Done: ${updated.size} clip(s) updated. ${summary}`, failed.length ? "warn" : "ok");
  if (opt("optCuts") && mode !== "source" && !opt("optStabilize")) {
    log("Cuts added at flip points stay in place: use Ctrl+Z, or right-click a cut > Join Through Edits.", "dim");
    log("Ctrl + Left-click drag to select multiple cut points.", "dim");
  }
}

// ------------------------------------------------------------------ wire up

(async () => {
  try {
    const m = JSON.parse(await fs.readFile("plugin:/manifest.json", { encoding: "utf-8" }));
    if (m && m.version) $("version").textContent = `v${m.version}`;
  } catch (e) { /* version label is optional */ }
})();

loadOptions();
$("log").addEventListener("scroll", () => {
  const box = $("log");
  logSticky = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
});
initLogo();
$("flip").addEventListener("click", () => { if (!busy) animateLogo(opt("optStabilize")); return guarded(analyseAndFlip); });
$("remove").addEventListener("click", () => guarded(removeRotation));
$("stop").addEventListener("click", () => { stopRequested = true; status("Stopping…"); });
$("scopeSwitch").addEventListener("click", () => { if (!busy) setSelectedOnly(!selectedOnly()); });
for (const id of OPTIONS) {
  $(id).addEventListener("click", () => { if (!busy && !$(id).classList.contains("overridden")) setOpt(id, !opt(id)); });
}
$("advancedToggle").addEventListener("click", () => {
  const open = $("advanced").classList.contains("hidden");
  if (open) $("advanced").classList.remove("hidden"); else $("advanced").classList.add("hidden");
  $("advancedToggle").textContent = open ? "Advanced ▾" : "Advanced ▸";
  if (open) refreshBackupInfo();
});
