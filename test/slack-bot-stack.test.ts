import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { SlackBotStack } from '../lib/slack-bot-stack';

function synth(rerankEnabled = true) {
  const app = new App();
  // KB スタックの出力(KB ID / ARN)をクロススタック参照で受け取る実構成を再現する
  const kb = new KnowledgeBaseStack(app, 'TestKbStack', {
    env: { region: 'ap-northeast-1' },
    driveFolderId: 'folder-123',
    scheduleRate: 'rate(1 day)',
    scheduleEnabled: true,
  });
  const stack = new SlackBotStack(app, 'TestSlackBotStack', {
    env: { region: 'ap-northeast-1' },
    knowledgeBaseId: kb.knowledgeBase.attrKnowledgeBaseId,
    knowledgeBaseArn: kb.knowledgeBase.attrKnowledgeBaseArn,
    rerankEnabled,
  });
  return Template.fromStack(stack);
}

test('受信 Lambda の Function URL が認証なし(署名検証で担保)で公開される', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
});

test('受信 Lambda に reserved concurrency が設定されている(コスト暴走ガード)', () => {
  const t = synth();
  // WORKER_FUNCTION_NAME を持つのは受信 Lambda だけのため、これで対象を特定する
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    ReservedConcurrentExecutions: 5,
    Environment: Match.objectLike({
      Variables: Match.objectLike({ WORKER_FUNCTION_NAME: Match.anyValue() }),
    }),
  }));
});

test('応答 Lambda の非同期リトライが 0 に固定されている(二重投稿防止)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    MaximumRetryAttempts: 0,
  });
});

test('応答 Lambda に KB 検索とモデル呼び出しの権限がある', () => {
  const t = synth();
  t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'] }),
        Match.objectLike({ Action: ['bedrock:InvokeModel', 'bedrock:GetInferenceProfile'] }),
      ]),
    }),
  }));
});

test('Slack 認証情報用のシークレットが 1 つ作られる', () => {
  const t = synth();
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
});

test('リランク有効時、応答 Lambda に RERANK_ENABLED=true とリランク IAM が付与される', () => {
  const t = synth(true);
  // 環境変数
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Environment: Match.objectLike({
      Variables: Match.objectLike({ RERANK_ENABLED: 'true', RERANK_MODEL_ARN: Match.anyValue() }),
    }),
  }));
  // 呼び出し側 IAM(Rerank + InvokeModel)
  t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: ['bedrock:Rerank', 'bedrock:InvokeModel'] }),
      ]),
    }),
  }));
});

test('リランク無効時、RERANK_ENABLED=false でリランク IAM は付与されない', () => {
  const t = synth(false);
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Environment: Match.objectLike({
      Variables: Match.objectLike({ RERANK_ENABLED: 'false' }),
    }),
  }));
  // Rerank アクションを含む IAM ステートメントが存在しないこと
  const policies = t.findResources('AWS::IAM::Policy');
  // CDK assertions に「該当プロパティが存在しないこと」の否定マッチャが無いため、
  // ポリシー全体を文字列化して bedrock:Rerank を含まないことを確認する。
  const hasRerank = JSON.stringify(policies).includes('bedrock:Rerank');
  expect(hasRerank).toBe(false);
});
