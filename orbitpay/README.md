# OrbitPay

Prepaid credit for OrbitWan's paid API and MCP calls, on Wanchain. Deposit wanUSDT or wanUSDC and OrbitWan credits the wallet you name. Operated by [OrbitWan](https://orbitwan.io).

## Contracts

| | |
|---|---|
| OrbitPay | [0x4bB94280136F3CB2D2d4cB3a27a91E8C7Eac90AE](https://orbitwan.io/address/0x4bb94280136f3cb2d2d4cb3a27a91e8c7eac90ae) |
| Vault factory (`OrbitPayVaultFactory`) | [0xf94b24605CAE326ead104Db1e5322988998215E0](https://orbitwan.io/address/0xf94b24605cae326ead104db1e5322988998215e0) |
| Network | Wanchain mainnet, chain id 888 |
| Accepted tokens | wanUSDT [0x11e77E27Af5539872efEd10abaA0b408cfd9fBBD](https://orbitwan.io/token/0x11e77e27af5539872efed10abaa0b408cfd9fbbd), wanUSDC [0x52A9CEA01c4CBDd669883e41758B8eB8e8E2B34b](https://orbitwan.io/token/0x52a9cea01c4cbdd669883e41758b8eb8e8e2b34b) |
| Treasury | [0x2193360d55Da460dFf00245457d3d33E40352bcE](https://orbitwan.io/address/0x2193360d55da460dff00245457d3d33e40352bce) |
| Deployed | OrbitPay block 46006998 ([transaction](https://orbitwan.io/tx/0xebb24dceaaa27abfa874c339521fa4fee12b5bfbf5f57b82143a36af2a6e359f)), factory block 46019519 ([transaction](https://orbitwan.io/tx/0x59b96a0409c1e3c1f5e07357692f29ae16b6d0c88ad0cc08ea0f51f18c1127c4)) |

## How it works

1. Call `approve(OrbitPay, amount)` on wanUSDT or wanUSDC.
2. Call `deposit(token, amount)` to credit yourself, or `depositFor(token, amount, wallet)` to credit another wallet. In the same transaction the tokens go straight to the treasury and the contract emits `Deposited(beneficiary, token, amount)`. OrbitWan credits the beneficiary from that event.
3. The minimum deposit is 1 token (both tokens have 6 decimals). Any other token reverts, and so does WAN sent to OrbitPay. A plain token transfer to OrbitPay is not a deposit and is not credited: it stays in OrbitPay until the treasury sweeps it.

The credit is a balance OrbitWan keeps off chain for the wallet named in `Deposited`. It is spent by signing requests with that wallet's key (EIP-191, see https://orbitwan.io/docs/orbitpay). Name a wallet whose key you hold: credit to a contract wallet, an exchange address, the zero address or a mistyped address can never be spent. A deposit cannot be withdrawn or refunded on chain.

## Paying from another chain

Every wallet has its own vault address on Wanchain, fixed before the vault even exists: `vaultOf(wallet)` on the factory. Bridge wanUSDT or wanUSDC to Wanchain with the vault as the receiving address. The vault is on Wanchain only: tokens sent to the same address on any other chain never reach it. Before sending, check that the vault address you were given equals `vaultOf(wallet)` on the factory.

Anyone can then call `collect(wallet, token)` on the factory: it deploys the vault if needed, and the vault deposits its whole balance of that token into OrbitPay for that wallet. While the vault holds less than 1 token of it, `collect` reverts.

OrbitWan calls `collect` for you once you have asked it for your vault at `https://orbitwan.io/idx/vault/<your wallet>`: from then on it checks the vault about every 30 seconds and collects its wanUSDT and its wanUSDC, each once the vault holds at least 1 token of it. Anyone else can call `collect` too; it costs WAN for gas.

A vault has no owner, and its wanUSDT and wanUSDC can only go into OrbitPay, credited to its wallet. Send it nothing else: WAN or any other token that reaches a vault address can never be moved out.

## What the treasury can do

- `sweep(token, to)`: send OrbitPay's whole balance of any token, wanUSDT and wanUSDC included, to any address. Deposits never stay in OrbitPay, so only tokens transferred to it directly can be there. The source comment says it "Cannot touch the whitelist": it cannot change which tokens are accepted, but it can move any token OrbitPay holds.

Nothing else on chain. The treasury, the two accepted tokens and the factory's OrbitPay address are fixed at deploy. None of the three contracts (OrbitPay, the factory and the vaults) can be upgraded, and the factory and the vaults have no owner. Crediting is off chain: OrbitWan reads `Deposited` and credits the wallet, and the contracts cannot enforce it.

## Verify it yourself

Needs Node.js 18 or later. From the repo root, `cd orbitpay`, then:

```
npm install
npm test
npm run verify
```

- `npm test` compiles both contracts with solc 0.8.36 (optimizer 200 runs, EVM version paris, because Wanchain does not support PUSH0; the vault factory and vault without metadata, as deployed), checks the fingerprints below except the two "on chain" lines, and runs 30 checks on a local chain with the test-only tokens in `contracts/OrbitPayTestTokens.sol`. On some Node.js versions ganache first prints a warning that a uWS binary does not match your Node.js build; it is harmless and the tests run.
- `npm run verify` reads OrbitPay and the factory from Wanchain mainnet and checks that their code is this source, byte for byte, including the two "on chain" fingerprints, and that the factory's vault addresses come from the vault init code hash below. It uses Wanchain's public RPC, https://gwan-ssl.wandevs.org:56891; set `RPC_URL` to use your own node. Only `VERIFY PASS` is a pass. `VERIFY FAIL` means the code differs; `VERIFY ERROR` means the check could not finish, most often because the RPC could not be read.

Fingerprints, sha256:

```
contracts/OrbitPay.sol                                b28d6a933392e51a03129b60fb00a75082feb8f57968bd38987d28e79bc996a8
contracts/OrbitPayVaults.sol                          9615f557888bccf506072bdcecce322890306c80df6585ab1a23702dcc117c37
OrbitPay creation code, before constructor arguments  c97e054712ba4e528506542a7cf764545148ccb2b3d4d3a3f21d96a89323f50c
OrbitPay runtime code, immutables zeroed              5c0db33208171974742c5e6c75077f17df768a5658c4d79023f71de9ae8727c4
OrbitPay runtime code on chain                        6f1ab0570ec776dceedcfa3b80a2a9f377a3f3ed266797810b1c9ae9f5683df7
factory creation code, before constructor arguments   367ecd9ad3d9c2a167f664a5d2c7b8426b6f71902cd6d2784e623773de83e920
factory runtime code, immutables zeroed               09429fe2c59a8deb780ea44c608cf608814a25207e1c9970c3ac32f6b6893c73
factory runtime code on chain                         68043b5fdd8610d0cce632e0a4530de7df6bdf9d005c694de3498affa524e7de
```

Vault init code hash, keccak256, the one `vaultOf` uses:

```
0x03383ce1d6fce1a6342517da603ef6473a1c0e72c12127006a1f413be468a9a9
```

## License

MIT. See [LICENSE](LICENSE).
