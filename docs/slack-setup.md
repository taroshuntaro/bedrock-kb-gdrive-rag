# Slack bot 構築手順

Slack のメンション / DM から Knowledge Base に質問できる bot のセットアップ手順。
コア(`KnowledgeBaseStack`)が構築済みであることが前提([docs/setup.md](setup.md))。

> 手順の順序が重要: **シークレット投入(手順 4)を終えてから Events URL を登録(手順 5)する**。
> URL 登録時に Slack が challenge 検証リクエストを送ってくるため、署名検証に使う
> signingSecret が先に入っていないと登録に失敗する。

## 1. Slack アプリの作成

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From scratch**
2. アプリ名(例: `kb-gdrive-rag-bot`)と導入先ワークスペースを選んで作成
3. **Basic Information** → App Credentials の **Signing Secret** を控える

## 2. 権限(スコープ)の設定とインストール

1. **OAuth & Permissions** → Scopes → **Bot Token Scopes** に以下を追加:
   - `app_mentions:read`(メンションの受信)
   - `im:history`(DM の受信)
   - `chat:write`(返信の投稿)

![](./images/slack-setup-001.png)

2. ページ上部の **Install to Workspace** でインストールし、
   **Bot User OAuth Token**(`xoxb-` で始まる)を控える

![](./images/slack-setup-002.png)

![](./images/slack-setup-003.png)

![](./images/slack-setup-004.png)

## 3. デプロイ

```bash
npx cdk deploy SlackBotStack -c driveFolderId=<DriveのフォルダID>
```

出力された `SlackEventsUrl`(Function URL)を控える。`SlackSecretArn` も出力されるが、手順 4 はシークレット名で実行できるため控えなくてよい。

> **リランクについて**: デフォルトで検索精度向上のためリランク(Cohere Rerank 3.5)が
> **有効**になっている。有効時は Cohere Rerank 3.5 のモデルサブスクリプション確定が必要(手順 7)。
> リランクが不要な場合は `-c rerank=false` を付けてデプロイすると無効化できる
> (この場合 Cohere のサブスクリプションは不要)。
>
> ```bash
> npx cdk deploy SlackBotStack -c driveFolderId=<DriveのフォルダID> -c rerank=false
> ```

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

![](./images/slack-setup-005.png)

4. 保存後に再インストールを求められたら従う

## 6. DM を有効化

**App Home** → Show Tabs → **Messages Tab** を有効にし、
**Allow users to send Slash commands and messages from the messages tab** にチェック。

![](./images/slack-setup-006.png)

## 7. モデルの初回サブスクリプション(アカウントで初回のみ)

現行の Bedrock に以前の「モデルアクセス画面で事前に有効化」する手順はない
(全モデルがデフォルトで利用可能)。代わりに、AWS Marketplace に商品 ID を持つサードパーティ
モデルは、**アカウントで初めて invoke した時点で Marketplace のサブスクリプション(=モデル合意)が
自動的に確定**される(呼び出し元に Marketplace 権限がある場合)。この自動確定に失敗すると以降の
呼び出しが `AccessDeniedException` になるため、動作確認の前に以下を満たしておく。

このスタックで対象になるサードパーティモデルは次の 2 つ。どちらも初回 invoke で自動確定されるが、
**Anthropic だけは追加でユースケースフォームの提出が必要**(後述の前提条件 2)で、Cohere は不要という違いがある:

- **Claude Haiku 4.5**(`anthropic.claude-haiku-4-5-20251001-v1:0`) — 回答生成。常に必要。
  自動確定に加え、Anthropic 固有のユースケースフォーム提出が前提。
- **Cohere Rerank 3.5**(`cohere.rerank-v3-5:0`) — 検索結果のリランク。**リランク有効
  (デフォルト)でデプロイした場合のみ必要**。フォーム提出は不要で、Marketplace 権限を持つ
  アイデンティティの初回 invoke で自動確定する。未確定のまま質問するとリランク実行時に
  `AccessDeniedException` になる。`-c rerank=false` でデプロイした場合はそもそも不要。

> 補足: Amazon 自社モデル(Titan Text Embeddings V2 = コア KB の埋め込み)は Marketplace 商品では
> なく合意の概念自体が無いため、サブスクリプションも本手順も不要(`list-foundation-model-agreement-offers`
> は「Agreement not supported」を返す)。

### 前提条件

1. **初回 invoke する IAM アイデンティティに Marketplace 権限があること**
   (自動サブスクリプションは呼び出し元の権限で実行される):

   ```json
   {
     "Effect": "Allow",
     "Action": [
       "aws-marketplace:Subscribe",
       "aws-marketplace:Unsubscribe",
       "aws-marketplace:ViewSubscriptions"
     ],
     "Resource": "*"
   }
   ```

2. **【Anthropic のみ】ユースケースフォーム提出(アカウントまたは Organization で 1 回)** —
   この要件は **Anthropic モデル固有**(AWS 公式: "Required one-time for Anthropic models only")で、
   Cohere Rerank には不要。Bedrock コンソールのモデルカタログで Anthropic モデルを選ぶとフォームが出る
   (または `aws bedrock put-use-case-for-model-access`)。提出すると即時で利用可能になる。
3. アカウントに有効な支払い方法が設定されていること。

### 手順と確認

上記を満たしたアイデンティティで一度 invoke すれば(プレイグラウンドでも CLI でも可)
サブスクリプションが確定する。確定後は**アカウント内の全アイデンティティ
(Lambda 実行ロールを含む)が Marketplace 権限なしで invoke できる**ため、
Lambda のロールに Marketplace 権限を足す必要はない。確定状態は次で確認できる:

```bash
# 回答生成モデル(常に必要)
aws bedrock get-foundation-model-availability \
  --region ap-northeast-1 \
  --model-id anthropic.claude-haiku-4-5-20251001-v1:0
# "agreementAvailability": {"status": "AVAILABLE"} なら確定済み

# リランクモデル(リランク有効=デフォルト時のみ必要)
aws bedrock get-foundation-model-availability \
  --region ap-northeast-1 \
  --model-id cohere.rerank-v3-5:0
```

> **ハマりどころ**: サブスクリプション確定前の猶予期間(最大 15 分)は呼び出しが
> **一時的に成功する**ことがある。「1 回目は動いたのに 2 回目以降
> `AccessDeniedException`(aws-marketplace:Subscribe ... not authorized)になる」場合は、
> 呼び出し元の Marketplace 権限不足で確定に失敗している。権限を付与して再度 invoke し、
> 反映まで 2 分ほど待つ。

## 8. 動作確認

- チャンネルに bot を招待(`/invite @<bot名>`)して `@<bot名> <質問>` でメンション →
  スレッドに回答 + 参照元(Drive リンク)が返る
- bot との DM で質問 → 通常メッセージで回答が返る
- 応答しない場合は受信/応答 Lambda の CloudWatch Logs を確認する

## 制約

- **シングルターン**: スレッドで追い質問しても文脈は引き継がれない
- **まれな二重応答 / 無応答**: Slack の at-least-once 配送と非同期起動失敗により、
  ごくまれに発生しうる(詳細は README の既知の制約)
