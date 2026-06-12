// =============================================================================
// 回答本文と引用元(S3 URI)から Slack 投稿用メッセージを組み立てる純ロジック層。
// S3 キーは `<DriveのfileId>/<ファイル名>` 形式(drive-client の buildKey 仕様)のため、
// 先頭セグメントから Drive の元ファイルへの直リンクを組み立てられる。
// =============================================================================

// 参照元 1 件分の表示情報
interface SourceLink {
  fileId: string; // Drive のファイル ID(リンク組み立てに使用)
  name: string;   // 表示用のファイル名(キーの 2 セグメント目以降)
}

// Slack メッセージに載せる参照元の最大件数
const MAX_SOURCES = 5;

// Slack mrkdwn のリンク記法 <URL|表示名> 内で特別扱いされる文字を全角に置換する
// (| はデリミタ、> は閉じマーカーとして解釈されリンクが壊れるため)
function escapeMrkdwn(text: string): string {
  return text.replace(/\|/g, '|').replace(/>/g, '>');
}

// s3://<bucket>/<fileId>/<name> 形式の URI を分解する(形式が合わなければ null)
function parseS3Uri(uri: string): SourceLink | null {
  const m = uri.match(/^s3:\/\/[^/]+\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { fileId: m[1], name: m[2] };
}

// 回答本文の末尾に、fileId で重複排除した参照元リンク(Slack mrkdwn 形式)を付与する
export function formatAnswer(answer: string, s3Uris: string[]): string {
  // fileId をキーに重複排除しつつ、最大件数まで参照元を集める
  const seen = new Map<string, SourceLink>();
  for (const uri of s3Uris) {
    if (seen.size >= MAX_SOURCES) break;
    const link = parseS3Uri(uri);
    if (link && !seen.has(link.fileId)) seen.set(link.fileId, link);
  }
  if (seen.size === 0) return answer;
  const lines = [...seen.values()].map(
    (l) => `• <https://drive.google.com/file/d/${l.fileId}/view|${escapeMrkdwn(l.name)}>`,
  );
  return `${answer}\n\n*参照元*\n${lines.join('\n')}`;
}
