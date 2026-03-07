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
- **3つのAIモデルに対応**: OpenAI / Claude / Gemini（すべて設定した場合は自動でランダム選択・レートリミット時の自動フォールバック対応）
- **陣営バイアス**: 定確率でレジスタンス陣営（青色）やエンライテンド陣営（緑色）に寄ったコメントを生成

## 📋 必要なもの

- PC版 Chrome または Firefox
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
   お使いのブラウザに `Tampermonkey` 拡張機能を追加します。
2. **スクリプトを追加**  
   Tampermonkeyのダッシュボード →「新規スクリプト」から、当リポジトリの [`ingress_niconico_comments.user.js`](ingress_niconico_comments.user.js) の中身をコピペして保存します。
3. **Ingress Intel Mapを開く**  
   [intel.ingress.com](https://intel.ingress.com) にアクセスします。画面上に「🎌 ニコニコインテルマップ」パネルが表示されれば準備完了です。
4. **APIキーを入力**  
   パネル内の「API設定」タブを開き、取得済みのAPIキーを入力します（入力からフォーカスを外すと自動的に検証され保存されます）。
5. **コメントを待つ**  
   COMM ALL に動きがあると、AIがコメントを生成して画面に流します（「今すぐ流す」ボタンで手動実行も可能）。

## 🎛️ パネルの使い方

### メインタブ
- **プラグイン有効**: ON/OFFで機能の有効化・無効化を切り替えます
- **コメント数**: 1回の生成で流れるコメントの数を指定します（1〜100）
- **デバッグ表示**: どのAIが呼ばれたか、パースエラーなどがリアルタイムで表示されます

### API設定タブ
- OpenAI / Claude / Gemini のキーを入力します
- 複数設定している場合は、イベント発生時に **ランダムで選ばれたモデル** がリクエストを処理します。いずれかの API で利用制限(Rate Limit 429)が発生した場合は自動的に他のAPIへフォールバックします。

## 💬 コメントの種類

| 種類 | 色 | 割合 | 説明 |
|---|---|---|---|
| 一般視聴者 | 白 | 85%〜 | ログに対する自然な反応。稀に陰謀論や深読みコメントも混ざる。 |
| Ingressガチ勢 | 白 | 〜5% | MU・CF・リンク戦略などを冷静に分析する。 |
| RESバイアス | 青 | 〜3% | レジスタンス側に有利なアクション時限定で出現。 |
| ENLバイアス | 緑 | 〜3% | エンライテンド側に有利なアクション時限定で出現。 |

## ⚠️ 注意事項

- 本プラグインは Niantic/Ingress の公式とは一切関係ありません。
- APIキーはブラウザのローカルストレージ（Tampermonkeyの管理領域）に保存されます。共用PCでは利用しないでください。
- AIの利用料金はご自身のAPIアカウントに対して発生します。
- Intel MapのDOM構造が仕様変更された場合、正常に動作しなくなる可能性があります。

---

*ニコニコインテルマップ — 非公式 Tampermonkey プラグイン*
