// Prover lab: can an offline browser make a Midnight zero-knowledge proof with no proof server?
// EXPERIMENT. Not part of the cold transfer flow; nothing here moves funds or touches a real key.
//
// It proves ONE shielded output (zswap "output" circuit) for a random, throwaway key and a made-up coin, then checks the
// proof with the ledger's own well-formedness check. An output is the simplest shielded proof: it needs no chain state
// and no Merkle path, so it measures the prover alone.
//
// The ledger (`L`) and the zkir prover (`Z`) are passed in, so this file imports no WebAssembly at run time and the
// same code runs in the page (inlined modules) and under Node (scripts/prover-lab-node.mjs).
import type * as LedgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import type * as ZkirV2 from '@midnightntwrk/zkir-v2';

export type Ledger = typeof LedgerV9;
export type Zkir = typeof ZkirV2;

/**
 * SHA-256 of every key file this lab accepts, as the wallet SDK's prover client pins them for ledger 9 (circuit generation
 * 10). Filled in at build time from `@midnightntwrk/wallet-sdk-prover-client` (`V9KeyMaterial`), so the page trusts the
 * same hashes the SDK does.
 */
export type Pins = {
  generation: number;
  /** 'zswap/output.prover' -> hex digest. */
  files: Record<string, string>;
  /** k -> hex digest of bls_midnight_2p<k>. */
  params: Record<string, string>;
};

/** The circuit the ledger asks for, by the key location it passes to the prover (mapping as in the SDK's KeyMaterial.js). */
export const OUTPUT_LOCATION = 'midnight/zswap/output';
export const OUTPUT_CIRCUIT = 'zswap/output';
export const OUTPUT_FILES = [`${OUTPUT_CIRCUIT}.prover`, `${OUTPUT_CIRCUIT}.verifier`, `${OUTPUT_CIRCUIT}.bzkir`] as const;

/** Where a pinned file lives on the SDK's key host (https://srs.midnight.network/): the generation goes after the folder. */
export const hostPath = (name: string, generation: number): string =>
  name.startsWith('params/') ? `bls_midnight_2p${name.slice('params/'.length)}` : name.replace('/', `/${generation}/`);

/** The file name a person sees and picks: the last part of the host path. */
export const displayName = (name: string, generation: number): string => hostPath(name, generation).split('/').pop()!;

/**
 * Identify a file by its hash, not its name: a renamed or wrong file is caught either way. Returns the logical name
 * ('zswap/output.prover', 'params/14') or undefined for a file the SDK does not pin.
 */
export const identify = (digestHex: string, pins: Pins): string | undefined => {
  for (const [name, d] of Object.entries(pins.files)) if (d === digestHex) return name;
  for (const [k, d] of Object.entries(pins.params)) if (d === digestHex) return `params/${k}`;
  return undefined;
};

/** The circuit size k of a circuit, read from its IR. The public parameters file must be for this k. */
export const circuitK = (Z: Zkir, bzkir: Uint8Array): number => Z.Zkir.deserialize(bzkir).getK();

/** What the prover asked for while proving, in order: shows which keys and parameter sizes a proof really needs. */
export type Requests = string[];

/** A key-material provider over files already loaded and hash-checked. Missing files fail with what to load. */
export const keyMaterial = (files: ReadonlyMap<string, Uint8Array>, generation: number, requests: Requests): ZkirV2.KeyMaterialProvider => ({
  lookupKey: async (location) => {
    requests.push(`key ${location}`);
    if (location !== OUTPUT_LOCATION) return undefined; // the lab proves outputs only
    const get = (name: string) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error(`The prover needs ${displayName(name, generation)}; load it and run again.`);
      return bytes;
    };
    return { proverKey: get(`${OUTPUT_CIRCUIT}.prover`), verifierKey: get(`${OUTPUT_CIRCUIT}.verifier`), ir: get(`${OUTPUT_CIRCUIT}.bzkir`) };
  },
  getParams: async (k) => {
    requests.push(`params k=${k}`);
    const bytes = files.get(`params/${k}`);
    if (!bytes) throw new Error(`The prover needs bls_midnight_2p${k} (public parameters for k = ${k}); load it and run again.`);
    return bytes;
  },
});

export type LabResult = {
  proveMs: number;
  verifyMs: number;
  txBytes: number;
  requests: Requests;
  /** The ledger's well-formedness check, with native proof verification on, accepted the proof. */
  verified: true;
};

/**
 * Prove one shielded output to a fresh random key, then verify it. `randomSeed` must be 32 random bytes; the keys made
 * from it are cleared afterwards. `now` is a clock in milliseconds (performance.now in the page, too).
 */
export const proveOneOutput = async (
  L: Ledger,
  Z: Zkir,
  files: ReadonlyMap<string, Uint8Array>,
  pins: Pins,
  randomSeed: Uint8Array,
  now: () => number,
  networkId = 'preprod',
): Promise<LabResult> => {
  if (randomSeed.length !== 32) throw new Error('The random seed must be 32 bytes.');
  const keys = L.ZswapSecretKeys.fromSeed(randomSeed);
  try {
    // A made-up coin of a random token type: proving an output does not look at the chain, so any coin will do.
    const coin = L.createShieldedCoinInfo(L.sampleRawTokenType(), 1_000_000n);
    const output = L.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
    const unproven = L.Transaction.fromParts(networkId, L.ZswapOffer.fromOutput(output));

    const requests: Requests = [];
    const provider = Z.provingProvider(keyMaterial(files, pins.generation, requests));
    const t0 = now();
    const proven = await unproven.prove(provider, L.CostModel.initialCostModel());
    const proveMs = now() - t0;

    // The real check: the ledger verifies the proof against its own built-in verifier key. An unbalanced transaction is
    // fine here (the lab makes value out of nothing on purpose); only balancing, limits and signatures are switched off.
    const bound = proven.bind();
    const strictness = new L.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.enforceLimits = false;
    strictness.verifySignatures = false;
    strictness.verifyContractProofs = false;
    strictness.verifyNativeProofs = true;
    const t1 = now();
    bound.wellFormed(L.LedgerState.blank(networkId), strictness, new Date());
    const verifyMs = now() - t1;

    return { proveMs, verifyMs, txBytes: bound.serialize().length, requests, verified: true };
  } finally {
    keys.clear();
  }
};
