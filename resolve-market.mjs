/**
 * resolve-market.mjs
 * Resolves a PredictionMarket (v1) on Vara mainnet using @gear-js/api + sails-js
 * Usage: node resolve-market.mjs <market_id> <outcome>
 * Example: node resolve-market.mjs 1505 B
 */
import { GearApi, GearKeyring } from '@gear-js/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PID_V1 = '0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6';
const MNEMONIC = 'coach street junior rubber tree monster notice mechanic public barrel dignity hawk';

const marketId = parseInt(process.argv[2] || '1505');
const outcome  = process.argv[3] || 'B';  // 'A' or 'B'

async function main() {
  console.log(`Connecting to Vara mainnet...`);
  const api = await GearApi.create({ providerAddress: 'wss://rpc.vara.network' });
  console.log(`Connected. Block: ${(await api.blocks.getFinalizedHead()).toString().slice(0,10)}...`);

  const keyring = await GearKeyring.fromMnemonic(MNEMONIC);
  console.log(`Signer: ${keyring.address}`);

  // Read IDL
  const idlText = readFileSync(join(__dirname, 'hy4_predict.idl'), 'utf8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  sails.parseIdl(idlText);
  sails.setApi(api);
  sails.setProgramId(PID_V1);

  const outcomeArg = outcome === 'A' ? { A: null } : { B: null };
  console.log(`Resolving market #${marketId} with outcome ${outcome}...`);
  console.log(`Outcome arg:`, JSON.stringify(outcomeArg));

  const tx = sails.services.PredictionMarket.functions.ResolveMarket(marketId, outcomeArg);
  tx.withAccount(keyring);
  tx.withGas(50_000_000_000n);

  await new Promise((resolve, reject) => {
    tx.signAndSend(({ status, blockHash }) => {
      console.log(`Status: ${JSON.stringify(status)}`);
      if (status.isInBlock) {
        console.log(`✅ Included in block: ${blockHash}`);
        resolve();
      } else if (status.isFinalized) {
        console.log(`✅ Finalized in block: ${status.asFinalized}`);
        resolve();
      } else if (status.isDropped || status.isInvalid || status.isUsurped) {
        reject(new Error(`Transaction failed: ${JSON.stringify(status)}`));
      }
    }).catch(reject);
  });

  await api.disconnect();
  console.log('Done.');
}

main().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
