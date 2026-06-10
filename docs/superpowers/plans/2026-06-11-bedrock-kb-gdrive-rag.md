# Bedrock KB (S3 Vectors) + Google Drive 同期 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google Drive をデータソースとする Bedrock Knowledge Base 一式(S3 Vectors)と、Drive→S3 差分同期 + 取り込み自動起動を、AWS CDK (TypeScript) で東京リージョンに構築する。

**Architecture:** 単一スタック `KnowledgeBaseStack` に、S3 ドキュメントバケット / S3 Vectors(バケット+インデックス)/ Bedrock KB / S3 データソース / Drive 同期 Lambda(Node.js)/ Secrets Manager / EventBridge スケジュールを集約する。Drive 同期は「フルリスト + modifiedTime 比較」で差分のみ S3 へ反映し、差分があり既存 ingestion job が無い時のみ `StartIngestionJob` を呼ぶ。

**Tech Stack:** AWS CDK 2.x (>= 2.239.0, `aws-s3vectors` を含む) / TypeScript / Node.js 20 Lambda / Jest / `googleapis` / AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/client-bedrock-agent`, `@aws-sdk/client-secrets-manager`)

---

## 前提メモ(全タスク共通)

- **S3 Vectors と Bedrock KB の S3Vectors 連携は新しめの機能。** L1 (`Cfn*`) コンストラクトのプロパティ名は、インストールした `aws-cdk-lib` のバージョンの型定義が正。各 CDK タスクの最後で `npx cdk synth` を実行し、型エラーが出たら**エディタの型補完 / `node_modules/aws-cdk-lib/aws-s3vectors` と `.../aws-bedrock` の `.d.ts`** を参照して、本計画のプロパティ名を実際の型に合わせて修正する。本計画のコードは CloudFormation のリソース仕様に基づく想定形であり、最終的な正解は型定義に従うこと。
- リージョンは全体で `ap-northeast-1` 固定。
- Embedding モデル ARN: `arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.titan-embed-text-v2:0`
- S3 Vectors インデックスの `nonFilterableMetadataKeys` に `AMAZON_BEDROCK_TEXT` と `AMAZON_BEDROCK_METADATA` を含める。
- コミットメッセージ末尾には既存運用に合わせ `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` を付ける。

## ファイル構成(decomposition)

| ファイル | 責務 |
|---|---|
| `bin/app.ts` | CDK App エントリ。env(region=ap-northeast-1)と context 取得、スタックのインスタンス化 |
| `lib/config.ts` | 定数(モデル ARN、次元、chunking、命名接頭辞、スケジュール既定値、export MIME マップ) |
| `lib/knowledge-base-stack.ts` | 全 AWS リソース定義(KB + 同期) |
| `lambda/drive-sync/mime.ts` | Google ネイティブ判定・エクスポート MIME・S3 拡張子の純粋ロジック |
| `lambda/drive-sync/s3-sync.ts` | 差分判定(更新/新規/削除)の純粋ロジック |
| `lambda/drive-sync/drive-client.ts` | Drive API ラッパ(列挙・取得・エクスポート)。副作用境界 |
| `lambda/drive-sync/index.ts` | ハンドラ。各部品を組み合わせ S3 反映 + ingestion ガード起動 |
| `test/knowledge-base-stack.test.ts` | CDK テンプレート assertion |
| `test/mime.test.ts` | `mime.ts` 単体テスト |
| `test/s3-sync.test.ts` | `s3-sync.ts` 単体テスト |
| `test/handler.test.ts` | `index.ts` のガードロジック単体テスト(Drive/S3/Bedrock をモック) |
| `README.md` | 構築手順・前提・手動作業 |

---

## Task 1: CDK TypeScript プロジェクトの初期化

**Files:**
- Create: `package.json`, `tsconfig.json`, `cdk.json`, `jest.config.js`, `bin/app.ts`, `lib/knowledge-base-stack.ts`

- [ ] **Step 1: package.json を作成**

```json
{
  "name": "bedrock-kb-gdrive-rag",
  "version": "0.1.0",
  "bin": { "bedrock-kb-gdrive-rag": "bin/app.js" },
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "cdk": "cdk",
    "synth": "cdk synth"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "aws-cdk": "^2.1010.0",
    "esbuild": "^0.23.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.0"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.239.0",
    "constructs": "^10.3.0"
  }
}
```

- [ ] **Step 2: tsconfig.json を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node", "jest"],
    "outDir": "dist"
  },
  "exclude": ["node_modules", "cdk.out", "dist"]
}
```

