# 設計書: Slack bot による Knowledge Base 検索応答(利用パターン 1 号)

- 作成日: 2026-06-12
- ステータス: 承認待ち
- リージョン: ap-northeast-1(東京)

## 1. 目的とスコープ

Slack のメンション / DM から質問すると、既存の Bedrock Knowledge Base(Google Drive 由来)を
検索して回答を返す bot を構築する。

### 検討の経緯(前提となる意思決定)

- 当初は Google Chat を希望していたが、**Google Chat アプリの開発には Google Workspace
  アカウントが必須**(個人 Gmail では開発不可)のため、Slack に変更した。
- **AgentCore は今回使わない**。Lambda + `RetrieveAndGenerate` で完結させる。
  AgentCore を使いたくなった場合は別途検討する。

### 今回のスコープ(作るもの)

- `SlackBotStack`(CDK スタック): 受信 Lambda + Function URL、応答 Lambda、
  Slack 認証情報用 Secrets Manager シークレット、最小権限 IAM ロール
- Slack イベント処理(メンション + DM、署名検証、challenge 応答、再送フィルタ)
- `RetrieveAndGenerate` による回答生成と、引用元(Drive リンク)付きの Slack 返信
- 純ロジックの単体テスト + CDK assertion テスト
- ドキュメント(`docs/slack-setup.md` 新規、README「利用パターン」セクション新設)

### スコープ外(将来の別作業)

- AgentCore 連携(エージェント化)
- マルチターン会話(スレッド文脈の引き継ぎ)
- `event_id` ベースの厳密な重複排除(DynamoDB が必要)
- API Gateway / WAF / カスタムドメイン(社内導入など組織要件が出た時に載せ替え)

## 2. リポジトリ構成方針: コア + 利用パターン

このリポジトリは今後、以下の二層構成とする。

| 層 | 内容 | デプロイ |
| --- | --- | --- |
| **コア(必須)** | KB 基盤一式(`KnowledgeBaseStack`: S3 / S3 Vectors / KB / Drive 同期) | 必ずデプロイする |
| **利用パターン(選択)** | KB を使うコンシューマ。今回の Slack bot が 1 号。将来: AgentCore エージェント、他チャット bot 等 | 利用者が使いたいものだけスタック単位でデプロイする |

- 利用パターンは `lib/<パターン名>-stack.ts` + `lambda/<パターン名>/` の既存規約で追加していく
  (**軽量モノレポ**)。npm workspaces 等のフル再編は、言語や依存が衝突するコンシューマが
  現れた時に初めて行う(YAGNI)。
- README の既存構成図(コア)は変更しない。「利用パターン」セクションを新設し、
  パターンごとに独立した図・ドキュメントを掲載する。
- KnowledgeBaseId はコア → コンシューマへ CDK アプリ内のスタック間参照で渡す。
  クロススタック参照のロックイン(参照中はコア側の該当値を変更不可)は規模的に許容する。

デプロイはスタック名指定で選択する:

```bash
npx cdk deploy KnowledgeBaseStack -c driveFolderId=<ID>   # コアのみ
npx cdk deploy SlackBotStack      -c driveFolderId=<ID>   # Slack bot(コアに依存)
```

## 3. アーキテクチャ

```
Slack(メンション / DM)
   │ Events API(HTTPS POST、3 秒以内に 200 必須)
   ▼
Lambda Function URL ── 受信 Lambda(receiver)
   │  1. url_verification(challenge)なら即応答
   │  2. 署名検証(HMAC + タイムスタンプ ±5 分)
   │  3. 再送(x-slack-retry-num)・bot 自身の発言を弾く
   │  4. 応答 Lambda を非同期起動し、常に 200 を返す
   ▼
応答 Lambda(worker)
   │  5. Bedrock RetrieveAndGenerate(KnowledgeBaseId + 生成モデル)
   │  6. 回答 + 引用元(Drive リンク)を Slack メッセージに整形
   ▼
Slack chat.postMessage(bot token)で返信(チャンネルはスレッド、DM は通常返信)
```

### 設計判断

