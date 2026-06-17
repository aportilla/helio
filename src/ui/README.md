# src/ui — pixel-art widget toolkit + HUDs

Generic pixel-art UI primitives (`Widget`, `BasePanel`, `IconButton`, the painter module, theme tokens, the hit-test contract) shared by every screen's HUD, plus the per-screen HUD orchestrators (`map-hud`, `system-hud`) and the persistent `sidebar` (turn controls + a swappable contextual region) shared across both views. Each HUD renders its own ortho pass at 1 unit = 1 buffer pixel; the sidebar is owned by `AppController` and rendered by whichever scene is active (see [the scene doc](../scene/README.md)). The system view's interaction/selection detail also lives in the scene doc.

## Files

```
widget.ts               Widget base: Mesh + plane + optional CanvasTexture lifecycle
base-panel.ts           Repaint-on-state-change canvas-texture panel base
panel.ts                Tabbed popover; toggle / action / keybinding / radio rows
icon-button.ts          Texture-pool button (off / hover / on / onHover)
painter.ts              Shared 2D primitives: surfaces, glyphs, pill + segmented-pill buttons
theme.ts                Colors, sizes, fonts shared across widgets
hit-test.ts             'interactive' | 'opaque' | 'transparent' pointer-routing contract
map-hud/
  index.ts              MapHud: the settings popover (opened from the sidebar header via toggleSettings) + the planet-test trigger
system-hud/
  index.ts              SystemHud: floating back button (top-left) + the on-hover body tooltip; the selected body's facilities + the system name now live in the sidebar's contextual region
  body-info-card.ts     BodyInfoCard: thin BasePanel that measures + lays out the on-hover tooltip
  body-rows.ts          Body → title / subtitle / key-value row projection for the card (label tables + per-kind builders)
  body-label.ts         Generative biome name for the BodyInfoCard subtitle — `[lead] [terrain]` composed from per-family word pools (surface worlds wear a landscape, gaseous worlds a skyscape), family chosen by a precedence cascade over body-traits predicates + raw fields; a notable condition replaces the family's signature lead (never stacks), always 2–3 words, no single body type
sidebar/
  sidebar.ts            Sidebar: persistent full-height right-edge panel — AppController-owned, rendered by the active scene. Turn header (count + Next Turn) over a swappable contextual region
  context.ts            SidebarContext: the interface for the contextual region below the header (paint + hit-test against absolute canvas coords)
  galaxy-context.ts     GalaxyContext: the galaxy view's region — civ summary (per-type facility tallies) + selected-system rows (relocated info-card content) + View System / Focus pills
  system-context.ts     SystemContext: the system view's region — system name + the selected body's facilities list + Add pills (a vertical facilities list; owns SelectedBodyInfo)
```

## UI subsystem

Helio is a 4X game — the galaxy map is the *first* screen, not the only one. Future siblings (research tree, fleet management, diplomacy, system inspector, ship designer, encyclopedia) will share the same `WebGLRenderer`, the same pixel grid, and the same widget toolkit. That's why `src/ui/` houses *generic* primitives — `Widget`, `BasePanel`, `IconButton`, the painter module, theme tokens, the `HitResult` contract — rather than map-specific HUD chrome. When proposing structure (file layout, base classes, orchestrators), think "what does this look like with five more screens" rather than just optimizing for the map. Defer until concrete consumers exist: full input router (today each HUD owns its own `hitTest` directly), keyboard focus stack, ScrollPanel, world-anchored placement, modal/tooltip/popover taxonomies. Build what current screens need; design only what the next one will.

## Settings panel

`src/ui/panel.ts` is the tabbed-popover widget; `MapHud` builds its spec each rebuild, anchors it just left of the sidebar (top-right of the content rect), and routes pointer events into it. The trigger is a hamburger glyph in the sidebar header — `Sidebar.onSettings` → `MapHud.toggleSettings()`; the galaxy view wires it, the system view leaves it a no-op for now (its toggles are galaxy-specific). Three tabs are wired today:

- **General** — `Auto-rotate view` (session-only `spin` toggle), `Reset view` (action).
- **Graphics** — `Show star labels`, `Show distance droplines` (persisted toggles), and a `Resolution` radio with `Low` / `Medium` / `High` options. The radio biases the auto-computed render N (see [the scene doc](../scene/README.md), "Pixel-perfect rendering" point 1) and the panel disables any option that would clamp to a no-op at the current display.
- **Controls** — `Pan with single touch` (persisted), plus a read-only **Keyboard** + **Mouse** reference. The reference rows use the `keybinding` row kind: a key column in `colors.starName` (yellow) and a description column in `colors.textBody`, with the description column aligned across the section so multiple rows form a clean grid.

Width is measured across **all** tabs' contents at rebuild time (not just the active one) so switching tabs never resizes the panel — width flicker would be worse than a few wasted pixels on shorter tabs. Height is per-active-tab, so the panel grows/shrinks vertically as the user switches; that's fine because the bottom edge moves while the top anchor stays put.

Pointer events fan out through four parallel hit-test methods on `Panel`:

- **`hitTab`** — tab strip at the top.
- **`probeRadio`** — per-pill probing for radio rows. Returns `{ rowId, value, disabled }`; the orchestrator dispatches when not disabled and absorbs (returns `'opaque'` from `hitTest`) when disabled, so a click on a no-op option lands silently rather than falling through to the scene.
- **`hitRow`** — toggle / action rows only. Radios are intentionally excluded here because they sit inside row Y bands but only consume sub-rects, and a row-wide hit would absorb clicks in the gaps between pills.
- **`hitsBackground`** — final absorb for clicks/hovers anywhere on the panel surface that didn't match a more specific zone.

`paintSegmentedPill` (in `src/ui/painter.ts`) is the shared primitive for tab pills and radio pills — same selected/hover styling, with an optional `disabled` flag radios use and tabs ignore. Keeping them on one primitive eliminates drift if the look evolves.

The active tab resets to `general` each time the panel opens — most native settings dialogs behave this way, and persisting the last tab would mean a `settings.ts` schema bump for very little payoff.
