import './styles.css';
import { initFonts } from './data/font-provider';

// Parse the bundled BDF fonts before any scene/HUD code constructs label
// textures — pixel-font.ts looks them up by name via the registry.
initFonts();

import './components/starmap-app';
