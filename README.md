# Keymap Viewer

Vial（QMK）と ZMK Studio 対応キーボードのキーマップを読み取って表示する PWA。
読み取ったキーマップは IndexedDB に保存されるので、次回からはキーボードを接続しなくてもオフラインで見られる。

## 使い方

1. HTTPS のサーバーに配置する（GitHub Pages、Cloudflare Pages など）。ローカルで試すなら `python3 -m http.server` で `http://localhost:8000/` を開く（localhost は HTTP でも動く）。
2. デスクトップ版 Chrome / Edge で開き、読み取りボタンを押す。
   - **Vial（USB）**：WebHID を使う。Vial アプリなど、キーボードを使用中の他のアプリは閉じておく。
   - **ZMK Studio（USB / Bluetooth）**：Web Serial / Web Bluetooth を使う。ファームウェア側で ZMK Studio を有効にしておく必要がある（`CONFIG_ZMK_STUDIO=y`、USB の場合は `studio-rpc-usb-uart` snippet）。ロック中なら `&studio_unlock` キーを押す。
3. 「アプリとしてインストール」でインストールできる。

## 動作環境の補足

- ZMK Studio の Bluetooth 接続では、Studio サービスとバッテリーサービス（通常の ZMK もアドバタイズする）の両方で機器を探す（DYA Studio と同じ方式）。Windows / macOS では、Studio Unlock キーを押すと接続待ちになるファームウェア（cormoran 版 ZMK など）が必要。iPhone では Bluefy ブラウザで Bluetooth 読み取りができる
- iPhone / iPad では「ホーム画面に追加」ボタンから追加手順を表示する（iOS には自動でインストールを促す仕組みがないため）
- カメラ（QR で受け取る）は HTTPS でしか使えない。iPhone の Safari やホーム画面に追加した PWA でも動く

## 機能

- レイヤー切り替え（タブ / 数字キー / ← →）、全レイヤーの一覧表示、印刷（全レイヤー）
- US / JIS 表記の切り替え（JIS 配列の PC で使うときの記号表示）
- Vial：レイアウトオプション、エンコーダ、customKeycodes、LT / MT / OSM / LM などの表示
- ZMK：物理レイアウト（回転を含む）、レイヤー名、ビヘイビアのメタデータから引数を解釈
- キーをタップすると内部のキーコードを表示し、レイヤーキーなら移動先のレイヤーへジャンプできる
- **QR で共有**：PC で読み取ったキーボードを表示して「QR で共有」を押すと、データを圧縮して QR コードを数枚ずつ順番に表示する。スマホの Keymap Viewer で「QR で受け取る」を押してカメラを向けると、全部そろった時点で自動的に保存される（読み取れなかった QR は次の周回で拾うので、順番を気にする必要はない）
- JSON のエクスポート / インポート（ファイルで移したい場合）

## ファイル構成

- `js/vial.js` — Vial の HID プロトコル（キーボード定義の取得と LZMA 展開、キーマップ、エンコーダ、レイアウトオプション）
- `js/zmk.js` — ZMK Studio の RPC（フレーミング、最小限の protobuf、シリアル / BLE トランスポート）
- `js/share.js` / `js/qr-worker.js` — QR 共有（deflate 圧縮 → Base45 → 分割、CRC32 で検証）。カメラの読み取りは Web Worker で行う
- `vendor/` — qrcode-generator（MIT）、jsQR（Apache-2.0）
- `js/lzma.js` — .xz / LZMA2 / .lzma のデコーダ
- `js/keymap.js` — KLE の解析とラベルの生成、`js/render.js` — SVG で描画
- `js/vial-keycodes.js` — vial-gui のキーコード表から生成したもの（GPL-2.0-or-later）
- `sw.js` — オフライン用の Service Worker。ファイルを更新したら `VERSION` を上げること
