# OrbitWan Express

Contracts and dapps on Wanchain, by [OrbitWan](https://orbitwan.io). Each contract folder holds the exact source of a live contract (the test-only contracts beside it say so at the top), and each page is served from this repo exactly as committed.

| | Contract | Dapp |
|---|---|---|
| xWAN Express | [xwan/](xwan/) | https://express.orbitwan.io |
| OrbitPay | [orbitpay/](orbitpay/) | |
| xLend | [OrbitWan/xlend](https://github.com/OrbitWan/xlend) | https://xlend.orbitwan.io |

## The site

[`site/`](site/) is published to https://express.orbitwan.io by [`.github/workflows/pages.yml`](.github/workflows/pages.yml). There is no build step: the files are served exactly as they are here.

- The pages load nothing from other sites. Their only network calls go to Wanchain's public RPC, https://gwan-ssl.wandevs.org:56891, and to your wallet.
- Your wallet signs every transaction. The pages never see a key.
- `site/shared/ethers-6.17.0.umd.min.js` is `dist/ethers.umd.min.js` from the npm package ethers 6.17.0, sha256 `532950515fd29ae9f7a21ceb2b68100815024d7944c3d5a92246d5b900bd703b`. Check it with `npm pack ethers@6.17.0`.
- Fonts: Geist and Geist Mono 1.9.2 (SIL OFL 1.1), cut to the characters OrbitWan's pages use.
- Icons: a globe drawn for these pages, linking to https://orbitwan.io; the GitHub mark from @primer/octicons 19.38.0, linking to this repo; and the X logo from simple-icons 16.33.0, linking to OrbitWan's account. The marks belong to GitHub and X.
- Token logos (`site/shared/tokens/`): the ones orbitwan.io shows, from spothq/cryptocurrency-icons (CC0 1.0), and VeChain's VET logo from vechain/vechain-kit (MIT). The logos belong to their projects.
- Licenses of these files: [`site/shared/licenses/`](site/shared/licenses/).

## License

MIT. See [LICENSE](LICENSE).
