// =============================================================================
// Drive ファイルの MIME タイプから「どう取得するか」を判定するロジック。
//   - direct: そのままバイト列でダウンロード
//   - export: Google ネイティブ形式を PDF/CSV などへ変換して取得
//   - skip  : フォルダ等の変換不能な Google 形式は対象外
// =============================================================================

// ダウンロード方針を表す判別共用体
export type DownloadPlan =
  | { mode: 'direct' }
  | { mode: 'export'; exportMimeType: string; extension: string }
  | { mode: 'skip' };

// Google ネイティブ形式 → エクスポート先(MIME / 拡張子)の対応表
const EXPORT_MAP: Record<string, { exportMimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.presentation': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { exportMimeType: 'text/csv', extension: 'csv' },
};

// MIME タイプを受け取り、エクスポート対象 → その他 Google 形式 → 通常ファイルの順に判定する
export function resolveDownload(mimeType: string): DownloadPlan {
  if (mimeType in EXPORT_MAP) {
    return { mode: 'export', ...EXPORT_MAP[mimeType] };
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return { mode: 'skip' };
  }
  return { mode: 'direct' };
}
