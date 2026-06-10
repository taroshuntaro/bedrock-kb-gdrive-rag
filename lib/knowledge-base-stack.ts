import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ARN,
  VECTOR_DATA_TYPE,
  VECTOR_DISTANCE_METRIC,
  NON_FILTERABLE_METADATA_KEYS,
  NAME_PREFIX,
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

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${NAME_PREFIX}-vectors`,
    });

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
  }
}
