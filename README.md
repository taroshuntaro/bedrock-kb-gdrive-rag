# bedrock-kb-gdrive-rag

Google Drive をデータソースとする Amazon Bedrock Knowledge Base(S3 Vectors)を
AWS CDK (TypeScript) で東京リージョン(ap-northeast-1)に構築する。Drive→S3 差分同期と
取り込み(ingestion)自動起動まで含む。

## 構成

- S3 ドキュメントバケット(同期先 / KB データソース)
- S3 Vectors バケット + インデックス(1024 次元 / cosine)
- Bedrock Knowledge Base(Titan Text Embeddings V2)+ S3 データソース(Fixed-size chunking)
- Drive 同期 Lambda(Node.js)+ Secrets Manager + EventBridge スケジュール

## 前提・手動作業

1. **GCP**: サービスアカウント作成 → JSON キー発行 → 対象プロジェクトで Drive API を有効化
2. **Drive**: 同期したいフォルダを SA のメールアドレスに「閲覧者」で共有
3. **Bedrock**: コンソールで Titan Text Embeddings V2 のモデルアクセスを有効化(初回のみ)
4. **AWS**: `npx cdk bootstrap`(東京、初回のみ)

## デプロイ

```bash
npm install
npx cdk deploy -c driveFolderId=<対象フォルダID> \
  -c scheduleRate="rate(1 day)" -c scheduleEnabled=true
```

デプロイ後:

1. 出力された `SaSecretArn` のシークレットに、発行した SA の JSON キーを投入
   ```bash
   aws secretsmanager put-secret-value --region ap-northeast-1 \
     --secret-id <SaSecretArn> --secret-string file://service-account.json
   ```
2. 同期 Lambda を手動起動(または初回スケジュールを待つ)
   ```bash
   aws lambda invoke --region ap-northeast-1 \
     --function-name <SyncFunctionName> /dev/stdout
   ```
3. S3 への反映と ingestion job の起動を確認

## テスト

```bash
npm test          # Jest 単体 + CDK assertion
npx cdk synth     # テンプレート生成確認
```

## スコープ外(将来)

検索バックエンド(Retrieve / RetrieveAndGenerate API)、UI、AgentCore 連携。
