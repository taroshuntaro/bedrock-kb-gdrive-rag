# 設計書: Google Drive をデータソースとする Bedrock Knowledge Base (S3 Vectors) の CDK 構築

- 作成日: 2026-06-11
- ステータス: 承認待ち
- リージョン: ap-northeast-1 (東京)

## 1. 目的とスコープ

Google Drive をデータソースとする RAG システムの土台を、**AWS CDK (TypeScript) で構築する**。Knowledge Base 一式に加え、**Google Drive → S3 の同期処理までを初期スコープに含める**。検索バックエンド・UI は今回作らず、後から追加できる構成にする。

### 今回のスコープ(作るもの)

- S3 ドキュメントバケット(同期されたファイルの置き場 / KB のデータソース)
- S3 Vectors バケットとインデックス(ベクトルストア)
- Bedrock Knowledge Base(Embedding: Titan Text Embeddings V2、ストレージ: S3 Vectors)
- S3 データソース(Fixed-size chunking)
- KB 実行用 IAM ロール(最小権限)
- **Google Drive → S3 同期 Lambda**(差分同期 + 取り込み起動)
- **同期用 Secrets Manager シークレット**(Google サービスアカウントの認証情報)
- **EventBridge スケジュール**(同期の定期起動。手動起動も併用)
- CloudFormation 出力(KnowledgeBaseId / DataSourceId / バケット名 / Lambda 名 / Secret ARN)

### スコープ外(将来の別作業)

- 検索バックエンド(Retrieve / RetrieveAndGenerate API)
- フロントエンド UI
- Amazon Bedrock AgentCore 連携
- 同期/取り込みの厳密な完了監視・通知(必要になったら追加)

## 2. データソース方針(なぜこの構成か)

Bedrock Knowledge Bases は **Google Drive をネイティブのデータソースコネクタとして持たない**(対応は S3 / Web Crawler / Confluence / SharePoint / Salesforce / Custom)。そのため Google Drive の取り込みは **「Drive → S3 同期 → S3 データソース」** 方式を採用する。S3 データソースは最も実績があり安定している。

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

## 5. Google Drive 同期方針

### 5.1 認証(サービスアカウント + フォルダ共有)

- GCP でサービスアカウント(SA)を作成し、JSON キーを発行する。
- 同期対象の Drive フォルダだけを SA のメールアドレスに「閲覧者」で共有する。SA は共有されたもの以外を一切参照できないため、**同期スコープが対象フォルダ(とサブフォルダ)に自然に限定**され、最小権限になる。
- 個人 Gmail / Google Workspace のどちらでもこの方式で動作する(ドメイン管理者権限は不要)。
- SA の JSON キーは AWS Secrets Manager に保存し、Lambda から読み取る。

### 5.2 対象ファイルと変換

- **Google ネイティブ形式はエクスポート変換する**:
  - Google ドキュメント / スライド → PDF (`application/pdf`)
  - Google スプレッドシート → CSV (`text/csv`)
- **通常ファイル(PDF / Word / テキスト等)はそのまま取得**する(`alt=media`)。

### 5.3 トリガー

- **EventBridge スケジュールで定期起動**(既定 `rate(1 day)`、有効/無効・頻度は設定可能)。
- 同じ Lambda を **CLI / コンソールから手動起動**することも可能にする。

### 5.4 差分検出と削除

- **フルリスト + 更新日時比較方式**を採用する。毎回フォルダ配下を全列挙し、`modifiedTime` を S3 オブジェクトのメタデータと比較して、新規・更新ファイルのみ転送する。
- Drive 側で削除されたファイルは、S3 側からも削除して同期する。
- S3 自体が同期状態を保持するため、別途の状態ストア(DynamoDB 等)は不要。

### 5.5 取り込み(ingestion)の起動 — 案1 + ガード

- 同期 Lambda が S3 反映後に `StartIngestionJob` を呼び、検索反映まで全自動にする。
- ガード:
  - **差分が 1 件でもあった場合のみ** ingestion を起動する(無変更時は起動しない)。
  - 当該データソースで **ingestion job が実行中の場合はスキップ**する(同時実行は 1 ジョブまでの制約に対応)。
- ingestion は非同期のため Lambda は起動のみ行い、完了は待たない。厳密な完了監視は初期スコープ外。

## 6. アーキテクチャ

