import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface KnowledgeBaseStackProps extends StackProps {
  readonly driveFolderId: string;
  readonly scheduleRate: string;
  readonly scheduleEnabled: boolean;
}

export class KnowledgeBaseStack extends Stack {
  public readonly docsBucket: s3.Bucket;

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
  }
}
