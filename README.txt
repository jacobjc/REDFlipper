REDFlipper - Premiere Pro panel
===============================

INSTALL / UPDATE (close Premiere first), in PowerShell:
  $upia = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
  & $upia /remove "REDFlipper"
  & $upia /install "<path to>\REDFlipper.ccx"
Then in Premiere: Window > UXP Plugins > REDFlipper.

USE
- Select clips (or untick "Selected clips only" for the whole active sequence).
- Analyze & Flip: reads each RED clip's motion data straight from its .R3D files,
  works out which sections are upside-down, and corrects them.
- Preview: same analysis, lists what would change, changes nothing.
- Remove rotation: removes REDFlipper's correction from the clips in scope.
- Stop: cancels a long analysis before anything is changed.
Nothing is written to disk. Motion data read during a Premiere session is kept in
memory, so running again (or Preview then Analyze & Flip) doesn't re-read the clips.

WHAT IT DOES
- Adds a Transform effect to each upside-down RED clip and sets its Rotation:
  - whole clip upside-down: Rotation = 180 (no keyframes)
  - flips mid-take: Hold keyframes (0 / 180) at each flip, covering the whole
    source clip, so later trims and extends stay correct.
- Motion > Rotation is left free for your own use.
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
