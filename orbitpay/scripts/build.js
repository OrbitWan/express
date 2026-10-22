#!/usr/bin/env node
'use strict';
// Builds OrbitPay, the vault factory and vault, and the test tokens with solc 0.8.36, optimizer 200 runs, evmVersion
// paris, exactly as they were deployed: OrbitPay.sol with the default metadata, OrbitPayVaults.sol with
// bytecodeHash none and appendCBOR false (no metadata in the code), each compiled as its own source unit.
// npm run build  -> writes build/OrbitPay.json, build/OrbitPayVaults.json and build/OrbitPayTestTokens.json.
// Gates: the sources, the creation and runtime code of OrbitPay and of the factory, and the vault's init code hash must
// equal the fingerprints below, and the code must hold no PUSH0 (0x5f), which Wanchain does not support, counted by an
// opcode walk (negative control: the same walk over a shanghai compile must find PUSH0). Nothing is written unless
// every gate passes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const solc = require('solc');
const { keccak256 } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const OP_SOL = path.join(ROOT, 'contracts/OrbitPay.sol');
const VAULTS_SOL = path.join(ROOT, 'contracts/OrbitPayVaults.sol');
const TOKENS_SOL = path.join(ROOT, 'contracts/OrbitPayTestTokens.sol');
const BUILD = path.join(ROOT, 'build');
const OP_JSON = path.join(BUILD, 'OrbitPay.json');
const VAULTS_JSON = path.join(BUILD, 'OrbitPayVaults.json');
const TOKENS_JSON = path.join(BUILD, 'OrbitPayTestTokens.json');

const EXPECT = {
  orbitpay_source_sha256: 'b28d6a933392e51a03129b60fb00a75082feb8f57968bd38987d28e79bc996a8',
  vaults_source_sha256: '9615f557888bccf506072bdcecce322890306c80df6585ab1a23702dcc117c37',
  tokens_source_sha256: '4aa11bab9130411ee296d9367330629dc2e446a8b33cbaa0a918d64a0f50dbf5',
  orbitpay_initcode_sha256: 'c97e054712ba4e528506542a7cf764545148ccb2b3d4d3a3f21d96a89323f50c',
  orbitpay_runtime_sha256: '5c0db33208171974742c5e6c75077f17df768a5658c4d79023f71de9ae8727c4',
  factory_initcode_sha256: '367ecd9ad3d9c2a167f664a5d2c7b8426b6f71902cd6d2784e623773de83e920',
  factory_runtime_sha256: '09429fe2c59a8deb780ea44c608cf608814a25207e1c9970c3ac32f6b6893c73',
  vault_initcode_keccak256: '0x03383ce1d6fce1a6342517da603ef6473a1c0e72c12127006a1f413be468a9a9',
};
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' };
const VAULTS_SETTINGS = { ...SETTINGS, metadata: { bytecodeHash: 'none', appendCBOR: false } };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// sha256 over the code bytes (not the hex text)
const codeSha = (hex) => sha256(Buffer.from(hex.replace(/^0x/, ''), 'hex'));

