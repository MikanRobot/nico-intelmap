<div align="center">
  <img src="https://img.shields.io/badge/Tampermonkey-Plugin-5b8fff.svg" alt="Tampermonkey Plugin">
  <img src="https://img.shields.io/badge/Version-1.8.0-green.svg" alt="Version 1.8.0">
  <h1>🎌 ニコニコインテルマップ (Nico Intel Map)</h1>
  <p>Ingress Intel Map に、ニコニコ動画風のAIコメントを流すTampermonkeyプラグイン</p>
</div>

<br>

**⚠️ 免責事項**
本プラグインは Ingress・Niantic社とは一切関係のない非公式ツールです。使用によるアカウントへの影響や不具合について、作者は責任を負いません。**自己責任でご利用ください。**

---

## 🗺️ これは何？

[Ingress Intel Map](https://intel.ingress.com) を開いていると、COMM ALLのログ（チャットやポータルの動き）をリアルタイムで読み取り、AIがニコニコ動画風のコメントを自動生成して画面に流してくれるプラグインです。

**主な特徴**

- **戦況をAIが実況**：ポータルの占領・中和、リンクやコントロールフィールドの形成など、マップ上の動きに合わせてコメントが流れます。
- **音声読み上げ対応**：コメントを合成音声で読み上げます。読み上げ方式は「ゆっくり」「普通」から選べます。
- **AI3社に対応**：OpenAI・Claude・Geminiのいずれか（複数設定も可）。無料枠のあるGeminiだけでも十分動きます。
- **陣営ネタ・エージェントあるある**：RES/ENLの贔屓コメントや、深夜徘徊・出勤前デプロイといった「あるある」ネタも混ざります。
- **軽量動作**：大量のコメントが流れてもカクつきません。

## 📋 必要なもの

- PC版 Chrome または Microsoft Edge
- 拡張機能「**Tampermonkey**」
- AIのAPIキー（下記いずれか1つ以上）

| AI | APIキー取得先 |
|---|---|
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Claude | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |

> 💡 迷ったら **Gemini** から始めるのがおすすめです。無料枠があるので、お金をかけずに試せます。

## ⚙️ 使い始めるまでの手順

1. **Tampermonkeyを導入する**
   ブラウザに [Tampermonkey拡張機能](https://www.tampermonkey.net/) を追加します。

2. **スクリプトをインストールする**
   👉 [ここをクリックしてインストール](https://raw.githubusercontent.com/MikanRobot/nico-intelmap/main/ingress_niconico_comments.user.js)
   Tampermonkeyのインストール画面が出るので「インストール」を押します。

3. **Ingress Intel Mapを開く**
   [intel.ingress.com](https://intel.ingress.com) にアクセスすると、画面右下に小さなパネル（🎌 ニコニコインテルマップ）が表示されます。クリックすると開閉します。ドラッグで好きな位置に動かせます。

4. **APIキーを入力する**
   パネルの「AI / API」タブを開き、取得したAPIキーを貼り付けます。キーは自動で保存・検証され、使えるかどうかがアイコンで表示されます。

5. **完了です**
   COMM ALLに動きがあると、AIが自動でコメントを生成して画面を流れます。

## 🎛️ パネルの見方

パネルは折りたたんだ状態でも、上部のバーに **AIコメントの残り回数・本日のAI利用料・直近使用したAI** が常に表示されます。左端の丸いランプは動作状況の目印です（🟢 稼働中／🟠 生成上限に到達／🔴 停止中）。

開くと3つのタブがあります。

| タブ | できること |
|---|---|
| **基本** | プラグインのON/OFF、1回に生成するコメント数、音声読み上げのON/OFFと読み上げ方式 |
| **AI / API** | AIコメント生成の残り回数と概算コストの確認、上限に達したときの延長、各AIのAPIキー管理 |
| **ログ** | 動作の詳細ログをリアルタイムで確認（コピーボタンあり） |

## 💬 コメントの種類

| 種類 | 色 | 内容 |
|---|---|---|
| 一般エージェント | 白 | ログへの自然な反応。ごく稀に根拠のない邪推・陰謀論も混ざる |
| ガチ勢 | 白 | 戦術や装備を冷静に分析するコメント |
| RESバイアス | 青 | レジスタンス贔屓のコメント。毎回1件以上出現 |
| ENLバイアス | 緑 | エンライテンド贔屓のコメント。毎回1件以上出現 |
| MACHINA | 赤 | 謎の第三勢力による、不気味な英語コメント（低確率） |

## ⚠️ 知っておいてほしいこと

- **料金について**：AIの利用料金はご自身のAPIアカウントに発生します。使いすぎを防ぐため、短時間に自動更新が5回続くとAIコメントの生成を自動で止める仕組みがあります（パネルからボタン1つで再開できます）。
- **音声が鳴らない場合**：ブラウザの仕様上、ページを開いた直後は音声が再生されません。マップを一度クリックまたはドラッグすると音声が有効になります。
- **APIキーの保管**：キーはTampermonkey内に保存されます。共用PCでの利用は避けてください。

## 💝 謝辞

本プラグインは、以下の素晴らしいゲームとサービスから多大な楽しさを得て作られました。

- **[Ingress Prime](https://ingress.com/)** / **[Niantic, Inc.](https://nianticlabs.com/)** — 現実世界を舞台にした陣取りゲームと、日々のエージェント活動を支えてくれる運営チームに感謝します。
- **[ニコニコ動画](https://www.nicovideo.jp/)** — 画面上にコメントが流れるという、インターネット文化における発明に敬意を表します。

---

*ニコニコインテルマップ — 非公式 Tampermonkey プラグイン*

<br>
<div align="right">
  <span style="color: #ff3333; font-family: 'Courier New', Courier, monospace; letter-spacing: 2px; text-shadow: 1px 0 red, -1px 0 cyan; opacity: 0.8; font-size: 11px;">
    T̸h̴e̶ ̷w̷o̶r̸l̵d̷ ̵a̶r̶o̸u̶n̸d̴ ̷y̴o̷u̷ ̸i̷s̶ ̸n̵o̸t̴ ̸w̴h̷a̷t̴ ̶i̸t̴ ̵s̵e̶e̴m̴s̵.̵
  </span>
</div>
