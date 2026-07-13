// MapHud — composition root for the star map's HUD overlay.
//
// Owns:
//   - testIcon (top-left) — IconButton, opens the planet-test view.
//   - settingsPanel — tabbed Panel ('general', 'graphics', 'controls'); anchored
//                     just left of the sidebar and opened via toggleSettings()
//                     (the trigger glyph lives in the sidebar header). Active tab
//                     resets to 'general' on each open.
//   - panelClose — IconButton at the panel's top-right corner.
//
// Selection + its nav actions live in the sidebar's GalaxyContext + footer
// (src/ui/sidebar/galaxy-context.ts), and the settings trigger is a glyph in the
// sidebar header; selection doesn't route through MapHud.
//
// External API: scene, camera, onToggle/onAction/onViewTest/onSettingsChanged
// callbacks; resize, toggleSettings, setAutoScale (called by the scene when a DPR
// boundary crosses, so the Resolution radio's disable states stay live),
// setToggleState, handleClick, hitTest, handlePointerMove, dispose.

import {
  CanvasTexture,
  OrthographicCamera,
  Scene,
} from 'three';
import { getSettings, setSetting, type ResolutionPreference } from '../../settings';
import { effectiveScale, type RenderScale } from '../../render-scale';
import {
  paintCloseX,
  paintGrid,
  paintSurface,
} from '../painter';
import { colors, sizes } from '../theme';
import { paintToTexture } from '../widget';
import { type HitResult } from '../hit-test';
import { IconButton, type IconButtonStates } from '../icon-button';
import { Panel, type PanelHit, type PanelSpec, type TabHit } from '../panel';

export type ToggleId = 'labels' | 'drops' | 'spin';
export type ActionId = 'reset' | 'resetGameState';
export type TabId = 'general' | 'graphics' | 'controls';

// Inline texture-pool factories for the icons that use IconButton's
// shared-texture path. Building them here keeps disposal in the
// orchestrator (single owner) — IconButton borrows references and
// never disposes them itself.

function buildCloseXTexture(glyphColor: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = sizes.closeBox; c.height = sizes.closeBox;
  paintCloseX(c.getContext('2d')!, 0, 0, glyphColor);
  return paintToTexture(c);
}

// 2-state factory for the planet-test trigger (top-left). Momentary
// trigger, not a toggle — only off/hover, mirroring the close-X pool.
// Hover swaps both the border and glyph to the accent/bright pair.
function buildTestIconTexture(state: 'off' | 'hover'): CanvasTexture {
  const SIZE = sizes.iconBox;
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const g = c.getContext('2d')!;

  const isHover = state === 'hover';
  paintSurface(g, 0, 0, SIZE, SIZE, {
    bg: colors.surface,
    border: isHover ? colors.borderAccent : colors.borderDim,
  });
  paintGrid(g, 0, 0, SIZE, isHover ? colors.glyphHover : colors.glyphOff);

  return paintToTexture(c);
}

