# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際の指針をまとめたものです。
構築手順や運用の詳細は重複させず、人間向けドキュメントへリンクで委譲しています。

- プロジェクト全体像・制約一覧: [README.md](README.md)
- 構築手順(GCP/AWS のセットアップ): [docs/setup.md](docs/setup.md)
- 設計/計画ドキュメント: [docs/superpowers/specs](docs/superpowers/specs) / [docs/superpowers/plans](docs/superpowers/plans)

## プロジェクト概要

Google Drive をデータソースとする Amazon Bedrock Knowledge Base(S3 Vectors)を
AWS CDK (TypeScript) で東京リージョン(**ap-northeast-1 固定**)に構築する。
Drive→S3 の差分同期と ingestion(取り込み)自動起動までを含む。検索 UI/バックエンドはスコープ外。

## 必須コマンドと完了前の検証

**「完了した」「修正した」と言う前に、必ず以下の両方を通すこと。**

```bash
npm test            # Jest: 単体テスト + CDK assertion テスト
npx tsc --noEmit    # 型チェック
```

- `jest` は **ts-jest を transpile-only(`isolatedModules`)で運用**している。
  これは googleapis/aws-sdk の巨大な型グラフによる OOM 回避のためで、
  **テストだけでは型エラーを検出できない**。型安全は必ず `npx tsc --noEmit` で別途担保する。
- CDK 系コマンドは**すべて `-c driveFolderId=<DriveのフォルダID>` が必須**(未指定だと即エラーで停止)。

```bash
npx cdk synth  -c driveFolderId=<ID>   # テンプレート生成
npx cdk diff   -c driveFolderId=<ID>   # 既存スタックとの差分
npx cdk deploy -c driveFolderId=<ID>   # デプロイ
```

## コード構成と設計方針

| パス | 責務 |
| --- | --- |
| `bin/app.ts` | CDK エントリポイント。CLI コンテキスト(`-c`)を読み取りスタックを生成 |
| `lib/config.ts` | スタック全体で共有する定数(モデル ARN・次元数・チャンク設定など) |
| `lib/knowledge-base-stack.ts` | 全 AWS リソース定義(S3 / S3 Vectors / IAM / KB / Lambda / Schedule) |
| `lambda/drive-sync/index.ts` | 同期 Lambda ハンドラ。**AWS SDK 呼び出し層**(S3 / Bedrock / Secrets) |
| `lambda/drive-sync/drive-client.ts` | Google Drive API のラッパー(認証・列挙・取得・キー生成) |
| `lambda/drive-sync/s3-sync.ts` | **純ロジック層**: 差分計算・アップロードのエラー隔離 |
| `lambda/drive-sync/mime.ts` | **純ロジック層**: MIME からダウンロード方式(direct/export/skip)を判定 |
| `test/*.test.ts` | Jest テスト |

**設計原則: 純ロジックと SDK 呼び出しを分離する。**
差分判定や MIME 判定のような副作用のないロジックは純関数として切り出し(`s3-sync.ts` / `mime.ts`、
および `index.ts` の `shouldStartIngestion`)、SDK 呼び出しはコールバックや薄いラッパー経由で渡す。
これにより SDK をモックせずに単体テストできる。**新しいロジックを足すときもこの分離を維持すること。**

## コーディング規約

### 言語

**コメント・コミットメッセージ・ドキュメント・テスト名はすべて日本語**で書く。
非 ASCII 文字(ダイアクリティカルマーク等)は正書法どおりに記述し、ASCII 代替に置き換えない。

### ソースコメント規約

メソッドやブロック単位で「何の処理・定義か」が一目で分かるレベルでコメントを付ける。

1. **ファイル冒頭に概要ブロック** — そのファイルの責務を `// ====` の囲みで記述
2. **関数・型・定数の直前に一行コメント** — 何をするか / 何を表すか(なぜそうするかの注意点があれば添える)
3. **関数内の処理ブロックの先頭に一行コメント** — そのブロックが何をしているか
4. **型のフィールドには行末コメント** で各項目の意味を補足

良い例(実際のスタイル):

```ts
// =============================================================================
// Drive と S3 の状態を突き合わせて差分を計算し、アップロードを実行する純ロジック層。
// AWS SDK 呼び出しはコールバック経由で受け取り、ここでは差分判定とエラー隔離に専念する。
// =============================================================================

// 差分計算の結果
export interface SyncDiff {
  uploads: DriveEntry[]; // 新規 or 更新されたためアップロードすべき項目
  deletes: string[];     // Drive から消えたため S3 から削除すべきキー
  hasChanges: boolean;   // 上記いずれかがあるか
}

// Drive と S3 を比較し、アップロード対象(新規・更新)と削除対象(Drive 側に無い)を算出する
export function diffSync(drive: DriveEntry[], s3: S3Entry[]): SyncDiff {
  // S3 側をキーで引けるようにインデックス化
  const s3ByKey = new Map(s3.map((e) => [e.key, e]));
  ...
}
```

### テスト方針

純ロジックを切り出して単体テストする。テスト名は日本語で意図を表す(例: `test('差分があり実行中ジョブが無ければ起動する', ...)`)。
新しい純ロジックを追加したら対応するテストも追加する。

## コミット規約

Conventional Commits + 日本語説明。

- `feat:` 機能追加 / `fix:` バグ修正 / `docs:` ドキュメント / `chore:` 雑務
- 例: `feat: Drive 同期 Lambda と最小権限ロールを追加`
- 1 コミット 1 関心事。無関係な変更を混ぜない。

## 重要な制約・落とし穴(コード変更で踏みやすいもの)

- **VectorBucketName は ARN でなくバケット名を渡す** — S3 Vectors のインデックスはバケットを名前(63 文字以内)で
  参照する。`ref`/ARN を渡すと `maxLength:63` 違反になる(`lib/knowledge-base-stack.ts`)。
- **S3 メタデータの非 ASCII 値はエンコードする** — `drive-path` 等は `encodeURIComponent` で格納する
  (`lambda/drive-sync/index.ts`)。生の日本語を入れると PutObject が失敗する。
- **S3 キーのファイル名内 `/` は `_` に置換する** — キー階層を意図せず分割しないため(`buildKey`)。
- **`listS3` の HeadObject N+1 は既知課題** — `ListObjectsV2` が独自メタデータを返さないための実装。
  数千ファイル規模で改修する場合はマニフェスト方式を検討(詳細は README「既知の課題」)。
- **リージョンは ap-northeast-1 固定**、ランタイムは **Node.js 20**。
- そのほかファイル変換・エクスポート上限・削除同期・`cdk destroy` の挙動などの運用上の制約は
  README「制約・注意事項」を参照。
