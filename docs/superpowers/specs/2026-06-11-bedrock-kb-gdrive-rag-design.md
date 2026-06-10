# 設計書: Google Drive を見据えた Bedrock Knowledge Base (S3 Vectors) の CDK 構築

- 作成日: 2026-06-11
- ステータス: 承認待ち
- リージョン: ap-northeast-1 (東京)

## 1. 目的とスコープ

Google Drive をデータソースとする RAG システムの土台として、**Amazon Bedrock Knowledge Base 一式を AWS CDK (TypeScript) で構築する**。UI・バックエンド・Google Drive 同期処理は今回作らず、それらを後から追加できる構成にする。

### 今回のスコープ(作るもの)

- S3 ドキュメントバケット(文書の置き場 / 将来の Drive→S3 同期の出力先)
- S3 Vectors バケットとインデックス(ベクトルストア)
- Bedrock Knowledge Base(Embedding: Titan Text Embeddings V2、ストレージ: S3 Vectors)
- S3 データソース(Fixed-size chunking)
- KB 実行用 IAM ロール(最小権限)
- CloudFormation 出力(KnowledgeBaseId / DataSourceId / バケット名)

### スコープ外(将来の別スタック・別作業)

- Google Drive → S3 の同期処理(Lambda / EventBridge 等)
- 検索バックエンド(Retrieve / RetrieveAndGenerate API)
- フロントエンド UI
- Amazon Bedrock AgentCore 連携

## 2. データソース方針(なぜこの構成か)

Bedrock Knowledge Bases は **Google Drive をネイティブのデータソースコネクタとして持たない**(対応は S3 / Web Crawler / Confluence / SharePoint / Salesforce / Custom)。そのため Google Drive の取り込みは **「Drive → S3 同期 → S3 データソース」** 方式を採用する。

これにより、今回は KB と S3 を先に構築し、Drive→S3 同期は将来別途追加できる。S3 データソースは最も実績があり安定している。

## 3. ベクトルストア方針(なぜ S3 Vectors か)

ベクトルストアには **Amazon S3 Vectors** を採用する。

- 2026 年時点で GA 済み。東京リージョン(ap-northeast-1)で利用可能。
- CloudFormation / CDK で構築可能(`AWS::S3Vectors::VectorBucket` / `AWS::S3Vectors::Index`、CDK の `aws-s3vectors` L1 モジュール)。
- Bedrock KB 側も `AWS::Bedrock::KnowledgeBase` の `S3VectorsConfiguration` で対応。
- OpenSearch Serverless のような常時課金(OCU)が無く、保存量とリクエストの従量課金のみ。個人・学習用途のコストとして最適。

## 4. リージョン方針(なぜ東京か)

東京(ap-northeast-1)を採用する。

- S3 Vectors / Titan Text Embeddings V2 / Bedrock Knowledge Bases がすべて東京で利用可能。
- 将来連携を想定する AgentCore も、中核機能(Runtime / Memory / Gateway / Identity / Observability / Evaluations / Policy / Agent Registry)が東京で利用可能。未対応は preview の harness / payments のみ。
- KB の Retrieve / RetrieveAndGenerate は API 呼び出しのためクロスリージョン参照も可能で、リージョン選択が将来の連携をブロックしない。
- 日本からの低レイテンシ・データ所在地が日本である点が個人ドキュメントの土台として有利。

## 5. アーキテクチャ

```
[将来] Google Drive ──(同期: 今回は対象外)──▶ ┌─────────────────────┐
                                              │  S3 ドキュメントバケット │
                                              └──────────┬──────────┘
                                                         │ (S3 データソース)
                                                         ▼
                                       ┌──────────────────────────────────┐
                                       │   Bedrock Knowledge Base          │
                                       │   - Embedding: Titan V2 (1024次元) │
                                       │   - Chunking: Fixed-size           │
                                       └──────────┬───────────────────────┘
                                                  │ (S3VectorsConfiguration)
                                                  ▼
                                       ┌──────────────────────────────────┐
                                       │  S3 Vectors                       │
                                       │   - Vector Bucket                 │
                                       │   - Index (1024, float32, cosine) │
                                       └──────────────────────────────────┘
```

## 6. CDK 構成要素とコンストラクト

S3 Vectors と KB の S3Vectors 連携は新しめの機能のため、**L1 (Cfn) コンストラクトを基本**とする(L2 は S3 Vectors 未対応の可能性があり、確実性を優先)。CDK は `aws-s3vectors` モジュールを含む **2.239.0 以降**を使用する。

