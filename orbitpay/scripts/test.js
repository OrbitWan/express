#!/usr/bin/env node
'use strict';
// OrbitPay test suite: 30 checks on an in-process ganache chain (hardfork merge), then two negative controls.
// npm test   (npm runs the build first and the suite reads build/*.json)
// Every expected revert is checked twice: a static call whose decoded error name must match, and a real send that must fail.
// Negative controls, each a variant compiled in memory: OrbitPay with its minimum lowered to 0.1 token (check 7 must
// FAIL there), and a vault that credits its caller instead of its wallet (check 21 must FAIL there).
const fs = require('fs');
const ganache = require('ganache');
const { ethers } = require('ethers');
const B = require('./build.js');

const T = (x) => ethers.parseUnits(String(x), 6);   // token amounts, 6 decimals like wanUSDT and wanUSDC
const GAS = { gasLimit: 3000000n };                 // deploys
const TXG = { gasLimit: 1000000n };                 // calls
const DEPOSITED_TOPIC = '0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7';

function decodeErr(e, ifaces) {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  const hex = typeof data === 'string' ? data : data?.data;
  if (!hex || hex === '0x') return '(empty)';
  for (const i of ifaces) { try { const p = i.parseError(hex); if (p) return p.name; } catch {} }
  return hex.slice(0, 10);
}