// Standard JSON compile of one source unit; returns { name: output } for every contract in it.
function compile(unitName, source, settings, evmVersion = settings.evmVersion) {
  const input = {
    language: 'Solidity',
    sources: { [unitName]: { content: source } },
    settings: {
      ...settings,
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
// OrbitPay's trailing CBOR metadata is walked too; it cannot hide a real 0x5f instruction, and in practice holds none.
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

const art = (c) => ({
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
  immutableReferences: c.evm.deployedBytecode.immutableReferences,
});

function buildOrbitPay(source, evmVersion) {
  return art(compile('OrbitPay.sol', source, SETTINGS, evmVersion).OrbitPay);
}

function buildVaults(source, evmVersion) {
  const cs = compile('OrbitPayVaults.sol', source, VAULTS_SETTINGS, evmVersion);
  return { OrbitPayVaultFactory: art(cs.OrbitPayVaultFactory), OrbitPayVault: art(cs.OrbitPayVault) };
}

function buildTokens(source) {
  const cs = compile('OrbitPayTestTokens.sol', source, SETTINGS);
  const pick = (n) => ({ abi: cs[n].abi, bytecode: '0x' + cs[n].evm.bytecode.object });
  return { MockToken: pick('MockToken'), NoReturnToken: pick('NoReturnToken'), FalseToken: pick('FalseToken') };
}

function main() {
  const log = (s) => console.log(s);
  let fail = null;
  const mark = (ok) => (ok ? 'MATCH' : 'MISMATCH');
  const opSrc = fs.readFileSync(OP_SOL, 'utf8');
  const vSrc = fs.readFileSync(VAULTS_SOL, 'utf8');
  const tokSrc = fs.readFileSync(TOKENS_SOL, 'utf8');
  const opSha = sha256(opSrc), vSha = sha256(vSrc), tokSha = sha256(tokSrc);
  log(`compiler ${solc.version()}`);
  log(`settings OrbitPay.sol       ${JSON.stringify(SETTINGS)}`);
  log(`settings OrbitPayVaults.sol ${JSON.stringify(VAULTS_SETTINGS)}`);
  log(`source_sha256 OrbitPay.sol           ${opSha} ${mark(opSha === EXPECT.orbitpay_source_sha256)}`);
  log(`source_sha256 OrbitPayVaults.sol     ${vSha} ${mark(vSha === EXPECT.vaults_source_sha256)}`);
  log(`source_sha256 OrbitPayTestTokens.sol ${tokSha} ${mark(tokSha === EXPECT.tokens_source_sha256)}`);
  if (opSha !== EXPECT.orbitpay_source_sha256 || vSha !== EXPECT.vaults_source_sha256 || tokSha !== EXPECT.tokens_source_sha256) fail = 'SOURCE_MISMATCH';

  const op = buildOrbitPay(opSrc);
  const v = buildVaults(vSrc);
  const f = v.OrbitPayVaultFactory, vault = v.OrbitPayVault;
  const got = {
    orbitpay_initcode_sha256: codeSha(op.bytecode), orbitpay_runtime_sha256: codeSha(op.deployedBytecode),
    factory_initcode_sha256: codeSha(f.bytecode), factory_runtime_sha256: codeSha(f.deployedBytecode),
    vault_initcode_keccak256: keccak256(vault.bytecode),
  };
  const size = (h) => `(${(h.length - 2) / 2} bytes)`;
  log(`OrbitPay initcode sha256 ${got.orbitpay_initcode_sha256} ${mark(got.orbitpay_initcode_sha256 === EXPECT.orbitpay_initcode_sha256)} ${size(op.bytecode)}`);
  log(`OrbitPay runtime  sha256 ${got.orbitpay_runtime_sha256} ${mark(got.orbitpay_runtime_sha256 === EXPECT.orbitpay_runtime_sha256)} ${size(op.deployedBytecode)}`);
  log(`factory  initcode sha256 ${got.factory_initcode_sha256} ${mark(got.factory_initcode_sha256 === EXPECT.factory_initcode_sha256)} ${size(f.bytecode)}`);
  log(`factory  runtime  sha256 ${got.factory_runtime_sha256} ${mark(got.factory_runtime_sha256 === EXPECT.factory_runtime_sha256)} ${size(f.deployedBytecode)}`);
  log(`vault init code hash keccak256 ${got.vault_initcode_keccak256} ${mark(got.vault_initcode_keccak256 === EXPECT.vault_initcode_keccak256)} ${size(vault.bytecode)}`);
  if (!fail && Object.keys(got).some((k) => got[k] !== EXPECT[k])) fail = 'BUILD_MISMATCH';
  const slots = (a) => { const n = Object.keys(a.immutableReferences).length; return `${n} immutable${n === 1 ? '' : 's'}, ${Object.values(a.immutableReferences).flat().length} slots`; };
  log(`immutableReferences: OrbitPay ${slots(op)}; factory ${slots(f)}; vault ${slots(vault)}`);

  const codes = [['OrbitPay', op], ['factory', f], ['vault', vault]];
  const p0 = codes.map(([n, a]) => [n, push0Count(a.bytecode), push0Count(a.deployedBytecode)]);
  const sop = buildOrbitPay(opSrc, 'shanghai'), sv = buildVaults(vSrc, 'shanghai');
  const s0 = [['OrbitPay', sop], ['factory', sv.OrbitPayVaultFactory], ['vault', sv.OrbitPayVault]]
    .map(([n, a]) => [n, push0Count(a.bytecode), push0Count(a.deployedBytecode)]);
  const p0ok = p0.every(([, i, r]) => i === 0 && r === 0);
  const s0ok = s0.every(([, i, r]) => i + r >= 1);
  log(`PUSH0 paris    ${p0.map(([n, i, r]) => `${n} ${i}/${r}`).join(', ')} (initcode/runtime) ${p0ok ? 'PASS' : 'FAIL'}`);
  log(`PUSH0 shanghai ${s0.map(([n, i, r]) => `${n} ${i}/${r}`).join(', ')} (negative control, each needs >=1) ${s0ok ? 'PASS' : 'FAIL'}`);
  if (!fail && (!p0ok || !s0ok)) fail = 'BUILD_MISMATCH';

  const t = buildTokens(tokSrc);
  log(`test tokens: MockToken ${size(t.MockToken.bytecode)}, NoReturnToken ${size(t.NoReturnToken.bytecode)}, FalseToken ${size(t.FalseToken.bytecode)} initcode`);

  if (fail) { log('BUILD ' + fail + ' (no artifacts written)'); process.exitCode = 1; return; }
  const opOut = { compiler: solc.version(), settings: SETTINGS, source: 'OrbitPay.sol', source_sha256: opSha,
    initcode_sha256: got.orbitpay_initcode_sha256, runtime_sha256: got.orbitpay_runtime_sha256, ...op };
  const vOut = { compiler: solc.version(), settings: VAULTS_SETTINGS, source: 'OrbitPayVaults.sol', source_sha256: vSha,
    factory_initcode_sha256: got.factory_initcode_sha256, factory_runtime_sha256: got.factory_runtime_sha256,
    vault_initcode_keccak256: got.vault_initcode_keccak256, ...v };
  const tokOut = { compiler: solc.version(), settings: SETTINGS, source: 'OrbitPayTestTokens.sol', source_sha256: tokSha, ...t };
  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(OP_JSON, JSON.stringify(opOut, null, 1) + '\n');
  fs.writeFileSync(VAULTS_JSON, JSON.stringify(vOut, null, 1) + '\n');
  fs.writeFileSync(TOKENS_JSON, JSON.stringify(tokOut, null, 1) + '\n');
  log(`wrote ${[OP_JSON, VAULTS_JSON, TOKENS_JSON].map((p) => path.relative(ROOT, p)).join(', ')}`);
  log('BUILD PASS');
}

module.exports = { compile, buildOrbitPay, buildVaults, buildTokens, push0Count, codeSha, sha256, EXPECT, SETTINGS, VAULTS_SETTINGS,
  OP_SOL, VAULTS_SOL, TOKENS_SOL, OP_JSON, VAULTS_JSON, TOKENS_JSON };
if (require.main === module) main();