- [ ] **Step 3: cdk.json を作成**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "context": {
    "driveFolderId": "",
    "scheduleRate": "rate(1 day)",
    "scheduleEnabled": "true"
  }
}
```

- [ ] **Step 4: jest.config.js を作成**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
};
```

- [ ] **Step 5: 最小の bin/app.ts と空スタックを作成**

`lib/knowledge-base-stack.ts`:
```ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface KnowledgeBaseStackProps extends StackProps {
  readonly driveFolderId: string;
  readonly scheduleRate: string;
  readonly scheduleEnabled: boolean;
}

export class KnowledgeBaseStack extends Stack {
  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);
  }
}
```

`bin/app.ts`:
```ts
#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new App();

const driveFolderId = app.node.tryGetContext('driveFolderId') ?? '';
const scheduleRate = app.node.tryGetContext('scheduleRate') ?? 'rate(1 day)';
const scheduleEnabled = String(app.node.tryGetContext('scheduleEnabled') ?? 'true') === 'true';

new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env: { region: 'ap-northeast-1' },
  driveFolderId,
  scheduleRate,
  scheduleEnabled,
});
```

- [ ] **Step 6: 依存をインストールして synth が通ることを確認**

Run: `npm install && npx cdk synth`
Expected: エラー無くテンプレート(空スタック)が出力される

- [ ] **Step 7: .gitignore を是正してコミット**

先に作成した `.gitignore` は `*.js` を無視するため、`jest.config.js` まで対象外になってしまう。CDK は ts-node で実行され `.ts` をその場でコンパイルしないので、`*.js` の blanket ignore は不要。`.gitignore` を次の内容に上書きする:
```
node_modules/
cdk.out/
dist/
.cdk.staging/
*.d.ts
```
そのうえでコミット:
```bash
git add .gitignore package.json tsconfig.json cdk.json jest.config.js bin/app.ts lib/knowledge-base-stack.ts
git commit -m "chore: CDK TypeScript プロジェクトを初期化"
```

---

## Task 2: 設定定数ファイル

**Files:**
- Create: `lib/config.ts`

- [ ] **Step 1: lib/config.ts を作成**

```ts
export const REGION = 'ap-northeast-1';
export const NAME_PREFIX = 'bedrock-kb-gdrive';

export const EMBEDDING_MODEL_ARN =
  `arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0`;
export const EMBEDDING_DIMENSION = 1024;
export const VECTOR_DATA_TYPE = 'float32';
export const VECTOR_DISTANCE_METRIC = 'cosine';

export const CHUNK_MAX_TOKENS = 300;
export const CHUNK_OVERLAP_PERCENT = 20;

// Bedrock KB が S3 Vectors に書き込む本文系メタデータキー(フィルタ非対象にする)
export const NON_FILTERABLE_METADATA_KEYS = [
  'AMAZON_BEDROCK_TEXT',
  'AMAZON_BEDROCK_METADATA',
];

export const DEFAULT_SCHEDULE_RATE = 'rate(1 day)';
```

- [ ] **Step 2: コンパイル確認**

Run: `npx tsc --noEmit`
Expected: エラー無し

- [ ] **Step 3: コミット**

```bash
git add lib/config.ts
git commit -m "chore: 設定定数を追加"
```

---

## Task 3: S3 ドキュメントバケット

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/knowledge-base-stack.test.ts`:
```ts
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

function synth() {
  const app = new App();
  const stack = new KnowledgeBaseStack(app, 'TestStack', {
    env: { region: 'ap-northeast-1' },
    driveFolderId: 'folder-123',
    scheduleRate: 'rate(1 day)',
    scheduleEnabled: true,
  });
  return Template.fromStack(stack);
}

