// Exports the compiled wnight contract for Midnight.js. Generated code lives in
// src/managed/wnight (run `npm run compile`; gitignored).
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type ImpureCircuits,
} from './managed/wnight/contract/index.js';
import { Contract } from './managed/wnight/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'wnight');

// wnight declares no witnesses.
export const CompiledWnight = CompiledContract.make('Wnight', Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
