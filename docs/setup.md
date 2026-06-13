# 構築手順

[README](../README.md) のシステムを東京リージョン(ap-northeast-1)に構築するための手順。
手順 0(AWS CLI の準備)は設定済みならスキップしてよい。

## 0. AWS CLI の準備(未設定の場合)

### 0-1. インストール

```bash
# Linux x86_64 の例(他 OS は https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip awscliv2.zip && sudo ./aws/install
aws --version   # aws-cli/2.x.x が表示されること
```

### 0-2. 認証情報の設定

どちらか一方を行う。

**A. IAM Identity Center(SSO)を使う場合(推奨)**

```bash
aws configure sso
# 対話で以下を入力:
#   SSO session name (Recommended): 任意のセッション名
#   SSO start URL    : 組織のアクセスポータル URL(https://xxxx.awsapps.com/start)
#   SSO region       : Identity Center のリージョン
#   SSO registration scopes [sso:account:access]: そのままエンター（デフォルト値）
#   → ブラウザが開くので認可し、アカウントとロールを選択
#     （ブラウザが自動で開かない場合、開くべき URL がターミナルに表示されるので、それを開く）
#   CLI default client Region : ap-northeast-1
#   CLI profile name : 任意(例: kb-dev)

# セッション切れ時の再ログイン
aws sso login --profile kb-dev

# このプロファイルを既定にしておくと以降の aws / cdk コマンドで指定不要
export AWS_PROFILE=kb-dev
```

**B. IAM ユーザーのアクセスキーを使う場合(個人検証向け)**

IAM コンソールでユーザーを作成し、アクセスキーを発行してから:

```bash
aws configure
# AWS Access Key ID / Secret Access Key : 発行したキーを入力
# Default region name                   : ap-northeast-1
# Default output format                 : json
```

> 必要な権限について: `cdk bootstrap` は IAM ロールや S3 バケットを作成するため、初回は
> 広い権限(個人アカウントなら `AdministratorAccess` 相当)を持つプリンシパルで実行するのが
> 確実。bootstrap 以降のデプロイは CDK が作成したロール経由で行われる。

### 0-3. 設定の確認

```bash
aws sts get-caller-identity   # アカウント ID と ARN が返れば認証 OK
aws configure get region      # ap-northeast-1 になっていること
```

## 1. GCP: サービスアカウントの作成と Drive API の有効化

Gmail(Google)アカウントがあれば、本手順はほぼ `gcloud` CLI だけで完結する。CLI 外の操作は
次の 3 つのみ:

1. 初回の GCP 利用規約への同意(コンソールを一度開くだけ)
2. `gcloud auth login` のブラウザ認可
3. 手順 2 の Drive フォルダ共有(Drive の Web UI)

請求先アカウント(課金)の設定は不要。Drive API・サービスアカウントとも無償で使える。

### 1-1. gcloud のセットアップとプロジェクト作成(初回のみ)