export class MapHud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  // Toggle state for the in-panel checkboxes. Initialized in the constructor
  // from `getSettings()` for the persisted display toggles (labels, drops);
  // `spin` is session-scoped so it always starts off. The HUD writes through
  // setSetting() on toggle so refresh restores the same state.
  private readonly toggleState: { [K in ToggleId]: boolean };

  // Composed widgets. Selection + its nav actions live in the sidebar's GalaxyContext,
  // and the settings trigger is a glyph in the sidebar header (it calls toggleSettings());
  // MapHud keeps the settings popover itself and the planet-test trigger.
  private readonly settingsPanel: Panel;
  private readonly panelClose: IconButton;
  // Planet-test trigger (top-left). Always visible in galaxy view.
  private readonly testIcon: IconButton;

  // Shared texture pools — disposed in dispose() (single owner).
  private readonly closeXTextures: IconButtonStates;
  private readonly testIconTextures: IconButtonStates;

  private settingsPanelOpen = false;
  private hoveredRowId: string | null = null;
  private hoveredTabId: string | null = null;
  private hoveredRadioKey: string | null = null;
  // Active settings tab. Always resets to 'general' on panel open — most
  // native settings dialogs behave this way, and persisting the last tab
  // would mean a settings.ts schema bump for very little payoff.
  private activeTabId: TabId = 'general';
  // Auto render scale (the 72-DPI integer N from RenderScaleObserver).
  // Drives disable state of the Resolution radio: at autoScale=1 the
  // 'high' option clamps to a no-op (already 1:1), so it's disabled; at
  // autoScale=4 'low' is disabled symmetrically. Updated by the scene
  // via setAutoScale() on observer changes.
  private autoScale: RenderScale = 3;

  // Public callbacks. The scene wires these to its own toggle methods.
  onToggle: (id: ToggleId, on: boolean) => void = () => {};
  onAction: (id: ActionId) => void = () => {};
  // Opens the planet test view; the scene wires it to AppController.enterTest.
  onViewTest: () => void = () => {};
  // Fires when a setting changes via the modal — scene reads getSettings()
  // each gesture so this is informational, but having a hook lets the
  // scene react immediately if a setting requires recomputed state.
  onSettingsChanged: () => void = () => {};

  constructor(autoScale: RenderScale) {
    this.autoScale = autoScale;
    const s = getSettings();
    this.toggleState = {
      labels: s.showLabels,
      drops:  s.showDroplines,
      spin:   false,
    };

    // ---- shared texture pools -------------------------------------------
    this.closeXTextures = {
      off:   buildCloseXTexture(colors.glyphOff),
      hover: buildCloseXTexture(colors.glyphHover),
    };
    this.testIconTextures = {
      off:   buildTestIconTexture('off'),
      hover: buildTestIconTexture('hover'),
    };

    // ---- planet-test trigger (top-left) ---------------------------------
    this.testIcon = new IconButton(sizes.iconBox, this.testIconTextures, {
      renderOrder: 100,
      hitPad: sizes.iconHitPad,
    });
    this.testIcon.addTo(this.scene);

    // ---- settings panel (modal) -----------------------------------------
    this.settingsPanel = new Panel(100);
    this.settingsPanel.addTo(this.scene);

    this.panelClose = new IconButton(sizes.closeBox, this.closeXTextures, {
      renderOrder: 101,                 // above the panel (100)
      hitPad: sizes.closeHitPad,
    });
    this.panelClose.setVisible(false);
    this.panelClose.addTo(this.scene);
  }

  // -- public API -------------------------------------------------------

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layoutAll();
  }

  // Open/close the settings popover. The trigger lives in the sidebar header now;
  // the scene wires sidebar.onSettings → this.
  toggleSettings(): void {
    if (this.settingsPanelOpen) this.closePanel();
    else this.openPanel();
  }

  // External notification: the auto render scale changed (DPR boundary
  // crossed). The Resolution radio's disable states depend on autoScale,
  // so rebuild the panel spec if it's currently visible. No-op when the
  // value didn't actually change.
  setAutoScale(scale: RenderScale): void {
    if (this.autoScale === scale) return;
    this.autoScale = scale;
    if (this.settingsPanelOpen) this.rebuildPanelSpec();
  }

  // External state sync — scene calls this if state flips from
  // elsewhere (e.g. keyboard shortcut, reset re-arming autospin off).
  setToggleState(id: ToggleId, on: boolean): void {
    if (this.toggleState[id] === on) return;
    this.toggleState[id] = on;
    if (this.settingsPanelOpen) this.rebuildPanelSpec();
  }

  // Returns true if the click was consumed by the HUD (interactive widget
  // dispatch OR opaque-surface absorb). Caller should NOT start a world
  // drag/pick when this returns true.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.testIcon.bounds.contains(bufX, bufY)) {
      this.onViewTest();
      return true;
    }
    if (this.settingsPanelOpen) {
      if (this.panelClose.bounds.contains(bufX, bufY)) {
        this.closePanel();
        return true;
      }
      const tab = this.settingsPanel.hitTab(bufX, bufY);
      if (tab) {
        this.dispatchTab(tab);
        return true;
      }
      // Radio pills have sub-row geometry — probe before hitRow so a click
      // in a gap between pills doesn't absorb to a phantom row hit.
      // Disabled pills absorb the click but don't dispatch, so the user's
      // click on a no-op option lands silently rather than falling through
      // to a star behind the panel.
      const radio = this.settingsPanel.probeRadio(bufX, bufY);
      if (radio) {
        if (!radio.disabled) this.dispatchRadio(radio.rowId, radio.value);
        return true;
      }
      const hit = this.settingsPanel.hitRow(bufX, bufY);
      if (hit) {
        this.dispatchRow(hit);
        return true;
      }
      // Tap inside the panel rect but on no row — absorb so it doesn't
      // fall through to star picking behind the panel.
      if (this.settingsPanel.hitsBackground(bufX, bufY)) return true;
    }
    return false;
  }

  // Three-way pointer hit-test. Scene queries this on every pointermove
  // to gate world hover/picking — pointer over an opaque or interactive
  // HUD surface must not also light up a star behind it.
  hitTest(bufX: number, bufY: number): HitResult {
    // Panel chrome takes priority when open — panel is drawn on top of
    // any non-modal HUD chrome, so the visual stack and hit stack agree.
    if (this.settingsPanelOpen) {
      if (this.panelClose.bounds.contains(bufX, bufY)) return 'interactive';
      if (this.settingsPanel.hitTab(bufX, bufY)) return 'interactive';
      // Disabled radio pills are opaque (block scene pick) but not
      // interactive (no cursor swap) — they're real surface but inert.
      const radio = this.settingsPanel.probeRadio(bufX, bufY);
      if (radio) return radio.disabled ? 'opaque' : 'interactive';
      if (this.settingsPanel.hitRow(bufX, bufY)) return 'interactive';
      if (this.settingsPanel.hitsBackground(bufX, bufY)) return 'opaque';
    }
    if (this.testIcon.bounds.contains(bufX, bufY)) return 'interactive';
    return 'transparent';
  }

  // Returns true if the cursor is over any HUD interactive element
  // (caller changes cursor to pointer in that case).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const onTestIcon = this.testIcon.bounds.contains(bufX, bufY);
    this.testIcon.setHover(onTestIcon);

    let onPanelClose = false;
    let hoveredRow: PanelHit | null = null;
    let hoveredTab: TabHit | null = null;
    let onRadioPill = false;
    if (this.settingsPanelOpen) {
      onPanelClose = this.panelClose.bounds.contains(bufX, bufY);
      this.panelClose.setHover(onPanelClose);

      hoveredTab = this.settingsPanel.hitTab(bufX, bufY);
      const newTabId = hoveredTab ? hoveredTab.id : null;
      if (newTabId !== this.hoveredTabId) {
        this.hoveredTabId = newTabId;
        this.settingsPanel.setHoveredTab(newTabId);
      }

      // Radio hover is per-pill (keyed by `${rowId}:${value}`). Disabled
      // pills clear the hover key — they shouldn't visibly highlight or
      // swap the cursor.
      const radio = this.settingsPanel.probeRadio(bufX, bufY);
      const newRadioKey = radio && !radio.disabled ? `${radio.rowId}:${radio.value}` : null;
      if (newRadioKey !== this.hoveredRadioKey) {
        this.hoveredRadioKey = newRadioKey;
        this.settingsPanel.setHoveredRadio(newRadioKey);
      }
      onRadioPill = newRadioKey !== null;

      // hitRow covers only toggle/action rows now; radios were handled above.
      hoveredRow = this.settingsPanel.hitRow(bufX, bufY);
      const newRowId = hoveredRow ? hoveredRow.id : null;
      if (newRowId !== this.hoveredRowId) {
        this.hoveredRowId = newRowId;
        this.settingsPanel.setHoveredRow(newRowId);
      }
    }
    return onTestIcon || onPanelClose
      || hoveredRow !== null || hoveredTab !== null || onRadioPill;
  }

  // -- internal: dispatch / panel state ---------------------------------

  private dispatchTab(hit: TabHit): void {
    const id = hit.id as TabId;
    if (this.activeTabId === id) return;
    this.activeTabId = id;
    // Switching tabs clears any hovered row/pill (whatever was under the
    // pointer before the click is no longer visible). The next pointermove
    // will repopulate it for whatever's under the cursor in the new tab.
    this.hoveredRowId = null;
    this.hoveredRadioKey = null;
    this.rebuildPanelSpec();
  }

  private dispatchRow(hit: PanelHit): void {
    if (hit.kind === 'action') {
      this.onAction(hit.id as ActionId);
      return;
    }
    if (hit.id === 'singleTouchPan') {
      const next = getSettings().singleTouchAction === 'pan' ? 'orbit' : 'pan';
      setSetting('singleTouchAction', next);
      this.onSettingsChanged();
      this.rebuildPanelSpec();
      return;
    }
    // Toggle row backed by a ToggleId — flip internal state, persist if
    // the toggle is settings-backed, fire the callback, rebuild so the
    // checkbox glyph updates. `spin` is session-scoped (no persist).
    const id = hit.id as ToggleId;
    const next = !this.toggleState[id];
    this.toggleState[id] = next;
    if (id === 'labels') setSetting('showLabels', next);
    else if (id === 'drops') setSetting('showDroplines', next);
    this.onToggle(id, next);
    this.rebuildPanelSpec();
  }

  // Resolution is the only radio today. If we add more, switch on rowId;
  // for now the single setting keeps the wiring direct.
  private dispatchRadio(rowId: string, value: string): void {
    if (rowId !== 'resolution') return;
    const pref = value as ResolutionPreference;
    if (getSettings().resolutionPreference === pref) return;
    setSetting('resolutionPreference', pref);
    this.onSettingsChanged();
    this.rebuildPanelSpec();
  }

  private buildPanelSpec(): PanelSpec {
    const s = getSettings();
    return {
      title: 'Settings',
      activeTabId: this.activeTabId,
      tabs: [
        {
          id: 'general',
          label: 'GENERAL',
          sections: [
            {
              header: 'View',
              rows: [
                { kind: 'toggle', id: 'spin',  label: 'Auto-rotate view', on: this.toggleState.spin },
                { kind: 'action', id: 'reset', label: 'Reset view' },
              ],
            },
            {
              // The GAME save (turn / facilities / ships / economy), distinct from the view-only rows above
              // and from display preferences — a wipe-and-restart for the persisted game, not the settings.
              header: 'Game',
              rows: [
                { kind: 'action', id: 'resetGameState', label: 'Reset game state' },
              ],
            },
          ],
        },
        {
          id: 'graphics',
          label: 'GRAPHICS',
          sections: [
            {
              header: 'Display',
              rows: [
                { kind: 'toggle', id: 'labels', label: 'Show star labels',        on: this.toggleState.labels },
                { kind: 'toggle', id: 'drops',  label: 'Show distance droplines', on: this.toggleState.drops  },
              ],
            },
            {
              header: 'Resolution',
              rows: [
                {
                  kind: 'radio',
                  id: 'resolution',
                  selected: s.resolutionPreference,
                  // Disable an option when its biased N clamps back to autoScale —
                  // i.e. the option would have no effect at the current display.
                  // Computed via effectiveScale rather than hand-wired so the
                  // bias logic stays in one place.
                  options: [
                    { value: 'low',    label: 'Low',    disabled: effectiveScale(this.autoScale, 'low')    === this.autoScale },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high',   label: 'High',   disabled: effectiveScale(this.autoScale, 'high')   === this.autoScale },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'controls',
          label: 'CONTROLS',
          sections: [
            {
              header: 'Touch',
              rows: [
                { kind: 'toggle', id: 'singleTouchPan', label: 'Pan with single touch', on: s.singleTouchAction === 'pan' },
              ],
            },
            {
              header: 'Keyboard',
              rows: [
                { kind: 'keybinding', key: 'WASD',     desc: 'Pan parallel to plane' },
                { kind: 'keybinding', key: 'Q / E',    desc: 'Orbit left / right' },
                { kind: 'keybinding', key: 'Z / X',    desc: 'Sink / lift pivot' },
                { kind: 'keybinding', key: 'F, Space', desc: 'Focus selection' },
                { kind: 'keybinding', key: 'Enter',    desc: 'Open system view' },
                { kind: 'keybinding', key: 'Esc',      desc: 'Deselect / back' },
              ],
            },
            {
              header: 'Mouse',
              rows: [
                { kind: 'keybinding', key: 'Drag',         desc: 'Orbit' },
                { kind: 'keybinding', key: 'Click',        desc: 'Select & focus star' },
                { kind: 'keybinding', key: 'Double-click', desc: 'Open system view' },
                { kind: 'keybinding', key: 'Wheel',        desc: 'Zoom' },
              ],
            },
          ],
        },
      ],
    };
  }

  // Rebuild the spec → panel re-paints. Width/height may change, so
  // re-anchor after every rebuild (mirrors the prior `rebuildSettingsPanel
  // → layoutSettingsPanel` sequence).
  private rebuildPanelSpec(): void {
    this.settingsPanel.setSpec(this.buildPanelSpec());
    this.layoutSettingsPanel();
  }

  private openPanel(): void {
    if (this.settingsPanelOpen) return;
    this.settingsPanelOpen = true;
    // Always start on the General tab — most native settings dialogs
    // behave this way, and persisting it would mean a settings.ts schema
    // bump for very little payoff.
    this.activeTabId = 'general';
    this.rebuildPanelSpec();
    this.panelClose.setVisible(true);
    this.layoutSettingsPanel();
  }

  private closePanel(): void {
    if (!this.settingsPanelOpen) return;
    this.settingsPanelOpen = false;
    this.settingsPanel.setVisible(false);
    this.panelClose.setVisible(false);
    this.panelClose.resetHover();
    this.hoveredRowId = null;
    this.hoveredTabId = null;
    this.hoveredRadioKey = null;
  }

  // -- layout -----------------------------------------------------------

  private layoutAll(): void {
    this.testIcon.anchorTo('tl', this.bufferW, this.bufferH, sizes.edgePad, sizes.edgePad);
    if (this.settingsPanelOpen) this.layoutSettingsPanel();
  }

  private layoutSettingsPanel(): void {
    if (!this.settingsPanelOpen) return;
    // The settings trigger lives in the sidebar header now, so the panel anchors
    // to the top-right of the CONTENT rect — flush against the sidebar's left
    // edge — and grows downward. The close-X sits at the panel's top-right corner.
    const panelRight = this.bufferW - sizes.sidebarW - sizes.edgePad;
    const panelTop = this.bufferH - sizes.edgePad;
    const panelW = this.settingsPanel.width;
    const panelH = this.settingsPanel.height;
    this.settingsPanel.placeAt(panelRight - panelW, panelTop - panelH);
    this.panelClose.placeAt(panelRight - sizes.closeBox, panelTop - sizes.closeBox);
  }

  // -- lifecycle --------------------------------------------------------

  dispose(): void {
    // IconButton instances borrow textures from the pools below; they
    // don't dispose them. Single-owner cleanup happens here.
    for (const k of Object.keys(this.closeXTextures) as Array<keyof IconButtonStates>) {
      this.closeXTextures[k]?.dispose();
    }
    for (const k of Object.keys(this.testIconTextures) as Array<keyof IconButtonStates>) {
      this.testIconTextures[k]?.dispose();
    }
    this.testIcon.dispose();
    this.settingsPanel.dispose();
    this.panelClose.dispose();
  }
}
