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
    MetadataConfiguration: {
      NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
    },
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

test('SA 用シークレットが作られる', () => {
  const t = synth();
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
});
