# CC-Server

**Discord-Bot** と **Discord-Security** を 1 つに統合した Discord サーバー管理 BOT です。
サーバー管理はすべて **管理サイト (Web Dashboard)** から行います。スラッシュコマンドでの操作は想定していません。

- Dashboard: React + Vite → GitHub Pages (`https://mnaoki20081106-afk.github.io/CC-server/`)
- Backend: Cloudflare Workers (`apps/worker`)
- Database: Cloudflare D1 (Main 用 `DB` と Security 用 `SECURITY_DB` の 2 つ)
- Discord: REST API + HTTP Interactions + Gateway (Durable Object)

## 機能

移植元: [Discord-Bot](https://github.com/mnaoki20081106-afk/Discord-Bot) / [Discord-Security](https://github.com/mnaoki20081106-afk/Discord-Security)

### 管理サイトのタブ

| タブ | 内容 (移植元) |
|---|---|
| サーバー管理 | Discord風プレビューで、チャンネル・カテゴリ・ロール・権限を直接編集します。テンプレート適用 (Community / Shop / Support) もここで行います。(Discord-Bot) |
| セキュリティ | Anti-Nuke、Anti-Raid、Cross-action Risk、Scam/Phishing、危険な添付ファイル、Bot/Webhook/Role/Permission/AutoMod Guard、緊急Lockdownを扱います。設定、検知履歴、Lockdownの操作もこのタブです。(Discord-Security) |
| 仲介 | PayPayで代金を預かる仲介取引を扱います。詳細は [docs/MEDIATION.md](./docs/MEDIATION.md) を参照してください。(Discord-Bot) |
| 入室管理 | 入退室を通知します。(Discord-Bot) |
| 認証 | Discord OAuth2認証パネルを置きます。アカウント作成日チェック、認証ロールの付与、復旧用メンバー登録も行います。(Discord-Bot) |
| Ticket | チケットパネルを置き、ユーザーごとに個別チャンネルを作ります。(Discord-Bot) |
| 自販機 | PayPay/Kyash自販機です。複数台、在庫、クーポン、ログ、ロール付与に対応します。詳細は [docs/VENDING.md](./docs/VENDING.md) を参照してください。(Discord-Bot) |
| **Amazon自販機** | Amazon商品をLTCで購入できます。ローソン店舗の確認も行います。(CC-server から無変更で引き継ぎ) |
| バックアップ管理 | サーバー構成のバックアップと復元、メンバー復旧を行います。(Discord-Bot) |

### Discord-Security の統合方式

Discord-Security は、元のコードを変更せずに `apps/worker/src/security/` へ置いています。動かすのは同じ Worker の中です。

```text
GitHub Pages (管理サイト)
        |
        v
CC-Server Worker
  ├─ Main (Discord-Bot)  ── D1: DB          … 管理API / Interactions / 自販機 / Amazon自販機 / バックアップ
  │     │  HMAC署名付き内部ブリッジ (security-bridge.ts → security-integration.ts)
  │     v
  └─ Security (Discord-Security) ── D1: SECURITY_DB … 検知 / 封じ込め / Lockdown
        └─ Durable Object: DiscordSecurityGateway (Gateway常時接続)
```

- Main 側のブリッジは元の設計のまま使っています。宛先を外部Workerから同じWorker内のSecurityへ差し替えただけです (`apps/worker/src/security-integration.ts`)。
- Security は専用の D1 (`SECURITY_DB`) を使います。データは Main と混ざりません。
- 署名鍵 `SECURITY_BRIDGE_SECRET` は未設定なら Bot Token から自動で導出するので、追加設定は不要です。
- `SECURITY_DISCORD_BOT_TOKEN` と `SECURITY_DISCORD_APPLICATION_ID` を設定すると、Security を別のBotアカウントで動かせます (元の「別Token」構成)。未設定ならメインBOTがSecurityも担当します。
- `SECURITY_API_BASE_URL` を設定すると内蔵Securityは使いません。その場合は従来どおり外部の Discord-Security Worker に接続します。

## デプロイ

### Bot-Factory

`bot-factory.json` に従ってデプロイします。Security用D1 (`cc-server-security-db`) は初回デプロイ時に自動で作られます。

### 手動 (wrangler)

```bash
npm ci
cd apps/worker
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_ENCRYPTION_KEY   # 32文字以上のランダム値
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put GOOGLE_PLACES_API_KEY    # Amazon自販機
npx wrangler deploy
```

### Discord Developer Portal

- Interactions Endpoint URL には `https://<Worker URL>/interactions` を設定します。
- OAuth2 Redirects には `https://<Worker URL>/auth/discord/callback` を設定します。`wrangler.jsonc` の `DISCORD_OAUTH_REDIRECT_URI` と完全に一致させてください。
- Privileged Gateway Intents では、**Server Members Intent** と **Message Content Intent** を有効にします (Securityが使います)。
- ロールの並び順は **人間の管理者 > CC-Server BOT > 他社製Bot > 一般ロール** を推奨します。

### 管理サイト (GitHub Pages)

Repository Variable `VITE_API_BASE_URL` に Worker の URL を設定します。`main` に push すると `.github/workflows/pages.yml` がデプロイします。

## 開発

```bash
npm ci
npm run build              # Worker型チェック + 管理サイトビルド
npm test                   # Worker回帰テスト + Securityエンジンテスト + 管理サイトテスト
npm run dev:worker         # wrangler dev
npm run dev:web            # vite
```

`apps/gateway-relay/` は、仲介機能でメッセージを即時削除するための VPS 用 Gateway リレーです (任意)。詳細は同ディレクトリの README を参照してください。

## Amazon自販機について

Amazon自販機は開発途中のため、CC-server の実装を変更せずに残しています。

- Worker: `apps/worker/src/amazon-vending.ts`。DB関数は `apps/worker/src/db.ts` の「Amazon自販機」節にあります。
- 管理サイト: `apps/web/src/AmazonVending.tsx`, `apps/web/src/DiscordPanelPreview.tsx`
- 旧 discord.js 版: `src/commands/amazon-vending.ts`, `src/handlers/amazon-vending-interactions.ts`, `src/lib/amazon-vending-helpers.ts`。依存する `src/db.ts`, `src/permissions.ts`, `src/types.ts`, `src/config.ts` もそのまま残しています。

## 旧データの扱い

旧 CC-server のバックアップ表は形式が異なります。そのため、初回起動時に `legacy_cc_guild_backups` と `legacy_cc_guild_restore_jobs` へ名前を変えて退避します。削除はしません。Amazon自販機の設定 (`amazon_vending_config`) はそのまま引き継ぎます。

## License

MIT。参考にしたOSSは [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) を参照してください。
