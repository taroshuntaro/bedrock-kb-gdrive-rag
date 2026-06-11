// =============================================================================
// Drive と S3 の状態を突き合わせて差分を計算し、アップロードを実行する純ロジック層。
// AWS SDK 呼び出しはコールバック経由で受け取り、ここでは差分判定とエラー隔離に専念する。
// =============================================================================

// Drive 側の 1 ファイル(想定 S3 キー付き)
export interface DriveEntry {
  fileId: string;
  key: string;
  modifiedTime: string; // ISO8601
}
// S3 側の既存オブジェクト
export interface S3Entry {
  key: string;
  modifiedTime: string; // S3 メタデータに保存した Drive の modifiedTime
}
// 差分計算の結果
export interface SyncDiff {
  uploads: DriveEntry[]; // 新規 or 更新されたためアップロードすべき項目
  deletes: string[];     // Drive から消えたため S3 から削除すべきキー
  hasChanges: boolean;   // 上記いずれかがあるか
}

// Drive と S3 を比較し、アップロード対象(新規・更新)と削除対象(Drive 側に無い)を算出する
export function diffSync(drive: DriveEntry[], s3: S3Entry[]): SyncDiff {
  const s3ByKey = new Map(s3.map((e) => [e.key, e]));
  const uploads: DriveEntry[] = [];
  for (const d of drive) {
    const existing = s3ByKey.get(d.key);
    if (!existing || Date.parse(d.modifiedTime) > Date.parse(existing.modifiedTime)) {
      uploads.push(d);
    }
  }
  const driveKeys = new Set(drive.map((d) => d.key));
  const deletes = s3.map((e) => e.key).filter((k) => !driveKeys.has(k));
  return { uploads, deletes, hasChanges: uploads.length > 0 || deletes.length > 0 };
}

// アップロード一括処理の集計結果
export interface UploadOutcome {
  uploaded: number; // 実際にアップロードした件数
  skipped: number; // コンテンツが取得できず転送しなかった件数
  failures: { fileId: string; key: string; error: string }[]; // 例外で失敗した項目
}

// 各アップロードをエラー隔離しながら実行する。
// 1 件の失敗(例: export 上限超過)で全体を止めず、後続を継続して失敗を記録する。
// uploadOne は転送したら true、コンテンツ無しでスキップしたら false を返す。
export async function runUploads(
  uploads: DriveEntry[],
  uploadOne: (entry: DriveEntry) => Promise<boolean>,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { uploaded: 0, skipped: 0, failures: [] };
  for (const up of uploads) {
    try {
      if (await uploadOne(up)) outcome.uploaded += 1;
      else outcome.skipped += 1;
    } catch (e) {
      outcome.failures.push({ fileId: up.fileId, key: up.key, error: (e as Error).message });
    }
  }
  return outcome;
}