- **2 段 Lambda**: Slack Events API は 3 秒以内の応答を要求するが、`RetrieveAndGenerate` は
  数秒〜十数秒かかるため、受信と応答を非同期に分離する。コードは 1 つの asset
  (`lambda/slack-bot/`)に `receiver.ts` / `worker.ts` の 2 ハンドラとして同居させる。
- **Lambda Function URL(API Gateway 不採用)**: 個人用途でルーティング・認可機能が不要なため、
  最も安価でシンプルな Function URL(AuthType: NONE)を採用。認可は Slack 署名検証で担保する。
  Function URL のイベント形式は API Gateway HTTP API(payload v2.0)と互換のため、
  将来の載せ替えはスタック側の変更だけで済む。
- **コスト暴走ガード**: 公開エンドポイントのため、受信 Lambda に小さめの
  reserved concurrency を設定し、大量リクエスト時の課金上限を抑える。

## 4. Slack イベント処理(受信 Lambda)

- **対象イベント**: `app_mention`(チャンネルでのメンション)+ `message.im`(DM)。
  チャンネルの通常メッセージ(`message.channels`)は購読しない。
- **url_verification**: Slack の Events URL 登録時に届く challenge をそのまま返す
  (これがないと URL 登録自体ができない)。
- **署名検証**: signing secret による HMAC-SHA256 検証に加え、`x-slack-request-timestamp` が
  現在時刻 ±5 分以内であることを確認する(リプレイ攻撃対策)。検証 NG は 401。
- **弾く条件**(弾いた後も 200 を返す):
  - `x-slack-retry-num` ヘッダ付き(Slack の再送)
  - `bot_id` を持つメッセージ(bot 自身の発言によるループ防止)
- **メンション除去**: `app_mention` のテキストから `<@BOTID>` を除去して質問文を抽出する。
- **応答 Lambda の起動**: `InvocationType: Event` で非同期起動。起動失敗はログのみで
  200 を返す(再送はすべて弾く方針のため、500 で再送させてもリカバリにならない)。

## 5. 回答生成(応答 Lambda)

- **API**: `RetrieveAndGenerate`(検索 + 生成をワンコールで実行)。
- **生成モデル**: Claude Haiku 4.5 の日本ジオ・クロスリージョン推論プロファイル
  `jp.anthropic.claude-haiku-4-5-20251001-v1:0` をデフォルトとする(コスト重視・応答速度良好。
  東京⇔大阪間でルーティングされ、推論処理が日本国内で完結する)。
  `lib/config.ts` に定数として置き、1 行で差し替え可能にする。
  初回はコンソールでのモデルアクセス有効化が必要(setup ドキュメントに記載)。
- **プロンプト**: 生成テンプレートを軽くカスタムし、「日本語で簡潔に答える」
  「ナレッジベースに情報がなければ、無いと正直に言う」を指示する。
- **引用元リンク**: citations の S3 URI からキー(`<fileId>/<ファイル名>`)を取り出し、
  先頭セグメントの fileId で `https://drive.google.com/file/d/<fileId>/view` を組み立てる。
  Google ドキュメント → PDF 変換されたファイルでも fileId は元ドキュメントの ID のため、
  リンク先は編集可能な元ドキュメントになる。回答末尾に「参照元」として重複排除した
  最大 5 件をファイル名付きで並べる。
- **シングルターン**: 各メンション / DM を独立した質問として扱う。`RetrieveAndGenerate` の
  `sessionId` による会話継続は、スレッド ↔ セッションの対応保存(DynamoDB)が必要なため
  見送り(将来拡張の筆頭候補)。

## 6. エラー処理

- 受信 Lambda: 署名検証 NG → 401(ログのみ)。応答 Lambda の起動失敗 → ログのみで 200
  (無応答になりうる。既知の制約として README に明記)。
- 応答 Lambda: `retryAttempts: 0` を明示する(非同期起動のデフォルト自動リトライ 2 回による
  二重投稿を防ぐ)。エラーはハンドラ内で捕捉し、「エラーが発生しました」を 1 回だけ
  スレッドに投稿してログに詳細を残す。Slack への投稿自体が失敗した場合はログのみ。
  タイムアウトは 60 秒。

