# CC-Server Bot

discord.js v14 + TypeScript + better-sqlite3 製の統合管理Bot。

## 機能

- **サーバー管理** `/server` — チャンネルロック/アンロック、アナウンス送信、スローモード設定
- **セキュリティ** `/security` — アンチスパム(連投検知+タイムアウト)、アンチリンク(URL自動削除+ホワイトリスト)、レイド対策(短時間の大量参加検知+チャンネルロック)、イベントログ
- **認証** `/verify setup` — ボタン→計算問題のモーダルに答えると認証ロールを付与
- **入退室管理** `/welcome` — 入室/退室メッセージ({user} {tag} {membercount} が使えるテンプレート)
- **チケット** `/ticket` — パネルから個別チャンネルを作成、クローズでログ送信+自動削除
- **パネル管理** `/panel` — 埋め込み+ボタンの汎用パネルを作成し、ロール付与/解除やテキスト表示をボタンに割り当てる
- **自販機** `/shop`, `/economy` — サーバー内ポイント経済と、ポイントで購入できる商品(在庫=配布テキスト、購入時にDM送信+ロール付与)
- **バックアップ** `/backup` — ロール/チャンネル構成をJSONに保存し、不足分のみ再作成(既存要素は削除しない)

## セットアップ

```bash
npm install
cp .env.example .env   # DISCORD_TOKEN / DISCORD_CLIENT_ID を設定
npm run deploy-commands # DEV_GUILD_ID を設定していればそのギルドに即反映
npm run build
npm start
# 開発中は npm run dev でホットリロード
```

## 必要な Bot 権限 / Intents

- Intents: `GUILDS`, `GUILD_MEMBERS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT`, `GUILD_MODERATION`
- 権限: チャンネル管理、ロール管理、メッセージ管理、メンバーをタイムアウト、埋め込みリンク

Discord Developer Portal の Bot 設定で **Server Members Intent** と **Message Content Intent** を有効化すること。

## データ

SQLite ファイルは `DB_PATH`(デフォルト `./data/bot.sqlite`)に保存される。バックアップJSONは `BACKUP_DIR`(デフォルト `./data/backups`)配下。どちらも `.gitignore` 済みなので本番ではボリューム等で永続化すること。
