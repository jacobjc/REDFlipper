REDFlipper - Premiere Pro panel
===============================

INSTALL / UPDATE
- Open Creative Cloud first (it must be running for the install to work).
- Download REDFlipper-v<version>.ccx from the latest release:
  https://github.com/jacobjc/REDFlipper/releases/latest
  Double-click it and Creative Cloud installs the plugin
  (close Premiere first when updating).
- Then in Premiere: Window > UXP Plugins > REDFlipper.

USE
- Select clips, or switch off "Selected clips only" to work on every clip in the
  active sequence.
- Analyze & Flip: reads each RED clip's motion data straight from its .R3D files,
  works out which sections are upside-down, and corrects them.
- Undo: removes REDFlipper's correction from the clips in scope. It only undoes
  what the current Advanced options apply (the bottom of the Advanced section explains it):
  the added Transform by default, Motion > Rotation with "Default Motion effect", the Source
  Transform with "Source Clip effect".
- Stop: works at any point. Before the first change to your clips (reading motion data,
  the backup) nothing is changed. While applying, the clips already finished keep their
  rotation and the rest get none (nothing is left half-keyframed); run again to finish
  them, or use Undo. While adding cuts, the remaining cuts are skipped.
- The log keeps every line from earlier runs; scroll up to read them.
  "Fast Analysis" (blue) reads only the motion blocks listed in each R3D chunk's index.
  If a chunk has no usable index it falls back to "Frame-by-Frame Analysis" (yellow),
  which walks every block and is much slower.

ADVANCED OPTIONS (remembered between sessions)
- Force Frame-by-Frame Analysis: always use the slow method. It reads the same motion data,
  so it doesn't improve quality; it only helps if a file's index is damaged (Fast
  Analysis already falls back on its own then).
- Apply Rotation to (dropdown):
  - Added Transform effect (default): adds a Transform effect to each timeline clip.
  - Default Motion effect: puts the rotation in Motion > Rotation instead. Existing Motion
    rotation keyframes are replaced.
  - Source Clip effect: puts the Transform on the source (master) clip, so every instance of
    that clip in the project is flipped.
- Add Cut at each Flip Point: cuts the timeline clip where the camera flips (not with
  Source Clip effect). Premiere's plugin API has no razor, so the cut is made by inserting a
  copy of the clip at the flip point (which splits it) and ripple-deleting the copy; both
  halves keep all effects. Undo does not rejoin cuts: use Ctrl+Z (Cmd+Z on macOS), or right-click
  the cut > Join Through Edits (Ctrl/Cmd + Left-click drag to select multiple cut points).
  Greyed out (off) with Source Clip effect or while Stabilize is on.
- Lock to Horizon (Stabilize Rotation): the main button becomes "Analyze & Stabilize". Instead of only flipping, levels the horizon on every frame.
  The camera's roll angle comes from its motion sensor: gravity (the accelerometer) says
  where level is, and the gyro follows fast turns, so whip pans and jolts don't knock the
  horizon off. The log says per clip whether the gyro was used.
  Upside-down sections come out at 180 and small tilts are corrected too. One keyframe on every frame of the part of the clip used in
  the sequence, plus 1 second either side (extend a trim further and run it again to stabilize the new
  part; with Source Clip effect the whole clip is keyed). Goes to the Transform, Motion or Source Clip
  like a flip. Disables cuts.
  Settings under it (while it's ticked):
  - Stabilizing Method: Gyroscope & Accelerometer (default) or Accelerometer Only.
  - Framing: Scale to Fill Frame (default) zooms each clip just enough to hide the corners the
    rotation shows: one constant zoom per clip (no keyframes), the smallest that shows no edges
    on any frame of the part used in the sequence (a clip that flips needs about 204% on 16:9), in the
    same place as the rotation (Transform, Motion or Source Clip). In Motion it scales the clip's
    own Scale, and Undo puts it back. No Change leaves the scale alone.
- Auto-Backup Project (recommended, on by default): every time Analyze & Flip (or Analyze & Stabilize) is used, saves the
  project (like Ctrl+S / Cmd+S), then puts a timestamped copy (<project>-REDFlipper-<date>_<time>.prproj)
  in the "Adobe Premiere Pro Auto-Save" folder next to the project, before anything is
  changed. The bottom of Advanced shows the folder and the last backup. Click a backup
  path (there or in the log) to open its folder; Premiere may ask to allow this once. (Premiere's own
  auto-save can't be triggered by a plugin.)
- Analyze & Flip still clears REDFlipper rotation from the other places (Transform, Motion,
  Source) where it would flip a clip twice.
Nothing is written to disk. Motion data read during a Premiere session is kept in
memory, so running again doesn't re-read the clips.

WHAT IT DOES
- Adds a Transform effect to each upside-down RED clip and sets its Rotation:
  - whole clip upside-down: Rotation = 180 (no keyframes)
  - flips mid-take: Hold keyframes (0 / 180) at each flip, covering the whole
    source clip, so later trims and extends stay correct.
- Motion > Rotation is left free for your own use (unless Apply Rotation to is set to Default Motion effect).
- A Transform on a RED clip whose Rotation is 180 or keyframed is treated as
  REDFlipper's (re-running updates it; Remove deletes it). Upright clips that
  carry one get it removed.

HOW IT DECIDES
- Gravity along the camera's Z axis: positive = upright, negative = upside-down
  (the camera rolled past 90 degrees). The change point is where it passes sideways.
- When the lens points nearly straight up or down, the last state is kept.
- Changes shorter than 2 seconds (of playback) are ignored, so a camera hovering
  near 90 degrees doesn't cause rapid flips.

SUPPORTED CAMERAS
REDFlipper reads the gyro/accelerometer data that RED's current camera bodies
record into the .R3D. Clips must be R3D (ProRes files carry no motion data).
- Tested: V-RAPTOR 8K VV.
- Should work (same motion data format, not yet tested):
  - V-RAPTOR and V-RAPTOR XL, including [X] models, firmware 1.2 or later
  - KOMODO, firmware 1.7 or later
  - KOMODO-X, firmware 1.0 or later
- Not supported: DSMC2 cameras (HELIUM, MONSTRO, GEMINI, DRAGON-X), RAVEN and
  older bodies. They store motion data in an older format REDFlipper doesn't read.
- For accurate data, RED recommends the in-camera calibration:
  Menu > Settings > Maintenance > Calibrate > Gyro/Acc.

CREDITS
- by Jacob J. Christiansen
- Flippers icon by Anna Pasechnaia from Noun Project (CC BY 3.0)
