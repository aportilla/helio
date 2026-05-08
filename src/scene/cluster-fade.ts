// Cluster fade thresholds — shared by Labels (cluster-name overlay + hover
// reticle) and Droplines (per-cluster vertical pin). Both subsystems use
// the SAME numbers so a cluster's label and its pin flip in/out together
// at the same camera pose. Tune them here in one place.
//
// Two independent ramps multiply into a per-cluster opacity. Each is
// evaluated against the cluster *primary* (not the COM) so the fade
// distance and the visual anchor (label position, drop-line top) agree.
//
//  - PIVOT ramp: `view.target` (orbit pivot) → primary distance. The
//    dominant gate at close zoom; scopes the visible cluster set to the
//    user's current point of interest.
//  - CAMERA ramp: `camera.position` → primary distance. Kicks in as the
//    user zooms out — primaries exit the camera bubble and dim independent
//    of how the pivot ramp rates them. CAMERA_FADE_NEAR is chosen so that
//    at a "reasonably close" orbit radius the camera ramp is fully open
//    and only the pivot ramp fires.
//
// Either FAR threshold hides the cluster outright; below NEAR the ramp is
// fully open. Hover and selection bypass both ramps in both consumers.

export const PIVOT_FADE_NEAR  = 10;
export const PIVOT_FADE_FAR   = 20;
export const CAMERA_FADE_NEAR = 30;
export const CAMERA_FADE_FAR  = 60;