test('ドキュメントバケットがバージョニング・暗号化・パブリックアクセスブロックを持つ', () => {
  const t = synth();
  t.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: Match.anyValue(),
    }),
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicAccess: true,
    },
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t バージョニング`
Expected: FAIL(バケットが存在しない)

- [ ] **Step 3: バケットを実装**

`lib/knowledge-base-stack.ts` の constructor 内に追加(import も追加):
```ts
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NAME_PREFIX } from './config';
// ...
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.docsBucket = docsBucket;
```
クラスにフィールドを追加:
```ts
  public readonly docsBucket: s3.Bucket;
```

- [ ] **Step 4: テスト成功を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t バージョニング`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: ドキュメント用 S3 バケットを追加"
```

---

## Task 4: S3 Vectors バケットとインデックス

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`test/knowledge-base-stack.test.ts` に追記:
```ts
test('S3 Vectors インデックスが 1024 次元/float32/cosine で作られる', () => {
  const t = synth();
  t.hasResourceProperties('AWS::S3Vectors::Index', {
    Dimension: 1024,
    DataType: 'float32',
    DistanceMetric: 'cosine',
  });
  t.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "S3 Vectors"`
Expected: FAIL

- [ ] **Step 3: S3 Vectors を実装**

import を追加し constructor に追記。**プロパティ名は synth で型に合わせて調整すること**(前提メモ参照):
```ts
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import {
  EMBEDDING_DIMENSION, VECTOR_DATA_TYPE, VECTOR_DISTANCE_METRIC,
  NON_FILTERABLE_METADATA_KEYS,
} from './config';
// ...
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {});

    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.ref,
      dimension: EMBEDDING_DIMENSION,
      dataType: VECTOR_DATA_TYPE,
      distanceMetric: VECTOR_DISTANCE_METRIC,
      metadataConfiguration: {
        nonFilterableMetadataKeys: NON_FILTERABLE_METADATA_KEYS,
      },
    });
    vectorIndex.addDependency(vectorBucket);
    this.vectorBucket = vectorBucket;
    this.vectorIndex = vectorIndex;
```
フィールド追加:
```ts
  public readonly vectorBucket: s3vectors.CfnVectorBucket;
  public readonly vectorIndex: s3vectors.CfnIndex;
```

- [ ] **Step 4: synth で型を確認し、必要なら修正**

Run: `npx cdk synth`
Expected: 成功。型エラーが出たら `node_modules/aws-cdk-lib/aws-s3vectors` の `.d.ts` を見てプロパティ名(例: `vectorBucketName` vs `vectorBucketArn`、`metadataConfiguration` の形)を合わせる。

- [ ] **Step 5: テスト成功を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "S3 Vectors"`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: S3 Vectors バケット・インデックスを追加"
```

---

## Task 5: KB 実行 IAM ロール

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('KB ロールが bedrock の信頼ポリシーを持つ', () => {
  const t = synth();
  t.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'bedrock.amazonaws.com' },
        }),
      ]),
    }),
  }));
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "KB ロール"`
Expected: FAIL

- [ ] **Step 3: ロールを実装**