[gcloud CLI をインストール](https://cloud.google.com/sdk/docs/install)してから:

```bash
# Gmail アカウントでログイン(ブラウザが開く。リモート環境では --no-launch-browser を付ける)
gcloud auth login

# プロジェクトを新規作成(<PROJECT_ID> は世界で一意な小文字英数とハイフン。例: my-kb-sync-2026)
gcloud projects create <PROJECT_ID>
gcloud config set project <PROJECT_ID>
```

> 初めて GCP を使うアカウントでは、プロジェクト作成時に
> `Callers must accept Terms of Service` エラーになることがある。その場合は
> [console.cloud.google.com](https://console.cloud.google.com) を一度開いて利用規約に
> 同意してから再実行する。

### 1-2. Drive API の有効化とサービスアカウントの作成

```bash
# Drive API を有効化
gcloud services enable drive.googleapis.com --project <PROJECT_ID>

# サービスアカウント(SA)を作成
gcloud iam service-accounts create drive-sync-reader \
  --project <PROJECT_ID> --display-name "Drive sync for Bedrock KB"

# JSON キーを発行(このファイルは後で Secrets Manager に投入する。git には絶対に入れない)
gcloud iam service-accounts keys create service-account.json \
  --iam-account drive-sync-reader@<PROJECT_ID>.iam.gserviceaccount.com
```

コンソールで行う場合: 「APIs & Services → ライブラリ」で **Google Drive API** を有効化し、
「IAM と管理 → サービスアカウント」で SA を作成 → 「キー」タブから **JSON キー**を発行する。

> SA に IAM ロールの付与は不要。次のステップの「フォルダ共有」だけでアクセス範囲が決まる。

## 2. Drive: 同期対象フォルダの共有とフォルダ ID の確認

1. Google Drive で同期したいフォルダを右クリック → 「共有」
2. SA のメールアドレス(`drive-sync-reader@<PROJECT_ID>.iam.gserviceaccount.com`)を
   **「閲覧者」** で追加する(「通知を送信」は外してよい)
3. フォルダを開いたときの URL からフォルダ ID を控える:
   `https://drive.google.com/drive/folders/<ここがフォルダID>`

SA は共有されたフォルダ(とそのサブフォルダ)以外を一切参照できないため、これが同期スコープになる。

## 3. AWS: Bedrock モデルアクセスの確認(通常は操作不要)

現行の Bedrock に以前の「モデルアクセス画面で事前に有効化」する手順はない
(全モデルがデフォルトで利用可能)。コア KB が使う **Titan Text Embeddings V2** は
Amazon 自社モデルで AWS Marketplace のサブスクリプション対象外のため、**追加の操作は不要**。

なお、利用パターン側で Anthropic などのサードパーティモデルを使う場合は、
初回 invoke 時に Marketplace サブスクリプションの自動確定が必要になる
(詳細は [slack-setup.md の手順 7](slack-setup.md#7-生成モデルの初回サブスクリプションアカウントで初回のみ))。

**Slack bot をリランク有効(デフォルト)でデプロイする場合**: 検索精度向上のため
Cohere Rerank 3.5 を使用する。Titan / Haiku と同様に、Marketplace サブスクリプションの
自動確定が必要になる(初回 invoke 時)。未確定のまま運用すると回答生成時に
`AccessDeniedException` が発生する。リランクが不要な場合は
`-c rerank=false` をデプロイ時に指定することで無効化できる(モデルアクセス不要)。

## 4. デプロイ

```bash
npm install

# CDK bootstrap(東京リージョンで初回のみ。アカウント ID は自動取得)
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-northeast-1 \
  -c driveFolderId=<手順2で控えたフォルダID>

# デプロイ
npx cdk deploy -c driveFolderId=<手順2で控えたフォルダID> \
  -c scheduleRate="rate(1 day)" -c scheduleEnabled=true
```

> `bootstrap` でも `-c driveFolderId` が要るのは、`bin/app.ts` が全 CDK コマンド共通で
> このコンテキストを必須にしているため(未指定だと即エラーで停止する)。bootstrap 自体は
> この値を使わないので、手順 2 のフォルダ ID をそのまま渡せばよい。

CDK context パラメータ:

| context | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `driveFolderId` | ○ | なし | 同期対象の Drive フォルダ ID |
| `scheduleRate` | - | `rate(1 day)` | 同期の起動間隔(EventBridge の rate / cron 式) |
| `scheduleEnabled` | - | `true` | `false` で定期起動を止める(手動起動のみ) |
| `rerank` | - | `true` | `false` で Slack bot のリランク(Cohere Rerank 3.5)を無効化。有効時はモデルアクセスが必要 |

デプロイ完了時に Outputs(`KnowledgeBaseId` / `DataSourceId` / `DocsBucketName` /
`SyncFunctionName` / `SaSecretArn`)が表示される。後から確認するには:

```bash
aws cloudformation describe-stacks --stack-name KnowledgeBaseStack \
  --region ap-northeast-1 --query "Stacks[0].Outputs" --output table
```

## 5. デプロイ後の設定と初回同期

### 5-1. SA の JSON キーをシークレットに投入

CDK は空のシークレットを作るだけなので、手順 1 で発行したキーを手動で投入する:

```bash
aws secretsmanager put-secret-value --region ap-northeast-1 \
  --secret-id <SaSecretArn> --secret-string file://service-account.json
```

> **注意(`file://` を必ず付ける)**: `--secret-string` に `file://` を付けないと、ファイルの
> 中身ではなくパス文字列そのものがシークレットに保存され、同期 Lambda が
> 「サービスアカウント JSON のパースに失敗しました」で落ちる。上記はカレントディレクトリに
> `service-account.json` がある前提。別の場所にある場合は絶対パスを指定するが、その際は
> `file://` + 先頭の `/` でスラッシュが 3 本になる(例: `file:///home/user/service-account.json`)。
> 値を入れ間違えても `put-secret-value` を正しく打ち直せば新バージョンで上書きされる。

投入後、手元の `service-account.json` は削除してよい(投入成功を確認してから)。

### 5-2. 同期 Lambda を手動起動

初回スケジュールを待たずに実行する場合:

```bash
aws lambda invoke --region ap-northeast-1 \
  --function-name <SyncFunctionName> \
  --cli-read-timeout 900 response.json && cat response.json
```

> Lambda のタイムアウトは 15 分。AWS CLI 既定の読み取りタイムアウト(60 秒)を
> `--cli-read-timeout 900` で延ばしておく。ファイル数が多く待ちたくない場合は
> `--invocation-type Event` で非同期起動し、ログで結果を確認する。

成功すると `{"uploaded":<件数>,"deleted":<件数>,"failed":<件数>,"ingestion":true}` が返る
(差分が無い 2 回目以降は `ingestion:false`)。`failed` はアップロードに失敗したファイル数で、
失敗ファイルは後続を止めずスキップされ、詳細は CloudWatch Logs に記録される。実行ログの確認:

```bash
aws logs tail /aws/lambda/<SyncFunctionName> --region ap-northeast-1 --follow
```

### 5-3. S3 反映と ingestion job の確認

```bash
# S3 への同期結果(キーは <DriveのfileId>/<ファイル名> 形式)
aws s3 ls s3://<DocsBucketName>/ --recursive

# ingestion job の状態(COMPLETE になれば検索可能)
aws bedrock-agent list-ingestion-jobs --region ap-northeast-1 \
  --knowledge-base-id <KnowledgeBaseId> --data-source-id <DataSourceId> \
  --query "ingestionJobSummaries[0].{status:status,stats:statistics}"
```

## 6. 動作確認(検索してみる)

ingestion が COMPLETE になったら検索を試せる。一番手軽なのは
[Bedrock コンソール(東京)のナレッジベース画面](https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1#/knowledge-bases)
で対象 KB を開き、「ナレッジベースをテスト」を使う方法。CLI で確認する場合は
Retrieve API を使う:

```bash
aws bedrock-agent-runtime retrieve --region ap-northeast-1 \
  --knowledge-base-id <KnowledgeBaseId> \
  --retrieval-query '{"text":"<ドキュメントに含まれるはずの内容>"}' \
  --query "retrievalResults[].{score:score,text:content.text}"
```
