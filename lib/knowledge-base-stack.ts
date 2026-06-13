import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ARN,
  VECTOR_DATA_TYPE,
  VECTOR_DISTANCE_METRIC,
  NON_FILTERABLE_METADATA_KEYS,
  NAME_PREFIX,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_PERCENT,
} from './config';

// スタックのデプロイ時パラメータ(bin/app.ts のコンテキスト由来)
export interface KnowledgeBaseStackProps extends StackProps {
  readonly driveFolderId: string;   // 同期対象の Drive フォルダ ID
  readonly scheduleRate: string;    // 同期スケジュール(rate/cron 式)
  readonly scheduleEnabled: boolean; // スケジュールの有効・無効
}

// =============================================================================
// Google Drive を情報源とする Bedrock RAG 基盤を一式構築する CDK スタック。
// ドキュメント用 S3 → S3 Vectors → Knowledge Base → 同期 Lambda → 定期実行
// の順にリソースを定義し、依存関係を明示的につなぐ。
// =============================================================================
export class KnowledgeBaseStack extends Stack {
  public readonly docsBucket: s3.Bucket;
  public readonly vectorBucket: s3vectors.CfnVectorBucket;
  public readonly vectorIndex: s3vectors.CfnIndex;
  public readonly kbRole: iam.Role;
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;
  public readonly saSecret: secretsmanager.Secret;
  public readonly syncFn: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    // --- ドキュメント原本を格納する S3 バケット(KB の取り込み元) ---
    // バージョニング有効・暗号化・公開遮断・SSL 強制。削除時も保持する。
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.docsBucket = docsBucket;

    // --- 埋め込みベクトルを保持する S3 Vectors バケット + インデックス ---
    // インデックスはバケットを「名前」で参照する(63 文字以内)。vectorBucket.ref は ARN を
    // 返し 78 文字になって maxLength:63 違反になるため、固定名を両方で共有する。
    const vectorBucketName = `${NAME_PREFIX}-vectors`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName,
    });

    // ベクトルインデックス(次元数・型・距離計量・フィルタ非対象キーを定義)
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName,
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

    // --- Knowledge Base 用 IAM ロール ---
    // Bedrock が引き受け、埋め込みモデル呼び出し・原本 S3 読取・ベクトル操作を許可する。
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
      resources: [vectorBucket.attrVectorBucketArn, vectorIndex.attrIndexArn],
    }));
    this.kbRole = kbRole;

    // --- Bedrock Knowledge Base 本体 ---
    // 埋め込みモデルと S3 Vectors ストレージを結びつけた VECTOR タイプの KB。
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

    // --- データソース(原本 S3 バケットを取り込み元に指定 + チャンク設定) ---
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

    // --- Drive 認証用のサービスアカウント JSON を保持する Secret ---
    // 箱だけ作成し、実際の鍵はデプロイ後に手動で投入する。
    const saSecret = new secretsmanager.Secret(this, 'DriveSaSecret', {
      secretName: `${NAME_PREFIX}-drive-sa`,
      description: 'Google service account JSON key for Drive sync (値はデプロイ後に手動投入)',
    });
    this.saSecret = saSecret;

    // --- Drive → S3 同期 Lambda(TypeScript を esbuild でバンドル) ---
    // 実行に必要なバケット名・フォルダ ID・KB/データソース ID・Secret ARN を環境変数で渡す。
    const syncFn = new lambdaNode.NodejsFunction(this, 'DriveSyncFunction', {
      entry: path.join(__dirname, '../lambda/drive-sync/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        DOCS_BUCKET: docsBucket.bucketName,
        DRIVE_FOLDER_ID: props.driveFolderId,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: dataSource.attrDataSourceId,
        SA_SECRET_ARN: saSecret.secretArn,
      },
      bundling: { minify: true, target: 'node24' },
    });

    // Lambda へ権限付与: 原本 S3 の読み書き / Secret 読み取り / ingestion ジョブ操作
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

    // --- 同期 Lambda を定期実行する EventBridge ルール ---
    new events.Rule(this, 'SyncSchedule', {
      schedule: events.Schedule.expression(props.scheduleRate),
      enabled: props.scheduleEnabled,
      targets: [new targets.LambdaFunction(syncFn)],
    });

    // --- デプロイ後に参照する主要リソースの ID/名前を出力 ---
    new CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId });
    new CfnOutput(this, 'DocsBucketName', { value: docsBucket.bucketName });
    new CfnOutput(this, 'SyncFunctionName', { value: syncFn.functionName });
    new CfnOutput(this, 'SaSecretArn', { value: saSecret.secretArn });
  }
}
