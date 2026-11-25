// Prove in-process with the wallet SDK's WebAssembly prover instead of a proof server (MIDNIGHT_PROVER=wasm).
//
// This is the prover a browser would run on an offline machine: the same zkir code the proof server uses, compiled to
// WebAssembly. Under Node each proof runs in its own worker. Key files come from the SDK's key host
// (https://srs.midnight.network/) and are checked against the SHA-256s the SDK pins for ledger 9 before use.
//
// The wallet's proofs (shielded spends and outputs, DUST spends) go through this. Contract-call proofs made through
// Midnight.js (deposit, redeem) still use MIDNIGHT_PROOF_SERVER: that is a separate provider (providers.ts).
import { WasmProver } from '@midnightntwrk/wallet-sdk-prover-client/effect';
import type { FluentWalletBuilder } from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';

export type ProofEvent = { atMs: number; what: string };

const events: ProofEvent[] = [];
let t0 = performance.now();

/** What the WASM prover asked for since the last reset, with times relative to it: one key lookup starts each check or proof. */
export function wasmProofEvents(): readonly ProofEvent[] {
  return events;
}

export function resetWasmProofEvents(): void {
  events.length = 0;
  t0 = performance.now();
}

/** Switch the wallet built by `builder` to the WASM prover. Call before buildWithoutStarting (and before a restore). */
export function useWasmProver(builder: FluentWalletBuilder, logger: Logger): void {
  const keys = WasmProver.makeV9KeyMaterialProvider();
  const record = (what: string) => {
    events.push({ atMs: performance.now() - t0, what });
    logger.debug(`wasm prover: ${what}`);
  };
  const timed = {
    lookupKey: async (location: string) => {
      record(`key ${location}`);
      return keys.lookupKey(location);
    },
    getParams: async (k: number) => {
      record(`params k=${k}`);
      return keys.getParams(k);
    },
  };
  // testkit keeps its wallet configuration private (wallet.ts reaches it the same way). `provers` takes precedence over
  // the `provingServerUrl` testkit sets from MIDNIGHT_PROOF_SERVER.
  const config = (builder as unknown as { config: Record<string, unknown> }).config;
  config['provers'] = { v9: { kind: 'wasm', keyMaterialProvider: timed } };
  logger.info('Proving wallet transactions in-process with the WebAssembly prover (MIDNIGHT_PROVER=wasm), not the proof server.');
}
