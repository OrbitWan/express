#!/usr/bin/env node
'use strict';
// Builds xWAN Express (contract XwanDesk) and its test tokens with solc 0.8.36, optimizer 200 runs, evmVersion paris.
// npm run build  -> writes build/XwanDesk.json and build/XwanDeskTestTokens.json.
// Gates: the sources, the creation code and the runtime code must equal the fingerprints below, and the code must hold
// no PUSH0 (0x5f), which Wanchain does not support, counted by an opcode walk (negative control: the same walk over a
// shanghai compile must find PUSH0). Nothing is written unless every gate passes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const solc = require('solc');

const ROOT = path.resolve(__dirname, '..');
const DESK_SOL = path.join(ROOT, 'contracts/XwanDesk.sol');
const TOKENS_SOL = path.join(ROOT, 'contracts/XwanDeskTestTokens.sol');
const BUILD = path.join(ROOT, 'build');
const DESK_JSON = path.join(BUILD, 'XwanDesk.json');
const TOKENS_JSON = path.join(BUILD, 'XwanDeskTestTokens.json');

const EXPECT = {
  source_sha256: '745fb91a3d1ac235ef3f783e8fc84a1b5451dc6355e19c349c246e585abb7f8b',
  tokens_source_sha256: 'dd76af3dfb43e0da63f04461643d669aabb4fa119b6765197e817214d46d9edd',
  initcode_sha256: 'de2dfd8045a1220c404881ae379ab17df669127d12ab31b3e9855a5e03bc9efa',
  runtime_sha256: '27fa87b434ef30bc81dbd4153cbfad959fb9df1d077da91855eb78425a99391a',
};
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// sha256 over the code bytes (not the hex text)
const codeSha = (hex) => sha256(Buffer.from(hex.replace(/^0x/, ''), 'hex'));

// Standard JSON compile of one source unit; returns { contracts: {name: output}, errors }.
function compile(unitName, source, evmVersion = SETTINGS.evmVersion) {
  const input = {
    language: 'Solidity',
    sources: { [unitName]: { content: source } },
    settings: {
      optimizer: SETTINGS.optimizer,
      evmVersion,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error('solc: ' + errors.map((e) => e.formattedMessage).join('\n'));
  return out.contracts[unitName];
}

// Opcode walk: counts PUSH0 (0x5f) instructions, skipping PUSH1..PUSH32 immediate data.
// The trailing CBOR metadata is walked too; it cannot hide a real 0x5f instruction, and in practice holds none here.
function push0Count(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x5f) n++;
    else if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return n;
}

function buildDesk(source, evmVersion) {
  const c = compile('XwanDesk.sol', source, evmVersion).XwanDesk;
  return {
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    deployedBytecode: '0x' + c.evm.deployedBytecode.object,
    immutableReferences: c.evm.deployedBytecode.immutableReferences,
  };
}

function buildTokens(source, evmVersion) {
  const cs = compile('XwanDeskTestTokens.sol', source, evmVersion);
  const pick = (n) => ({ abi: cs[n].abi, bytecode: '0x' + cs[n].evm.bytecode.object });
  return { MockXWAN: pick('MockXWAN'), Reenter: pick('Reenter') };
}

function main() {
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  let fail = null;
  const deskSrc = fs.readFileSync(DESK_SOL, 'utf8');
  const tokSrc = fs.readFileSync(TOKENS_SOL, 'utf8');
  const srcSha = sha256(deskSrc), tokSha = sha256(tokSrc);
  log(`compiler ${solc.version()}  settings ${JSON.stringify(SETTINGS)}`);
  log(`source_sha256 XwanDesk.sol           ${srcSha} ${srcSha === EXPECT.source_sha256 ? 'MATCH' : 'MISMATCH'}`);
  log(`source_sha256 XwanDeskTestTokens.sol ${tokSha} ${tokSha === EXPECT.tokens_source_sha256 ? 'MATCH' : 'MISMATCH'}`);
  if (srcSha !== EXPECT.source_sha256 || tokSha !== EXPECT.tokens_source_sha256) fail = 'SOURCE_MISMATCH';

  const d = buildDesk(deskSrc);
  const initSha = codeSha(d.bytecode), rtSha = codeSha(d.deployedBytecode);
  log(`initcode sha256 ${initSha} ${initSha === EXPECT.initcode_sha256 ? 'MATCH' : 'MISMATCH'} (${(d.bytecode.length - 2) / 2} bytes)`);
  log(`runtime  sha256 ${rtSha} ${rtSha === EXPECT.runtime_sha256 ? 'MATCH' : 'MISMATCH'} (${(d.deployedBytecode.length - 2) / 2} bytes)`);
  if (!fail && (initSha !== EXPECT.initcode_sha256 || rtSha !== EXPECT.runtime_sha256)) fail = 'BUILD_MISMATCH';
  const immut = Object.values(d.immutableReferences).length;
  log(`immutableReferences: ${immut} immutables, ${Object.values(d.immutableReferences).flat().length} slots`);

  const p0i = push0Count(d.bytecode), p0r = push0Count(d.deployedBytecode);
  const s = buildDesk(deskSrc, 'shanghai');
  const s0i = push0Count(s.bytecode), s0r = push0Count(s.deployedBytecode);
  log(`PUSH0 paris    initcode ${p0i} runtime ${p0r} ${p0i === 0 && p0r === 0 ? 'PASS' : 'FAIL'}`);
  log(`PUSH0 shanghai initcode ${s0i} runtime ${s0r} (negative control, needs >=1) ${s0i + s0r >= 1 ? 'PASS' : 'FAIL'}`);
  if (!fail && (p0i || p0r || s0i + s0r < 1)) fail = 'BUILD_MISMATCH';

  const t = buildTokens(tokSrc);
  log(`MockXWAN initcode ${(t.MockXWAN.bytecode.length - 2) / 2} bytes, Reenter initcode ${(t.Reenter.bytecode.length - 2) / 2} bytes`);

  if (fail) { log('BUILD ' + fail + ' (no artifacts written)'); process.exitCode = 1; return; }
  const deskOut = { compiler: solc.version(), settings: SETTINGS, source: 'XwanDesk.sol', source_sha256: srcSha,
    initcode_sha256: initSha, runtime_sha256: rtSha, abi: d.abi, bytecode: d.bytecode,
    deployedBytecode: d.deployedBytecode, immutableReferences: d.immutableReferences };
  const tokOut = { compiler: solc.version(), settings: SETTINGS, source: 'XwanDeskTestTokens.sol', source_sha256: tokSha, ...t };
  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(DESK_JSON, JSON.stringify(deskOut, null, 1) + '\n');
  fs.writeFileSync(TOKENS_JSON, JSON.stringify(tokOut, null, 1) + '\n');
  log(`wrote ${path.relative(ROOT, DESK_JSON)} and ${path.relative(ROOT, TOKENS_JSON)}`);
  log('BUILD PASS');
}

module.exports = { compile, buildDesk, buildTokens, push0Count, codeSha, sha256, EXPECT, SETTINGS, DESK_SOL, TOKENS_SOL, DESK_JSON, TOKENS_JSON };
if (require.main === module) main();
