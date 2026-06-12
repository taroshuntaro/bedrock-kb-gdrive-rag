# Slack bot 構築手順

Slack のメンション / DM から Knowledge Base に質問できる bot のセットアップ手順。
コア(`KnowledgeBaseStack`)が構築済みであることが前提([docs/setup.md](setup.md))。

> 手順の順序が重要: **シークレット投入(手順 4)を終えてから Events URL を登録(手順 5)する**。
> URL 登録時に Slack が challenge 検証リクエストを送ってくるため、署名検証に使う
> signingSecret が先に入っていないと登録に失敗する。

## 1. Slack アプリの作成

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. アプリ名(例: `KB 検索 bot`)と導入先ワークスペースを選んで作成
3. **Basic Information** → App Credentials の **Signing Secret** を控える

## 2. 権限(スコープ)の設定とインストール

1. **OAuth & Permissions** → Scopes → **Bot Token Scopes** に以下を追加:
   - `app_mentions:read`(メンションの受信)
   - `im:history`(DM の受信)
   - `chat:write`(返信の投稿)
2. ページ上部の **Install to Workspace** でインストールし、
   **Bot User OAuth Token**(`xoxb-` で始まる)を控える

## 3. デプロイ

```bash
npx cdk deploy SlackBotStack -c driveFolderId=<DriveのフォルダID>
```

出力された `SlackEventsUrl`(Function URL)を控える。`SlackSecretArn` も出力されるが、手順 4 はシークレット名で実行できるため控えなくてよい。

## 4. シークレットの投入

手順 1〜2 で控えた 2 つの値を Secrets Manager に投入する:

```bash
aws secretsmanager put-secret-value \
  --region ap-northeast-1 \
  --secret-id bedrock-kb-gdrive-slack-bot \
  --secret-string '{"signingSecret":"<Signing Secret>","botToken":"<xoxb-...>"}'
```

## 5. Events URL の登録とイベント購読

1. Slack アプリ設定の **Event Subscriptions** → Enable Events を **On**
2. **Request URL** に手順 3 の `SlackEventsUrl` を入力(Verified になることを確認)
3. **Subscribe to bot events** に以下を追加して保存:
   - `app_mention`
   - `message.im`
4. 保存後に再インストールを求められたら従う

## 6. DM を有効化

**App Home** → Show Tabs → **Messages Tab** を有効にし、
**Allow users to send Slash commands and messages from the messages tab** にチェック。

## 7. モデルアクセスの有効化(初回のみ)

[Bedrock コンソール(東京)のモデルアクセス画面](https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1#/modelaccess)
で **Anthropic Claude Haiku 4.5** へのアクセスを有効化する。

## 8. 動作確認

- チャンネルに bot を招待(`/invite @<bot名>`)して `@<bot名> <質問>` でメンション →
  スレッドに回答 + 参照元(Drive リンク)が返る
- bot との DM で質問 → 通常メッセージで回答が返る
- 応答しない場合は受信/応答 Lambda の CloudWatch Logs を確認する

## 制約

- **シングルターン**: スレッドで追い質問しても文脈は引き継がれない
- **まれな二重応答 / 無応答**: Slack の at-least-once 配送と非同期起動失敗により、
  ごくまれに発生しうる(詳細は README の既知の制約)
