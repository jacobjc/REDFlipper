REDFlipper - Premiere Pro panel
===============================

INSTALL / UPDATE
- Download REDFlipper-v<version>.ccx and double-click it. Creative Cloud installs the plugin
  (close Premiere first when updating).
- Then in Premiere: Window > UXP Plugins > REDFlipper.

USE
- Select clips, or switch off "Selected clips only" to work on every clip in the
  active sequence.
- Analyze & Flip: reads each RED clip's motion data straight from its .R3D files,
  works out which sections are upside-down, and corrects them.
- Undo: removes REDFlipper's correction from the clips in scope. It only undoes
  what the current Advanced options apply (the bottom of the Advanced section explains it):
  the Transform by default, Motion > Rotation with the Motion option, the Source Transform
  with the Source option.
- Stop: cancels a long analysis before anything is changed.
- The log keeps every line from earlier runs; scroll up to read them.
  "Fast Analysis" (blue) reads only the motion blocks listed in each R3D chunk's index.
  If a chunk has no usable index it falls back to "Frame-by-Frame Analysis" (yellow),
  which walks every block and is much slower.

ADVANCED OPTIONS (remembered between sessions)
- Force Frame-by-Frame Analysis: always use the slow method.
- Apply Rotation to Clip "Motion" Effect: puts the rotation in Motion > Rotation instead
  of a Transform effect. Existing Motion rotation keyframes are replaced.
- Apply Rotation to Source Clip: puts the Transform on the source (master) clip, so every
  instance of that clip in the project is flipped. Overrides the Motion option (shown greyed out, off).
- Add Cut at each Flip Point: cuts the timeline clip where the camera flips (not with the
  Source option). Premiere's plugin API has no razor, so the cut is made by inserting a
  copy of the clip at the flip point (which splits it) and ripple-deleting the copy; both
  halves keep all effects. Undo does not rejoin cuts: use Ctrl+Z, or right-click
  the cut > Join Through Edits (Ctrl + Left-click drag to select multiple cut points).
  Greyed out (off) when Apply Rotation to Source Clip or Stabilize is on.
- Lock to Horizon (Stabilize): the main button becomes "Analyze & Stabilize". Instead of only flipping, levels the horizon on every frame.
  The camera's roll angle comes from gravity measured by its motion sensor (averaged over
  0.1 s around each frame), so upside-down sections come out at 180 and small tilts are
  corrected too. Keyframes are linear; a key is only kept where a straight line between
  its neighbours would be off by more than 0.05 degrees. Goes to the Transform, Motion or
  Source Clip like a flip. Disables cuts. Rotating
  shows the frame's corners; scale up to hide them.
- Auto-Backup Project (on by default): every time Analyze & Flip (or Analyze & Stabilize) is used, saves the
  project (like Ctrl+S), then puts a timestamped copy (<project>-REDFlipper-<date>_<time>.prproj)
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
- Motion > Rotation is left free for your own use (unless the Motion option is on).
- A Transform on a RED clip whose Rotation is 180 or keyframed is treated as
  REDFlipper's (re-running updates it; Remove deletes it). Upright clips that
  carry one get it removed.

HOW IT DECIDES
- Gravity along the camera's Z axis: positive = upright, negative = upside-down
  (the camera rolled past 90 degrees). The change point is where it passes sideways.
- When the lens points nearly straight up or down, the last state is kept.
- Changes shorter than 2 seconds (of playback) are ignored, so a camera hovering
  near 90 degrees doesn't cause rapid flips.
- Needs clips from KOMODO 1.7+, KOMODO-X, or V-RAPTOR 1.2+ firmware (motion data).

CREDITS
- by Jacob J. Christiansen
- Flippers icon by Anna Pasechnaia from Noun Project (CC BY 3.0)
