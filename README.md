<div align="center">
  <img src="https://img.shields.io/badge/Tampermonkey-Plugin-5b8fff.svg" alt="Tampermonkey Plugin">
  <h1>🎌 ニコニコインテルマップ (Nico Intel Map)</h1>
  <p>Ingress Intel Map にニコニコ動画風のAIコメントを流すTampermonkeyプラグイン</p>
</div>

<br>

**⚠️ 免責事項・自己責任について**  
本プラグインは Ingress・Niantic社とは一切関係ありません。使用によるアカウントへの影響・不具合・損害等について、作者は一切の責任を負いません。**ご利用はすべて自己責任でお願いします。**

---

## 🗺️ これは何？

Ingress Intel Map（[intel.ingress.com](https://intel.ingress.com)）を開いた状態で COMM ALL のログを読み取り、AI がニコニコ動画風のコメントを生成して地図上に流す拡張スクリプトです。

- **リアルタイム反応**: ポータル名・地名・プレイヤー名を拾ってコメント
- **音声読み上げ機能**: AIが生成したコメントを合成音声（Web Speech API）で読み上げ（個別声色設定付き）
- **3つのAIモデルに対応**: OpenAI / Claude / Gemini（すべて設定した場合は自動でランダム選択・レートリミット時の自動フォールバック対応）
- **陣営バイアス**: 定確率でレジスタンス陣営（青色）やエンライテンド陣営（緑色）に寄ったコメントを生成

## 📋 必要なもの

- PC版 Chrome または Microsoft Edge
- 拡張機能 **Tampermonkey**
- **AIのAPIキー**（以下のいずれか1つ以上）

| AI | 推奨モデル | APIキー取得先 |
|---|---|---|
| **OpenAI** | `gpt-4o-mini` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Claude** | `claude-haiku-4-5` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| **Gemini** | `gemini-2.0-flash` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |

> 💡 **Geminiは無料枠あり**  
> Google AI StudioのGemini APIは無料枠での利用が可能です（2025年3月現在）。まずはGeminiから試すのがお勧めです。

## ⚙️ インストール手順

1. **Tampermonkeyをインストール**  
   お使いのブラウザに [`Tampermonkey` 拡張機能](https://www.tampermonkey.net/)を追加します。
2. **スクリプトを追加**  
   👉 **[ここをクリックしてスクリプトをインストール](https://raw.githubusercontent.com/MikanRobot/nico-intelmap/main/ingress_niconico_comments.user.js)**  
   *※Tampermonkeyのインストール画面が開くので「インストール」を押してください。（手動の場合は、当リポジトリの `ingress_niconico_comments.user.js` の中身をコピペして保存します）*
3. **Ingress Intel Mapを開く**  
   [intel.ingress.com](https://intel.ingress.com) にアクセスします。画面右下に「🎌 ニコニコインテルマップ」パネルが表示されれば準備完了です。
4. **APIキーを入力**  
   パネル内の「API設定」タブを開き、取得済みのAPIキーを入力します（入力からフォーカスを外すと自動的に検証され保存されます）。
5. **コメントを待つ**  
   COMM ALL に動きがあると、AIが内容を読み取って自動でコメントを生成し、画面右から左へ一定時間（約10秒間）で流します。

## 🎛️ パネルの使い方

### メインタブ
- **プラグイン有効**: ON/OFFで全体機能の有効化・無効化を切り替えます
- **音声読み上げ**: ON/OFFで合成音声による読み上げ機能を切り替えます。一般コメントはゆっくりボイス風、MACHINAコメントは不気味な声色で読み上げられます。
- **コメント数**: 1回の生成で流れるコメントの数を指定します（1〜100 / 初期設定: 7）
- **デバッグ表示**: どのAIが呼ばれたか、パースエラーなどがリアルタイムで表示されます

### API設定タブ
- OpenAI / Claude / Gemini のキーを入力します
- 複数設定している場合は、イベント発生時に **ランダムで選ばれたモデル** がリクエストを処理します。いずれかの API で利用制限(Rate Limit 429)が発生した場合は自動的に他のAPIへフォールバックします。

## 💬 コメントの種類

| 種類 | 色 | 説明 |
|---|---|---|
| 一般視聴者 | 白 | ログに対する自然な反応。稀に陰謀論や深読みコメントも混ざる。 |
| Ingressガチ勢 | 白 | MU・CF・リンク戦略などを冷静に分析する。 |
| RESバイアス | 青 | レジスタンス側に有利なアクション時限定で出現。 |
| ENLバイアス | 緑 | エンライテンド側に有利なアクション時限定で出現。 |
| MACHINA | 赤 | 極低確率で出現する不気味な英語コメント。文字が乱れるグリッチエフェクト付き。 |

## ⚠️ 注意事項

- 本プラグインは Niantic/Ingress の公式とは一切関係ありません。
- APIキーはブラウザのローカルストレージ（Tampermonkeyの管理領域）に保存されます。共用PCでは利用しないでください。
- AIの利用料金はご自身のAPIアカウントに対して発生します。
- ブラウザの自動再生ブロック（Autoplay Policy）の仕様上、**画面を開いた直後は音声が再生されません。** マップ上を1度クリックやドラッグすることで音声エンジンのロックが解除され、以降のコメントから読み上げが開始されます（最初のアクションまではテキスト表示のみが進行します）。
- Intel MapのDOM構造が仕様変更された場合、正常に動作しなくなる可能性があります。

## 💝 Special Thanks (謝辞)

本プラグインは、以下の素晴らしいゲームとサービスから多大な霊感と楽しさを得て作成されました。心より感謝申し上げます。

- **[Ingress Prime](https://ingress.com/)** / **[Niantic, Inc.](https://nianticlabs.com/)**
  - 現実世界を舞台にした素晴らしい陣取りゲームと、日々のエージェント活動を可能にしてくれる運営チームに深く感謝します。
- **[ニコニコ動画 (Niconico)](https://www.nicovideo.jp/)**
  - 画面上にコメントが流れるという、インターネットにおける最高の発明と文化に敬意を表します。

---

*ニコニコインテルマップ — 非公式 Tampermonkey プラグイン*

<br>
<div align="right">
  <span style="color: #ff3333; font-family: 'Courier New', Courier, monospace; letter-spacing: 2px; text-shadow: 1px 0 red, -1px 0 cyan; opacity: 0.8; font-size: 11px;">
    T̸h̴e̶ ̷w̷o̶r̸l̵d̷ ̵a̶r̶o̸u̶n̸d̴ ̷y̴o̷u̷ ̸i̷s̶ ̸n̵o̸t̴ ̸w̴h̷a̷t̴ ̶i̸t̴ ̵s̵e̶e̴m̴s̵.̵
  </span>
</div>
