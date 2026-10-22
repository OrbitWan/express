'use strict';
// Wallet helpers shared by every OrbitWan Express dapp. They speak EIP-1193 to the wallet the browser provides
// (MetaMask or any compatible wallet) and never see a key: the wallet signs, the page only asks.
window.Wallet = (() => {
  const WANCHAIN = {
    chainId: '0x378', // 888
    chainName: 'Wanchain',
    nativeCurrency: { name: 'WAN', symbol: 'WAN', decimals: 18 },
    rpcUrls: ['https://gwan-ssl.wandevs.org:56891'],
    blockExplorerUrls: ['https://orbitwan.io'],
  };
  const eth = () => window.ethereum || null;

  async function accounts() { return eth() ? eth().request({ method: 'eth_accounts' }) : []; }
  async function connect() { return eth().request({ method: 'eth_requestAccounts' }); }
  async function chainId() { return parseInt(await eth().request({ method: 'eth_chainId' }), 16); }

  // Switch to Wanchain, adding it to the wallet first if the wallet does not know it (error 4902).
  async function switchToWanchain() {
    try {
      await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: WANCHAIN.chainId }] });
    } catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902) throw e;
      await eth().request({ method: 'wallet_addEthereumChain', params: [WANCHAIN] });
    }
  }

  function on(event, fn) { if (eth() && eth().on) eth().on(event, fn); }

  // On a phone without a wallet in the browser, this link opens the same page inside MetaMask's own browser.
  const metamaskLink = () => 'https://metamask.app.link/dapp/' + location.host + location.pathname;

  // True when the user declined in the wallet, as opposed to a failure.
  const rejected = (e) => !!e && (e.code === 4001 || e.code === 'ACTION_REJECTED' ||
    (e.info && e.info.error && e.info.error.code === 4001));

  return { WANCHAIN, eth, accounts, connect, chainId, switchToWanchain, on, metamaskLink, rejected };
})();