```ts
import * as iam from 'aws-cdk-lib/aws-iam';
import { EMBEDDING_MODEL_ARN } from './config';
// ...
    const kbRole = new iam.Role(this, 'KbRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [EMBEDDING_MODEL_ARN],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [docsBucket.bucketArn, `${docsBucket.bucketArn}/*`],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3vectors:*'],
      resources: [vectorIndex.attrIndexArn],
    }));
    this.kbRole = kbRole;
```
フィールド追加: `public readonly kbRole: iam.Role;`

> 注: `vectorIndex.attrIndexArn` の属性名は synth で確認。`AWS::S3Vectors::Index` の戻り属性名に合わせる(`attrIndexArn` / `attrArn` 等)。

- [ ] **Step 4: synth & テスト成功を確認**

Run: `npx cdk synth && npx jest test/knowledge-base-stack.test.ts -t "KB ロール"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: KB 実行 IAM ロールを追加"
```

---

## Task 6: Bedrock Knowledge Base(S3 Vectors)

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('KB が S3_VECTORS ストレージと Titan V2 埋め込みを使う', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Bedrock::KnowledgeBase', Match.objectLike({
    KnowledgeBaseConfiguration: Match.objectLike({
      Type: 'VECTOR',
      VectorKnowledgeBaseConfiguration: Match.objectLike({
        EmbeddingModelArn: Match.stringLikeRegexp('titan-embed-text-v2'),
      }),
    }),
    StorageConfiguration: Match.objectLike({ Type: 'S3_VECTORS' }),
  }));
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "S3_VECTORS ストレージ"`
Expected: FAIL

- [ ] **Step 3: KB を実装**

```ts
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { EMBEDDING_DIMENSION } from './config';
// ...
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${NAME_PREFIX}-kb`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: EMBEDDING_MODEL_ARN,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: EMBEDDING_DIMENSION,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
          indexArn: vectorIndex.attrIndexArn,
        },
      },
    });
    knowledgeBase.addDependency(vectorIndex);
    knowledgeBase.node.addDependency(kbRole);
    this.knowledgeBase = knowledgeBase;
```
フィールド追加: `public readonly knowledgeBase: bedrock.CfnKnowledgeBase;`

> 注: `s3VectorsConfiguration` のプロパティ名(`vectorBucketArn` / `indexArn` / `indexName`)と属性名(`attrVectorBucketArn` 等)は synth で型に合わせること(前提メモ)。

- [ ] **Step 4: synth & テスト成功を確認**

Run: `npx cdk synth && npx jest test/knowledge-base-stack.test.ts -t "S3_VECTORS ストレージ"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: Bedrock Knowledge Base (S3 Vectors) を追加"
```

---

## Task 7: S3 データソース(Fixed-size chunking)

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('データソースが S3 + Fixed-size chunking を使う', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Bedrock::DataSource', Match.objectLike({
    DataSourceConfiguration: Match.objectLike({ Type: 'S3' }),
    VectorIngestionConfiguration: Match.objectLike({
      ChunkingConfiguration: Match.objectLike({
        ChunkingStrategy: 'FIXED_SIZE',
        FixedSizeChunkingConfiguration: {
          MaxTokens: 300,
          OverlapPercentage: 20,
        },
      }),
    }),
  }));
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "Fixed-size chunking"`
Expected: FAIL

- [ ] **Step 3: データソースを実装**

```ts
import { CHUNK_MAX_TOKENS, CHUNK_OVERLAP_PERCENT } from './config';
// ...
    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: `${NAME_PREFIX}-s3-source`,
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: { bucketArn: docsBucket.bucketArn },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: CHUNK_MAX_TOKENS,
            overlapPercentage: CHUNK_OVERLAP_PERCENT,
          },
        },
      },
    });
    this.dataSource = dataSource;
```
フィールド追加: `public readonly dataSource: bedrock.CfnDataSource;`

- [ ] **Step 4: synth & テスト成功を確認**

Run: `npx cdk synth && npx jest test/knowledge-base-stack.test.ts -t "Fixed-size chunking"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: S3 データソース(Fixed-size chunking)を追加"
```

---

## Task 8: Drive 同期ロジック — MIME 判定(純粋関数)

**Files:**
- Create: `lambda/drive-sync/mime.ts`
- Test: `test/mime.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/mime.test.ts`:
```ts
import { resolveDownload } from '../lambda/drive-sync/mime';

test('Google ドキュメントは PDF にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.document')).toEqual({
    mode: 'export', exportMimeType: 'application/pdf', extension: 'pdf',
  });
});

test('Google スプレッドシートは CSV にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.spreadsheet')).toEqual({
    mode: 'export', exportMimeType: 'text/csv', extension: 'csv',
  });
});

test('Google スライドは PDF にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.presentation')).toEqual({
    mode: 'export', exportMimeType: 'application/pdf', extension: 'pdf',
  });
});

test('通常の PDF はそのまま取得', () => {
  expect(resolveDownload('application/pdf')).toEqual({ mode: 'direct' });
});

test('Google フォルダなど未対応ネイティブ形式は skip', () => {
  expect(resolveDownload('application/vnd.google-apps.folder')).toEqual({ mode: 'skip' });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/mime.test.ts`
Expected: FAIL(`resolveDownload` 未定義)

- [ ] **Step 3: 実装**

`lambda/drive-sync/mime.ts`:
```ts
export type DownloadPlan =
  | { mode: 'direct' }
  | { mode: 'export'; exportMimeType: string; extension: string }
  | { mode: 'skip' };

const EXPORT_MAP: Record<string, { exportMimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.presentation': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { exportMimeType: 'text/csv', extension: 'csv' },
};

export function resolveDownload(mimeType: string): DownloadPlan {
  if (mimeType in EXPORT_MAP) {
    return { mode: 'export', ...EXPORT_MAP[mimeType] };
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return { mode: 'skip' };
  }
  return { mode: 'direct' };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `npx jest test/mime.test.ts`
Expected: PASS(5 件)

- [ ] **Step 5: コミット**

```bash
git add lambda/drive-sync/mime.ts test/mime.test.ts
git commit -m "feat: Drive ファイルのダウンロード方式判定ロジックを追加"
```

---

## Task 9: Drive 同期ロジック — 差分判定(純粋関数)

**Files:**
- Create: `lambda/drive-sync/s3-sync.ts`
- Test: `test/s3-sync.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/s3-sync.test.ts`:
```ts
import { diffSync, DriveEntry, S3Entry } from '../lambda/drive-sync/s3-sync';

const drive: DriveEntry[] = [
  { fileId: 'a', key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
  { fileId: 'b', key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
];

test('S3 に無いファイルは upload', () => {
  const r = diffSync(drive, []);
  expect(r.uploads.map((u) => u.fileId).sort()).toEqual(['a', 'b']);
  expect(r.deletes).toEqual([]);
});

test('modifiedTime が新しいものだけ upload', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' }, // 同じ→skip
    { key: 'b/sheet.csv', modifiedTime: '2026-06-09T00:00:00Z' }, // 古い→update
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads.map((u) => u.fileId)).toEqual(['b']);
  expect(r.deletes).toEqual([]);
});

test('Drive に無い S3 オブジェクトは delete', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'old/removed.pdf', modifiedTime: '2026-06-01T00:00:00Z' },
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads).toEqual([]);
  expect(r.deletes).toEqual(['old/removed.pdf']);
});

test('変更が一切無ければ uploads も deletes も空', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads).toEqual([]);
  expect(r.deletes).toEqual([]);
  expect(r.hasChanges).toBe(false);
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/s3-sync.test.ts`
Expected: FAIL(`diffSync` 未定義)

- [ ] **Step 3: 実装**

`lambda/drive-sync/s3-sync.ts`:
```ts
export interface DriveEntry {
  fileId: string;
  key: string;
  modifiedTime: string; // ISO8601
}
export interface S3Entry {
  key: string;
  modifiedTime: string; // S3 メタデータに保存した Drive の modifiedTime
}
export interface SyncDiff {
  uploads: DriveEntry[];
  deletes: string[];
  hasChanges: boolean;
}

export function diffSync(drive: DriveEntry[], s3: S3Entry[]): SyncDiff {
  const s3ByKey = new Map(s3.map((e) => [e.key, e]));
  const uploads: DriveEntry[] = [];
  for (const d of drive) {
    const existing = s3ByKey.get(d.key);
    if (!existing || Date.parse(d.modifiedTime) > Date.parse(existing.modifiedTime)) {
      uploads.push(d);
    }
  }
  const driveKeys = new Set(drive.map((d) => d.key));
  const deletes = s3.map((e) => e.key).filter((k) => !driveKeys.has(k));
  return { uploads, deletes, hasChanges: uploads.length > 0 || deletes.length > 0 };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `npx jest test/s3-sync.test.ts`
Expected: PASS(4 件)

- [ ] **Step 5: コミット**

```bash
git add lambda/drive-sync/s3-sync.ts test/s3-sync.test.ts
git commit -m "feat: Drive→S3 差分判定ロジックを追加"
```

---

## Task 10: Drive API ラッパ

**Files:**
- Create: `lambda/drive-sync/drive-client.ts`

このモジュールは Google API への副作用境界。純粋ロジックは Task 8/9 で検証済みのため、ここは薄いラッパに留め、ハンドラ側(Task 11)でモックして検証する。

- [ ] **Step 1: 実装**

`lambda/drive-sync/drive-client.ts`:
```ts
import { google, drive_v3 } from 'googleapis';
import { resolveDownload } from './mime';

export interface RemoteFile {
  fileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  path: string; // フォルダ階層を '/' 連結したもの(末尾にファイル名は含めない)
}

export function createDrive(serviceAccountJson: string): drive_v3.Drive {
  const creds = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// フォルダ配下を再帰列挙(サブフォルダも辿る)
export async function listFolderRecursive(
  drive: drive_v3.Drive,
  folderId: string,
  parentPath = '',
): Promise<RemoteFile[]> {
  const results: RemoteFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const childPath = parentPath ? `${parentPath}/${f.name}` : f.name!;
        results.push(...(await listFolderRecursive(drive, f.id!, childPath)));
      } else {
        results.push({
          fileId: f.id!,
          name: f.name!,
          mimeType: f.mimeType!,
          modifiedTime: f.modifiedTime!,
          path: parentPath,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return results;
}

// 1 ファイルをバイト列で取得(direct か export)
export async function fetchContent(
  drive: drive_v3.Drive,
  file: RemoteFile,
): Promise<{ body: Buffer; extension?: string } | null> {
  const plan = resolveDownload(file.mimeType);
  if (plan.mode === 'skip') return null;
  if (plan.mode === 'export') {
    const res = await drive.files.export(
      { fileId: file.fileId, mimeType: plan.exportMimeType },
      { responseType: 'arraybuffer' },
    );
    return { body: Buffer.from(res.data as ArrayBuffer), extension: plan.extension };
  }
  const res = await drive.files.get(
    { fileId: file.fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return { body: Buffer.from(res.data as ArrayBuffer) };
}

// S3 オブジェクトキー: fileId を起点に安定化。export 時は拡張子を付け替え。
export function buildKey(file: RemoteFile, extension?: string): string {
  const base = extension ? `${file.name}.${extension}` : file.name;
  return `${file.fileId}/${base}`;
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー無し(`googleapis` 依存が必要。次の手順でインストール)

- [ ] **Step 3: 依存をインストール**

Run: `npm install googleapis @aws-sdk/client-s3 @aws-sdk/client-bedrock-agent @aws-sdk/client-secrets-manager`
Expected: 追加成功。再度 `npx tsc --noEmit` がエラー無し

- [ ] **Step 4: コミット**

```bash
git add lambda/drive-sync/drive-client.ts package.json package-lock.json
git commit -m "feat: Google Drive API ラッパを追加"
```

---

## Task 11: ハンドラ(同期 + ingestion ガード起動)

**Files:**
- Create: `lambda/drive-sync/index.ts`
- Test: `test/handler.test.ts`

ハンドラは「差分があり、かつ実行中 ingestion job が無い時のみ起動」というガードが肝。ここを純粋関数 `shouldStartIngestion` に切り出して単体テストする。

- [ ] **Step 1: 失敗するテストを書く**

`test/handler.test.ts`:
```ts
import { shouldStartIngestion } from '../lambda/drive-sync/index';

test('差分があり実行中ジョブが無ければ起動する', () => {
  expect(shouldStartIngestion(true, [])).toBe(true);
});

test('差分が無ければ起動しない', () => {
  expect(shouldStartIngestion(false, [])).toBe(false);
});

test('実行中ジョブ(IN_PROGRESS)があれば起動しない', () => {
  expect(shouldStartIngestion(true, ['IN_PROGRESS'])).toBe(false);
});

test('STARTING のジョブがあれば起動しない', () => {
  expect(shouldStartIngestion(true, ['COMPLETE', 'STARTING'])).toBe(false);
});

test('完了済みジョブだけなら起動する', () => {
  expect(shouldStartIngestion(true, ['COMPLETE', 'FAILED'])).toBe(true);
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/handler.test.ts`
Expected: FAIL(`shouldStartIngestion` 未定義)

- [ ] **Step 3: ハンドラを実装**

`lambda/drive-sync/index.ts`:
```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BedrockAgentClient, StartIngestionJobCommand, ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { createDrive, listFolderRecursive, fetchContent, buildKey } from './drive-client';
import { resolveDownload } from './mime';
import { diffSync, DriveEntry, S3Entry } from './s3-sync';

const ACTIVE_STATUSES = new Set(['STARTING', 'IN_PROGRESS']);

// ガード: 差分があり、実行中(STARTING/IN_PROGRESS)ジョブが無い時のみ true
export function shouldStartIngestion(hasChanges: boolean, jobStatuses: string[]): boolean {
  if (!hasChanges) return false;
  return !jobStatuses.some((s) => ACTIVE_STATUSES.has(s));
}

const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const s3 = new S3Client({ region });
const bedrock = new BedrockAgentClient({ region });
const secrets = new SecretsManagerClient({ region });

const MODIFIED_META = 'drive-modified-time';

async function getServiceAccountJson(secretArn: string): Promise<string> {
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!out.SecretString) throw new Error('SA シークレットが空です');
  return out.SecretString;
}

async function listS3(bucket: string): Promise<S3Entry[]> {
  const entries: S3Entry[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: o.Key! }));
      entries.push({ key: o.Key!, modifiedTime: head.Metadata?.[MODIFIED_META] ?? '1970-01-01T00:00:00Z' });
    }
    token = res.NextContinuationToken;
  } while (token);
  return entries;
}

export async function handler(): Promise<{ uploaded: number; deleted: number; ingestion: boolean }> {
  const bucket = process.env.DOCS_BUCKET!;
  const folderId = process.env.DRIVE_FOLDER_ID!;
  const kbId = process.env.KNOWLEDGE_BASE_ID!;
  const dataSourceId = process.env.DATA_SOURCE_ID!;
  const secretArn = process.env.SA_SECRET_ARN!;

  const drive = createDrive(await getServiceAccountJson(secretArn));
  const remote = await listFolderRecursive(drive, folderId);

  // Drive 側の想定 S3 キー一覧を作る(export は拡張子付与)
  const driveEntries: DriveEntry[] = remote.map((f) => {
    const plan = resolveDownload(f.mimeType);
    const ext = plan.mode === 'export' ? plan.extension : undefined;
    return { fileId: f.fileId, key: buildKey(f, ext), modifiedTime: f.modifiedTime };
  }).filter((_, i) => resolveDownload(remote[i].mimeType).mode !== 'skip');

  const s3Entries = await listS3(bucket);
  const diff = diffSync(driveEntries, s3Entries);

  // アップロード
  for (const up of diff.uploads) {
    const file = remote.find((r) => r.fileId === up.fileId)!;
    const content = await fetchContent(drive, file);
    if (!content) continue;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: up.key, Body: content.body,
      Metadata: { [MODIFIED_META]: up.modifiedTime, 'drive-file-id': file.fileId, 'drive-path': file.path },
    }));
  }
  // 削除
  for (const key of diff.deletes) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  // ingestion ガード
  const jobs = await bedrock.send(new ListIngestionJobsCommand({
    knowledgeBaseId: kbId, dataSourceId,
  }));
  const statuses = (jobs.ingestionJobSummaries ?? []).map((j) => j.status as string);
  let ingestion = false;
  if (shouldStartIngestion(diff.hasChanges, statuses)) {
    await bedrock.send(new StartIngestionJobCommand({ knowledgeBaseId: kbId, dataSourceId }));
    ingestion = true;
  }
  return { uploaded: diff.uploads.length, deleted: diff.deletes.length, ingestion };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `npx jest test/handler.test.ts`
Expected: PASS(5 件)

- [ ] **Step 5: 全テスト・型チェック**

Run: `npx jest && npx tsc --noEmit`
Expected: 全 PASS、型エラー無し

- [ ] **Step 6: コミット**

```bash
git add lambda/drive-sync/index.ts test/handler.test.ts
git commit -m "feat: Drive 同期ハンドラと ingestion ガードを追加"
```

---

## Task 12: Secrets Manager シークレット

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('SA 用シークレットが作られる', () => {
  const t = synth();
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "SA 用シークレット"`
Expected: FAIL

- [ ] **Step 3: 実装**

```ts
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
// ...
    const saSecret = new secretsmanager.Secret(this, 'DriveSaSecret', {
      secretName: `${NAME_PREFIX}-drive-sa`,
      description: 'Google service account JSON key for Drive sync (値はデプロイ後に手動投入)',
    });
    this.saSecret = saSecret;
```
フィールド追加: `public readonly saSecret: secretsmanager.Secret;`

- [ ] **Step 4: テスト成功を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "SA 用シークレット"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: Drive SA 用 Secrets Manager シークレットを追加"
```

---

## Task 13: 同期 Lambda + 実行ロール

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('同期 Lambda が Node.js で環境変数を持つ', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Runtime: Match.stringLikeRegexp('nodejs'),
    Environment: Match.objectLike({
      Variables: Match.objectLike({
        DRIVE_FOLDER_ID: 'folder-123',
      }),
    }),
  }));
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "同期 Lambda"`
Expected: FAIL

- [ ] **Step 3: 実装**

```ts
import { Duration } from 'aws-cdk-lib';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
// ...
    const syncFn = new lambdaNode.NodejsFunction(this, 'DriveSyncFunction', {
      entry: path.join(__dirname, '../lambda/drive-sync/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        DOCS_BUCKET: docsBucket.bucketName,
        DRIVE_FOLDER_ID: props.driveFolderId,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: dataSource.attrDataSourceId,
        SA_SECRET_ARN: saSecret.secretArn,
      },
      bundling: { minify: true, target: 'node20' },
    });

    docsBucket.grantReadWrite(syncFn);
    saSecret.grantRead(syncFn);
    syncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
      resources: [
        knowledgeBase.attrKnowledgeBaseArn,
        `${knowledgeBase.attrKnowledgeBaseArn}/*`,
      ],
    }));
    this.syncFn = syncFn;
```
フィールド追加: `public readonly syncFn: lambdaNode.NodejsFunction;`

> 注: `bedrock:ListIngestionJobs` / `StartIngestionJob` のリソース ARN は KB ARN 配下(data source 含む)。synth 後 `bedrock` の ARN 属性名(`attrKnowledgeBaseArn`)を型で確認。

- [ ] **Step 4: synth で esbuild バンドルが通ることを確認**

Run: `npx cdk synth`
Expected: 成功。`googleapis` が大きいので時間がかかることがある。バンドルエラーが出たら `bundling.externalModules` 等で調整(必要時のみ)。

- [ ] **Step 5: テスト成功を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "同期 Lambda"`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: Drive 同期 Lambda と最小権限ロールを追加"
```

---

## Task 14: EventBridge スケジュール + 出力

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

```ts
test('スケジュールルールが Lambda をターゲットにする', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Events::Rule', Match.objectLike({
    ScheduleExpression: 'rate(1 day)',
    State: 'ENABLED',
  }));
});

test('主要 ID が CfnOutput される', () => {
  const t = synth();
  const outputs = t.findOutputs('*');
  const keys = Object.keys(outputs);
  expect(keys).toEqual(expect.arrayContaining([
    'KnowledgeBaseId', 'DataSourceId', 'DocsBucketName', 'SyncFunctionName', 'SaSecretArn',
  ]));
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t "スケジュールルール"`
Expected: FAIL

- [ ] **Step 3: 実装**

```ts
import { CfnOutput } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
// ...
    new events.Rule(this, 'SyncSchedule', {
      schedule: events.Schedule.expression(props.scheduleRate),
      enabled: props.scheduleEnabled,
      targets: [new targets.LambdaFunction(syncFn)],
    });

    new CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId });
    new CfnOutput(this, 'DocsBucketName', { value: docsBucket.bucketName });
    new CfnOutput(this, 'SyncFunctionName', { value: syncFn.functionName });
    new CfnOutput(this, 'SaSecretArn', { value: saSecret.secretArn });
```

- [ ] **Step 4: synth & テスト成功を確認**

Run: `npx cdk synth && npx jest test/knowledge-base-stack.test.ts`
Expected: 全 PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: EventBridge スケジュールと CfnOutput を追加"
```

---

## Task 15: README(構築手順・手動作業)

**Files:**
- Create: `README.md`

- [ ] **Step 1: README を作成**

````markdown
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
````

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: README に構築手順と手動作業を追加"
```

---

## 完了条件

- [ ] `npm test` が全 PASS(CDK assertion + Lambda 単体)
- [ ] `npx cdk synth` がエラー無く成功
- [ ] 仕様書(`docs/superpowers/specs/2026-06-11-bedrock-kb-gdrive-rag-design.md`)の全要件にタスクが対応
- [ ] 実デプロイは前提の手動作業(SA 作成・フォルダ共有・モデル有効化・bootstrap)完了後に `cdk deploy`
