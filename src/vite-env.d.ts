/// <reference types="vite/client" />

// Inline-as-string imports for BDF font sources and the bundled star
// catalog CSV. Vite resolves the `?raw` query at build time and serves the
// file content as a default-exported string; these declarations teach TS
// the resulting module shape.
declare module '*.bdf?raw' {
  const content: string;
  export default content;
}
declare module '*.csv?raw' {
  const content: string;
  export default content;
}
