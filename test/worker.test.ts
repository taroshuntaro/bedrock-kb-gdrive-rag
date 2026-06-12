// =============================================================================
// 応答 Lambda(worker)の定数・設定値に関するテスト。
// SDK 呼び出し自体はモックせず、citations 取得の前提となるプロンプトの形を検証する。
// =============================================================================
import { PROMPT_TEMPLATE } from '../lambda/slack-bot/worker';

describe('PROMPT_TEMPLATE', () => {
  test('検索結果プレースホルダ $search_results$ を含む', () => {
    expect(PROMPT_TEMPLATE).toContain('$search_results$');
  });

  test('引用出力プレースホルダ $output_format_instructions$ を含む(無いと citations の retrievedReferences が空になり Drive リンクが付かない)', () => {
    expect(PROMPT_TEMPLATE).toContain('$output_format_instructions$');
  });
});
