// EncounterController — the thin scene-side glue that runs an encounter as a MODE on SystemScene
// (E3). It owns the transient EncounterState, its own ortho overlay Scene+camera (the SystemActionMenu
// precedent), and the combat-chrome overlay; SystemScene owns the freeze flag + the sidebar/turn gates
// and drives this from its tick/resize/input. It imports the encounter RULES (createEncounterState /
// applyCommand / isTerminal) and DTOs from src/encounter/ — never the reverse (the combat rules know
// nothing about the scene). No second SystemDiagram: combat is an extra render PASS over the one live
// diagram, anchored to the fleet slots via the slotCenterFor accessor SystemScene passes in.
//
// E3 ships a SPECTATOR auto-play: on enter it advances the reducer on a timer (a synthetic "first
// attack at the first living enemy" intent) so the headless loop + the overlay + the side-elimination
// exit are all visible end-to-end with no menu. E4 sets `autoPlay = false` and drives the same reducer
// from the anchored menu instead — this loop is the scaffold that proves the wiring first.

import { OrthographicCamera, Scene, type WebGLRenderer } from 'three';
import { applyCommand, createEncounterState } from '../encounter/step';
import { isTerminal } from '../encounter/terminal';
import { isDown, type EncounterState } from '../encounter/state';
import type { EncounterSpec } from '../encounter/encounter-spec';
import type { ActionIntent } from '../actions/types';
import { CombatOverlay } from './encounter-overlay';
import type { SlotCenter } from './actions/system-action-menu';

// Wall-clock pacing for the spectator auto-play (ms between reducer steps) — slow enough to read each
// hit + the HP drain. Render-only timing; it never feeds back into the integer-milli reducer.
const STEP_MS = 650;

export class EncounterController {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly overlay = new CombatOverlay();

  private state: EncounterState | null = null;
  private contentW = 1;
  private bufH = 1;
  private lastStepAt = 0; // 0 = re-arm: the first tick shows the opening state before stepping

  // E3 default: auto-play the loop (spectator). E4 flips this off and drives via the menu.
  autoPlay = true;
  // Raised by the controller when the encounter ends (side-elimination or flee); SystemScene wires
  // this to exitEncounter (lower the freeze, re-enable Next Turn).
  onExit: () => void = () => {};

  constructor(private readonly slotCenterFor: (id: string) => SlotCenter | null) {
    this.overlay.addTo(this.scene);
  }

  get active(): boolean {
    return this.state !== null;
  }

  // Begin the encounter from a launch spec: seed the reducer state, re-arm the spectator timer, paint
  // the opening roster.
  enter(spec: EncounterSpec): void {
    this.state = createEncounterState(spec);
    this.lastStepAt = 0;
    this.repaint();
  }

  exit(): void {
    this.state = null;
    this.overlay.hide();
  }

  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = contentBufferW;
    this.bufH = bufferH;
    this.camera.right = contentBufferW;
    this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    if (this.state) this.repaint();
  }

  // Per-frame: advance the spectator loop on the timer. Lingers one interval on the terminal state
  // (so the final down reads) before exiting. A no-op when not auto-playing (E4's menu loop).
  tick(now: number): void {
    if (!this.state || !this.autoPlay) return;
    if (this.lastStepAt === 0) {
      this.lastStepAt = now; // first frame after enter: hold the opening state for one interval
      return;
    }
    if (now - this.lastStepAt < STEP_MS) return;
    this.lastStepAt = now;
    if (isTerminal(this.state)) {
      this.onExit();
      return;
    }
    this.step();
  }

  // The overlay anchors to the live fleet slots, so it must render in the SAME content viewport the
  // diagram does; SystemScene sets that up and calls this between the diagram and the chrome passes.
  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  // Fold one synthetic intent into the reducer and repaint. The intent is always the ACTIVE
  // combatant's (applyCommand DEV-asserts that), so the satisfies-the-assert invariant holds.
  private step(): void {
    if (!this.state) return;
    const intent = this.autoIntent(this.state);
    if (!intent) return; // nothing to do (no attack/enemy) — terminal will catch it next tick
    this.state = applyCommand(this.state, intent).state;
    this.repaint();
  }

  // A spectator move for the active combatant: its first attack-category command aimed at the first
  // living enemy. Defensive (skips downed, respects category); returns null when no move exists. E3
  // scaffolding only — the E4 player loop produces real intents from the menu.
  private autoIntent(state: EncounterState): ActionIntent | null {
    const actor = state.combatants[state.activeId];
    if (!actor) return null;
    const attack = actor.commands.find((c) => c.grant.category === 'attack');
    if (!attack) return null;
    const enemy = state.combatants.find((c) => c.factionId !== actor.factionId && !isDown(c));
    if (!enemy) return null;
    return { actorId: actor.id, actionId: attack.id, targetIds: [enemy.id] };
  }

  private repaint(): void {
    if (!this.state) return;
    this.overlay.paint(this.state.combatants, this.state.activeId, this.slotCenterFor, this.contentW, this.bufH);
  }

  dispose(): void {
    this.overlay.dispose();
  }
}
