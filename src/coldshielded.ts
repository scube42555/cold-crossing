// The cold machine's shielded spend, without the command line: rebuild the wallet's coins from a zswap feed, plan and
// build a shielded transfer with the ledger directly, prove it in-process with the zkir WebAssembly prover from local key
// files, and check the result. No wallet SDK wallet, no sync, no network code. The ledger (`L`) and the prover (`Z`)
// are passed in, so nothing here imports WebAssembly at run time (the cold page can reuse it later).
//
// Prototyped end to end on Preprod on 25 Nov 2026 (wnight wallet B as the "cold" wallet): coins found from a 2.6 KB feed,
// spend + output proved in 175 s, sponsor added DUST, accepted in block 3,578,333.
import type * as LedgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import type * as ZkirV2 from '@midnightntwrk/zkir-v2';
import { fromHex, toHex } from './hex.js';
import { type Feed, feedDeadline, rootMatches } from './zswapfeed.js';

export type Ledger = typeof LedgerV9;
export type Zkir = typeof ZkirV2;
export type Coin = LedgerV9.QualifiedShieldedCoinInfo;

/** The circuits a shielded transfer needs, by the key location the ledger asks for (as in the SDK's KeyMaterial.js). */
export const CIRCUITS: Record<string, string> = { 'midnight/zswap/spend': 'zswap/spend', 'midnight/zswap/output': 'zswap/output' };
export const KEY_FILES = ['zswap/spend.prover', 'zswap/spend.verifier', 'zswap/spend.bzkir', 'zswap/output.prover', 'zswap/output.verifier', 'zswap/output.bzkir'];

/** SHA-256 pins for key files and public parameters, as the wallet SDK's prover client declares them for ledger 9. */
export type KeyPins = { generation: number; files: Record<string, string>; params: Record<string, string> };

/** The name a key file has on disk (as fetch-prover-keys writes it): 'zswap/spend.prover' -> 'spend.prover'. */
export const diskName = (logical: string): string => (logical.startsWith('params/') ? `bls_midnight_2p${logical.slice(7)}` : logical.split('/').pop()!);

/**
 * Accept key files by hash only. `entries` are (file name, bytes) pairs from a folder; anything unpinned is reported and
 * ignored. Returns logical name -> bytes, and what is missing for a transfer (public parameters checked once k is known).
 */
export const acceptKeyFiles = (
  entries: readonly [string, Uint8Array][],
  pins: KeyPins,
  sha256hex: (b: Uint8Array) => string,
): { files: Map<string, Uint8Array>; rejected: string[] } => {
  const byHash = new Map<string, string>();
  for (const [n, d] of Object.entries(pins.files)) byHash.set(d, n);
  for (const [k, d] of Object.entries(pins.params)) byHash.set(d, `params/${k}`);
  const files = new Map<string, Uint8Array>();
  const rejected: string[] = [];
  for (const [name, bytes] of entries) {
    const logical = byHash.get(sha256hex(bytes));
    if (logical) files.set(logical, bytes);
    else rejected.push(name);
  }
  return { files, rejected };
};

/** What still has to be loaded before proving: the six circuit files, then the parameters for each circuit's k. */
export const missingKeyFiles = (Z: Zkir, files: ReadonlyMap<string, Uint8Array>): string[] => {
  const missing = KEY_FILES.filter((n) => !files.has(n));
  for (const c of ['zswap/spend', 'zswap/output']) {
    const ir = files.get(`${c}.bzkir`);
    if (ir) {
      const k = Z.Zkir.deserialize(ir).getK();
      if (!files.has(`params/${k}`)) missing.push(`params/${k}`);
    }
  }
  return [...new Set(missing)];
};

export const keyMaterial = (files: ReadonlyMap<string, Uint8Array>, asked: string[] = []): ZkirV2.KeyMaterialProvider => ({
  lookupKey: async (location) => {
    asked.push(location);
    const c = CIRCUITS[location];
    if (!c) return undefined;
    const get = (n: string) => {
      const b = files.get(n);
      if (!b) throw new Error(`The prover needs ${diskName(n)}; it is not among the loaded key files.`);
      return b;
    };
    return { proverKey: get(`${c}.prover`), verifierKey: get(`${c}.verifier`), ir: get(`${c}.bzkir`) };
  },
  getParams: async (k) => {
    const b = files.get(`params/${k}`);
    if (!b) throw new Error(`The prover needs bls_midnight_2p${k} (public parameters for k = ${k}).`);
    return b;
  },
});

export type Rebuilt = { state: LedgerV9.ZswapLocalState; coins: Coin[] };

/**
 * Rebuild the wallet's view of the coin tree from the feed with its own keys, and check the result reaches the tip's
 * root. A feed that lies only makes the spend fail on chain (the proof binds to the root); it cannot move coins.
 */
export const rebuildFromFeed = (L: Ledger, keys: LedgerV9.ZswapSecretKeys, feed: Feed): Rebuilt => {
  let state = new L.ZswapLocalState();
  for (const s of feed.segments) {
    state =
      s.type === 'collapsed'
        ? state.applyCollapsedUpdate(L.MerkleTreeCollapsedUpdate.deserialize(fromHex(s.update)))
        : state.replayEvents(keys, s.events.map((e) => L.Event.deserialize(fromHex(e))));
  }
  if (state.firstFree !== BigInt(feed.tip.zswapEndIndex)) {
    throw new Error(`The feed rebuilt the tree to position ${state.firstFree}, not the tip's ${feed.tip.zswapEndIndex}. Make a new feed.`);
  }
  if (!rootMatches(state.merkleTreeRoot, feed.tip.zswapMerkleTreeRoot)) {
    throw new Error("The rebuilt tree's root is not the tip's root: the feed is inconsistent. Make a new feed on the hot machine.");
  }
  return { state, coins: [...state.coins] };
};

