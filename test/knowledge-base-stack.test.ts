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

test('VectorIndex はバケットを ARN ではなくバケット名で参照する(VectorBucketName の 63 文字制限対策)', () => {
  const t = synth();
  // バケット名は 63 文字以内の固定名。インデックス側も同じ「名前」を渡す必要があり、
  // ARN(Ref)を渡すと 78 文字になり maxLength:63 で CREATE_FAILED になる。
  t.hasResourceProperties('AWS::S3Vectors::VectorBucket', {
    VectorBucketName: 'bedrock-kb-gdrive-vectors',
  });
  t.hasResourceProperties('AWS::S3Vectors::Index', {
    VectorBucketName: 'bedrock-kb-gdrive-vectors',
  });
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

test('データソースが S3 + Semantic chunking を使う', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Bedrock::DataSource', Match.objectLike({
    DataSourceConfiguration: Match.objectLike({ Type: 'S3' }),
    VectorIngestionConfiguration: Match.objectLike({
      ChunkingConfiguration: Match.objectLike({
        ChunkingStrategy: 'SEMANTIC',
        SemanticChunkingConfiguration: {
          MaxTokens: 300,
          BufferSize: 1,
          BreakpointPercentileThreshold: 95,
        },
      }),
    }),
  }));
});

test('SA 用シークレットが作られる', () => {
  const t = synth();
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
});

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

test('KB サービスロールにリランク権限がある(Rerank は *、InvokeModel はモデル ARN 限定)', () => {
  const app = new App();
  const stack = new KnowledgeBaseStack(app, 'TestKbRerank', {
    env: { region: 'ap-northeast-1' },
    driveFolderId: 'folder-123',
    scheduleRate: 'rate(1 day)',
    scheduleEnabled: true,
  });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        // bedrock:Rerank はリソーススコープ非対応のため Resource: *
        Match.objectLike({ Action: 'bedrock:Rerank', Resource: '*' }),
        // モデルの限定は InvokeModel をリランクモデル ARN に絞って担保
        Match.objectLike({
          Action: 'bedrock:InvokeModel',
          Resource: 'arn:aws:bedrock:ap-northeast-1::foundation-model/cohere.rerank-v3-5:0',
        }),
      ]),
    }),
  }));
});
