// Made by scripts/build-prover-lab.mjs (prover lab experiment only): the zkir v2 prover's WebAssembly module, inlined in
// the page and started without a fetch. `memory` is the module's linear memory, for the page's memory report.
declare module 'virtual:zkir-v2' {
  export const loadZkir: () => Promise<{ zkir: typeof import('@midnightntwrk/zkir-v2'); memory: () => WebAssembly.Memory }>;
}
