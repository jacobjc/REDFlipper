REDFlipper - Premiere Pro panel
===============================

INSTALL / UPDATE
- Open Creative Cloud first (it must be running for the install to work).
- Download REDFlipper.ccx from the latest release:
  https://github.com/jacobjc/REDFlipper/releases/latest
  Double-click it and Creative Cloud installs the plugin
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