export const balancesOf = (coins: readonly Coin[]): Map<string, { total: bigint; count: number }> => {
  const m = new Map<string, { total: bigint; count: number }>();
  for (const c of coins) {
    const e = m.get(c.type) ?? { total: 0n, count: 0 };
    e.total += c.value;
    e.count++;
    m.set(c.type, e);
  }
  return m;
};

export type SpendPlan = { inputs: Coin[]; amount: bigint; change: bigint; tokenType: string };

/**
 * Choose the coins: one coin that covers the amount if there is one (the smallest such), else the largest coins until
 * they do. Fewer inputs mean less proving (about two minutes each in WASM) and a smaller transaction.
 */
export const planSpend = (coins: readonly Coin[], tokenType: string, amount: bigint, maxInputs = 4): SpendPlan => {
  if (amount <= 0n) throw new Error('The amount must be greater than zero.');
  const mine = coins.filter((c) => c.type === tokenType);
  const total = mine.reduce((t, c) => t + c.value, 0n);
  if (total < amount) throw new Error(`The feed shows ${total} of this token, less than ${amount}.`);
  const single = mine.filter((c) => c.value >= amount).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0];
  let inputs: Coin[];
  if (single) inputs = [single];
  else {
    inputs = [];
    let sum = 0n;
    for (const c of [...mine].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))) {
      inputs.push(c);
      sum += c.value;
      if (sum >= amount) break;
    }
  }
  if (inputs.length > maxInputs) throw new Error(`The transfer needs ${inputs.length} coins; at most ${maxInputs} are allowed. Send a smaller amount.`);
  const sum = inputs.reduce((t, c) => t + c.value, 0n);
  return { inputs, amount, change: sum - amount, tokenType };
};

/** The latest expiry a spend from this feed should carry: inside the root's lifetime, with a margin for the sponsor. */
export const spendTtl = (feed: Feed, now: Date, marginMs = 10 * 60_000): Date => {
  const latest = feedDeadline(feed).getTime() - marginMs;
  if (latest <= now.getTime()) {
    throw new Error(`This feed is too old: a spend from it must be on chain by ${feedDeadline(feed).toISOString()}. Make a new feed on the hot machine.`);
  }
  return new Date(latest);
};

export type Recipient = { coinPublicKey: string; encryptionPublicKey: string };

/**
 * Build the unproven transfer: spends of the planned coins, an output to the recipient and, if any, a change output back
 * to this wallet, all in the guaranteed section; plus an empty intent that carries the expiry (sponsor-submit reads it).
 * The fee is not paid here: the sponsor adds it.
 */
export const buildShieldedTransfer = (
  L: Ledger,
  keys: LedgerV9.ZswapSecretKeys,
  rebuilt: Rebuilt,
  plan: SpendPlan,
  recipient: Recipient,
  networkId: string,
  ttl: Date,
): LedgerV9.UnprovenTransaction => {
  let state = rebuilt.state;
  let offer: LedgerV9.ZswapOffer<LedgerV9.PreProof> | undefined;
  const add = (o: LedgerV9.ZswapOffer<LedgerV9.PreProof>) => (offer = offer ? offer.merge(o) : o);
  for (const coin of plan.inputs) {
    const [next, input] = state.spend(keys, coin, 0, ttl);
    state = next;
    add(L.ZswapOffer.fromInput(input));
  }
  add(L.ZswapOffer.fromOutput(L.ZswapOutput.new(L.createShieldedCoinInfo(plan.tokenType, plan.amount), 0, recipient.coinPublicKey, recipient.encryptionPublicKey)));
  if (plan.change > 0n) {
    add(L.ZswapOffer.fromOutput(L.ZswapOutput.new(L.createShieldedCoinInfo(plan.tokenType, plan.change), 0, keys.coinPublicKey, keys.encryptionPublicKey)));
  }
  return L.Transaction.fromParts(networkId, offer, undefined, L.Intent.new(ttl));
};

export type Proved = { bytes: Uint8Array; hex: string; proveMs: number; asked: string[] };

/**
 * Prove in-process (the spend witness holds the coin secret key, so this must happen on the cold machine), bind, and
 * check the proofs with the ledger's own verifier. Balancing is not enforced: the DUST fee is added later by the sponsor.
 */
export const proveAndCheck = async (
  L: Ledger,
  Z: Zkir,
  unproven: LedgerV9.UnprovenTransaction,
  files: ReadonlyMap<string, Uint8Array>,
  networkId: string,
  now: () => number,
): Promise<Proved> => {
  const asked: string[] = [];
  const t0 = now();
  const proven = await unproven.prove(Z.provingProvider(keyMaterial(files, asked)), L.CostModel.initialCostModel());
  const proveMs = now() - t0;
  const bound = proven.bind();
  const strictness = new L.WellFormedStrictness();
  strictness.enforceBalancing = false;
  strictness.enforceLimits = true;
  strictness.verifySignatures = true;
  strictness.verifyContractProofs = false;
  strictness.verifyNativeProofs = true;
  bound.wellFormed(L.LedgerState.blank(networkId), strictness, new Date());
  // The shielded part itself must balance: every token in equals what goes out (the fee is DUST, added by the sponsor).
  for (const [type, delta] of bound.guaranteedOffer?.deltas ?? new Map()) {
    if (delta !== 0n) throw new Error(`The shielded part does not balance for token ${type} (${delta}). Nothing was written.`);
  }
  const bytes = bound.serialize();
  return { bytes, hex: toHex(bytes), proveMs, asked };
};
