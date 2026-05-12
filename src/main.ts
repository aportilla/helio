import './styles.css';
import { initFonts } from './data/font-provider';
import { AppController } from './scene/app-controller';

// Parse the bundled BDF fonts before any scene/HUD code constructs label
// textures — pixel-font.ts looks them up by name via the registry.
initFonts();

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const controller = new AppController(canvas);
controller.start();

// Splash markup is inlined in index.html so it paints before the bundle
// loads; we just dismiss it once the scene is up.
const splash = document.getElementById('boot-splash');
if (splash) {
  setTimeout(() => {
    splash.classList.add('fading');
    setTimeout(() => splash.remove(), 600);
  }, 350);
}
