#!/usr/bin/env node
'use strict';
// Checks that the code live at the OrbitPay and vault factory addresses is this source, compiled as build.js compiles it.
// npm run verify                  reads Wanchain mainnet through Wanchain's public RPC
// RPC_URL=<your node> npm run verify   reads it through any Wanchain mainnet node you choose
// It compiles both sources, checks the fingerprints, writes the addresses this repo states into the compiled runtime
// code at the offsets solc reports for the immutables, and compares the result byte for byte with eth_getCode; then it
// checks that each contract's getters return those addresses and that the factory's vaultOf comes from the vault init
// code hash. All chain reads are pinned to one block, a few below the head.
const fs = require('fs');
const solc = require('solc');
const { ethers } = require('ethers');
const B = require('./build.js');

const RPC_URL = process.env.RPC_URL || 'https://gwan-ssl.wandevs.org:56891';
const CHAIN_ID = 888;
const ORBITPAY = '0x4bb94280136f3cb2d2d4cb3a27a91e8c7eac90ae';
const FACTORY = '0xf94b24605cae326ead104db1e5322988998215e0';
const TREASURY = '0x2193360d55da460dff00245457d3d33e40352bce';
const EXPECT_ADDR = {
  orbitpay: { treasury: TREASURY, owner: TREASURY, usdt: '0x11e77e27af5539872efed10abaa0b408cfd9fbbd', usdc: '0x52a9cea01c4cbdd669883e41758b8eb8e8e2b34b' },
  factory: { orbitpay: ORBITPAY },
};
const DEPLOYED_SHA256 = {
  orbitpay: '6f1ab0570ec776dceedcfa3b80a2a9f377a3f3ed266797810b1c9ae9f5683df7',
  factory: '68043b5fdd8610d0cce632e0a4530de7df6bdf9d005c694de3498affa524e7de',
};
const PROBE = '0x0000000000000000000000000000000000000001'; // any wallet; its vault need not exist

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

// AST id -> name of every immutable state variable in one source unit.
function immutableNames(unit, source, settings) {
  const input = {
    language: 'Solidity',
    sources: { [unit]: { content: source } },
    settings: { ...settings, outputSelection: { '*': { '': ['ast'] } } },
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
  })(out.sources[unit].ast);
  return names;
}

async function main() {
  const log = (s) => console.log(s);
  const fail = (why) => { log(`VERIFY FAIL ${why}`); process.exitCode = 1; };

  // 1. The sources and their builds must be the fingerprinted ones.
  const opSrc = fs.readFileSync(B.OP_SOL, 'utf8'), vSrc = fs.readFileSync(B.VAULTS_SOL, 'utf8');
  const op = B.buildOrbitPay(opSrc), v = B.buildVaults(vSrc), f = v.OrbitPayVaultFactory;
  const E = B.EXPECT;
  const buildOk = B.sha256(opSrc) === E.orbitpay_source_sha256 && B.sha256(vSrc) === E.vaults_source_sha256
    && B.codeSha(op.bytecode) === E.orbitpay_initcode_sha256 && B.codeSha(op.deployedBytecode) === E.orbitpay_runtime_sha256
    && B.codeSha(f.bytecode) === E.factory_initcode_sha256 && B.codeSha(f.deployedBytecode) === E.factory_runtime_sha256
    && ethers.keccak256(v.OrbitPayVault.bytecode) === E.vault_initcode_keccak256;
  log(`source and build fingerprints: ${buildOk ? 'MATCH' : 'MISMATCH'}`);
  if (!buildOk) return fail('BUILD_MISMATCH');

  // 2. The chain: Wanchain mainnet, one pinned block.
  log(`rpc ${new URL(RPC_URL).host}`);
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  log(`chain id ${chainId}`);
  if (chainId !== CHAIN_ID) return fail('WRONG_CHAIN');
  // A few blocks below the head, so a load-balanced RPC whose nodes lag by a block still answers every read.
  const head = BigInt(await rpc('eth_blockNumber', []));
  const block = '0x' + (head > 5n ? head - 5n : head).toString(16);
  log(`block ${BigInt(block)} (head ${head})`);

  let ok = true;
  const targets = [
    { key: 'orbitpay', label: 'OrbitPay', address: ORBITPAY, art: op, unit: 'OrbitPay.sol', src: opSrc, settings: B.SETTINGS },
    { key: 'factory', label: 'vault factory', address: FACTORY, art: f, unit: 'OrbitPayVaults.sol', src: vSrc, settings: B.VAULTS_SETTINGS },
  ];
  for (const t of targets) {
    log(`== ${t.label} ${t.address}`);
    const code = await rpc('eth_getCode', [t.address, block]);
    if (code === '0x') return fail(`NO_CODE ${t.label}`);
    const want = EXPECT_ADDR[t.key];

    // 3. The compiled runtime with the stated addresses written into its immutables must equal the code on chain,
    //    byte for byte. This comes first, so code that differs is a FAIL even when it cannot answer the getters.
    const names = immutableNames(t.unit, t.src, t.settings);
    const b = Buffer.from(t.art.deployedBytecode.slice(2), 'hex');
    for (const [id, refs] of Object.entries(t.art.immutableReferences)) {
      const name = names[id];
      if (!want[name]) return fail(`UNKNOWN_IMMUTABLE ${t.label} ${id}`);
      const word = Buffer.from(want[name].slice(2).padStart(64, '0'), 'hex');
      for (const r of refs) word.copy(b, r.start, 0, r.length);
    }
    const live = Buffer.from(code.slice(2), 'hex');
    const liveSha = B.sha256(live);
    const same = live.equals(b);
    let firstDiff = -1;
    if (!same) for (let i = 0; i < Math.max(live.length, b.length); i++) if (live[i] !== b[i]) { firstDiff = i; break; }
    log(`runtime on chain ${live.length} bytes, sha256 ${liveSha} ${liveSha === DEPLOYED_SHA256[t.key] ? 'MATCH' : 'MISMATCH'}`);
    log(`compiled runtime with immutables filled: ${same ? 'IDENTICAL to the code on chain' : 'DIFFERS at byte ' + firstDiff}`);
    ok = ok && same && liveSha === DEPLOYED_SHA256[t.key];
    if (!same) continue;

    // 4. The getters must equal the addresses this repo states.
    const iface = new ethers.Interface(t.art.abi);
    const call = async (fn, args = []) => iface.decodeFunctionResult(fn,
      await rpc('eth_call', [{ to: t.address, data: iface.encodeFunctionData(fn, args) }, block]))[0];
    for (const k of Object.keys(want)) {
      const got = (await call(k)).toLowerCase();
      const m = got === want[k];
      log(`${k.padEnd(8)} ${got} ${m ? 'MATCH' : 'MISMATCH, expected ' + want[k]}`);
      ok = ok && m;
    }

    // 5. The factory's vault addresses come from the vault init code hash in this build.
    if (t.key === 'factory') {
      const onchain = (await call('vaultOf', [PROBE])).toLowerCase();
      const computed = ethers.getCreate2Address(FACTORY, ethers.zeroPadValue(PROBE, 32), E.vault_initcode_keccak256).toLowerCase();
      const m = onchain === computed;
      log(`vaultOf(${PROBE}) ${onchain} ${m ? 'MATCH' : 'MISMATCH, computed ' + computed} (CREATE2 with init code hash ${E.vault_initcode_keccak256})`);
      ok = ok && m;
    }
  }

  if (!ok) return fail('CODE_MISMATCH');
  log('VERIFY PASS');
}

main().catch((e) => { console.log(`VERIFY ERROR ${e.message}`); process.exitCode = 1; });
