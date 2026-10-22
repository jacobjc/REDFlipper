REDFlipper - Premiere Pro panel
===============================

INSTALL / UPDATE
- Download REDFlipper.ccx and double-click it. Creative Cloud installs the plugin
  (close Premiere first when updating).
- Then in Premiere: Window > UXP Plugins > REDFlipper.

USE
- Select clips, or switch off "Selected clips only" to work on every clip in the
  active sequence.
- Analyze & Flip: reads each RED clip's motion data straight from its .R3D files,
  works out which sections are upside-down, and corrects them.
- Remove Rotation: removes REDFlipper's correction from the clips in scope.
- Stop: cancels a long analysis before anything is changed.
- Advanced: more options (coming in a later version).
Nothing is written to disk. Motion data read during a Premiere session is kept in
memory, so running again doesn't re-read the clips.

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

CREDITS
- by Jacob J. Christiansen
- Flippers icon by Anna Pasechnaia from Noun Project (CC BY 3.0)
