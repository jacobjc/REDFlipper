// REDFlipper — finds upside-down sections of RED clips from the camera's own
// accelerometer data (read straight from the .R3D files) and corrects them with a
// Transform effect: Rotation 180°, keyframed with Hold where the camera flips mid-take.
// Motion > Rotation is left free for the editor. Nothing is written to disk.
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

let busy = false;
let stopRequested = false;
let transformMatch = null;
const analysisCache = new Map();  // media path -> result, for this Premiere session only

// ------------------------------------------------------------------ ui helpers

const $ = (id) => document.getElementById(id);

function log(msg, cls) {
  const d = document.createElement("div");
  d.textContent = msg;
  if (cls) d.className = cls;
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
}

function clearLog() { $("log").innerHTML = ""; }
function status(msg) { $("status").textContent = msg || ""; }

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
  for (const id of ["flip", "preview", "remove"]) $(id).disabled = true;
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
    for (const id of ["flip", "preview", "remove"]) $(id).disabled = false;
    $("stop").disabled = true;
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
    if (!bin) { bin = [0, 0, 0, 0]; bins.set(k, bin); }
    bin[0] += b.view.getInt16(o + 8) / 1000;
    bin[1] += b.view.getInt16(o + 10) / 1000;
    bin[2] += b.view.getInt16(o + 12) / 1000;
    bin[3]++;
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
async function readClip(firstChunkPath, onProgress) {
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
  let meta = {}, frame0 = null, frames = 0, walked = 0;

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
      let n = await readChunkIndexed(fd, await fileSize(path), bins);   // adds samples only if the index checks out
      if (n === null) { n = await readChunkWalk(fd, bins); walked++; }
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
    .map(([k, v]) => [k * BIN_US, v[0] / v[3], v[1] / v[3], v[2] / v[3]]);
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

function tc(frame, fpsNum, fpsDen) {
  const nominal = Math.round(fpsNum / fpsDen);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(Math.floor(frame / (nominal * 3600)))}:${p(Math.floor(frame / (nominal * 60)) % 60)}:` +
         `${p(Math.floor(frame / nominal) % 60)}:${p(frame % nominal)}`;
}

async function analyse(path, onProgress) {
  if (analysisCache.has(path)) return analysisCache.get(path);
  const clip = await readClip(path, onProgress);
  const segs = classify(clip);
  let plan;
  if (!segs) plan = { kind: "nodata" };
  else if (!segs.some((x) => x[0] === "INV")) plan = { kind: "upright" };
  else if (!segs.some((x) => x[0] === "UP")) plan = { kind: "inverted" };
  else plan = {
    kind: "mixed",
    keys: segs.map(([state, start]) => ({ frame: start, value: state === "INV" ? UPSIDE_DOWN : 0, tc: tc(start, clip.fpsNum, clip.fpsDen) })),
  };
  const result = { plan, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen, walked: clip.walked };
  analysisCache.set(path, result);
  return result;
}

// ------------------------------------------------------------------ Premiere helpers

function tickTimeAt(frame, num, den) {
  const ticks = (BigInt(frame) * TICKS_PER_SEC * BigInt(den)) / BigInt(num);
  return ppro.TickTime.createWithTicks(ticks.toString());
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

// Motion > Rotation set by version 1.0: static 180, or keyframed with only 0/180 values.
async function isLegacyMotionFlip(param, inPoint) {
  if (!param) return false;
  if (!param.isTimeVarying()) return Math.abs(num(await param.getValueAtTime(inPoint)) - UPSIDE_DOWN) < 0.001;
  for (const time of param.getKeyframeListAsTickTimes()) {
    const v = num(await param.getValueAtTime(time));
    if (!(Math.abs(v) < 0.001 || Math.abs(v - UPSIDE_DOWN) < 0.001)) return false;
  }
  return true;
}

// A clip's effects: REDFlipper's Transform (a Transform whose Rotation is 180° or keyframed),
// the last Transform, and Motion's rotation.
async function scanChain(item, inPoint) {
  const tm = await getTransformMatchName();
  const chain = await item.getComponentChain();
  const out = { chain, ours: null, lastTransform: null, motionRotation: null };
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

// Run one undoable step for all entries; if the batch fails (e.g. a locked
// track), retry entry by entry so one bad clip doesn't block the rest.
function runPhase(project, label, entries, makeActions) {
  if (!entries.length) return [];
  const failed = [];
  let ok = false;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((ca) => {
        for (const e of entries) for (const a of makeActions(e)) ca.addAction(a);
      }, `REDFlipper: ${label}`);
    });
  } catch (err) { ok = false; }
  if (ok) return failed;
  for (const e of entries) {
    let one = false;
    try {
      project.lockedAccess(() => {
        one = project.executeTransaction((ca) => {
          for (const a of makeActions(e)) ca.addAction(a);
        }, `REDFlipper: ${label}`);
      });
    } catch (err) { one = false; }
    if (!one) failed.push(e);
  }
  return failed;
}

// ------------------------------------------------------------------ collect + analyse

async function collect() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No project open.");
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("No active sequence.");

  let items = [];
  if ($("selectedOnly").checked) {
    const sel = await seq.getSelection();
    items = (await sel.getTrackItems()).filter((t) => t instanceof ppro.VideoClipTrackItem);
    if (!items.length) throw new Error("Nothing selected. Select clips, or untick “Selected clips only”.");
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
    let path = null;
    try {
      const cpi = ppro.ClipProjectItem.cast(await item.getProjectItem());
      if (cpi) path = await cpi.getMediaFilePath();
    } catch (e) { /* adjustment layers, titles, nests */ }
    if (!path || !/\.r3d$/i.test(path)) { nonRed++; continue; }
    const inPoint = await item.getInPoint();
    targets.push({ item, path, name: await item.getName(), inPoint, scan: await scanChain(item, inPoint) });
  }
  log(`${items.length} video clip(s) in scope: ${targets.length} RED, ${nonRed} other.`, "dim");
  return { project, seq, targets };
}

// Analyse every distinct source clip once (several timeline clips can share one source).
async function analyseTargets(targets) {
  const paths = [...new Set(targets.map((t) => t.path))];
  const t0 = Date.now();
  const results = new Map();
  let failed = 0;
  for (let i = 0; i < paths.length; i++) {
    if (stopRequested) throw new Error("Stopped. Nothing was changed.");
    const p = paths[i];
    const shortName = p.split(/[\\/]/).pop().replace(/_\d{3}\.r3d$/i, "");
    status(`Reading motion data ${i + 1} / ${paths.length}: ${shortName}${analysisCache.has(p) ? " (already read)" : ""}`);
    progress(analysisCache.has(p) ? 1 : 0);
    try { results.set(p, await analyse(p, progress)); }
    catch (e) {
      if (stopRequested) throw new Error("Stopped. Nothing was changed.");
      failed++;
      results.set(p, { plan: { kind: "error", error: e && e.message ? e.message : String(e) } });   // not cached: retried next run
    }
  }
  progress(null);
  for (const t of targets) t.result = results.get(t.path);
  const walked = [...results.values()].reduce((a, r) => a + (r.walked || 0), 0);
  log(`Read motion data for ${paths.length} source clip(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
      (failed ? `, ${failed} couldn't be read` : "") +
      (walked ? ` (${walked} file chunk(s) had no index and were scanned frame by frame, which is slower)` : "") + ".", "dim");
  const reported = new Set();
  for (const t of targets) {
    const k = t.result.plan.kind;
    if (reported.has(t.path) || (k !== "error" && k !== "nodata")) continue;
    reported.add(t.path);
    if (k === "error") log(`${t.name}: couldn't read the R3D, ${t.result.plan.error}. Skipped.`, "err");
    else log(`${t.name}: no motion data in this clip (older firmware?). Skipped.`, "warn");
  }
}

