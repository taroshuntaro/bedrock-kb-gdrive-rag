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

export interface KnowledgeBaseStackProps extends StackProps {
  readonly driveFolderId: string;
  readonly scheduleRate: string;
  readonly scheduleEnabled: boolean;
}

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

    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.docsBucket = docsBucket;

    // インデックスはバケットを「名前」で参照する(63 文字以内)。vectorBucket.ref は ARN を
    // 返し 78 文字になって maxLength:63 違反になるため、固定名を両方で共有する。
    const vectorBucketName = `${NAME_PREFIX}-vectors`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName,
    });

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

    const saSecret = new secretsmanager.Secret(this, 'DriveSaSecret', {
      secretName: `${NAME_PREFIX}-drive-sa`,
      description: 'Google service account JSON key for Drive sync (値はデプロイ後に手動投入)',
    });
    this.saSecret = saSecret;

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
  }
}