async function suite(op, vaults, tokens, shanghai) {
  const g = ganache.provider({ chain: { hardfork: 'merge', chainId: 1337 }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const [deployer, payer, treasuryS, other, stranger, benS] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const [DEPLOYER, PAYER, TREASURY, OTHER, STRANGER, BEN] = await Promise.all([deployer, payer, treasuryS, other, stranger, benS].map((s) => s.getAddress()));
  const F = vaults.OrbitPayVaultFactory, V = vaults.OrbitPayVault;
  const opI = new ethers.Interface(op.abi), fI = new ethers.Interface(F.abi), vI = new ethers.Interface(V.abi);
  const ifaces = [opI, fI, vI];
  const results = [];
  const check = (n, desc, ok, detail = '') => { results.push({ n, desc, ok: !!ok, detail }); };
  const events = (rcpt, iface, name, address) => rcpt.logs
    .filter((l) => !address || l.address.toLowerCase() === address.toLowerCase())
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter((x) => x?.name === name);

  // Expected revert: static call must throw with error `name`, real send (explicit gasLimit) must fail.
  async function expectRevert(name, staticFn, sendFn) {
    let got = 'no revert', staticOk = false, sendOk = false;
    try { await staticFn(); } catch (e) { got = decodeErr(e, ifaces); staticOk = got === name; }
    try { const tx = await sendFn(); const r = await tx.wait(); sendOk = r.status === 0; }
    catch (e) { sendOk = e.code === 'CALL_EXCEPTION' || /revert|invalid opcode/i.test(e.message || ''); }
    return { ok: staticOk && sendOk, detail: `static: ${got}, send failed: ${sendOk}` };
  }
  const deployToken = async (k) => (await (await new ethers.ContractFactory(tokens[k].abi, tokens[k].bytecode, deployer).deploy(GAS)).waitForDeployment());
  const usdt = await deployToken('MockToken'), usdc = await deployToken('MockToken'), stray = await deployToken('MockToken');
  const noret = await deployToken('NoReturnToken'), falsy = await deployToken('FalseToken');
  const [USDT, USDC, STRAY, NORET, FALSY] = await Promise.all([usdt, usdc, stray, noret, falsy].map((c) => c.getAddress()));
  for (const tk of [usdt, usdc, stray]) await (await tk.mint(PAYER, T(100), TXG)).wait();

  const opF = new ethers.ContractFactory(op.abi, op.bytecode, deployer);
  const initFor = (f, a, args) => a.bytecode + f.interface.encodeDeploy(args).slice(2);

  // 1-2 constructor guards
  let r = await expectRevert('(empty)',
    () => provider.call({ from: DEPLOYER, data: initFor(opF, op, [ethers.ZeroAddress, USDT, USDC]) }),
    () => deployer.sendTransaction({ data: initFor(opF, op, [ethers.ZeroAddress, USDT, USDC]), ...GAS }));
  check(1, 'OrbitPay constructor rejects a zero treasury [require, empty revert]', r.ok, r.detail);
  r = await expectRevert('(empty)',
    () => provider.call({ from: DEPLOYER, data: initFor(opF, op, [TREASURY, ethers.ZeroAddress, USDC]) }),
    () => deployer.sendTransaction({ data: initFor(opF, op, [TREASURY, ethers.ZeroAddress, USDC]), ...GAS }));
  const r2 = await expectRevert('(empty)',
    () => provider.call({ from: DEPLOYER, data: initFor(opF, op, [TREASURY, USDT, ethers.ZeroAddress]) }),
    () => deployer.sendTransaction({ data: initFor(opF, op, [TREASURY, USDT, ethers.ZeroAddress]), ...GAS }));
  check(2, 'OrbitPay constructor rejects a zero usdt and a zero usdc [require, empty revert]', r.ok && r2.ok, `usdt: ${r.detail}; usdc: ${r2.detail}`);

  const p = await (await opF.deploy(TREASURY, USDT, USDC, GAS)).waitForDeployment();
  const OP = await p.getAddress();
  const pp = p.connect(payer), pst = p.connect(stranger);
  check(3, 'treasury, owner, usdt and usdc stored as given, owner = treasury',
    (await p.treasury()) === TREASURY && (await p.owner()) === TREASURY && (await p.usdt()) === USDT && (await p.usdc()) === USDC);
  check(4, 'Deposited topic0 is 0x8752a472...', opI.getEvent('Deposited').topicHash === DEPOSITED_TOPIC);

  // 5-7 refusals
  r = await expectRevert('TransferFailed', () => pp.deposit.staticCall(USDT, T(1)), () => pp.deposit(USDT, T(1), TXG));
  check(5, 'deposit without approval reverts [TransferFailed]', r.ok, r.detail);
  await (await stray.connect(payer).approve(OP, T(10), TXG)).wait();
  r = await expectRevert('TokenNotWhitelisted', () => pp.deposit.staticCall(STRAY, T(5)), () => pp.deposit(STRAY, T(5), TXG));
  check(6, 'deposit of a token not on the list reverts [TokenNotWhitelisted]', r.ok, r.detail);
  await (await usdt.connect(payer).approve(OP, T(50), TXG)).wait();
  r = await expectRevert('AmountTooLow', () => pp.deposit.staticCall(USDT, 999999n), () => pp.deposit(USDT, 999999n, TXG));
  check(7, 'deposit of 0.999999 token reverts [AmountTooLow]', r.ok, r.detail);

  // 8-10 deposits
  const b0 = { p: await usdt.balanceOf(PAYER), t: await usdt.balanceOf(TREASURY) };
  const d1 = await (await pp.deposit(USDT, T(1), TXG)).wait();
  check(8, 'deposit of exactly 1 token: payer -1, treasury +1, OrbitPay holds none',
    b0.p - (await usdt.balanceOf(PAYER)) === T(1) && (await usdt.balanceOf(TREASURY)) - b0.t === T(1) && (await usdt.balanceOf(OP)) === 0n);
  const e1 = events(d1, opI, 'Deposited', OP);
  check(9, 'one Deposited(payer, usdt, 1 token)', e1.length === 1 && e1[0].args.beneficiary === PAYER && e1[0].args.token === USDT && e1[0].args.amount === T(1));
  await (await usdc.connect(payer).approve(OP, T('2.5'), TXG)).wait();
  const c0 = await usdc.balanceOf(PAYER);
  const d2 = await (await pp.depositFor(USDC, T('2.5'), BEN, TXG)).wait();
  const e2 = events(d2, opI, 'Deposited', OP);
  check(10, 'depositFor(usdc, 2.5, wallet): the caller pays, the treasury receives, Deposited names the wallet',
    c0 - (await usdc.balanceOf(PAYER)) === T('2.5') && (await usdc.balanceOf(TREASURY)) === T('2.5')
    && e2.length === 1 && e2[0].args.beneficiary === BEN && e2[0].args.token === USDC && e2[0].args.amount === T('2.5'));

  // 11-12 token return values, on a second OrbitPay accepting a no-return token and a false-returning token
  const p2 = await (await opF.deploy(TREASURY, NORET, FALSY, GAS)).waitForDeployment();
  const OP2 = await p2.getAddress();
  await (await noret.mint(PAYER, T(5), TXG)).wait();
  await (await noret.connect(payer).approve(OP2, T(5), TXG)).wait();
  const d3 = await (await p2.connect(payer).deposit(NORET, T(2), TXG)).wait();
  check(11, 'a token whose transferFrom returns nothing deposits',
    d3.status === 1 && (await noret.balanceOf(TREASURY)) === T(2) && events(d3, opI, 'Deposited', OP2).length === 1);
  await (await falsy.mint(PAYER, T(5), TXG)).wait();
  r = await expectRevert('TransferFailed', () => p2.connect(payer).deposit.staticCall(FALSY, T(2)), () => p2.connect(payer).deposit(FALSY, T(2), TXG));
  check(12, 'a token whose transferFrom returns false is refused [TransferFailed]', r.ok, r.detail);

  // 13-14 sweep
  await (await stray.connect(payer).transfer(OP, T(3), TXG)).wait();
  r = await expectRevert('NotTreasury', () => pst.sweep.staticCall(STRAY, STRANGER), () => pst.sweep(STRAY, STRANGER, TXG));
  check(13, 'sweep by anyone but the treasury reverts [NotTreasury]', r.ok, r.detail);
  await (await usdt.connect(payer).transfer(OP, T(2), TXG)).wait();
  await (await p.connect(treasuryS).sweep(STRAY, OTHER, TXG)).wait();
  await (await p.connect(treasuryS).sweep(USDT, OTHER, TXG)).wait();
  check(14, 'the treasury sweeps tokens sent to OrbitPay directly, an accepted token too, to the address it names',
    (await stray.balanceOf(OP)) === 0n && (await stray.balanceOf(OTHER)) === T(3)
    && (await usdt.balanceOf(OP)) === 0n && (await usdt.balanceOf(OTHER)) === T(2));

  // 15-16 factory
  const fF = new ethers.ContractFactory(F.abi, F.bytecode, deployer);
  r = await expectRevert('(empty)',
    () => provider.call({ from: DEPLOYER, data: initFor(fF, F, [ethers.ZeroAddress]) }),
    () => deployer.sendTransaction({ data: initFor(fF, F, [ethers.ZeroAddress]), ...GAS }));
  check(15, 'factory constructor rejects a zero OrbitPay [require, empty revert]', r.ok, r.detail);
  const f = await (await fF.deploy(OP, GAS)).waitForDeployment();
  const FAC = await f.getAddress();
  const fst = f.connect(stranger);
  const par0 = await f.parameters();
  check(16, 'factory stores OrbitPay, parameters() reads zero', (await f.orbitpay()) === OP && par0[0] === ethers.ZeroAddress && par0[1] === ethers.ZeroAddress);

  // 17-19 the vault address
  const VAULT = await f.vaultOf(BEN);
  const want = ethers.getCreate2Address(FAC, ethers.zeroPadValue(BEN, 32), B.EXPECT.vault_initcode_keccak256);
  check(17, 'vaultOf(wallet) is the CREATE2 address of the vault init code hash 0x03383ce1...', VAULT === want, `vaultOf ${VAULT}, computed ${want}`);
  check(18, 'the vault address holds no code before the first collect', (await provider.getCode(VAULT)) === '0x');
  await (await usdt.connect(payer).transfer(VAULT, 999999n, TXG)).wait();
  r = await expectRevert('AmountTooLow', () => fst.collect.staticCall(BEN, USDT), () => fst.collect(BEN, USDT, TXG));
  check(19, 'collect with less than 1 token in the vault reverts [AmountTooLow] and deploys nothing',
    r.ok && (await provider.getCode(VAULT)) === '0x', r.detail);

  // 20-22 first collect, by a stranger
  await (await usdt.connect(payer).transfer(VAULT, T('4.000001'), TXG)).wait();
  const inVault = await usdt.balanceOf(VAULT);
  const s0 = { s: await usdt.balanceOf(STRANGER), t: await usdt.balanceOf(TREASURY) };
  const c1 = await (await fst.collect(BEN, USDT, TXG)).wait();
  const dep = events(c1, fI, 'VaultDeployed', FAC), col = events(c1, fI, 'Collected', FAC);
  check(20, 'a stranger\'s collect deploys the vault at vaultOf(wallet) [VaultDeployed, Collected]',
    (await provider.getCode(VAULT)) !== '0x' && dep.length === 1 && dep[0].args.beneficiary === BEN && dep[0].args.vault === VAULT
    && col.length === 1 && col[0].args.beneficiary === BEN && col[0].args.token === USDT && col[0].args.vault === VAULT);
  const e3 = events(c1, opI, 'Deposited', OP);
  check(21, 'it credits the wallet: Deposited(wallet, usdt, the whole balance), the treasury receives it, the vault is empty',
    e3.length === 1 && e3[0].args.beneficiary === BEN && e3[0].args.token === USDT && e3[0].args.amount === inVault
    && (await usdt.balanceOf(TREASURY)) - s0.t === inVault && (await usdt.balanceOf(VAULT)) === 0n
    && (await usdt.balanceOf(STRANGER)) === s0.s, `in vault ${inVault}`);
  const vc = new ethers.Contract(VAULT, V.abi, stranger);
  const par1 = await f.parameters();
  check(22, 'the vault knows OrbitPay and its wallet, and parameters() is cleared again',
    (await vc.orbitpay()) === OP && (await vc.beneficiary()) === BEN && par1[0] === ethers.ZeroAddress && par1[1] === ethers.ZeroAddress);

  // 23-25 later collects
  await (await usdc.mint(VAULT, T(7), TXG)).wait();
  const c2 = await (await f.connect(other).collect(BEN, USDC, TXG)).wait();
  const e4 = events(c2, opI, 'Deposited', OP);
  check(23, 'a second collect does not deploy again and credits the wallet again',
    events(c2, fI, 'VaultDeployed', FAC).length === 0 && e4.length === 1 && e4[0].args.beneficiary === BEN && e4[0].args.amount === T(7));
  await (await stray.connect(payer).transfer(VAULT, T(2), TXG)).wait();
  r = await expectRevert('TokenNotWhitelisted', () => fst.collect.staticCall(BEN, STRAY), () => fst.collect(BEN, STRAY, TXG));
  check(24, 'collect of a token not on the list reverts [TokenNotWhitelisted] and the token stays in the vault',
    r.ok && (await stray.balanceOf(VAULT)) === T(2), r.detail);
  await (await usdt.connect(payer).transfer(VAULT, T(3), TXG)).wait();
  const c3 = await (await vc.collect(USDT, TXG)).wait();
  const e5 = events(c3, opI, 'Deposited', OP);
  check(25, 'calling the vault\'s own collect directly credits only its wallet', e5.length === 1 && e5[0].args.beneficiary === BEN && e5[0].args.amount === T(3));

  // 26-28 what a vault cannot do
  const fns = V.abi.filter((x) => x.type === 'function').map((x) => x.name).sort().join(',');
  const extra = V.abi.filter((x) => x.type === 'receive' || x.type === 'fallback').length;
  check(26, 'a vault has no owner: its only functions are beneficiary, collect and orbitpay, no receive or fallback',
    fns === 'beneficiary,collect,orbitpay' && extra === 0, fns);
  let wanRefused = false;
  try { const tx = await other.sendTransaction({ to: VAULT, value: ethers.parseEther('1'), ...TXG }); wanRefused = (await tx.wait()).status === 0; }
  catch (e) { wanRefused = true; }
  const VAULT_O = await f.vaultOf(OTHER);
  await (await stranger.sendTransaction({ to: VAULT_O, value: ethers.parseEther('1'), ...TXG })).wait();
  await (await usdt.connect(payer).transfer(VAULT_O, T(1), TXG)).wait();
  const c4 = await (await fst.collect(OTHER, USDT, TXG)).wait();
  check(27, 'a WAN transfer to a deployed vault reverts; WAN sent to a vault address before the vault exists stays there after it is deployed',
    wanRefused && (await provider.getBalance(VAULT)) === 0n && events(c4, fI, 'VaultDeployed', FAC).length === 1
    && (await provider.getCode(VAULT_O)) !== '0x' && (await provider.getBalance(VAULT_O)) === ethers.parseEther('1'));
  const f2 = await (await fF.deploy(OP2, GAS)).waitForDeployment();
  const V2 = await f2.vaultOf(BEN);
  await (await falsy.mint(V2, T(2), TXG)).wait();
  r = await expectRevert('ApproveFailed', () => f2.connect(stranger).collect.staticCall(BEN, FALSY), () => f2.connect(stranger).collect(BEN, FALSY, TXG));
  check(28, 'a vault whose token refuses approve reverts [ApproveFailed]', r.ok, r.detail);

  // 29-30 hardfork fit: PUSH0 is not valid on this chain (merge = paris)
  let shFail = 0;
  for (const [a, args] of [[shanghai.op, [TREASURY, USDT, USDC]], [shanghai.factory, [OP]]]) {
    const init = a.bytecode + new ethers.Interface(a.abi).encodeDeploy(args).slice(2);
    let st = false, se = false;
    try { await provider.call({ from: DEPLOYER, data: init }); } catch { st = true; }
    try { const tx = await deployer.sendTransaction({ data: init, ...GAS }); se = (await tx.wait()).status === 0; } catch { se = true; }
    if (st && se) shFail++;
  }
  check(29, 'shanghai-compiled OrbitPay and factory both fail to deploy on this chain', shFail === 2, `failed ${shFail} of 2`);
  // The code each paris build deployed equals its compiled runtime, the immutables' bytes aside (zero in the build).
  const zeroImm = (hex, refs) => { const b = Buffer.from(hex.slice(2), 'hex'); for (const rs of Object.values(refs)) for (const x of rs) b.fill(0, x.start, x.start + x.length); return b.toString('hex'); };
  const same = [];
  for (const [a, art] of [[OP, op], [FAC, F], [VAULT, V]]) {
    const live = await provider.getCode(a);
    same.push(live.length > 2 && zeroImm(live, art.immutableReferences) === art.deployedBytecode.slice(2));
  }
  check(30, 'OrbitPay, the factory and a vault run exactly the build\'s runtime code, immutables aside', same.every(Boolean), same.join('/'));

  await g.disconnect();
  return results;
}

function report(res, label) {
  for (const x of res) console.log(`${label}${x.ok ? 'PASS' : 'FAIL'} ${String(x.n).padStart(2)} ${x.desc}${x.detail && !label ? '  (' + x.detail + ')' : ''}`);
}

async function main() {
  const op = JSON.parse(fs.readFileSync(B.OP_JSON, 'utf8'));
  const vaults = JSON.parse(fs.readFileSync(B.VAULTS_JSON, 'utf8'));
  const tokens = JSON.parse(fs.readFileSync(B.TOKENS_JSON, 'utf8'));
  if (B.codeSha(op.bytecode) !== B.EXPECT.orbitpay_initcode_sha256 || B.codeSha(vaults.OrbitPayVaultFactory.bytecode) !== B.EXPECT.factory_initcode_sha256
    || ethers.keccak256(vaults.OrbitPayVault.bytecode) !== B.EXPECT.vault_initcode_keccak256) throw new Error('ARTIFACT_MISMATCH');
  const opSrc = fs.readFileSync(B.OP_SOL, 'utf8'), vSrc = fs.readFileSync(B.VAULTS_SOL, 'utf8');
  const shanghai = { op: B.buildOrbitPay(opSrc, 'shanghai'), factory: B.buildVaults(vSrc, 'shanghai').OrbitPayVaultFactory };

  console.log('== OrbitPay tests (paris builds, build/*.json)');
  const res = await suite(op, vaults, tokens, shanghai);
  report(res, '');
  const pass = res.filter((x) => x.ok).length;
  console.log(`RESULT ${pass}/${res.length} PASS`);

  console.log('== Negative control 1: OrbitPay with a minimum of 0.1 token (in memory)');
  const v1src = opSrc.replace('if (amount < 1e6) revert AmountTooLow();', 'if (amount < 1e5) revert AmountTooLow();');
  if (v1src === opSrc) throw new Error('variant 1 substitution failed');
  const v1 = await suite(B.buildOrbitPay(v1src), vaults, tokens, shanghai);
  report(v1, '  variant 1 ');
  const n7 = v1.find((x) => x.n === 7);

  console.log('== Negative control 2: a vault that credits its caller instead of its wallet (in memory)');
  const v2src = vSrc.replace('IOrbitPay(orbitpay).depositFor(token, bal, beneficiary);', 'IOrbitPay(orbitpay).depositFor(token, bal, msg.sender);');
  if (v2src === vSrc) throw new Error('variant 2 substitution failed');
  const v2 = await suite(op, B.buildVaults(v2src), tokens, shanghai);
  report(v2, '  variant 2 ');
  const n21 = v2.find((x) => x.n === 21);

  const nc = !n7.ok && !n21.ok;
  console.log(`NEGATIVE CONTROLS check 7 on variant 1: ${n7.ok ? 'PASS' : 'FAIL'}, check 21 on variant 2: ${n21.ok ? 'PASS' : 'FAIL'} -> control ${nc ? 'OK (both FAIL as required)' : 'BROKEN'}`);
  const ok = pass === 30 && res.length === 30 && nc;
  console.log(ok ? 'TESTS PASS' : 'TESTS FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('TESTS ERROR ' + (e.stack || e)); process.exitCode = 1; });