```
        ┌──────────────────────┐
        │ EventBridge Schedule │ (定期/有効無効・頻度は設定可)
        └──────────┬───────────┘   ※同じ Lambda を手動起動も可
                   ▼
        ┌──────────────────────────────────────────┐
        │ Drive Sync Lambda (Node.js/TS)           │
        │  1. Secrets Manager から SA 認証取得       │
        │  2. Drive フォルダ配下を再帰列挙           │
        │  3. Google ネイティブ=エクスポート変換     │
        │     (Docs/Slides→PDF, Sheets→CSV)         │
        │     通常ファイル=そのまま取得              │
        │  4. modifiedTime 比較で新規/更新のみ S3 へ  │
        │  5. Drive で消えたファイルは S3 からも削除  │
        │  6. 差分あり&実行中ジョブ無し→StartIngestion│
        └───┬───────────────────────┬──────────────┘
            ▼                       ▼
   ┌─────────────────┐    ┌──────────────────────┐
   │ Secrets Manager │    │ S3 ドキュメントバケット │
   │ (SA JSON キー)   │    └──────────┬───────────┘
   └─────────────────┘               │ (S3 データソース)
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

## 7. CDK 構成要素とコンストラクト

S3 Vectors と KB の S3Vectors 連携は新しめの機能のため、**L1 (Cfn) コンストラクトを基本**とする(L2 は S3 Vectors 未対応の可能性があり、確実性を優先)。CDK は `aws-s3vectors` モジュールを含む **2.239.0 以降**を使用する。

| # | リソース | コンストラクト | 役割 |
|---|---|---|---|
| 1 | ドキュメント用 S3 バケット | `s3.Bucket` (L2) | 同期ファイルの置き場。バージョニング有効 / SSE-S3 暗号化 / パブリックアクセス全ブロック |
| 2 | S3 Vectors バケット | `aws-s3vectors` の `CfnVectorBucket` (L1) | ベクトルの保存先 |
| 3 | S3 Vectors インデックス | `CfnIndex` (L1) | 1024 次元 / float32 / distanceMetric=cosine |
| 4 | KB 用 IAM ロール | `iam.Role` (L2) | KB の実行ロール(最小権限) |
| 5 | Knowledge Base | `bedrock.CfnKnowledgeBase` (L1) | embedding=Titan V2(1024)、storage=`S3VectorsConfiguration` |
| 6 | データソース | `bedrock.CfnDataSource` (L1) | type=S3、対象=①のバケット、chunking=Fixed-size |
| 7 | 出力 | `CfnOutput` | KnowledgeBaseId / DataSourceId / バケット名 / Lambda 名 / Secret ARN |
| 8 | SA 認証シークレット | `secretsmanager.Secret` | Google SA の JSON キー保管(**値は手動投入**) |
| 9 | Drive Sync Lambda | `nodejs.NodejsFunction` | 同期 + ingestion 起動。タイムアウト長め(〜15分)、メモリは取得サイズに応じて設定 |
| 10 | Lambda 実行ロール | `iam.Role` (L2) | 同期 Lambda の最小権限ロール |
| 11 | EventBridge スケジュール | `events.Rule` (schedule) | Lambda 定期起動。`enabled` と頻度を設定可能に |

KB → (S3 Vectors インデックス, KB 用 IAM ロール) の依存を明示し、作成順序を保証する。

> **実装上の注意(S3 Vectors × Bedrock KB のメタデータ設定):** Bedrock KB は S3 Vectors にチャンク本文やソース情報を `AMAZON_BEDROCK_TEXT` / `AMAZON_BEDROCK_METADATA` といったメタデータキーで書き込む。これらをフィルタ可能メタデータとして扱うとサイズ上限に抵触しやすいため、インデックスの `MetadataConfiguration` で本文系キーを **non-filterable** に指定する。詳細値は実装計画で確定する。

### IAM ロールの権限(最小権限)

**KB 実行ロール(④)**
- `bedrock:InvokeModel` — Titan Text Embeddings V2 のモデル ARN に限定
- `s3:GetObject` / `s3:ListBucket` — ① のドキュメントバケットに限定
- S3 Vectors インデックスへのアクセス(`s3vectors:*` を当該インデックス ARN に限定)

**同期 Lambda 実行ロール(⑩)**
- `secretsmanager:GetSecretValue` — ⑧ のシークレットに限定
- `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` / `s3:ListBucket` — ① のドキュメントバケットに限定
- `bedrock:StartIngestionJob` / `bedrock:ListIngestionJobs` — 当該 KB・データソースに限定

## 8. プロジェクト構成

プロジェクトフォルダ: `/home/ss160341/_work/bedrock-kb-gdrive-rag`

```
bedrock-kb-gdrive-rag/
├── bin/
│   └── app.ts                       # CDK App エントリ。env(account/region=ap-northeast-1)設定
├── lib/
│   └── knowledge-base-stack.ts      # 本体スタック(KB + 同期を集約)
├── lambda/
│   └── drive-sync/
│       ├── index.ts                 # ハンドラ(同期 + ingestion 起動)
│       ├── drive-client.ts          # Drive API ラッパ(列挙・エクスポート・取得)
│       └── s3-sync.ts               # 差分判定・アップロード・削除
├── test/
│   ├── knowledge-base-stack.test.ts # CDK テンプレート assertion テスト
│   └── drive-sync.test.ts           # 同期ロジックの単体テスト(Drive/S3 をモック)
├── cdk.json
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md                        # 構築手順・前提・将来拡張メモ
```

スタックは 1 つ(`KnowledgeBaseStack`)に集約。将来 UI / 検索 API を足す時に別スタックを追加する。Lambda コードは `lambda/drive-sync/` に分離する。

## 9. 初期パラメータ

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
| `DRIVE_FOLDER_ID` | 同期対象フォルダ ID(CDK context or env で指定。必須) |
| スケジュール頻度 | 既定 `rate(1 day)`(設定で変更可)。手動起動も併用 |
| Google エクスポート形式 | Docs/Slides→PDF、Sheets→CSV |
| S3 オブジェクトキー | Drive の fileId 起点の安定キー + 元のパス/名称をメタデータ保持(リネーム時の重複・削除検出に強い) |
| Lambda 実装言語 | TypeScript(Node.js) |
| Lambda タイムアウト | 〜15 分(取得量に応じて調整) |
| リソース命名 | `bedrock-kb-gdrive-*` 接頭辞 |

## 10. テスト方針

TDD で進める。

**CDK アサーション(`aws-cdk-lib/assertions` の `Template`)**
- KB が `S3VectorsConfiguration` を持つこと
- S3 Vectors インデックスが 1024 次元 / float32 / cosine であること
- データソースが Fixed-size chunking 設定であること
- 各 IAM ロールが最小権限であること(対象 ARN に限定されていること)
- 同期 Lambda・EventBridge スケジュール・シークレットが生成されること

**同期ロジックの単体テスト(Drive / S3 をモック)**
- modifiedTime 比較で新規・更新のみ転送されること
- Drive で削除されたファイルが S3 から削除されること
- Google ネイティブ形式が正しいエクスポート形式に振り分けられること
- 差分が無い場合に ingestion を起動しないこと
- ingestion job が実行中の場合にスキップすること

## 11. 前提・手動作業(README に明記)

- GCP で **サービスアカウント作成 → JSON キー発行 → Drive API 有効化**
- 同期対象の **Drive フォルダを SA メールに共有**(閲覧者)
- Bedrock コンソールで **Titan Text Embeddings V2 のモデルアクセス有効化**(初回 1 回、手動)
- `cdk bootstrap`(東京リージョン、初回のみ)
- `DRIVE_FOLDER_ID` を CDK context で指定して `cdk deploy`
- デプロイ後、発行した **JSON キーを Secrets Manager のシークレットに投入**(CDK は空のシークレットを作成)
- 同期 Lambda を手動起動(または初回スケジュールを待つ)→ S3 反映 → ingestion 起動を確認

## 12. 参考リンク

- [S3 Vectors × Bedrock Knowledge Bases](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html)
- [S3 Vectors 対応リージョン一覧(東京を含む)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-regions-quotas.html)
- [S3 Vectors GA(AWS News)](https://aws.amazon.com/blogs/aws/amazon-s3-vectors-now-generally-available-with-increased-scale-and-performance/)
- [AWS::Bedrock::KnowledgeBase S3VectorsConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-s3vectorsconfiguration.html)
- [AgentCore 対応リージョン一覧](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
- [コスト最適化 RAG(Bedrock KB + S3 Vectors)](https://aws.amazon.com/blogs/machine-learning/building-cost-effective-rag-applications-with-amazon-bedrock-knowledge-bases-and-amazon-s3-vectors/)
- [Google Drive API: ファイルのエクスポート](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
