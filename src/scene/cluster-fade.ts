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

// Stars-only: when to enable / disable the per-star pivot-dim local-focus
// effect (see stars shader in materials.ts). Keyed to ORBIT DISTANCE
// (view.distance = camera ↔ pivot), not per-star camera distance, because
// the user-facing intent is "zoomed in = focus dimming, zoomed out =
// everything bright." A per-star camera ramp would never re-brighten on
// zoom-out — every star is far from a zoomed-out camera, including the
// nearby ones we want bright.
//
// Bounds are tuned against DEFAULT_VIEW.distance = 30: full effect at and
// below default zoom, smooth disappear from FULL_BELOW → OFF_ABOVE, no
// effect beyond OFF_ABOVE (well inside the [4, 150] zoom range so the
// "zoom-out reveals the galaxy uniformly" cue is unmistakable).
export const STAR_DIM_FULL_BELOW = 40;
export const STAR_DIM_OFF_ABOVE  = 100;
