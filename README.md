# OrbitWan Express

Contracts and dapps on Wanchain, by [OrbitWan](https://orbitwan.io). Each contract here is the exact source of a live contract, and each page is served from this repo exactly as committed.

| | Contract | Dapp |
|---|---|---|
| xWAN Express | [xwan/](xwan/) | https://express.orbitwan.io |
| OrbitPay | [orbitpay/](orbitpay/) | |

## The site

[`site/`](site/) is published to https://express.orbitwan.io by [`.github/workflows/pages.yml`](.github/workflows/pages.yml). There is no build step: the files are served exactly as they are here.

- The pages load nothing from other sites. Their only network calls go to Wanchain's public RPC, https://gwan-ssl.wandevs.org:56891, and to your wallet.
- Your wallet signs every transaction. The pages never see a key.
- `site/shared/ethers-6.17.0.umd.min.js` is `dist/ethers.umd.min.js` from the npm package ethers 6.17.0, sha256 `532950515fd29ae9f7a21ceb2b68100815024d7944c3d5a92246d5b900bd703b`. Check it with `npm pack ethers@6.17.0`.
- Fonts: Space Grotesk and IBM Plex, from @fontsource.
- Icons: the GitHub mark from @primer/octicons 19.38.0 and the X logo from simple-icons 16.33.0, each linking to OrbitWan's own account. The marks belong to GitHub and X.
- Licenses of these files: [`site/shared/licenses/`](site/shared/licenses/).

## License

MIT. See [LICENSE](LICENSE).
