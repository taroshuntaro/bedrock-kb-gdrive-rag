// =============================================================================
// Slack Events API のリクエストボディから「どう処理すべきか」を判定する純ロジック層。
// challenge 応答 / 無視(再送・bot 発言など)/ 回答(質問抽出済み)の 3 択に分類し、
// SDK 呼び出しは一切含まない。
// =============================================================================

// イベントの処理方針を表す判別共用体
export type EventDecision =
  | { action: 'challenge'; challenge: string }                             // URL 検証に応答する
  | { action: 'ignore'; reason: string }                                   // 処理せず 200 を返す
  | { action: 'answer'; question: string; channel: string; threadTs?: string }; // 応答 Lambda に委譲する

// 生ボディと再送ヘッダ(x-slack-retry-num)から処理方針を判定する
export function decideEvent(rawBody: string, retryNum: string | undefined): EventDecision {
  // Slack の再送は無視する(初回リクエストで処理済みのため。二重応答防止)
  if (retryNum !== undefined) return { action: 'ignore', reason: `再送 (retry=${retryNum})` };

  // ボディの JSON 解析(不正な形式は無視)
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { action: 'ignore', reason: 'JSON 解析失敗' };
  }

  // Events URL 登録時の URL 検証(challenge をそのまま返す必要がある)
  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    return { action: 'challenge', challenge: body.challenge };
  }
  if (body?.type !== 'event_callback' || !body.event) {
    return { action: 'ignore', reason: '対象外タイプ' };
  }

  const ev = body.event;
  // bot 自身の発言・bot_message や編集等のサブタイプ付きメッセージは無視(無限ループ防止)
  if (ev.bot_id || ev.subtype) return { action: 'ignore', reason: 'bot またはサブタイプ付きメッセージ' };

  // チャンネルでのメンション: メンション文字列を除去し、スレッドで返信する
  if (ev.type === 'app_mention') {
    const question = String(ev.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!question) return { action: 'ignore', reason: '質問が空' };
    return { action: 'answer', question, channel: ev.channel, threadTs: ev.thread_ts ?? ev.ts };
  }

  // bot との DM: 通常返信(スレッドにしない)
  if (ev.type === 'message' && ev.channel_type === 'im') {
    const question = String(ev.text ?? '').trim();
    if (!question) return { action: 'ignore', reason: '質問が空' };
    return { action: 'answer', question, channel: ev.channel };
  }

  return { action: 'ignore', reason: `対象外イベント (${ev.type})` };
}