// ------------------------------------------------------------------ actions

async function preview() {
  clearLog();
  const c = await collect();
  if (!c.targets.length) return log("No RED clips in scope.", "ok");
  await analyseTargets(c.targets);
  let n = 0;
  for (const t of c.targets) {
    const plan = t.result.plan;
    if (plan.kind === "upright") {
      if (t.scan.ours) { n++; log(`${t.name}: upright, remove REDFlipper Transform`); }
      continue;
    }
    if (plan.kind !== "inverted" && plan.kind !== "mixed") continue;
    n++;
    const how = t.scan.ours ? "update Transform" : "add Transform";
    if (plan.kind === "inverted") log(`${t.name}: ${how}, rotate 180° (whole clip)`);
    else log(`${t.name}: ${how}, ${plan.keys.map((k) => `${k.tc} → ${k.value}°`).join(",  ")}`);
  }
  log(n ? `${n} clip(s) would change. Nothing has been modified.` : "All RED clips in scope are upright. Nothing to change.", "ok");
}

async function analyseAndFlip() {
  clearLog();
  const c = await collect();
  if (!c.targets.length) return log("No RED clips in scope.", "ok");
  await analyseTargets(c.targets);
  status("Applying rotation…");

  const project = c.project;
  const HOLD = ppro.Constants.InterpolationMode.HOLD;
  const tm = await getTransformMatchName();

  const flips = [], strip = [];
  for (const t of c.targets) {
    t.plan = t.result.plan;
    if (t.plan.kind === "upright") { if (t.scan.ours) strip.push(t); }
    else if (t.plan.kind === "inverted" || t.plan.kind === "mixed") flips.push(t);
  }
  if (!flips.length && !strip.length) return log("All RED clips in scope are upright. Nothing to change.", "ok");
  const nInv = flips.filter((t) => t.plan.kind === "inverted").length;
  log(`Applying: ${nInv} whole-clip flip(s), ${flips.length - nInv} mid-take flip clip(s)` +
      (strip.length ? `, ${strip.length} upright clip(s) cleaned up` : "") + " …");

  const bad = new Set();
  const note = (list, what) => list.forEach((t) => { bad.add(t); log(`${t.name}: failed to ${what}`, "err"); });

  // 1. add a Transform where the clip doesn't have ours yet; remove ours from upright clips
  const needs = flips.filter((t) => !t.scan.ours);
  for (const t of needs) t.newTransform = await ppro.VideoFilterFactory.createComponent(tm);
  note(runPhase(project, "add Transform", needs,
    (t) => [t.scan.chain.createAppendComponentAction(t.newTransform)]), "add Transform effect (locked track?)");
  note(runPhase(project, "remove Transform from upright clips", strip,
    (t) => [t.scan.chain.createRemoveComponentAction(t.scan.ours.component)]), "remove Transform");

  for (const t of flips) {
    if (bad.has(t)) continue;
    if (t.scan.ours) { t.rotation = t.scan.ours.rotation; continue; }
    const rescan = await scanChain(t.item, t.inPoint);
    if (rescan.lastTransform) t.rotation = rescan.lastTransform.rotation;
    else note([t], "find the new Transform effect");
  }
  const ready = flips.filter((t) => !bad.has(t));
  const inverted = ready.filter((t) => t.plan.kind === "inverted");
  const anim = ready.filter((t) => t.plan.kind === "mixed");

  // 1b. clear Motion > Rotation flips left by version 1.0 (otherwise the clip would be flipped twice)
  const legacy = [];
  for (const t of ready) if (await isLegacyMotionFlip(t.scan.motionRotation, t.inPoint)) legacy.push(t);
  if (legacy.length) {
    const lf1 = runPhase(project, "reset Motion rotation", legacy, (t) => [t.scan.motionRotation.createSetTimeVaryingAction(false)]);
    const lf2 = runPhase(project, "reset Motion rotation", legacy.filter((t) => !lf1.includes(t)),
      (t) => [t.scan.motionRotation.createSetValueAction(t.scan.motionRotation.createKeyframe(0), true)]);
    [...lf1, ...lf2].forEach((t) => log(`${t.name}: couldn't reset the old Motion rotation, please check it`, "warn"));
  }

  // 2. clear previous rotation animation; whole-clip flips get a static 180°
  note(runPhase(project, "clear rotation", ready,
    (t) => [t.rotation.createSetTimeVaryingAction(false)]), "clear old rotation");
  note(runPhase(project, "set rotation", inverted.filter((t) => !bad.has(t)),
    (t) => [t.rotation.createSetValueAction(t.rotation.createKeyframe(UPSIDE_DOWN), true)]), "set rotation");

  // 3. mid-take flips get Hold keyframes
  note(runPhase(project, "enable rotation keyframes", anim.filter((t) => !bad.has(t)),
    (t) => [t.rotation.createSetTimeVaryingAction(true)]), "enable keyframes");

  for (const t of anim) {
    if (bad.has(t)) continue;
    t.kfs = [];
    for (const k of t.plan.keys) {
      const kf = t.rotation.createKeyframe(k.value);
      kf.position = tickTimeAt(k.frame, t.result.fpsNum, t.result.fpsDen);
      try { await kf.setTemporalInterpolationMode(HOLD); } catch (e) { /* set again below */ }
      t.kfs.push(kf);
    }
  }
  note(runPhase(project, "add rotation keyframes", anim.filter((t) => !bad.has(t)),
    (t) => t.kfs.map((kf) => t.rotation.createAddKeyframeAction(kf))), "add keyframes");

  // 4. Hold interpolation; remove any stray key Premiere added when keyframing was switched on.
  // A key is ours if it is the nearest to a planned time (within half a frame). Strays are only
  // removed when every planned key was found, so an unexpected time base never wipes our keys.
  note(runPhase(project, "hold keyframes", anim.filter((t) => !bad.has(t)), (t) => {
    const halfFrame = Number(TICKS_PER_SEC) * t.result.fpsDen / t.result.fpsNum / 2;
    const plannedTicks = t.plan.keys.map((k) => tickTimeAt(k.frame, t.result.fpsNum, t.result.fpsDen).ticksNumber);
    const existing = t.rotation.getKeyframeListAsTickTimes();
    const ours = new Set();
    let allFound = true;
    for (const p of plannedTicks) {
      let best = -1, bestD = Infinity;
      existing.forEach((time, i) => {
        const d = Math.abs(time.ticksNumber - p);
        if (d <= halfFrame && d < bestD && !ours.has(i)) { best = i; bestD = d; }
      });
      if (best < 0) allFound = false; else ours.add(best);
    }
    const acts = [];
    existing.forEach((time, i) => {
      if (ours.has(i)) acts.push(t.rotation.createSetInterpolationAtKeyframeAction(time, HOLD, false));
      else if (allFound) acts.push(t.rotation.createRemoveKeyframeAction(time, false));
    });
    if (!allFound) log(`${t.name}: keyframes didn't land where expected, please check this clip`, "warn");
    return acts;
  }), "set hold interpolation");

  // 5. keyframe test on the first mid-take clip
  const check = anim.find((t) => !bad.has(t) && t.plan.keys.length > 1);
  if (check) {
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

  const done = flips.length + strip.length - bad.size;
  log(`Done: ${done} clip(s) updated${bad.size ? `, ${bad.size} failed` : ""}. ` +
      `Undo is a few Ctrl+Z steps, or use “Remove rotation”.`, bad.size ? "warn" : "ok");
}

async function removeRotation() {
  clearLog();
  const c = await collect();

  const withTransform = c.targets.filter((t) => t.scan.ours);
  const f1 = runPhase(c.project, "remove Transform", withTransform,
    (t) => [t.scan.chain.createRemoveComponentAction(t.scan.ours.component)]);

  // Motion > Rotation left at 180° / keyframed by version 1.0 of this panel
  const legacy = [];
  for (const t of c.targets) if (await isLegacyMotionFlip(t.scan.motionRotation, t.inPoint)) legacy.push(t);
  const f2 = runPhase(c.project, "reset Motion rotation", legacy, (t) => [t.scan.motionRotation.createSetTimeVaryingAction(false)]);
  const f3 = runPhase(c.project, "reset Motion rotation", legacy.filter((t) => !f2.includes(t)),
    (t) => [t.scan.motionRotation.createSetValueAction(t.scan.motionRotation.createKeyframe(0), true)]);

  [...f1, ...f2, ...f3].forEach((t) => log(`${t.name}: failed (locked track?)`, "err"));
  if (!withTransform.length && !legacy.length) return log("No REDFlipper rotation found on RED clips in scope.", "ok");
  log(`Removed the REDFlipper Transform from ${withTransform.length - f1.length} clip(s)` +
      (legacy.length ? `; reset Motion rotation (from the earlier version) on ${legacy.length - f2.length - f3.length}` : "") + ".", "ok");
}

// ------------------------------------------------------------------ wire up

(async () => {
  try {
    const m = JSON.parse(await fs.readFile("plugin:/manifest.json", { encoding: "utf-8" }));
    if (m && m.version) $("version").textContent = `v${m.version}`;
  } catch (e) { /* version label is optional */ }
})();

$("flip").addEventListener("click", () => guarded(analyseAndFlip));
$("preview").addEventListener("click", () => guarded(preview));
$("remove").addEventListener("click", () => guarded(removeRotation));
$("stop").addEventListener("click", () => { stopRequested = true; status("Stopping…"); });
