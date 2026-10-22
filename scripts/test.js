#!/usr/bin/env node
'use strict';
// xWAN Express test suite: 30 checks on an in-process ganache chain (hardfork merge), then a negative control.
// npm test   (npm runs the build first and the suite reads build/*.json)
// Every expected revert is checked twice: a static call whose decoded error name must match, and a real send that must fail.
// Negative control: the suite reruns on an in-memory variant with MAX_RATE = 1.05e18; checks 18 and 19 must FAIL there.
const fs = require('fs');
const ganache = require('ganache');
const { ethers } = require('ethers');
const B = require('./build.js');

const E = (x) => ethers.parseEther(String(x));
const GAS = { gasLimit: 3000000n };        // deploys
const TXG = { gasLimit: 500000n };         // calls

function decodeErr(e, ifaces) {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  const hex = typeof data === 'string' ? data : data?.data;
  if (!hex || hex === '0x') return '(empty)';
  for (const i of ifaces) { try { const p = i.parseError(hex); if (p) return p.name; } catch {} }
  return hex.slice(0, 10);
}

async function suite(desk, tokens, shanghaiBytecode, label) {
  const g = ganache.provider({ chain: { hardfork: 'merge', chainId: 1337 }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const [admin, seller, treasuryS, other, stranger] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const TREASURY = await treasuryS.getAddress(), ADMIN = await admin.getAddress(), SELLER = await seller.getAddress();
  const deskI = new ethers.Interface(desk.abi);
  const results = [];
  const check = (n, desc, ok, detail = '') => { results.push({ n, desc, ok: !!ok, detail }); };

  // Expected revert: static call must throw with error `name`, real send (explicit gasLimit) must fail.
  async function expectRevert(name, staticFn, sendFn) {
    let got = 'no revert', staticOk = false, sendOk = false;
    try { await staticFn(); } catch (e) { got = decodeErr(e, [deskI]); staticOk = got === name; }
    try { const tx = await sendFn(); const r = await tx.wait(); sendOk = r.status === 0; }
    catch (e) { sendOk = e.code === 'CALL_EXCEPTION' || /revert|invalid opcode/i.test(e.message || ''); }
    return { ok: staticOk && sendOk, detail: `static: ${got}, send failed: ${sendOk}` };
  }

  const xwanF = new ethers.ContractFactory(tokens.MockXWAN.abi, tokens.MockXWAN.bytecode, admin);
  const xwan = await (await xwanF.deploy(GAS)).waitForDeployment();
  const XWAN = await xwan.getAddress();
  await (await xwan.mint(SELLER, E(100), TXG)).wait();
  const deskF = new ethers.ContractFactory(desk.abi, desk.bytecode, admin);
  const initFor = (args) => desk.bytecode + deskF.interface.encodeDeploy(args).slice(2);

  // 1-2 constructor guards
  let r = await expectRevert('RateTooHigh',
    () => provider.call({ from: ADMIN, data: initFor([XWAN, TREASURY, ADMIN, E('0.96')]) }),
    () => admin.sendTransaction({ data: initFor([XWAN, TREASURY, ADMIN, E('0.96')]), ...GAS }));
  check(1, 'constructor rejects rate 0.96 [RateTooHigh]', r.ok, r.detail);
  r = await expectRevert('(empty)',
    () => provider.call({ from: ADMIN, data: initFor([ethers.ZeroAddress, TREASURY, ADMIN, E('0.7')]) }),
    () => admin.sendTransaction({ data: initFor([ethers.ZeroAddress, TREASURY, ADMIN, E('0.7')]), ...GAS }));
  check(2, 'constructor rejects a zero xwan address [require, empty revert]', r.ok, r.detail);

  const d = await (await deskF.deploy(XWAN, TREASURY, ADMIN, E('0.7'), GAS)).waitForDeployment();
  const DESK = await d.getAddress();
  const ds = d.connect(seller), dst = d.connect(stranger);
  check(3, 'rate stored 0.7', (await d.rate()) === E('0.7'));
  check(4, 'treasury and admin stored as given', (await d.treasury()) === TREASURY && (await d.admin()) === ADMIN && (await d.xwan()) === XWAN);
  check(5, 'quote(10 XWAN) = 7 WAN', (await d.quote(E(10))) === E(7));

  // 6 funding
  const fr = await (await other.sendTransaction({ to: DESK, value: E(5), ...TXG })).wait();
  const funded = fr.logs.map((l) => { try { return deskI.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Funded');
  check(6, 'a plain WAN send funds the desk', (await provider.getBalance(DESK)) === E(5) && funded?.args.amount === E(5));

  // 7 no approval
  r = await expectRevert('TransferFailed', () => ds.sell.staticCall(E(1)), () => ds.sell(E(1), TXG));
  check(7, 'sell without approval reverts [TransferFailed]', r.ok, r.detail);

  // 8-9 desk short of WAN
  await (await xwan.connect(seller).approve(DESK, E(10), TXG)).wait();
  const s0 = { sx: await xwan.balanceOf(SELLER), tx: await xwan.balanceOf(TREASURY), dw: await provider.getBalance(DESK) };
  r = await expectRevert('TransferFailed', () => ds.sell.staticCall(E(10)), () => ds.sell(E(10), TXG));
  check(8, 'sell needing 7 WAN with 5 in the desk reverts [TransferFailed]', r.ok, r.detail);
  check(9, 'after it: seller keeps XWAN, treasury 0, desk unchanged',
    (await xwan.balanceOf(SELLER)) === s0.sx && (await xwan.balanceOf(TREASURY)) === 0n && (await provider.getBalance(DESK)) === s0.dw);

  // 10-14 a real sale of 1 XWAN
  const w0 = await provider.getBalance(SELLER);
  const sr = await (await ds.sell(E(1), TXG)).wait();
  const w1 = await provider.getBalance(SELLER);
  const fee = sr.gasUsed * sr.gasPrice;
  check(10, 'seller receives exactly 0.7 WAN for 1 XWAN, gas accounted', w1 - w0 + fee === E('0.7'), `delta ${w1 - w0} fee ${fee}`);
  check(11, 'treasury receives the 1 XWAN', (await xwan.balanceOf(TREASURY)) === E(1));
  check(12, 'desk holds no XWAN', (await xwan.balanceOf(DESK)) === 0n);
  check(13, 'desk WAN 5 to 4.3', (await provider.getBalance(DESK)) === E('4.3'));
  const sold = sr.logs.map((l) => { try { return deskI.parseLog(l); } catch { return null; } }).filter((x) => x?.name === 'Sold');
  check(14, 'Sold event carries 1 XWAN and 0.7 WAN', sold.length === 1 && sold[0].args.seller === SELLER && sold[0].args.xwanAmount === E(1) && sold[0].args.wanAmount === E('0.7') && sold[0].args.rate === E('0.7'));

  // 15 dust
  r = await expectRevert('ZeroPayout', () => ds.sell.staticCall(1n), () => ds.sell(1n, TXG));
  check(15, 'sell of 1 wei XWAN reverts [ZeroPayout]', r.ok, r.detail);

  // 16-21 rate
  r = await expectRevert('NotAdmin', () => dst.setRate.staticCall(E('0.8')), () => dst.setRate(E('0.8'), TXG));
  check(16, 'non-admin setRate reverts [NotAdmin]', r.ok, r.detail);
  await (await d.setRate(E('0.8'), TXG)).wait();
  check(17, 'admin sets 0.8', (await d.rate()) === E('0.8'));
  r = await expectRevert('RateTooHigh', () => d.setRate.staticCall(E('0.96')), () => d.setRate(E('0.96'), TXG));
  check(18, 'admin 0.96 rejected [RateTooHigh]', r.ok, r.detail);
  r = await expectRevert('RateTooHigh', () => d.setRate.staticCall(E('1')), () => d.setRate(E('1'), TXG));
  check(19, 'admin 1.0 rejected [RateTooHigh]', r.ok, r.detail);
  // the variant may have accepted 0.96 or 1.0 above; 20 still sets 0.95 explicitly
  await (await d.setRate(E('0.95'), TXG)).wait();
  check(20, 'admin 0.95 allowed', (await d.rate()) === E('0.95'));
  await (await d.setRate(0n, TXG)).wait();
  r = await expectRevert('Closed', () => ds.sell.staticCall(E(1)), () => ds.sell(E(1), TXG));
  check(21, 'sell while closed (rate 0) reverts [Closed]', r.ok && (await d.rate()) === 0n, r.detail);
  await (await d.setRate(E('0.7'), TXG)).wait();

  // 22-23 re-entrancy
  const reF = new ethers.ContractFactory(tokens.Reenter.abi, tokens.Reenter.bytecode, other);
  const re = await (await reF.deploy(DESK, XWAN, GAS)).waitForDeployment();
  const RE = await re.getAddress();
  await (await xwan.mint(RE, E(2), TXG)).wait();
  const s1 = { rx: await xwan.balanceOf(RE), tx: await xwan.balanceOf(TREASURY), dw: await provider.getBalance(DESK), rw: await provider.getBalance(RE) };
  r = await expectRevert('TransferFailed', () => re.go.staticCall(E(1)), () => re.go(E(1), TXG));
  check(22, 'a contract re-entering sell from its receive reverts the whole call [TransferFailed]', r.ok, r.detail);
  check(23, 'after it nothing moved',
    (await xwan.balanceOf(RE)) === s1.rx && (await xwan.balanceOf(TREASURY)) === s1.tx && (await provider.getBalance(DESK)) === s1.dw
    && (await provider.getBalance(RE)) === s1.rw && (await re.tried()) === false);

  // 24-25 stray tokens
  await (await xwan.connect(seller).transfer(DESK, E(3), TXG)).wait();
  r = await expectRevert('NotAdmin', () => dst.sweepToken.staticCall(XWAN), () => dst.sweepToken(XWAN, TXG));
  check(24, 'non-admin sweepToken reverts [NotAdmin]', r.ok, r.detail);
  const t0 = await xwan.balanceOf(TREASURY);
  await (await d.sweepToken(XWAN, TXG)).wait();
  check(25, 'admin sweepToken sends stray XWAN to the treasury', (await xwan.balanceOf(DESK)) === 0n && (await xwan.balanceOf(TREASURY)) - t0 === E(3));

  // 26-28 sweep WAN
  r = await expectRevert('NotAdmin', () => dst.sweep.staticCall(), () => dst.sweep(TXG));
  check(26, 'non-admin sweep reverts [NotAdmin]', r.ok, r.detail);
  const dw = await provider.getBalance(DESK), tw = await provider.getBalance(TREASURY);
  await (await d.sweep(TXG)).wait();
  check(27, 'admin sweep sends all desk WAN to the treasury', (await provider.getBalance(DESK)) === 0n && (await provider.getBalance(TREASURY)) - tw === dw && dw > 0n);
  r = await expectRevert('TransferFailed', () => ds.sell.staticCall(E(1)), () => ds.sell(E(1), TXG));
  check(28, 'sell with an empty desk reverts [TransferFailed]', r.ok, r.detail);

  // 29-30 hardfork fit: PUSH0 is not valid on this chain (merge = paris)
  const shInit = shanghaiBytecode + deskF.interface.encodeDeploy([XWAN, TREASURY, ADMIN, E('0.7')]).slice(2);
  let shStatic = false, shSend = false;
  try { await provider.call({ from: ADMIN, data: shInit }); } catch { shStatic = true; }
  try { const tx = await admin.sendTransaction({ data: shInit, ...GAS }); const rr = await tx.wait(); shSend = rr.status === 0; } catch { shSend = true; }
  check(29, 'a shanghai-compiled desk fails to deploy on this chain', shStatic && shSend, `static failed: ${shStatic}, send failed: ${shSend}`);
  const d2 = await (await deskF.deploy(XWAN, TREASURY, ADMIN, E('0.7'), GAS)).waitForDeployment();
  const code2 = await provider.getCode(await d2.getAddress());
  check(30, 'the paris build deploys on it', code2.length > 2 && (await d2.rate()) === E('0.7'), `runtime ${(code2.length - 2) / 2} bytes`);

  await g.disconnect();
  return results;
}

async function main() {
  const desk = JSON.parse(fs.readFileSync(B.DESK_JSON, 'utf8'));
  const tokens = JSON.parse(fs.readFileSync(B.TOKENS_JSON, 'utf8'));
  const src = fs.readFileSync(B.DESK_SOL, 'utf8');
  if (desk.initcode_sha256 !== B.EXPECT.initcode_sha256 || B.codeSha(desk.bytecode) !== B.EXPECT.initcode_sha256) throw new Error('ARTIFACT_MISMATCH');
  const shanghai = B.buildDesk(src, 'shanghai');

  console.log('== xWAN Express tests (paris build, build/XwanDesk.json)');
  const res = await suite(desk, tokens, shanghai.bytecode, 'main');
  for (const x of res) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${String(x.n).padStart(2)} ${x.desc}${x.detail ? '  (' + x.detail + ')' : ''}`);
  const pass = res.filter((x) => x.ok).length;
  console.log(`RESULT ${pass}/${res.length} PASS`);

  console.log('== Negative control: MAX_RATE = 1.05e18 variant (in memory)');
  const vsrc = src.replace('MAX_RATE = 0.95e18', 'MAX_RATE = 1.05e18');
  if (vsrc === src) throw new Error('variant substitution failed');
  const variant = B.buildDesk(vsrc);
  const vres = await suite(variant, tokens, shanghai.bytecode, 'variant');
  for (const x of vres) console.log(`  variant ${x.ok ? 'PASS' : 'FAIL'} ${String(x.n).padStart(2)} ${x.desc}`);
  const v18 = vres.find((x) => x.n === 18), v19 = vres.find((x) => x.n === 19);
  const nc = !v18.ok && !v19.ok;
  console.log(`NEGATIVE CONTROL checks 18 and 19 on the variant: ${v18.ok ? 'PASS' : 'FAIL'} / ${v19.ok ? 'PASS' : 'FAIL'} -> control ${nc ? 'OK (both FAIL as required)' : 'BROKEN'}`);

  const ok = pass === 30 && res.length === 30 && nc;
  console.log(ok ? 'TESTS PASS' : 'TESTS FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('TESTS ERROR ' + (e.stack || e)); process.exitCode = 1; });
