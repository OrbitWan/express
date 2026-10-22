# xWAN Express

A fixed-rate desk on Wanchain: sell it xWAN and it pays you WAN in the same transaction. Operated by [OrbitWan](https://orbitwan.io).

## Contract

| | |
|---|---|
| xWAN Express (`XwanDesk`) | [0xcC0ba524134d9625B97569626106B671e6c492f2](https://orbitwan.io/address/0xcc0ba524134d9625b97569626106b671e6c492f2) |
| Network | Wanchain mainnet, chain id 888 |
| xWAN token | [0x2eA407Aa69be7367BF231E76B51fab9eC436766c](https://orbitwan.io/address/0x2ea407aa69be7367bf231e76b51fab9ec436766c) |
| Treasury | [0x2c68767042BE27E922b5Cf279f73E42361daD306](https://orbitwan.io/address/0x2c68767042be27e922b5cf279f73e42361dad306) |
| Admin | [0x484A01495358BC46a90Cbf4208dFAdaee9e3C5Cf](https://orbitwan.io/address/0x484a01495358bc46a90cbf4208dfadaee9e3c5cf) |
| Deployed | block 46612835, [transaction](https://orbitwan.io/tx/0x27271302a4a361c768b442aef19a93f5a44267f94ca1ac511e4bbf760b495794) |

## How it works

1. Call `approve(desk, amount)` on the xWAN token.
2. Call `sell(amount)` on the desk. In the same transaction it sends your xWAN to the treasury and pays you `quote(amount)` WAN.
3. If the desk is closed or holds too little WAN, the sale reverts and you keep your xWAN.

`rate()` is the WAN paid per 1 xWAN, in wei. `sell` takes no minimum: the rate in force when it runs applies. A plain xWAN transfer to the desk is not a sale and is not paid.

## What the admin can do

- `setRate`: from 0 (closed) to 0.95 WAN per xWAN. The cap is fixed in the code and stays below 1 because WAN converts to xWAN 1:1 on XFlows ([Wanchain docs](https://docs.wanchain.org/cross-chain-infrastructure/wan-coin/xwan)).
- `sweep`: send all WAN in the desk to the treasury.
- `sweepToken`: send any token sent to the desk by mistake to the treasury.

Nothing else. The admin and the treasury are each a single key. The xWAN token, treasury and admin are fixed at deploy, and the contract cannot be upgraded.

## Verify it yourself

Needs Node.js 18 or later. From the repo root, `cd xwan`, then:

```
npm install
npm test
npm run verify
```

- `npm test` compiles the contract with solc 0.8.36 (optimizer 200 runs, EVM version paris, because Wanchain does not support PUSH0), checks the fingerprints below and runs 30 checks on a local chain with the test-only contracts in `contracts/XwanDeskTestTokens.sol`.
- `npm run verify` reads the desk from Wanchain mainnet and checks that its code is this source, byte for byte. It uses Wanchain's public RPC, https://gwan-ssl.wandevs.org:56891; set `RPC_URL` to use your own node. `VERIFY ERROR` means the RPC could not be read, not that the code differs.

Fingerprints, sha256:

```
contracts/XwanDesk.sol                       745fb91a3d1ac235ef3f783e8fc84a1b5451dc6355e19c349c246e585abb7f8b
creation code, before constructor arguments  de2dfd8045a1220c404881ae379ab17df669127d12ab31b3e9855a5e03bc9efa
runtime code, immutables zeroed              27fa87b434ef30bc81dbd4153cbfad959fb9df1d077da91855eb78425a99391a
runtime code on chain                        d0a3305192202237d47cdda0187328da1b18cb0bee946e09f38c506c25a0fd4f
```

## License

MIT. See [LICENSE](LICENSE).
