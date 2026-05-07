// Single source of truth for HUD palette, sizing, and font selection.
// Tokens, no logic. If a value appears in two `build*Texture` functions
// across the HUD subtree, it lives here.
//
// All sizes are *env pixels* — 1 env pixel = ENV_PX_PER_SCREEN_PX (3)
// physical pixels after the browser's nearest-neighbor upscale. So
// `sizes.edgePad = 8` becomes a 24-physical-pixel inset.
//
// Color values are literal sRGB. Three.js ColorManagement is disabled
// (see app-controller.ts) so every hex string and numeric color renders
// at exactly the value written here. Don't introduce any conversion layer.

import { FONTS } from '../data/font-provider';

export const colors = {
  // Title block
  titleBright: '#5ec8ff',           // primary title text
  titleDim:    '#2d7ab8',           // subtitle, dim accent

  // Surface borders
  borderAccent: '#3a8fe0',          // bright outline / hover / dialog edge
  borderDim:    '#1e6fc4',          // inactive surface outline

  // Surface fills
  surface:   'rgba(0,8,20,0.92)',   // panel/card background
  surfaceOn: '#10325d',             // dim-blue selected fill (settings icon when panel open)

  // Glyphs (close-X, hamburger)
  glyphOff:     '#2d7ab8',          // glyph default
  glyphHover:   '#5ec8ff',          // glyph on hover (over default surface)
  glyphOnState: '#ffffff',          // glyph on selected dark fill
  glyphOnHover: '#cfeeff',          // glyph on selected dark fill, hovered

  // Text
  textBody:      '#aee4ff',         // panel labels, info card values
  textBodyHover: '#ffffff',         // hovered row label
  textKey:       '#2d7ab8',         // info card keys, panel section headers
  starName:      '#ffe98a',         // info card star name, panel title

  // Scale bar (numeric — passed to MeshBasicMaterial.color)
  scaleBar: 0xe8f6ff,
} as const;

export const sizes = {
  // Chrome edge inset
  edgePad:    8,    // distance from canvas edges for title / scale / icon
  cardMargin: 14,   // info card inset (bigger than edgePad — gives the boxed border breathing room)

  // Surface internal padding (info card + settings panel use the same values)
  padX: 8,
  padY: 6,

  // Close-X widget
  closeBox:    17,  // outer square
  closeGlyph:  9,   // X glyph (odd so the diagonal lands on a center pixel)
  closeHitPad: 2,   // forgiving click target

  // Settings trigger
  iconBox:    17,
  iconHitPad: 2,

  // Checkbox glyph
  checkbox:         9,
  checkboxFill:     3,   // center dot when on (centered: (9-3)/2 = 3)
  checkboxLabelGap: 4,

  // Scale bar
  scaleTickH:    3,
  scaleLabelGap: 2,

  // Settings panel layout rhythm
  panelTriggerGap:       6,  // gap between settings icon and panel
  panelTitleGap:         2,  // gap below title line
  panelTitleToSection:   4,
  panelSectionGapBefore: 6,
  panelSectionGapAfter:  2,
  panelRowPadY:          2,

  // Info card / panel — name-line trailing space for a corner close-X
  nameToCloseGap: 4,
  cardNameGap:    2,  // gap between name line and body lines
  cardActionGap:  4,  // gap between info card bottom and the action button below it
} as const;

export const fonts = {
  title:      FONTS.EspySans[20],
  subtitle:   FONTS.Monaco[11],
  cardName:   FONTS.EspySans[15],
  panelTitle: FONTS.EspySans[15],
  body:       FONTS.Monaco[11],
} as const;
