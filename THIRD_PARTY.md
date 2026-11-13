# Third-party components

Lights Out itself is licensed under the Apache License 2.0 (see `LICENSE`). It ships
the following third-party components, each under its own licence. The licence
text for each one sits next to it in this repository.

| Component | Version | Where | Licence | Licence file |
|---|---|---|---|---|
| [Shaka Player](https://github.com/shaka-project/shaka-player) (Google LLC) | 5.2.9 | `app/lib/shaka/` | Apache-2.0 | `app/lib/shaka/LICENSE` |
| [webOSTV.js](https://webostv.developer.lge.com/develop/references/webostvjs-introduction) (LG Electronics) | 1.2.4 | `app/lib/webOSTVjs-1.2.4/` | Apache-2.0 | `app/lib/webOSTVjs-1.2.4/LICENSE-2.0.txt` |
| [QR Code Generator](https://github.com/kazuhikoarase/qrcode-generator) (Kazuhiko Arase) | | `app/lib/qrcode/` | MIT | `app/lib/qrcode/LICENSE` |
| [Barlow](https://github.com/jpt/barlow) (The Barlow Project Authors) | | `app/fonts/` | SIL OFL 1.1 | `app/fonts/OFL.txt` |
| [flag-icons](https://github.com/lipis/flag-icons) (Panayiotis Lipiridis) | | `app/flags/` | MIT | `app/flags/LICENSE` |
| [webos-service](https://github.com/webosose/nodejs-module-webos-service) (LG Electronics) | commit `1dd2c9d` | `service/node_modules/webos-service/` | Apache-2.0 | `service/node_modules/webos-service/LICENSE` |
| [ws](https://github.com/websockets/ws) | 8.21.3 | `service/node_modules/ws/` | MIT | `service/node_modules/ws/LICENSE` |
| [ws](https://github.com/websockets/ws), with [options](https://github.com/einaros/options.js) and [ultron](https://github.com/unshiftio/ultron) (webOS 4 package only) | 1.1.5 | fetched by `legacy/make.sh` | MIT | `LICENSE` (ultron) or the README (ws, options) in each module's folder |

`service/node_modules/` is committed on purpose: a webOS service must be
self-contained inside the package, so these modules ship in the IPK.
