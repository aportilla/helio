import './styles.css';
import { initFonts } from './data/font-provider';
import { AppController } from './scene/app-controller';
import { installDesktopFullscreen } from './desktop-fullscreen';
import { STARS, STAR_CLUSTERS, clusterIndexFor, systemIdForCluster } from './data/stars';
import { addFriendlyShip, addOpponentShip } from './game-state';

// Parse the bundled BDF fonts before any scene/HUD code constructs label
// textures — pixel-font.ts looks them up by name via the registry.
initFonts();

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const controller = new AppController(canvas);
controller.start();

// Desktop (Tauri) only: bind the borderless-fullscreen toggle (Alt+Enter). No-op in
// the browser build.
installDesktopFullscreen();

// DEV visual-test affordance: ?demo-encounter boots straight into the Sol system, whose SystemScene
// then auto-launches a demo combat overlay; ?demo-warp instead seeds a friendly ship and opens its menu
// on the WARP DRIVE row — so both the combat mode and the galaxy movement chrome are reproducibly
// screenshot-able (scripts/screenshot.mjs --query=demo-encounter / --query=demo-warp). Tree-shaken from prod.
if (import.meta.env.DEV && (new URLSearchParams(location.search).has('demo-encounter') || new URLSearchParams(location.search).has('demo-warp'))) {
  const sunIdx = STARS.findIndex((s) => s.id === 'sol');
  const solCluster = sunIdx >= 0 ? clusterIndexFor(sunIdx) : -1;
  if (solCluster >= 0) controller.enterSystem(solCluster);
}

// ?demo-route stays in the GALAXY view: seed a ready ship at Sol, then open its warp pick with the nearest
// destination locked — so the gold departure banner + gold route line are reproducibly screenshot-able
// (scripts/screenshot.mjs --query=demo-route). ?demo-transit instead DISPATCHES the warp and leaves the ship
// mid-transit, so the galaxy TransitLines leg + its step-midpoint ship-marker triangle are screenshot-able
// (--query=demo-transit). Both tree-shaken from prod.
if (import.meta.env.DEV && (new URLSearchParams(location.search).has('demo-route') || new URLSearchParams(location.search).has('demo-transit'))) {
  const sunIdx = STARS.findIndex((s) => s.id === 'sol');
  const solCluster = sunIdx >= 0 ? clusterIndexFor(sunIdx) : -1;
  const sysId = solCluster >= 0 ? systemIdForCluster(solCluster) : null;
  if (sysId) {
    addFriendlyShip(sysId);
    if (new URLSearchParams(location.search).has('demo-transit')) controller.devDemoTransit();
    else controller.devDemoRoute();
  }
}

// ?demo-fleet also stays in the GALAXY view: seed a muster of ready ships (a few player + one rival) and
// select the cluster, so the stationed ship-marker grid beside the star is reproducibly screenshot-able
// (scripts/screenshot.mjs --query=demo-fleet). It targets the richest MULTI-STAR cluster so the muster's
// disc clearance is exercised against several member discs (a single star is the trivial case). Tree-shaken
// from prod.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo-fleet')) {
  let clusterIdx = -1, mostMembers = 0;
  STAR_CLUSTERS.forEach((c, i) => { if (c.members.length > mostMembers) { mostMembers = c.members.length; clusterIdx = i; } });
  if (clusterIdx < 0) { const sun = STARS.findIndex((s) => s.id === 'sol'); clusterIdx = sun >= 0 ? clusterIndexFor(sun) : -1; }
  const sysId = clusterIdx >= 0 ? systemIdForCluster(clusterIdx) : null;
  if (sysId) {
    for (let i = 0; i < 5; i++) addFriendlyShip(sysId);
    addOpponentShip(sysId);
    controller.devDemoFleet(clusterIdx);
  }
}

// ?demo-convoy stays in the GALAXY view: seed ready ships at Sol, check TWO into a convoy, and arm the nav
// destination pick — so the multi-ship "travel together" mode (range ring + in-range lens + the sidebar ship
// list in nav-target mode, two tiles checked) is reproducibly screenshot-able (scripts/screenshot.mjs
// --query=demo-convoy). Tree-shaken from prod.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo-convoy')) {
  const sunIdx = STARS.findIndex((s) => s.id === 'sol');
  const solCluster = sunIdx >= 0 ? clusterIndexFor(sunIdx) : -1;
  const sysId = solCluster >= 0 ? systemIdForCluster(solCluster) : null;
  if (sysId) {
    for (let i = 0; i < 3; i++) addFriendlyShip(sysId);
    controller.devDemoConvoy(solCluster);
  }
}

// Splash markup is inlined in index.html so it paints before the bundle
// loads; we just dismiss it once the scene is up.
const splash = document.getElementById('boot-splash');
if (splash) {
  setTimeout(() => {
    splash.classList.add('fading');
    setTimeout(() => splash.remove(), 600);
  }, 350);
}
