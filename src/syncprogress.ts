// Wallet sync progress and the "sync the sponsor early" notice. Pure: no SDK, no network, no files (tests/syncprogress.test.ts).
// The progress format follows the wnight project's syncWallet, so both projects print a sync the same way.

/** How often a sync prints a progress line when nothing finishes in between. MIDNIGHT_SYNC_LOG_INTERVAL_MS, default 15 s. */
export const syncLogIntervalMs = (env: Record<string, string | undefined> = process.env): number => {
  const v = Number(env.MIDNIGHT_SYNC_LOG_INTERVAL_MS ?? 15_000);
  return Number.isFinite(v) && v >= 1_000 ? v : 15_000;
};

/** How often a long sync saves what it has so far. MIDNIGHT_WALLET_SAVE_INTERVAL_MS, default 5 minutes. */
export const saveIntervalMs = (env: Record<string, string | undefined> = process.env): number => {
  const v = Number(env.MIDNIGHT_WALLET_SAVE_INTERVAL_MS ?? 300_000);
  return Number.isFinite(v) && v >= 10_000 ? v : 300_000;
};

export const isStrictlyComplete = (progress: unknown): boolean => {
  const p = progress as { isStrictlyComplete?: unknown } | null;
  return typeof p?.isStrictlyComplete === 'function' && (p.isStrictlyComplete as () => boolean).call(p) === true;
};

/**
 * The two numbers each part's isStrictlyComplete() compares: shielded and DUST progress compare appliedIndex with
 * highestRelevantWalletIndex, unshielded compares appliedId with highestTransactionId. Null for an unknown shape.
 */
export const progressNumbers = (progress: unknown): { applied: bigint; target: bigint } | null => {
  if (!progress || typeof progress !== 'object') return null;
  const p = progress as Record<string, unknown>;
  if (typeof p.appliedIndex === 'bigint' && typeof p.highestRelevantWalletIndex === 'bigint') {
    return { applied: p.appliedIndex, target: p.highestRelevantWalletIndex };
  }
  if (typeof p.appliedId === 'bigint' && typeof p.highestTransactionId === 'bigint') {
    return { applied: p.appliedId, target: p.highestTransactionId };
  }
  return null;
};

/** "done", "42.3%", "starting" before the target is known, or "syncing" when the numbers are not available. */
export const describeProgress = (progress: unknown): string => {
  if (isStrictlyComplete(progress)) return 'done';
  const n = progressNumbers(progress);
  if (!n) return 'syncing';
  if (n.target <= 0n) return 'starting';
  // Held below 100 until the SDK itself reports complete; the target moves as blocks arrive, so it can dip briefly.
  const permille = n.applied >= n.target ? 999n : (n.applied * 1000n) / n.target;
  return `${permille / 10n}.${permille % 10n}%`;
};

export type Parts = { shielded: unknown; unshielded: unknown; dust: unknown };

/** One progress line, and a key that changes whenever a part finishes (a line is printed then, whatever the interval). */
export const progressLine = (parts: Parts, updates: number, secondsIn: number): { line: string; key: string } => ({
  line:
    `Sync (${secondsIn} s): ` +
    Object.entries(parts).map(([name, p]) => `${name} ${describeProgress(p)}`).join(', ') +
    ` (update ${updates})`,
  key: Object.values(parts).map(isStrictlyComplete).join(),
});

// ---- The early notice: a later step (sponsor-submit) needs the sponsor wallet synced. ----

export const STATE_FILE_RE = /^wallet-state-(mn_addr_[a-z]+1[02-9ac-hj-np-z]+)\.json$/;
const DAY_MS = 24 * 3600_000;

export type SavedStateFile = { name: string; mtimeMs: number };

const age = (ms: number): string =>
  ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 2 * DAY_MS ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / DAY_MS).toFixed(1)} days`;

/**
 * What to tell the user, at the first hot step of a flow, about the sponsor wallet's saved sync state in `dir`.
 * The sponsor's secret is not read here, so this cannot tell which state file is the sponsor's: it lists them.
 * `level` is "warn" when no state is saved (the first sync takes hours), "info" when one is over a day old, else "ok".
 */
export const sponsorNotice = (
  files: SavedStateFile[],
  now: number,
  dir: string,
): { level: 'ok' | 'info' | 'warn'; lines: string[] } => {
  const states = files
    .map((f) => ({ ...f, m: STATE_FILE_RE.exec(f.name) }))
    .filter((f) => f.m)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const how = 'npm run hot:sponsor-sync   (in this folder, with SPONSOR_MNEMONIC set; another terminal is fine)';
  if (states.length === 0) {
    return {
      level: 'warn',
      lines: [
        `SYNC AHEAD: the last step, sponsor-submit, needs the sponsor wallet synced, and ${dir} has no saved sponsor state.`,
        'A first sync takes hours, and a shielded tx.hex expires about 50 minutes after its feed. Start it now:',
        `  ${how}`,
      ],
    };
  }
  const lines = states.map((s) => {
    const a = s.m![1]!;
    return `  ${a.slice(0, 18)}...${a.slice(-8)}  last saved ${age(now - s.mtimeMs)} ago`;
  });
  const newest = states[0]!;
  const old = now - newest.mtimeMs > DAY_MS;
  return {
    level: old ? 'info' : 'ok',
    lines: [
      `Saved wallet state here (sponsor-submit resumes from the one for SPONSOR_MNEMONIC's address):`,
      ...lines,
      ...(old ? ['It catches up before it can pay; to have that done before the last step, run now:', `  ${how}`] : []),
    ],
  };
};
