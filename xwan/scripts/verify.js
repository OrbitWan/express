#!/usr/bin/env node
'use strict';
// Checks that the code live at the xWAN Express address is this source, compiled as build.js compiles it.
// npm run verify                  reads Wanchain mainnet through Wanchain's public RPC
// RPC_URL=<your node> npm run verify   reads it through any Wanchain mainnet node you choose
// It compiles the source, checks the fingerprints, writes the three immutables (xwan, treasury, admin) into the
// compiled runtime code at the offsets solc reports, and compares the result byte for byte with eth_getCode.
// All chain reads are pinned to one block.
const fs = require('fs');
const solc = require('solc');
const { ethers } = require('ethers');
const B = require('./build.js');

const RPC_URL = process.env.RPC_URL || 'https://gwan-ssl.wandevs.org:56891';
const CHAIN_ID = 888;
const DESK = '0xcc0ba524134d9625b97569626106b671e6c492f2';
const EXPECT_ADDR = {
  xwan: '0x2ea407aa69be7367bf231e76b51fab9ec436766c',
  treasury: '0x2c68767042be27e922b5cf279f73e42361dad306',
  admin: '0x484a01495358bc46a90cbf4208dfadaee9e3c5cf',
};
const MAX_RATE = 950000000000000000n;
const DEPLOYED_SHA256 = 'd0a3305192202237d47cdda0187328da1b18cb0bee946e09f38c506c25a0fd4f';

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  if (typeof j.result !== 'string') throw new Error(`${method}: no result`);
  return j.result;
}

// AST id -> name of every immutable state variable in XwanDesk.sol.
function immutableNames(source) {
  const input = {
    language: 'Solidity',
    sources: { 'XwanDesk.sol': { content: source } },
    settings: { ...B.SETTINGS, outputSelection: { '*': { '': ['ast'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const names = {};
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') names[n.id] = n.name;
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  })(out.sources['XwanDesk.sol'].ast);
  return names;
}

async function main() {
  const log = (s) => console.log(s);
  const fail = (why) => { log(`VERIFY FAIL ${why}`); process.exitCode = 1; };

  // 1. The source and its build must be the fingerprinted ones.
  const src = fs.readFileSync(B.DESK_SOL, 'utf8');
  const d = B.buildDesk(src);
  const srcOk = B.sha256(src) === B.EXPECT.source_sha256;
  const initOk = B.codeSha(d.bytecode) === B.EXPECT.initcode_sha256;
  const rtOk = B.codeSha(d.deployedBytecode) === B.EXPECT.runtime_sha256;
  log(`source and build fingerprints: ${srcOk && initOk && rtOk ? 'MATCH' : 'MISMATCH'}`);
  if (!srcOk || !initOk || !rtOk) return fail('BUILD_MISMATCH');

  // 2. The chain: Wanchain mainnet, one pinned block.
  log(`rpc ${new URL(RPC_URL).host}`);
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  log(`chain id ${chainId}`);
  if (chainId !== CHAIN_ID) return fail('WRONG_CHAIN');
  const block = await rpc('eth_blockNumber', []);
  log(`block ${BigInt(block)}`);
  const code = await rpc('eth_getCode', [DESK, block]);
  if (code === '0x') return fail('NO_CODE');
  const iface = new ethers.Interface(d.abi);
  const call = async (fn) => iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to: DESK, data: iface.encodeFunctionData(fn) }, block]))[0];
  const onchain = {};
  for (const k of ['xwan', 'treasury', 'admin']) onchain[k] = (await call(k)).toLowerCase();
  const rate = await call('rate');
  const maxRate = await call('MAX_RATE');

  // 3. The getters must equal the addresses this repo states.
  let ok = true;
  for (const k of ['xwan', 'treasury', 'admin']) {
    const m = onchain[k] === EXPECT_ADDR[k];
    log(`${k.padEnd(8)} ${onchain[k]} ${m ? 'MATCH' : 'MISMATCH, expected ' + EXPECT_ADDR[k]}`);
    ok = ok && m;
  }
  log(`MAX_RATE ${maxRate} ${maxRate === MAX_RATE ? 'MATCH' : 'MISMATCH'}`);
  ok = ok && maxRate === MAX_RATE;
  log(`rate     ${rate} (WAN wei per 1 xWAN; the admin may change it)`);

  // 4. The compiled runtime with the stated immutables filled in must equal the code on chain, byte for byte.
  const names = immutableNames(src);
  const b = Buffer.from(d.deployedBytecode.slice(2), 'hex');
  for (const [id, refs] of Object.entries(d.immutableReferences)) {
    const name = names[id];
    if (!EXPECT_ADDR[name]) return fail(`UNKNOWN_IMMUTABLE ${id}`);
    const word = Buffer.from(EXPECT_ADDR[name].slice(2).padStart(64, '0'), 'hex');
    for (const r of refs) word.copy(b, r.start, 0, r.length);
  }
  const live = Buffer.from(code.slice(2), 'hex');
  const liveSha = B.sha256(live);
  const same = live.equals(b);
  let firstDiff = -1;
  if (!same) for (let i = 0; i < Math.max(live.length, b.length); i++) if (live[i] !== b[i]) { firstDiff = i; break; }
  log(`runtime on chain ${live.length} bytes, sha256 ${liveSha} ${liveSha === DEPLOYED_SHA256 ? 'MATCH' : 'MISMATCH'}`);
  log(`compiled runtime with immutables filled: ${same ? 'IDENTICAL to the code on chain' : 'DIFFERS at byte ' + firstDiff}`);
  ok = ok && same && liveSha === DEPLOYED_SHA256;

  if (!ok) return fail('CODE_MISMATCH');
  log('VERIFY PASS');
}

main().catch((e) => { console.log(`VERIFY ERROR ${e.message}`); process.exitCode = 1; });