| # | リソース | コンストラクト | 役割 |
|---|---|---|---|
| 1 | ドキュメント用 S3 バケット | `s3.Bucket` (L2) | 文書の置き場。バージョニング有効 / SSE-S3 暗号化 / パブリックアクセス全ブロック |
| 2 | S3 Vectors バケット | `aws-s3vectors` の `CfnVectorBucket` (L1) | ベクトルの保存先 |
| 3 | S3 Vectors インデックス | `CfnIndex` (L1) | 1024 次元 / float32 / distanceMetric=cosine |
| 4 | KB 用 IAM ロール | `iam.Role` (L2) | KB の実行ロール(最小権限) |
| 5 | Knowledge Base | `bedrock.CfnKnowledgeBase` (L1) | embedding=Titan V2(1024)、storage=`S3VectorsConfiguration` |
| 6 | データソース | `bedrock.CfnDataSource` (L1) | type=S3、対象=①のバケット、chunking=Fixed-size |
| 7 | 出力 | `CfnOutput` | KnowledgeBaseId / DataSourceId / バケット名 |

KB → (S3 Vectors インデックス, IAM ロール) の依存を明示し、作成順序を保証する。

> **実装上の注意(S3 Vectors × Bedrock KB のメタデータ設定):** Bedrock KB は S3 Vectors にチャンク本文やソース情報を `AMAZON_BEDROCK_TEXT` / `AMAZON_BEDROCK_METADATA` といったメタデータキーで書き込む。これらをフィルタ可能メタデータとして扱うとサイズ上限に抵触しやすいため、インデックスの `MetadataConfiguration` で本文系キーを **non-filterable** に指定する。詳細値は実装計画で確定する。

### IAM ロールの権限(KB 実行ロール、最小権限)

- `bedrock:InvokeModel` — Titan Text Embeddings V2 のモデル ARN に限定
- `s3:GetObject` / `s3:ListBucket` — ① のドキュメントバケットに限定
- S3 Vectors インデックスへのアクセス(`s3vectors:*` を当該インデックス ARN に限定)

## 7. プロジェクト構成

プロジェクトフォルダ: `/home/ss160341/_work/bedrock-kb-gdrive-rag`

```
bedrock-kb-gdrive-rag/
├── bin/
│   └── app.ts                      # CDK App エントリ。env(account/region=ap-northeast-1)設定
├── lib/
│   └── knowledge-base-stack.ts     # 本体スタック(セクション6の①〜⑦)
├── test/
│   └── knowledge-base-stack.test.ts # テンプレート assertion テスト
├── cdk.json
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md                       # 構築手順・前提・将来拡張メモ
```

スタックは 1 つ(`KnowledgeBaseStack`)。将来 UI / 同期 / API を足す時に別スタックを追加する。

## 8. 初期パラメータ

定数として `lib` に定義し、後で調整しやすくする。

| 項目 | 初期値 |
|---|---|
| リージョン | `ap-northeast-1` |
| Embedding モデル | `amazon.titan-embed-text-v2:0` |
| ベクトル次元 | `1024` |
| 距離メトリック | `cosine` |
| データ型 | `float32` |
| Chunking 戦略 | Fixed-size: maxTokens=300 / overlap=20% |
| S3 バケット | バージョニング有効 / SSE-S3 暗号化 / パブリックアクセス全ブロック |
| リソース命名 | `bedrock-kb-gdrive-*` 接頭辞 |

## 9. テスト方針

TDD で進める。`aws-cdk-lib/assertions` の `Template` を用い、以下を検証する軽量なアサーションテストを用意する。

- KB が `S3VectorsConfiguration` を持つこと
- S3 Vectors インデックスが 1024 次元 / float32 / cosine であること
- データソースが Fixed-size chunking 設定であること
- IAM ロールが最小権限であること(対象 ARN に限定されていること)

## 10. 前提・手動作業(README に明記)

- Bedrock コンソールで **Titan Text Embeddings V2 のモデルアクセス有効化**(初回 1 回、手動)
- `cdk bootstrap`(東京リージョン、初回のみ)
- デプロイ後、① バケットに文書を置く → KB の Sync(ingestion job)を実行して動作確認

## 11. 参考リンク

- [S3 Vectors × Bedrock Knowledge Bases](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html)
- [S3 Vectors 対応リージョン一覧(東京を含む)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-regions-quotas.html)
- [S3 Vectors GA(AWS News)](https://aws.amazon.com/blogs/aws/amazon-s3-vectors-now-generally-available-with-increased-scale-and-performance/)
- [AWS::Bedrock::KnowledgeBase S3VectorsConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-s3vectorsconfiguration.html)
- [AgentCore 対応リージョン一覧](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
- [コスト最適化 RAG(Bedrock KB + S3 Vectors)](https://aws.amazon.com/blogs/machine-learning/building-cost-effective-rag-applications-with-amazon-bedrock-knowledge-bases-and-amazon-s3-vectors/)
