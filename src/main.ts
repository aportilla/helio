import './styles.css';
import { initFonts } from './data/font-provider';
import { AppController } from './scene/app-controller';
import { installDesktopFullscreen } from './desktop-fullscreen';
import { STARS, clusterIndexFor, systemIdForCluster } from './data/stars';
import { addFriendlyShip } from './game-state';

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
// (scripts/screenshot.mjs --query=demo-route). Tree-shaken from prod.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo-route')) {
  const sunIdx = STARS.findIndex((s) => s.id === 'sol');
  const solCluster = sunIdx >= 0 ? clusterIndexFor(sunIdx) : -1;
  const sysId = solCluster >= 0 ? systemIdForCluster(solCluster) : null;
  if (sysId) {
    addFriendlyShip(sysId);
    controller.devDemoRoute();
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
