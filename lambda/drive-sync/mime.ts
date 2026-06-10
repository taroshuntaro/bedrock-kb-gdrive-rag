export type DownloadPlan =
  | { mode: 'direct' }
  | { mode: 'export'; exportMimeType: string; extension: string }
  | { mode: 'skip' };

const EXPORT_MAP: Record<string, { exportMimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.presentation': { exportMimeType: 'application/pdf', extension: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { exportMimeType: 'text/csv', extension: 'csv' },
};

export function resolveDownload(mimeType: string): DownloadPlan {
  if (mimeType in EXPORT_MAP) {
    return { mode: 'export', ...EXPORT_MAP[mimeType] };
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return { mode: 'skip' };
  }
  return { mode: 'direct' };
}
