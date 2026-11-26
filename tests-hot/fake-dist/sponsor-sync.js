// Stand-in for dist/sponsor-sync.js in the hot page tests: no wallet, no network. Prints its arguments and "saves" a state.
import { writeFileSync } from 'node:fs';

console.log(`Network:  ${process.env.MIDNIGHT_NETWORK}`);
console.log(`ARGS ${JSON.stringify(process.argv.slice(2))}`);
const name = 'wallet-state-mn_addr_preprod1rwkswmczy5przerxkwn5anxtgjge40a5m6cputamv9styeplzx3q222lwj.json';
writeFileSync(name, '{}', { mode: 0o600 });
console.log(`Synced in 1 s (1 updates); saved the synced wallet state to ${name}.`);
process.exit(0);
