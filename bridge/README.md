# sparkDash e-ink bridge

Renders a 400x300 three-colour scene and pushes it over BLE to an `NRF_EPD` e-paper tag.
Plain `http.server`, no web framework.

## Install (Debian/Raspberry Pi, user `spark001`)

```sh
cd /home/spark001/sparkDash/bridge
sudo apt install -y python3-venv fonts-noto-cjk          # CJK font for the renderer
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt                # bleak, pillow
```

## Selftest (no BLE, no hardware)

```sh
.venv/bin/python eink_bridge.py --selftest /tmp/eink-preview.png
```

Prints the path. The PNG is already palette-quantised — exactly what the tag receives.

## Run

```sh
.venv/bin/python eink_bridge.py --host 127.0.0.1 --port 8790 --log INFO
```

`GET /health`, `GET /devices?all=0` (8s BLE scan; `all=1` also lists non-`NRF_EPD`
names), `GET /algorithms` (`{"ok":true,"algorithms":[...]}`, the dither engines in a
stable order), `POST /render` with `{"scene":{...}}` (preview PNG, no BLE),
`POST /display` with
`{"scene":{...},"device":{"address":"A0:A3:B8:2D:A5:68","name":"NRF_EPD_A568"}}`
returning `{"ok":true,"ms":..,"batteryMv":..,"chunks":..}`. BLE work is serialised; a
failing tag answers `{"ok":false,"error":"..."}` and the server keeps serving.

`POST /render` and `POST /display` echo the settings that were actually applied
(clamped, not as requested): `ditherAlgorithm`, `ditherStrength`, `backgroundZoom`,
`backgroundOffsetX`/`Y`, `backgroundBrightness` and `backgroundContrast`. The render
route answers with a PNG, so those values travel in `X-Eink-Dither-Algorithm`,
`X-Eink-Dither-Strength`, `X-Eink-Background-Zoom`, `X-Eink-Background-Offset-X`/`-Y`,
`X-Eink-Background-Brightness` and `X-Eink-Background-Contrast` headers; sending
`{"scene":{...},"meta":true}` instead returns
`{"ok":true,"settings":{...},"pngBase64":"..."}`. `/display` also carries them in its
JSON body and in the `display ok` log line.

## Scene fields

| field | range | meaning |
| --- | --- | --- |
| `textProtection` | `auto` \| `halo` \| `plate` \| `off` | text over a photo: glyph outline, replace the content area, or draw straight on it. The old `scrim` option is gone and now means `auto`. |
| `backgroundZoom` | 1.0–4.0 | cover-fit multiplier, applied around the drawn centre |
| `backgroundOffsetX` / `Y` | -1.0–1.0 | pan the crop window, as a fraction of the canvas width/height |
| `backgroundBrightness` | -100–100 | added to every channel before the crop |
| `backgroundContrast` | -100–100 | `(v-128)*(1+c/100)+128`, factor clamped to 0.2–3.0 |
| `ditherAlgorithm` | see `GET /algorithms` | `none`, `floyd-steinberg`, `jarvis`, `stucki`, `burkes`, `sierra`, `sierra-lite`, `atkinson`, `bayer8`, `blue-noise`; unknown names fall back to `floyd-steinberg` |
| `ditherStrength` | 0.0–1.0 | scales the diffused error, or the ordered mask bias; 0 gives plain nearest-colour thresholding |

The dither only touches the background photo. The UI layer is painted afterwards in
exact palette colours, so no dither can eat a glyph stroke, and pixels that already
are an exact ink are left alone by the ordered masks. `blue-noise` is a 64x64 mask
generated at import with Ulichney's void-and-cluster method (see
`_void_and_cluster_mask`); no matrix is shipped as a literal.

## Install the systemd unit

```sh
sudo cp /home/spark001/sparkDash/deploy/sparkdash-eink-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sparkdash-eink-bridge
journalctl -u sparkdash-eink-bridge -f
```