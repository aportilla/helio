// The conservation + invariant harness (§10, §11, build-step 2) — the executable
// principles. These run every turn in DEV (P8) and are the only safety net for
// the ledger-drift and re-home bug classes, which have no prior-art guard.
//
// They throw with detail rather than returning, so a violation fails a test (or
// a build gate) loudly at the exact turn it first appears.

import { EtaBuckets } from './transfer-ring.ts';
import type { World } from './world.ts';

export class InvariantError extends Error {}

/** Conservation is an EXACT integer equality with NO loss terms (§3.6):
 *  produced − consumed = Δ(stock + in-transit), measured over the turn's
 *  economic window. */
export function assertConservation(before: number, after: number, produced: number, consumed: number): void {
  const lhs = produced - consumed;
  const rhs = after - before;
  if (lhs !== rhs) {
    throw new InvariantError(
      `conservation broken: produced−consumed=${lhs} but Δ(stock+inTransit)=${rhs} ` +
      `(before=${before} after=${after} produced=${produced} consumed=${consumed})`);
  }
}

/** No planet ever holds negative stock (§3.4 — guaranteed by exportable + the
 *  decrementing avail copy; asserted as a backstop). */
export function assertNoNegativeStock(world: World): void {
  for (let i = 0; i < world.stock.length; i++) {
    if (world.stock[i]! < 0) {
      const p = Math.floor(i / world.R);
      const r = i % world.R;
      throw new InvariantError(`negative stock: planet ${p} resource ${r} = ${world.stock[i]}`);
    }
  }
}

/** The ring is the single source of truth; the ETA ledger is its derived cache.
 *  Rebuild the ledger from the ring and assert cell-by-cell equality, plus
 *  Σ inboundReserved == Σ in-flight (§3.5, §11 rule 10). Catches the re-home /
 *  phantom-inbound bug class. */
export function assertLedgerMatchesRing(world: World): void {
  if (world.ledger.total() !== world.ring.inFlightTotal) {
    throw new InvariantError(
      `ledger total ${world.ledger.total()} != ring in-flight ${world.ring.inFlightTotal}`);
  }
  const rebuilt = new EtaBuckets(world.R, world.ringSpan);
  rebuilt.rebuildFrom(world.ring);
  if (!rebuilt.equals(world.ledger)) {
    throw new InvariantError('ledger does not match a rebuild from the ring (drift)');
  }
}
