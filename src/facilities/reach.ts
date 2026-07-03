// The economy's single-jump reach, in light-years — the farthest a single transport leg spans; longer
// hauls route multi-leg over the graph. ~9 ly comfortably exceeds the solar neighborhood's typical
// nearest-neighbor spacing (~5–6 ly), so systems connect into one routable graph rather than isolated
// islands, while reach still matters.
//
// Authored HERE (a sim-free, catalog-free leaf) rather than inline in economy-bridge.ts so both the
// bridge (which drags in the sim + catalog) and node-pure tests can read it without crossing that wall.
// A ship's warp range is pinned equal to REACH_LY × LY_TO_SIM_UNITS by a test — one reachability graph:
// fleets go exactly where trade can. jumpRadius is a runtime tech tier (excluded from the sim save's
// configHash), so retuning REACH_LY never invalidates a save.
export const REACH_LY = 9;
