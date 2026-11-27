// Pure: turns the indexer's `dustGenerations` messages into a list of generation entries. No SDK imports.
// The messages come from a network service, so every field is checked before it is used.
// The message shapes are read from wallet-sdk-dust-wallet 2.0.0 (v2/SyncSchema.js). Verified (13 Nov 2026, Preprod):
// a real answer with items, a progress message and a dtime update was read with nothing ignored.

/** One NIGHT coin that generates DUST for the watched address. */
export type GenerationEntry = {
  generationMtIndex: number;
  /** Identifies the NIGHT coin behind this entry. */
  backingNight: string;
  /** The NIGHT behind it, in STAR. */
  nightValue: bigint;
  /** DUST (in SPECK) the entry held at `ctime`. */
  initialValue: bigint;
  ctime: Date;
  transactionHash: string;
  /** Set when the NIGHT behind it was spent: generation stops and the DUST decays from then. */
  dtime?: Date;
};

export type Generations = { entries: GenerationEntry[]; progressSeen: boolean; ignored: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const digits = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,40}$/.test(v);
const index = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const seconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e11;
const hexish = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{1,200}$/.test(v);

/**
 * Collect entries from the messages in the order they arrived. A `DustGenerationDtimeUpdateItem` marks the entry with
 * the same tree index as stopped. Messages of an unknown or malformed shape are counted in `ignored`, never guessed at.
 */
export const collectGenerations = (messages: readonly unknown[]): Generations => {
  const byIndex = new Map<number, GenerationEntry>();
  const stopped = new Map<number, Date>();
  let progressSeen = false;
  let ignored = 0;
  for (const m of messages) {
    if (!isRecord(m)) {
      ignored++;
      continue;
    }
    if (m.__typename === 'DustGenerationsItem') {
      if (!index(m.generationMtIndex) || !digits(m.value) || !digits(m.initialValue) || !hexish(m.backingNight) || !seconds(m.ctime) || !hexish(m.transactionHash)) {
        ignored++;
        continue;
      }
      byIndex.set(m.generationMtIndex, {
        generationMtIndex: m.generationMtIndex,
        backingNight: m.backingNight.toLowerCase(),
        nightValue: BigInt(m.value),
        initialValue: BigInt(m.initialValue),
        ctime: new Date(m.ctime * 1000),
        transactionHash: m.transactionHash.toLowerCase(),
      });
    } else if (m.__typename === 'DustGenerationDtimeUpdateItem') {
      if (!index(m.generationMtIndex) || !seconds(m.newDtime)) {
        ignored++;
        continue;
      }
      stopped.set(m.generationMtIndex, new Date(m.newDtime * 1000));
    } else if (m.__typename === 'DustGenerationsProgress') {
      progressSeen = true;
    } else {
      ignored++;
    }
  }
  for (const [i, dtime] of stopped) {
    const entry = byIndex.get(i);
    if (entry) entry.dtime = dtime;
  }
  return { entries: [...byIndex.values()].sort((a, b) => a.generationMtIndex - b.generationMtIndex), progressSeen, ignored };
};
