// Browser-safe base64 ⇄ bytes for the sim's binary save — extracted from
// economy-bridge.ts so the round-trip is node-testable (node exposes global
// btoa/atob too). Chunked so a large byte array can't overflow the
// String.fromCharCode argument stack.

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
