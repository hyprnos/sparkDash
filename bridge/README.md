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
names), `POST /render` with `{"scene":{...}}` (preview PNG, no BLE), `POST /display`
with `{"scene":{...},"device":{"address":"A0:A3:B8:2D:A5:68","name":"NRF_EPD_A568"}}`
returning `{"ok":true,"ms":..,"batteryMv":..,"chunks":..}`. BLE work is serialised; a
failing tag answers `{"ok":false,"error":"..."}` and the server keeps serving.

## Install the systemd unit

```sh
sudo cp /home/spark001/sparkDash/deploy/sparkdash-eink-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sparkdash-eink-bridge
journalctl -u sparkdash-eink-bridge -f
```