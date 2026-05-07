import './styles.css';
import { initFonts } from './data/font-provider';
import { AppController } from './scene/app-controller';

// Parse the bundled BDF fonts before any scene/HUD code constructs label
// textures — pixel-font.ts looks them up by name via the registry.
initFonts();

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const splash = document.createElement('div');
splash.className = 'boot-splash';
splash.innerHTML = '<div class="dot"></div><div class="ring"></div><div class="ring delay"></div>';
document.body.appendChild(splash);

const controller = new AppController(canvas);
controller.start();

// Hold the splash briefly, fade, then unmount.
setTimeout(() => {
  splash.classList.add('fading');
  setTimeout(() => splash.remove(), 600);
}, 350);
