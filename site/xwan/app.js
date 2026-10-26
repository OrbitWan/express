'use strict';
// xWAN Express: sell xWAN to the desk for WAN, or buy xWAN from the sell desk's stock for WAN.
// The page asks the wallet to sign three kinds of transaction, each to the fixed addresses below:
//   approve(desk, amount) on the xWAN token, for exactly the amount being sold, only when the allowance is short;
//   sell(amount) on the desk, after a dry run on the node and a fresh quote;
//   buy(minXwan) on the sell desk, paying the WAN entered, with minXwan the quote shown (displayed to 6 decimals), after
//   a fresh quote and a dry run; the sell desk passes the WAN to the desk in the same transaction.
// Every transaction names chain 888, and the page reads the wallet's chain again just before it sends.
// Before a wallet connects, reads go to Wanchain's public RPC; after, through the wallet. Nothing else leaves the page.
(() => {
  const { Interface, parseUnits, formatUnits } = window.ethers;
  const W = window.Wallet;

  // One release: the page, shared/style.css, shared/wallet.js and this file carry one release id, and every file link
  // in the page carries ?v= and the first 8 hex of that file's sha256, so a new page never takes an old file from a
  // cache. A browser may still hold the previous page for a few minutes while the site already answers with the new
  // files: on a mismatch the page loads itself once more under an address no cache holds (?r=), then runs with what
  // it has. A matching page drops ?r from the address bar.
  const BUILD = 'b50014525';
  {
    const u = new URL(location.href);
    const css = getComputedStyle(document.documentElement).getPropertyValue('--build').trim();
    if (document.documentElement.dataset.build !== BUILD || css !== BUILD || !W || W.BUILD !== BUILD) {
      if (u.searchParams.get('r') !== BUILD) { u.searchParams.set('r', BUILD); location.replace(u.href); return; }
    } else if (u.searchParams.has('r')) {
      u.searchParams.delete('r');
      history.replaceState(null, '', u.href);
    }
  }

  const CHAIN_ID = 888;
  const RPC = 'https://gwan-ssl.wandevs.org:56891';
  const DESK = '0xcC0ba524134d9625B97569626106B671e6c492f2';
  const XWAN = '0x2eA407Aa69be7367BF231E76B51fab9eC436766c';
  const SELL = '0x9cB5d522C16e2A52330156c2e6b31DdE4bF9E90c'; // the sell desk: buyers get xWAN from its stock
  const EXPLORER = 'https://orbitwan.io';
  const RPC_TIMEOUT_MS = 15000;  // a public RPC read that takes longer counts as unread
  const WAIT_MS = 300000;        // how long to wait for a sent transaction's receipt before saying it is unconfirmed
  const GAS_RESERVE = parseUnits('0.01', 18); // WAN a buy leaves in the wallet for gas; MAX leaves it too
  const ONE = parseUnits('1', 18);
  const MAX_AMOUNT = parseUnits('1000000000', 18); // above any supply: a larger amount is not valid

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
  const sellDesk = new Interface([
    'function price() view returns (uint256)',
    'function quote(uint256 wanAmount) view returns (uint256)',
    'function buy(uint256 minXwan) payable returns (uint256)',
    'event Bought(address indexed buyer, uint256 wanAmount, uint256 xwanAmount, uint256 price)',
    'error Closed()', 'error ZeroOut()', 'error BelowMinimum()', 'error ShortStock()', 'error TransferFailed()', 'error Reentrant()',
  ]);

  const $ = (id) => document.getElementById(id);
  const s = {
    account: null, onChain: false,                 // wallet
    rate: null, deskWan: null,                      // desk, null = not read
    xwan: null, wan: null, allowance: null,         // the connected account, null = not read
    amount: null, quote: null,                      // amount: bigint, 'bad' or null; quote belongs to amount
    approvedNow: false, busy: '', note: null,       // note: { text, kind, hash }
    price: null, stock: null,                       // sell desk: price and xWAN stock, null = not read
    bamount: null, bquote: null, bnote: null,       // the buy card: WAN amount (bigint, 'bad' or null), its quote, its note
    busyCard: '',                                   // 'sell' or 'buy': the card whose transaction s.busy describes
    readFailed: false,                              // the last read failed: an unread figure shows a dash, else a blank
  };
  const setNote = (card, n) => { if (card === 'buy') s.bnote = n; else s.note = n; };

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

  // The reads of one refresh go out at once: through the wallet side by side, or to the public RPC as one JSON-RPC
  // batch, one request on one connection (measured 25 Oct 2026: that RPC is HTTP/1.1, about 0.55 s to open a
  // connection and 0.18 s a call, and it answers a batch of nine in the time of one read). A reply without a result
  // fails the refresh.
  async function readAll(reqs) {
    if (s.account && s.onChain) return Promise.all(reqs.map(([method, params]) => W.eth().request({ method, params })));
    const body = reqs.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error('rpc batch error');
    return body.map(({ id }) => {
      const r = j.find((x) => x && x.id === id);
      if (!r || r.error || r.result === undefined) throw new Error('rpc batch error');
      return r.result;
    });
  }
  const ec = (to, iface, fn, args = []) => ['eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']];
  const dc = (iface, fn, data) => iface.decodeFunctionResult(fn, data)[0];

  async function refresh() {
    const acct = s.account && s.onChain ? s.account : null, amount = s.amount, bamount = s.bamount;
    try {
      const reqs = [ec(DESK, desk, 'rate'), ['eth_getBalance', [DESK, 'latest']], ec(SELL, sellDesk, 'price'),
        ec(XWAN, token, 'balanceOf', [SELL])];
      if (acct) reqs.push(ec(XWAN, token, 'balanceOf', [acct]), ['eth_getBalance', [acct, 'latest']],
        ec(XWAN, token, 'allowance', [acct, DESK]));
      if (typeof amount === 'bigint') reqs.push(ec(DESK, desk, 'quote', [amount]));
      if (typeof bamount === 'bigint') reqs.push(ec(SELL, sellDesk, 'quote', [bamount]));
      const r = await readAll(reqs);
      s.rate = dc(desk, 'rate', r[0]); s.deskWan = BigInt(r[1]);
      s.price = dc(sellDesk, 'price', r[2]); s.stock = dc(token, 'balanceOf', r[3]);
      let i = 4;
      if (acct) {
        const x = dc(token, 'balanceOf', r[i++]), w = BigInt(r[i++]), al = dc(token, 'allowance', r[i++]);
        if (s.account === acct) { s.xwan = x; s.wan = w; s.allowance = al; } // the account changed meanwhile: dropped
      }
      // a quote belongs to its amount: one that arrives after the amount changed is dropped
      if (typeof amount === 'bigint') { const q = dc(desk, 'quote', r[i++]); if (s.amount === amount) s.quote = q; }
      if (typeof bamount === 'bigint') { const q = dc(sellDesk, 'quote', r[i++]); if (s.bamount === bamount) s.bquote = q; }
      s.readFailed = false;
      if (s.note && s.note.kind === 'read') s.note = null;
      if (s.bnote && s.bnote.kind === 'read') s.bnote = null;
    } catch (e) {
      s.readFailed = true;
      s.rate = s.deskWan = s.quote = null;
      s.price = s.stock = s.bquote = null;
      s.note = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' };
      s.bnote = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' };
    }
    render();
  }

  // ---- wallet ------------------------------------------------------------------------------------
  async function syncWallet() {
    if (!W.eth()) { s.account = null; s.onChain = false; return; }
    const before = s.account;
    s.account = (await W.accounts())[0] || null;
    s.onChain = s.account ? (await W.chainId()) === CHAIN_ID : false;
    // another account, or none: the previous account's balances leave the page at once
    if (!s.account || !s.onChain || s.account !== before) s.xwan = s.wan = s.allowance = null;
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
  // card: 'sell' or 'buy', whose button and note show the progress; value: WAN wei sent with the call (buy only).
  async function send(to, data, waiting, card, value) {
    // the wallet's chain is read again just before the send, and the transaction names Wanchain: a wallet moved to
    // another chain since the tap sends nothing
    if ((await W.chainId()) !== CHAIN_ID) throw new Error('the wallet is not on Wanchain');
    s.busy = 'Confirm in your wallet'; s.busyCard = card; render();
    const tx = { from: s.account, to, data, chainId: '0x' + CHAIN_ID.toString(16) };
    if (value) tx.value = '0x' + value.toString(16);
    const hash = await W.eth().request({ method: 'eth_sendTransaction', params: [tx] });
    s.busy = waiting; setNote(card, { text: 'Waiting for Wanchain.', kind: '', hash }); render();
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
    const r = await send(XWAN, token.encodeFunctionData('approve', [DESK, s.amount]), 'Approving', 'sell');
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
    const r = await send(DESK, data, 'Selling', 'sell');
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

  async function buy() {
    const amount = s.bamount, shown = s.bquote;
    const fresh = await call(SELL, sellDesk, 'quote', [amount]);
    if (fresh !== shown) {
      s.bquote = fresh;
      s.bnote = { text: 'The price changed. Check the new amount, then buy again.', kind: 'bad' };
      return refresh();
    }
    const data = sellDesk.encodeFunctionData('buy', [shown]); // the least xWAN accepted: the quote shown
    try {
      // dry run: a buy that would fail never reaches the wallet
      await rpc('eth_call', [{ from: s.account, to: SELL, data, value: '0x' + amount.toString(16) }, 'latest']);
    } catch (e) {
      s.bnote = { text: buyRevertText(e), kind: 'bad' };
      return refresh();
    }
    const r = await send(SELL, data, 'Buying', 'buy', amount);
    s.busy = '';
    if (r.ok === null) { s.bnote = unconfirmed(r.hash); return refresh(); }
    if (!r.ok) { s.bnote = { text: 'The purchase failed. Nothing was bought.', kind: 'bad', hash: r.hash }; return refresh(); }
    let bought = null;
    for (const log of r.rc.logs || []) {
      if (String(log.address).toLowerCase() !== SELL.toLowerCase()) continue;
      try { const p = sellDesk.parseLog(log); if (p && p.name === 'Bought') bought = p.args; } catch (e) { /* not ours */ }
    }
    s.bnote = bought
      ? { text: `Bought ${fmt(bought.xwanAmount)} xWAN for ${fmt(bought.wanAmount)} WAN.`, kind: 'good', hash: r.hash }
      : { text: 'Bought.', kind: 'good', hash: r.hash };
    s.bamount = null; s.bquote = null; $('bamount').value = '';
    await refresh();
  }

  function buyRevertText(e) {
    const hex = [e?.data, e?.data?.data, e?.data?.originalError?.data, e?.error?.data]
      .find((d) => typeof d === 'string' && d.startsWith('0x'));
    let name = null;
    try { if (hex) name = sellDesk.parseError(hex).name; } catch (err) { /* unknown error */ }
    if (name === 'Closed') return 'The desk is closed. Nothing was sent.';
    if (name === 'ZeroOut') return 'The amount is too small. Nothing was sent.';
    if (name === 'BelowMinimum') return 'The price changed. Nothing was sent.';
    if (name === 'ShortStock') return 'The desk is short of xWAN. Nothing was sent.';
    return 'The purchase would fail. Nothing was sent.';
  }

  // ---- what the button does ----------------------------------------------------------------------
  // While a transaction waits, the card that sent it shows its progress and neither button does anything.
  function action(card) {
    const a = card === 'buy' ? buyStep() : sellStep();
    if (!s.busy) return a;
    return card === s.busyCard ? { text: s.busy } : { text: a.text };
  }
  function walletStep() {
    if (!W.eth()) return { text: 'Open in MetaMask', run: () => { location.href = W.metamaskLink(); } };
    if (!s.account) return { text: 'Connect wallet', run: connect };
    if (!s.onChain) return { text: 'Switch to Wanchain', run: switchChain };
    return null;
  }
  function buyStep() {
    const w = walletStep();
    if (w) return w;
    if (s.price === null || s.stock === null || s.wan === null) return { text: 'Reading Wanchain' };
    if (s.price === 0n) return { text: 'Desk closed' };
    if (s.bamount === 'bad') return { text: 'Enter a valid amount' };
    if (s.bamount === null || s.bamount === 0n) return { text: 'Enter an amount' };
    if (s.bamount + GAS_RESERVE > s.wan) return { text: 'Not enough WAN' };
    if (s.bquote === null) return { text: 'Reading Wanchain' };
    if (s.bquote === 0n) return { text: 'Amount too small' };
    if (s.bquote > s.stock) return { text: 'Desk short of xWAN' };
    return { text: 'Buy xWAN', run: buy };
  }
  function sellStep() {
    const w = walletStep();
    if (w) return w;
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

  // From the tap on, both buttons are disabled until the step ends, so a second tap opens no second wallet prompt.
  async function onClick(card) {
    const a = action(card);
    if (!a.run || s.busy) return;
    setNote(card, null);
    s.busy = a.text; s.busyCard = card; render();
    try { await a.run(); }
    catch (e) {
      s.busy = '';
      setNote(card, W.rejected(e)
        ? { text: 'Cancelled in your wallet.', kind: 'bad' }
        : { text: card === 'buy' ? 'Something went wrong. Nothing was bought.' : 'Something went wrong. Nothing was sold.', kind: 'bad' });
      await syncWallet().catch(() => {});
      await refresh();
    }
    finally { s.busy = ''; render(); }
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
    // a figure not read yet is blank while the page reads it; a dash means only that Wanchain could not be read
    const none = s.readFailed ? '-' : '';
    $('bal').textContent = s.xwan === null ? none : `${fmt(s.xwan)} xWAN`;

    const amt = typeof s.amount === 'bigint' ? s.amount : null;
    $('out').textContent = amt === null ? '0' : s.quote === null ? none : fmt(s.quote);
    $('rate').textContent = s.rate === null ? none : s.rate === 0n ? 'Closed' : `1 xWAN = ${fmt(s.rate)} WAN`;
    $('desk').textContent = s.deskWan === null ? none : `${fmt(s.deskWan)} WAN`;

    $('bbalrow').hidden = $('bmax').hidden = !(s.account && s.onChain);
    $('bbal').textContent = s.wan === null ? none : `${fmt(s.wan)} WAN`;
    const bamt = typeof s.bamount === 'bigint' ? s.bamount : null;
    $('bout').textContent = bamt === null ? '0' : s.bquote === null ? none : fmt(s.bquote);
    $('price').textContent = s.price === null ? none : s.price === 0n ? 'Closed' : `1 WAN = ${fmt(ONE * ONE / s.price)} xWAN`; // what 1 WAN buys: the desk's quote, rounded down
    $('stock').textContent = s.stock === null ? none : `${fmt(s.stock)} xWAN`;

    for (const [card, go, note, n0] of [['sell', 'go', 'note', s.note], ['buy', 'bgo', 'bnote', s.bnote]]) {
      const a = action(card);
      $(go).textContent = a.text;
      $(go).disabled = !a.run;
      const n = $(note);
      const kind = n0 ? (n0.kind === 'read' ? 'bad' : n0.kind) : '';
      n.className = kind ? `note ${kind}` : 'note';
      n.textContent = n0 ? n0.text : '';
      if (n0 && n0.hash) {
        const link = document.createElement('a');
        link.href = `${EXPLORER}/tx/${n0.hash}`; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = 'View transaction';
        n.append(' ', link);
      }
    }
  }

  // ---- input -------------------------------------------------------------------------------------
  let quoteTimer = null, quoteSeq = 0;
  function onInput() {
    const v = $('amount').value.trim().replace(',', '.');
    s.quote = null;
    if (!v) s.amount = null;
    else if (!/^\d*\.?\d*$/.test(v) || v === '.') s.amount = 'bad';
    else { try { s.amount = parseUnits(v, 18); if (s.amount > MAX_AMOUNT) s.amount = 'bad'; } catch (e) { s.amount = 'bad'; } }
    if (s.note && s.note.kind !== 'read') s.note = null;
    render();
    clearTimeout(quoteTimer);
    if (typeof s.amount !== 'bigint' || s.amount === 0n) return;
    const seq = ++quoteSeq, amount = s.amount;
    quoteTimer = setTimeout(async () => {
      try {
        const q = await call(DESK, desk, 'quote', [amount]);
        if (seq === quoteSeq) { s.quote = q; render(); }
      } catch (e) { if (seq === quoteSeq) { s.readFailed = true; s.note = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' }; render(); } }
    }, 250);
  }

  // the buy card: the WAN entered, quoted on the sell desk
  let bquoteTimer = null, bquoteSeq = 0;
  function onBuyInput() {
    const v = $('bamount').value.trim().replace(',', '.');
    s.bquote = null;
    if (!v) s.bamount = null;
    else if (!/^[0-9]*[.]?[0-9]*$/.test(v) || v === '.') s.bamount = 'bad';
    else { try { s.bamount = parseUnits(v, 18); if (s.bamount > MAX_AMOUNT) s.bamount = 'bad'; } catch (e) { s.bamount = 'bad'; } }
    if (s.bnote && s.bnote.kind !== 'read') s.bnote = null;
    render();
    clearTimeout(bquoteTimer);
    if (typeof s.bamount !== 'bigint' || s.bamount === 0n) return;
    const seq = ++bquoteSeq, amount = s.bamount;
    bquoteTimer = setTimeout(async () => {
      try {
        const q = await call(SELL, sellDesk, 'quote', [amount]);
        if (seq === bquoteSeq) { s.bquote = q; render(); }
      } catch (e) { if (seq === bquoteSeq) { s.readFailed = true; s.bnote = { text: 'Wanchain could not be read. Trying again shortly.', kind: 'read' }; render(); } }
    }, 250);
  }
  // MAX: the WAN balance less GAS_RESERVE, and no more than the whole stock costs
  function buyMax() {
    if (s.wan === null || s.price === null || s.stock === null) return;
    let v = s.wan > GAS_RESERVE ? s.wan - GAS_RESERVE : 0n;
    if (s.price > 0n && s.stock * s.price / ONE < v) v = s.stock * s.price / ONE;
    $('bamount').value = exact(v); onBuyInput();
  }

  $('amount').addEventListener('input', onInput);
  $('max').addEventListener('click', () => { if (s.xwan !== null) { $('amount').value = exact(s.xwan); onInput(); } });
  $('go').addEventListener('click', () => onClick('sell'));
  $('bamount').addEventListener('input', onBuyInput);
  $('bmax').addEventListener('click', buyMax);
  $('bgo').addEventListener('click', () => onClick('buy'));
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
