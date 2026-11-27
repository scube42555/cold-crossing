// Is the proof server there? sponsor-submit proves the sponsor's DUST spend only after you type SUBMIT, so a proof server
// that is not running, or a PROOF_SERVER_URL that is not set, used to fail at the very end, after the sync and after the
// shielded tx.hex's time had been spent. This asks first (tests/proofcheck.test.ts).
//
// It calls GET /version, which the proof server answers with its version (for example "9.0.2") and which carries no private
// data. The URL is never printed: PROOF_SERVER_URL can name a LAN host, and the rule here is not to print endpoint URLs.

export type ProofCheck = { ok: true; version: string } | { ok: false; reason: string };

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** One GET /version with a timeout. Never throws. */
export const checkProofServer = async (baseUrl: string, fetchFn: FetchLike = fetch, timeoutMs = 5_000): Promise<ProofCheck> => {
  try {
    const res = await fetchFn(new URL('version', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `it answered HTTP ${res.status}` };
    const version = (await res.text()).trim().slice(0, 40);
    return { ok: true, version: /^[\w.+-]+$/.test(version) ? version : '(unknown version)' };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, reason: name === 'TimeoutError' ? `no answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s` : 'could not connect' };
  }
};

/** What to tell the user when the check fails. `isSet`: whether PROOF_SERVER_URL is set in this terminal. */
export const proofServerHelp = (reason: string, isSet: boolean): string[] => [
  `The proof server is not reachable (${reason}). sponsor-submit needs it to prove the sponsor's DUST fee payment.`,
  isSet
    ? 'PROOF_SERVER_URL is set in this terminal: check that it names the right host and port, and that the server is running.'
    : 'PROOF_SERVER_URL is not set, so it looked on this machine, port 6300. Start the proof server here, or set PROOF_SERVER_URL',
  ...(isSet ? [] : ['to where it runs (see the README on a LAN proof server, or tunnel it with ssh -L 6300:127.0.0.1:6300 <host>).']),
];