## 7. IAM(最小権限)

- **受信 Lambda**: 応答 Lambda への `lambda:InvokeFunction` + Slack シークレット読み取りのみ。
  Bedrock 権限なし。
- **応答 Lambda**: KB ARN への `bedrock:Retrieve` / `bedrock:RetrieveAndGenerate`、
  推論プロファイルおよび基盤モデルへの `bedrock:InvokeModel`(クロスリージョンのため
  基盤モデルは `arn:aws:bedrock:*::foundation-model/...` のワイルドカード)、
  Slack シークレット読み取り。
- **Slack シークレット**: 1 つ(JSON で `signingSecret` / `botToken` の 2 キー)。
  service-account.json と同じ運用パターンで、デプロイ後に手動投入する。

## 8. コード構成

| パス | 責務 |
| --- | --- |
| `lib/slack-bot-stack.ts` | SlackBotStack の全リソース定義 |
| `lambda/slack-bot/receiver.ts` | 受信ハンドラ。**SDK 呼び出し層**(Secrets / Lambda Invoke) |
| `lambda/slack-bot/worker.ts` | 応答ハンドラ。**SDK 呼び出し層**(Bedrock / Secrets / Slack API) |
| `lambda/slack-bot/slack-verify.ts` | **純ロジック層**: 署名・タイムスタンプ検証 |
| `lambda/slack-bot/slack-event.ts` | **純ロジック層**: challenge / 再送 / bot 発言の判定、メンション除去 |
| `lambda/slack-bot/answer-format.ts` | **純ロジック層**: citations → Drive リンク付き Slack メッセージ整形 |

既存の設計原則(純ロジックと SDK 呼び出しの分離)を踏襲する。

## 9. テスト方針

- `slack-verify.ts`: HMAC 署名とタイムスタンプ窓(±5 分)の検証 → 単体テスト
- `slack-event.ts`: challenge 応答 / 再送ヘッダ / bot 自身の発言 / メンション除去の判定 → 単体テスト
- `answer-format.ts`: citations から Drive リンク付きメッセージへの整形(重複排除・最大 5 件) → 単体テスト
- `SlackBotStack` の CDK assertion テスト(リソース存在・IAM・reserved concurrency・retryAttempts)
- テスト名はすべて日本語。完了前に `npm test` + `npx tsc --noEmit` の両方を通す。

## 10. ドキュメント更新

- `docs/slack-setup.md` 新規作成: Slack アプリ作成、必要スコープ
  (`app_mentions:read` / `im:history` / `chat:write`)、シークレット投入、
  デプロイ、Events URL 登録(デプロイで Function URL が出てから登録する順序に注意)、
  イベント購読設定、動作確認。
- README: 「利用パターン」セクションを新設し、Slack bot をパターン 1 号として掲載
  (既存のコア構成図は変更せず、Slack bot 用の図を別途用意)。
  既知の制約(下記)を追記。
- CLAUDE.md: コード構成表に `lib/slack-bot-stack.ts` と `lambda/slack-bot/` を追加。
  コア + 利用パターンの二層構成方針を追記。

## 11. 既知の制約

- **まれな二重応答**: Slack Events API は at-least-once 配送。再送ヘッダで大半は弾けるが、
  `event_id` ベースの厳密な重複排除は入れないため、まれに同じ質問へ 2 回答える可能性がある。
- **まれな無応答**: 応答 Lambda の起動失敗時はログのみで終わる(再送リカバリなし)。
- **シングルターン**: スレッドで追い質問しても文脈は引き継がれない。
- **3 秒制約**: 受信 Lambda のコールドスタートが長引くと Slack が再送する。再送は弾くため
  二重応答にはならないが、初回の処理は実行済みのため実害なし。

## 12. 将来拡張

- マルチターン会話(`sessionId` + DynamoDB でスレッド対応)
- AgentCore 連携(生成部分をエージェントに差し替え)
- API Gateway への載せ替え(組織のセキュリティ要件が出た場合。ハンドラはほぼ無修正で可)
- `event_id` 重複排除(DynamoDB)
