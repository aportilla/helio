// Cluster info card — shown in the bottom-right when a star (i.e. its
// containing cluster) is selected. Single-member clusters look like the
// previous single-star layout; multi-member systems list every member
// with its own block of body rows under a member sub-header.
//
// Two-font layout: title (primary name) in EspySans 15 (display),
// member sub-headers and key/value body lines in Monaco 11. Different
// enough from the generic Panel (no toggle/action rows, no sections,
// two fonts mixed) to be its own subclass.
//
// Close-X is NOT owned by InfoCard — it's a sibling IconButton in the
// orchestrator. Dismissal policy (clear selection) lives there.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { STARS, STAR_CLUSTERS } from '../../data/stars';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

interface BodyRow { key: string; val: string; }

function bodyForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx];
  return [
    { key: 'class    ', val: s.rawClass },
    { key: 'distance ', val: `${s.distLy.toFixed(2)} ly` },
    { key: 'mass     ', val: `${s.mass.toFixed(2)} Msun` },
    { key: 'radius   ', val: `${s.radiusSolar.toFixed(2)} Rsun` },
  ];
}

// True when the star carries a separate IAU canonical name worth surfacing
// (Toliman → Alpha Centauri B). Empty iauName is the catalog's "same as
// display name" signal; suppress the secondary line in that case so the
// card doesn't carry redundant text for the ~95% of rows where the
// colloquial name already IS the IAU form.
function iauLineFor(starIdx: number): string | null {
  const s = STARS[starIdx];
  if (!s.iauName || s.iauName === s.name) return null;
  return s.iauName;
}

// Vertical gap above each member sub-header (after the first). Visually
// separates per-member blocks without a divider line, which would clash
// with the rest of the HUD's no-divider style.
const MEMBER_BLOCK_GAP = 4;

export class InfoCard extends BasePanel {
  private clusterIdx = -1;

  // Pass -1 to clear (hides the card). Otherwise rebuilds the texture
  // for the selected cluster.
  setCluster(clusterIdx: number): void {
    if (this.clusterIdx === clusterIdx) return;
    this.clusterIdx = clusterIdx;
    if (clusterIdx < 0) {
      this.setVisible(false);
      return;
    }
    this.rebuild();
  }

  protected measure(): { w: number; h: number } {
    if (this.clusterIdx < 0) return { w: 0, h: 0 };
    const cluster = STAR_CLUSTERS[this.clusterIdx];
    const primary = STARS[cluster.primary];
    const isMulti = cluster.members.length > 1;
    const titleText = isMulti ? `${primary.name} +${cluster.members.length - 1}` : primary.name;
    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    const titleW = measurePixelText(titleText, fonts.cardName);
    let maxBodyW = 0;
    let bodyH = 0;
    // Title-level IAU line surfaces the primary's canonical name when the
    // colloquial display drops it ("Alpha Centauri" → "Alpha Centauri A").
    // Suppressed in multi-member mode — each member sub-header gets its
    // own IAU line below, and the primary's line would otherwise repeat
    // the same text twice within a few rows.
    const titleIau = !isMulti ? iauLineFor(cluster.primary) : null;
    if (titleIau) {
      const w = measurePixelText(titleIau);
      if (w > maxBodyW) maxBodyW = w;
      bodyH += bodyLineH;
    }
    for (let i = 0; i < cluster.members.length; i++) {
      const memIdx = cluster.members[i];
      if (isMulti) {
        // Sub-header for this member.
        if (i > 0) bodyH += MEMBER_BLOCK_GAP;
        const nameW = measurePixelText(STARS[memIdx].name);
        if (nameW > maxBodyW) maxBodyW = nameW;
        bodyH += bodyLineH;
        const memberIau = iauLineFor(memIdx);
        if (memberIau) {
          const w = measurePixelText(memberIau);
          if (w > maxBodyW) maxBodyW = w;
          bodyH += bodyLineH;
        }
      }
      const body = bodyForStar(memIdx);
      for (const b of body) {
        const w = measurePixelText(b.key) + measurePixelText(b.val);
        if (w > maxBodyW) maxBodyW = w;
      }
      bodyH += bodyLineH * body.length;
    }
    // Title line reserves room for the corner close-X (sibling widget).
    const W = Math.max(
      sizes.padX + titleW + sizes.nameToCloseGap + sizes.closeBox,
      sizes.padX * 2 + maxBodyW,
    );
    const H = sizes.padY * 2 + titleLineH + sizes.cardNameGap + bodyH;
    return { w: W, h: H };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    const cluster = STAR_CLUSTERS[this.clusterIdx];
    const primary = STARS[cluster.primary];
    const isMulti = cluster.members.length > 1;
    const titleText = isMulti ? `${primary.name} +${cluster.members.length - 1}` : primary.name;
    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    paintSurface(g, 0, 0, w, h);

    drawPixelText(g, titleText, sizes.padX, sizes.padY, colors.starName, fonts.cardName);

    let cursorY = sizes.padY + titleLineH + sizes.cardNameGap;
    const titleIau = !isMulti ? iauLineFor(cluster.primary) : null;
    if (titleIau) {
      drawPixelText(g, titleIau, sizes.padX, cursorY, colors.textKey);
      cursorY += bodyLineH;
    }
    for (let i = 0; i < cluster.members.length; i++) {
      const memIdx = cluster.members[i];
      if (isMulti) {
        if (i > 0) cursorY += MEMBER_BLOCK_GAP;
        drawPixelText(g, STARS[memIdx].name, sizes.padX, cursorY, colors.starName);
        cursorY += bodyLineH;
        const memberIau = iauLineFor(memIdx);
        if (memberIau) {
          drawPixelText(g, memberIau, sizes.padX, cursorY, colors.textKey);
          cursorY += bodyLineH;
        }
      }
      for (const b of bodyForStar(memIdx)) {
        drawPixelText(g, b.key, sizes.padX, cursorY, colors.textKey);
        drawPixelText(g, b.val, sizes.padX + measurePixelText(b.key), cursorY, colors.textBody);
        cursorY += bodyLineH;
      }
    }
  }
}
