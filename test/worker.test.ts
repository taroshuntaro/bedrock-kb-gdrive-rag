// =============================================================================
// 応答 Lambda(worker)の定数・設定値に関するテスト。
// SDK 呼び出し自体はモックせず、citations 取得の前提となるプロンプトの形を検証する。
// =============================================================================
import { PROMPT_TEMPLATE, buildRetrievalConfiguration } from '../lambda/slack-bot/worker';

describe('PROMPT_TEMPLATE', () => {
  test('検索結果プレースホルダ $search_results$ を含む', () => {
    expect(PROMPT_TEMPLATE).toContain('$search_results$');
  });

  test('引用出力プレースホルダ $output_format_instructions$ を含む(無いと citations の retrievedReferences が空になり Drive リンクが付かない)', () => {
    expect(PROMPT_TEMPLATE).toContain('$output_format_instructions$');
  });
});

describe('buildRetrievalConfiguration', () => {
  const arn = 'arn:aws:bedrock:ap-northeast-1::foundation-model/cohere.rerank-v3-5:0';

  test('リランク無効なら取得件数のみ設定しリランク設定を含めない', () => {
    const cfg = buildRetrievalConfiguration(false, arn);
    expect(cfg.vectorSearchConfiguration?.numberOfResults).toBe(8);
    expect(cfg.vectorSearchConfiguration?.rerankingConfiguration).toBeUndefined();
  });

  test('リランク有効なら多めに取得しリランク上位件数とモデル ARN を設定する', () => {
    const cfg = buildRetrievalConfiguration(true, arn);
    expect(cfg.vectorSearchConfiguration?.numberOfResults).toBe(20);
    const rc = cfg.vectorSearchConfiguration?.rerankingConfiguration;
    expect(rc?.type).toBe('BEDROCK_RERANKING_MODEL');
    expect(rc?.bedrockRerankingConfiguration?.numberOfRerankedResults).toBe(8);
    expect(rc?.bedrockRerankingConfiguration?.modelConfiguration?.modelArn).toBe(arn);
  });
});
