// Pure classification of one RING cargo transfer (in-flight, inter-cluster) relative
// to the viewed system — the within / from / to / through logic `buildShipLanes`
// (economy-read.ts) applies to each transfer the ring carries, kept pure so it
// unit-tests without constructing a whole sim world. The overlay's live INTERNAL
// lanes are sourced separately from the instant intra-cluster moves (the engine's
// localTransfers), not from here, so the `internal` result below now arises only for
// a legacy same-cluster transfer draining out of a pre-0-turn save.
//
// It is the 2×2 of (is the source in this cluster? × is the destination in this
// cluster?), plus the relay case where neither endpoint is here but the route
// passes through:
//
//                | dst in-cluster | dst elsewhere
//   src in-clstr | internal       | outgoing
//   src elsewhere| incoming       | through (if routed here) / none
//
// All ids are cluster-node integers (the sim's StarId == SystemId == our cluster
// index, all one number). `hops` is the transfer's full multi-leg route as a
// cluster chain, endpoints included (hops[0] == source cluster, last == dest).

export type FlowClass =
  | { readonly kind: 'internal' }                                                      // within: both endpoints here
  | { readonly kind: 'outgoing' }                                                      // from:   source here only
  | { readonly kind: 'incoming' }                                                      // to:     destination here only
  | { readonly kind: 'through'; readonly dir: 'ltr' | 'rtl'; readonly entry: number; readonly exit: number } // relayed across
  | { readonly kind: 'none' };                                                         // unrelated — not rendered here

export function classifyFlow(
  srcCluster: number,
  dstCluster: number,
  viewedCluster: number,
  hops: readonly number[],
): FlowClass {
  const srcIn = srcCluster === viewedCluster;
  const dstIn = dstCluster === viewedCluster;
  if (srcIn && dstIn) return { kind: 'internal' };
  if (srcIn) return { kind: 'outgoing' };
  if (dstIn) return { kind: 'incoming' };
  // Neither endpoint here: a relay only if this cluster is an INTERMEDIATE hop
  // (strictly inside the chain — an endpoint would have been caught above).
  const i = hops.indexOf(viewedCluster);
  if (i <= 0 || i >= hops.length - 1) return { kind: 'none' };
  // Direction from the bracketing hops: arbitrary-but-stable (entry < exit →
  // left-to-right). True geographic bearing is a deferred upgrade. entry/exit are
  // surfaced so the caller can key distinct transit corridors apart.
  const entry = hops[i - 1]!;
  const exit = hops[i + 1]!;
  return { kind: 'through', dir: entry < exit ? 'ltr' : 'rtl', entry, exit };
}
