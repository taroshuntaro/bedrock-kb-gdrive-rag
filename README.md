# bedrock-kb-gdrive-rag

Google Drive をデータソースとする Amazon Bedrock Knowledge Base(S3 Vectors)を
AWS CDK (TypeScript) で東京リージョン(ap-northeast-1)に構築する。Drive→S3 差分同期と
取り込み(ingestion)自動起動まで含む。

現時点では検索バックエンドや UI は本リポジトリのスコープ外だが、ナレッジベースさえ作れば
[Bedrock コンソール(東京)のナレッジベース画面](https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1#/knowledge-bases)
から対象 KB を開き、「ナレッジベースをテスト」でそのまま検索を試せる
(ベクトル検索のみの取得と、モデルを選んで回答生成させる RAG の両方が UI 上で実行できる)。

## 構成

- S3 ドキュメントバケット(同期先 / KB データソース)
- S3 Vectors バケット + インデックス(1024 次元 / cosine)
- Bedrock Knowledge Base(Titan Text Embeddings V2)+ S3 データソース(Fixed-size chunking)
- Drive 同期 Lambda(Node.js)+ Secrets Manager + EventBridge スケジュール

## 前提

- Node.js 20 以上 / npm
- AWS CLI v2(未設定の場合は手順 0 を参照)
- Google アカウント(Gmail で可。GCP のセットアップはほぼ `gcloud` CLI だけで完結する — 手順 1)

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
#   SSO start URL    : 組織のアクセスポータル URL(https://xxxx.awsapps.com/start)
#   SSO region       : Identity Center のリージョン
#   → ブラウザが開くので認可し、アカウントとロールを選択
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

## 3. AWS: Bedrock モデルアクセスの有効化(初回のみ)

[Bedrock コンソール(東京)](https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1#/modelaccess)
の「モデルアクセス」→「モデルアクセスを変更」で **Titan Text Embeddings V2** を有効化する。

## 4. デプロイ

```bash
npm install

# CDK bootstrap(東京リージョンで初回のみ。アカウント ID は自動取得)
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-northeast-1

# デプロイ
npx cdk deploy -c driveFolderId=<手順2で控えたフォルダID> \
  -c scheduleRate="rate(1 day)" -c scheduleEnabled=true
```

CDK context パラメータ:

| context | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `driveFolderId` | ○ | なし | 同期対象の Drive フォルダ ID |
| `scheduleRate` | - | `rate(1 day)` | 同期の起動間隔(EventBridge の rate / cron 式) |
| `scheduleEnabled` | - | `true` | `false` で定期起動を止める(手動起動のみ) |

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

投入後、手元の `service-account.json` は削除してよい。

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

ingestion が COMPLETE になったら検索を試せる。一番手軽なのは Bedrock コンソールの
対象 KB 画面にある「ナレッジベースをテスト」(冒頭のリンク参照)。CLI で確認する場合は
Retrieve API を使う:

```bash
aws bedrock-agent-runtime retrieve --region ap-northeast-1 \
  --knowledge-base-id <KnowledgeBaseId> \
  --retrieval-query '{"text":"<ドキュメントに含まれるはずの内容>"}' \
  --query "retrievalResults[].{score:score,text:content.text}"
```

## 制約・注意事項

- **ファイル変換**: Google ドキュメント / スライド → PDF、スプレッドシート → CSV に
  エクスポートして同期する。それ以外の Google ネイティブ形式(フォーム等)はスキップ。
  通常ファイル(PDF / Word / テキスト等)はそのまま同期する。
- **エクスポート上限**: Drive の export API には約 10 MB の上限があり、超える Google
  ドキュメント等はエクスポートに失敗する。
- **取り込み対象形式**: Bedrock KB が解釈できるのは PDF / TXT / MD / HTML / DOC(X) /
  CSV / XLS(X) 等。対象外形式のファイルが S3 にあると ingestion で失敗・スキップ扱いになる。
- **削除も同期される**: Drive 側で削除(ゴミ箱入り含む)したファイルは S3 からも削除される。
- **`cdk destroy` の挙動**: ドキュメントバケットは `RETAIN` のため削除されず残る。
  完全に消す場合はバケットを空にしてから手動で削除する。

## 既知の課題(ファイル増加時)

数百ファイル規模では問題ないが、対象フォルダのファイル数が増えると以下が顕在化しうる:

- **S3 一覧時の `HeadObject` N+1**: 同期 Lambda は差分判定のため、S3 オブジェクトごとに
  `HeadObject` を発行して `modifiedTime`(独自メタデータ)を取得している
  (`lambda/drive-sync/index.ts` の `listS3`)。`ListObjectsV2` は独自メタデータを返さない
  ための実装だが、オブジェクト数に比例して API 呼び出しと同期時間が増える。数千ファイル規模で
  Lambda の 15 分タイムアウトに近づく場合は、同期状態(キー → `modifiedTime`)を 1 つの
  マニフェスト JSON として S3 に置き、毎回 1 回の `GetObject` で読む方式への変更を検討する。
  - 補足: 安定キー(`<fileId>/<名前>`)にタイムスタンプを埋め込む案は、リネーム時の重複・
    削除検出を壊すため不可。状態は別管理(マニフェスト等)にするのが筋。

## 開発用コマンド

```bash
npm install              # 依存をインストール

npm test                 # Jest 単体テスト + CDK assertion テスト
npx tsc --noEmit         # 型チェック(ts-jest は transpile-only のためテストでは型検査しない)
npm run build            # TypeScript を dist/ にコンパイル

npx cdk synth  -c driveFolderId=<対象フォルダID>   # CloudFormation テンプレートを生成して確認
npx cdk diff   -c driveFolderId=<対象フォルダID>   # 既存スタックとの差分を確認
npx cdk deploy -c driveFolderId=<対象フォルダID>   # デプロイ
npx cdk destroy -c driveFolderId=<対象フォルダID>  # スタックを削除
```

> `driveFolderId` は全 CDK コマンドで必須(未指定だと即エラーで停止する)。`destroy` でも
> アプリの合成のため指定が要るが、削除動作自体には影響しない。

> メモ: 型安全は `npx tsc --noEmit` で担保している(`jest` は速度・メモリのため transpile-only)。
> CI などでは `npm test` と `npx tsc --noEmit` を併用すること。

## スコープ外(将来)

検索バックエンド(Retrieve / RetrieveAndGenerate API)、UI、AgentCore 連携。
