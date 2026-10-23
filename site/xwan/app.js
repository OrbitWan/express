'use strict';
// xWAN Express: sell xWAN to the desk for WAN.
// The page asks the wallet to sign two kinds of transaction, both to the fixed addresses below:
//   approve(desk, amount) on the xWAN token, for exactly the amount being sold, only when the allowance is short;
//   sell(amount) on the desk, after a dry run on the node and a fresh quote.
// Before a wallet connects, reads go to Wanchain's public RPC; after, through the wallet. Nothing else leaves the page.
(() => {
  const { Interface, parseUnits, formatUnits } = window.ethers;
  const W = window.Wallet;

  const CHAIN_ID = 888;
  const RPC = 'https://gwan-ssl.wandevs.org:56891';
  const DESK = '0xcC0ba524134d9625B97569626106B671e6c492f2';
  const XWAN = '0x2eA407Aa69be7367BF231E76B51fab9eC436766c';
  const EXPLORER = 'https://orbitwan.io';
  const RPC_TIMEOUT_MS = 15000;  // a public RPC read that takes longer counts as unread
  const WAIT_MS = 300000;        // how long to wait for a sent transaction's receipt before saying it is unconfirmed

  const desk = new Interface([
    'function rate() view returns (uint256)',
    'function quote(uint256 xwanAmount) view returns (uint256)',
    'function sell(uint256 xwanAmount) returns (uint256)',
    'event Sold(address indexed seller, uint256 xwanAmount, uint256 wanAmount, uint256 rate)',
    'error Closed()', 'error ZeroPayout()', 'error TransferFailed()', 'error Reentrant()',
  ]);
  const token = new Interface([
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);

  const $ = (id) => document.getElementById(id);
  const s = {
    account: null, onChain: false,                 // wallet
    rate: null, deskWan: null,                      // desk, null = not read
    xwan: null, wan: null, allowance: null,         // the connected account, null = not read
    amount: null, quote: null,                      // amount: bigint, 'bad' or null; quote belongs to amount
    approvedNow: false, busy: '', note: null,       // note: { text, kind, hash }
  };

  // ---- chain reads -------------------------------------------------------------------------------
  let rpcId = 0;
  async function rpc(method, params) {
    if (s.account && s.onChain) return W.eth().request({ method, params });
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data });
    return j.result;
  }
  async function call(to, iface, fn, args = []) {
    const data = await rpc('eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']);
    return iface.decodeFunctionResult(fn, data)[0];
  }
  const balance = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));

  async function refresh() {
    try {
      [s.rate, s.deskWan] = await Promise.all([call(DESK, desk, 'rate'), balance(DESK)]);
      if (s.account && s.onChain) {
        [s.xwan, s.wan, s.allowance] = await Promise.all([
          call(XWAN, token, 'balanceOf', [s.account]), balance(s.account),
          call(XWAN, token, 'allowance', [s.account, DESK])]);
      }
      if (typeof s.amount === 'bigint') s.quote = await call(DESK, desk, 'quote', [s.amount]);
      if (s.note && s.note.kind === 'read') s.note = null;
    } catch (e) {
      s.rate = s.deskWan = s.quote = null;
      s.note = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' };
    }
    render();
  }

  // ---- wallet ------------------------------------------------------------------------------------
  async function syncWallet() {
    if (!W.eth()) { s.account = null; s.onChain = false; return; }
    s.account = (await W.accounts())[0] || null;
    s.onChain = s.account ? (await W.chainId()) === CHAIN_ID : false;
    if (!s.account || !s.onChain) s.xwan = s.wan = s.allowance = null;
  }
  async function connect() { await W.connect(); await syncWallet(); await refresh(); }
  async function switchChain() { await W.switchToWanchain(); await syncWallet(); await refresh(); }
  // The page forgets the account at once and reads the public RPC again; the wallet is asked to end the site's access too.
  async function disconnect() {
    W.disconnect();
    s.approvedNow = false; s.note = { text: 'Disconnected.', kind: '' };
    await syncWallet(); await refresh();
  }

  // Sends one transaction through the wallet and waits up to WAIT_MS for its receipt. Once the wallet has sent it, only a
  // receipt decides the outcome: a failed read is asked again, and no receipt in time returns ok: null, never a failure.
  async function send(to, data, waiting) {
    s.busy = 'Confirm in your wallet'; render();
    const hash = await W.eth().request({ method: 'eth_sendTransaction', params: [{ from: s.account, to, data }] });
    s.busy = waiting; s.note = { text: 'Waiting for Wanchain.', kind: '', hash }; render();
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const rc = await W.eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (rc) return { hash, ok: rc.status === '0x1', rc };
      } catch (e) { /* not read this time: ask again */ }
    }
    return { hash, ok: null };
  }
  const unconfirmed = (hash) => ({ text: 'Sent, but Wanchain has not confirmed it yet. Check it before trying again.', kind: 'bad', hash });

  async function approve() {
    const r = await send(XWAN, token.encodeFunctionData('approve', [DESK, s.amount]), 'Approving');
    s.busy = '';
    if (r.ok === null) { s.note = unconfirmed(r.hash); return refresh(); }
    if (!r.ok) { s.note = { text: 'The approval failed. Nothing was sold.', kind: 'bad', hash: r.hash }; return refresh(); }
    s.approvedNow = true;
    s.note = null;
    await refresh();
  }

  async function sell() {
    const amount = s.amount, shown = s.quote;
    const fresh = await call(DESK, desk, 'quote', [amount]);
    if (fresh !== shown) {
      s.quote = fresh;
      s.note = { text: 'The rate changed. Check the new amount, then sell again.', kind: 'bad' };
      return refresh();
    }
    const data = desk.encodeFunctionData('sell', [amount]);
    try {
      await rpc('eth_call', [{ from: s.account, to: DESK, data }, 'latest']); // dry run: a sale that would fail never reaches the wallet
    } catch (e) {
      s.note = { text: revertText(e), kind: 'bad' };
      return refresh();
    }
    const r = await send(DESK, data, 'Selling');
    s.busy = '';
    if (r.ok === null) { s.note = unconfirmed(r.hash); return refresh(); }
    if (!r.ok) { s.note = { text: 'The sale failed. Nothing was sold.', kind: 'bad', hash: r.hash }; return refresh(); }
    let sold = null;
    for (const log of r.rc.logs || []) {
      if (String(log.address).toLowerCase() !== DESK.toLowerCase()) continue;
      try { const p = desk.parseLog(log); if (p && p.name === 'Sold') sold = p.args; } catch (e) { /* not ours */ }
    }
    s.note = sold
      ? { text: `Sold ${fmt(sold.xwanAmount)} xWAN for ${fmt(sold.wanAmount)} WAN.`, kind: 'good', hash: r.hash }
      : { text: 'Sold.', kind: 'good', hash: r.hash };
    s.amount = null; s.quote = null; s.approvedNow = false; $('amount').value = '';
    await refresh();
  }

  function revertText(e) {
    // wallets and nodes put the revert data in different places
    const hex = [e?.data, e?.data?.data, e?.data?.originalError?.data, e?.error?.data]
      .find((d) => typeof d === 'string' && d.startsWith('0x'));
    let name = null;
    try { if (hex) name = desk.parseError(hex).name; } catch (err) { /* unknown error */ }
    if (name === 'Closed') return 'The desk is closed. Nothing was sent.';
    if (name === 'ZeroPayout') return 'The amount is too small. Nothing was sent.';
    return 'The sale would fail. Nothing was sent.';
  }

  // ---- what the button does ----------------------------------------------------------------------
  function action() {
    if (s.busy) return { text: s.busy };
    if (!W.eth()) return { text: 'Open in MetaMask', run: () => { location.href = W.metamaskLink(); } };
    if (!s.account) return { text: 'Connect wallet', run: connect };
    if (!s.onChain) return { text: 'Switch to Wanchain', run: switchChain };
    if (s.rate === null || s.deskWan === null || s.xwan === null) return { text: 'Reading Wanchain' };
    if (s.rate === 0n) return { text: 'Desk closed' };
    if (s.amount === 'bad') return { text: 'Enter a valid amount' };
    if (s.amount === null || s.amount === 0n) return { text: 'Enter an amount' };
    if (s.amount > s.xwan) return { text: 'Not enough xWAN' };
    if (s.quote === null) return { text: 'Reading Wanchain' };
    if (s.quote === 0n) return { text: 'Amount too small' };
    if (s.quote > s.deskWan) return { text: 'Desk short of WAN' };
    if (s.wan === 0n) return { text: 'No WAN for gas' };
    if (s.allowance < s.amount) return { text: 'Approve xWAN (1 of 2)', run: approve };
    return { text: s.approvedNow ? 'Sell xWAN (2 of 2)' : 'Sell xWAN', run: sell };
  }

  async function onClick() {
    const a = action();
    if (!a.run) return;
    s.note = null;
    try { await a.run(); }
    catch (e) {
      s.busy = '';
      s.note = W.rejected(e)
        ? { text: 'Cancelled in your wallet.', kind: 'bad' }
        : { text: 'Something went wrong. Nothing was sold.', kind: 'bad' };
      await syncWallet().catch(() => {});
      await refresh();
    }
  }

  // ---- display -----------------------------------------------------------------------------------
  function fmt(wei, dp = 6) {
    if (wei === null || wei === undefined) return '-';
    let [i, f = ''] = formatUnits(wei, 18).split('.');
    f = f.slice(0, dp).replace(/0+$/, '');
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (wei > 0n && i === '0' && !f) return `< 0.${'0'.repeat(dp - 1)}1`; // never show a real amount as 0
    return f ? `${i}.${f}` : i;
  }
  const exact = (wei) => formatUnits(wei, 18).replace(/\.0$/, '');
  const short = (a) => `${a.slice(0, 6)}\u2026${a.slice(-4)}`;
  // the header's account chip opens a menu that holds Disconnect; it closes on a choice, Escape or a press elsewhere
  const menu = (open) => { $('menu').hidden = !open; $('acct').setAttribute('aria-expanded', open ? 'true' : 'false'); };

  function render() {
    $('acct').textContent = s.account ? short(s.account) : '';
    $('acct').hidden = !s.account;
    $('acct').disabled = !!s.busy;
    if (!s.account || s.busy) menu(false);
    $('balrow').hidden = $('max').hidden = !(s.account && s.onChain);
    $('bal').textContent = s.xwan === null ? '-' : `${fmt(s.xwan)} xWAN`;

    const amt = typeof s.amount === 'bigint' ? s.amount : null;
    $('out').textContent = amt === null ? '0' : s.quote === null ? '-' : fmt(s.quote);
    $('rate').textContent = s.rate === null ? '-' : s.rate === 0n ? 'Closed' : `1 xWAN = ${fmt(s.rate)} WAN`;
    $('desk').textContent = s.deskWan === null ? '-' : `${fmt(s.deskWan)} WAN`;

    const a = action();
    $('go').textContent = a.text;
    $('go').disabled = !a.run;

    const n = $('note');
    const kind = s.note ? (s.note.kind === 'read' ? 'bad' : s.note.kind) : '';
    n.className = kind ? `note ${kind}` : 'note';
    n.textContent = s.note ? s.note.text : '';
    if (s.note && s.note.hash) {
      const link = document.createElement('a');
      link.href = `${EXPLORER}/tx/${s.note.hash}`; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'View transaction';
      n.append(' ', link);
    }
  }

  // ---- input -------------------------------------------------------------------------------------
  let quoteTimer = null, quoteSeq = 0;
  function onInput() {
    const v = $('amount').value.trim().replace(',', '.');
    s.quote = null;
    if (!v) s.amount = null;
    else if (!/^\d*\.?\d*$/.test(v) || v === '.') s.amount = 'bad';
    else { try { s.amount = parseUnits(v, 18); } catch (e) { s.amount = 'bad'; } }
    if (s.note && s.note.kind !== 'read') s.note = null;
    render();
    clearTimeout(quoteTimer);
    if (typeof s.amount !== 'bigint' || s.amount === 0n) return;
    const seq = ++quoteSeq, amount = s.amount;
    quoteTimer = setTimeout(async () => {
      try {
        const q = await call(DESK, desk, 'quote', [amount]);
        if (seq === quoteSeq) { s.quote = q; render(); }
      } catch (e) { if (seq === quoteSeq) { s.note = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' }; render(); } }
    }, 250);
  }

  $('amount').addEventListener('input', onInput);
  $('max').addEventListener('click', () => { if (s.xwan !== null) { $('amount').value = exact(s.xwan); onInput(); } });
  $('go').addEventListener('click', onClick);
  $('acct').addEventListener('click', (e) => { e.stopPropagation(); menu($('menu').hidden); });
  $('disc').addEventListener('click', () => { menu(false); disconnect().catch(() => {}); });
  document.addEventListener('click', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) menu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu(false); });
  W.on('accountsChanged', async () => { s.approvedNow = false; await syncWallet().catch(() => {}); await refresh(); });
  W.on('chainChanged', async () => { await syncWallet().catch(() => {}); await refresh(); });
  setInterval(() => { if (!document.hidden && !s.busy) refresh(); }, 30000);

  render();
  syncWallet().catch(() => {}).then(refresh);
})();
