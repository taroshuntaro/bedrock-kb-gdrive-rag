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

test('S3 Vectors インデックスが 1024 次元/float32/cosine で作られる', () => {
  const t = synth();
  t.hasResourceProperties('AWS::S3Vectors::Index', {
    Dimension: 1024,
    DataType: 'float32',
    DistanceMetric: 'cosine',
  });
  t.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
});

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
      RestrictPublicBuckets: true,
    },
  });
});
