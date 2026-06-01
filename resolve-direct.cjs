/**
 * resolve-direct.cjs
 * Directly resolves a PredictionMarket v1 market using @gear-js/api
 * with manually-encoded Sails payload.
 *
 * Sails payload encoding:
 *   - SCALE compact-length-prefixed string for service name
 *   - SCALE compact-length-prefixed string for function name
 *   - SCALE-encoded arguments
 */
'use strict';

const { GearApi, GearKeyring } = require('@gear-js/api');
const { u8aToHex } = require('@polkadot/util');

const PID_V1 = '0x2aa206e02547b2c23751e112c0751acb463d80756c34477f12db89fa1fe877e6';
const MNEMONIC = 'coach street junior rubber tree monster notice mechanic public barrel dignity hawk';

const marketId = parseInt(process.argv[2] || '1505');
const outcome  = process.argv[3] || 'B';  // 'A' or 'B'

// SCALE compact integer encoding
function compactEncode(n) {
  if (n < 64) return Buffer.from([n << 2]);
  if (n < (1 << 14)) {
    const v = (n << 2) | 1;
    return Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  }
  // For larger values (not needed here)
  throw new Error('Compact encoding for large values not implemented');
}

// SCALE encode a UTF-8 string: compact length + bytes
function scaleString(s) {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([compactEncode(bytes.length), bytes]);
}

// SCALE encode u64 little-endian 8 bytes
function scaleU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

// Build the Sails call payload
function buildPayload(serviceName, funcName, ...encodedArgs) {
  return Buffer.concat([
    scaleString(serviceName),
    scaleString(funcName),
    ...encodedArgs,
  ]);
}

async function main() {
  console.log(`Connecting to Vara mainnet...`);
  const api = await GearApi.create({ providerAddress: 'wss://rpc.vara.network' });
  console.log(`Connected.`);

  const keyring = await GearKeyring.fromMnemonic(MNEMONIC);
  console.log(`Signer: ${keyring.address}`);

  // Encode: ResolveMarket(market_id: u64, winning_outcome: Outcome)
  // Outcome is an enum: A=0, B=1
  const outcomeVariant = outcome === 'A' ? 0 : 1;
  const payload = buildPayload(
    'PredictionMarket',
    'ResolveMarket',
    scaleU64(marketId),
    Buffer.from([outcomeVariant]),
  );

  console.log(`Payload (hex): ${u8aToHex(payload)}`);
  console.log(`Resolving market #${marketId} → outcome ${outcome} (variant=${outcomeVariant})`);

  // Estimate gas first
  console.log('Estimating gas...');
  let gasLimit;
  try {
    const estimated = await api.program.calculateGas.handle(
      keyring.address,
      PID_V1,
      payload,
      0,    // value
      false // allow other panics
    );
    gasLimit = estimated.min_limit;
    console.log(`Estimated gas: ${gasLimit}`);
  } catch (e) {
    console.warn(`Gas estimation failed (${e.message}), using default 50B gas`);
    gasLimit = 50_000_000_000n;
  }

  // Submit the message
  const message = {
    destination: PID_V1,
    payload: u8aToHex(payload),
    gasLimit: gasLimit,
    value: 0,
  };

  console.log('Sending message...');
  await new Promise((resolve, reject) => {
    let done = false;
    api.message.send(message, { signer: keyring })
      .signAndSend(keyring, ({ status, events, dispatchError }) => {
        if (done) return;
        console.log(`  Status: ${status.type}`);
        if (dispatchError) {
          done = true;
          let errMsg = dispatchError.toString();
          if (dispatchError.isModule) {
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            errMsg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
          }
          reject(new Error(`Dispatch error: ${errMsg}`));
          return;
        }
        if (status.isInBlock) {
          done = true;
          console.log(`✅ In block: ${status.asInBlock.toString()}`);
          resolve();
        } else if (status.isFinalized) {
          done = true;
          console.log(`✅ Finalized: ${status.asFinalized.toString()}`);
          resolve();
        } else if (status.isDropped || status.isInvalid || status.isUsurped) {
          done = true;
          reject(new Error(`Transaction failed: ${status.type}`));
        }
      })
      .catch(reject);
  });

  await api.disconnect();
  console.log('Done.');
}

main().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
