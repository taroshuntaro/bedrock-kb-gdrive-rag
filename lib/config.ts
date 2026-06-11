// =============================================================================
// スタック全体で共有する定数定義。
// Bedrock Knowledge Base / S3 Vectors / チャンク分割の設定値を一元管理する。
// =============================================================================

// デプロイ先リージョンとリソース名の共通プレフィックス
export const REGION = 'ap-northeast-1';
export const NAME_PREFIX = 'bedrock-kb-gdrive';

// 埋め込みモデル(Titan Text Embeddings V2)とベクトルの仕様
export const EMBEDDING_MODEL_ARN =
  `arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0`;
export const EMBEDDING_DIMENSION = 1024;
export const VECTOR_DATA_TYPE = 'float32';
export const VECTOR_DISTANCE_METRIC = 'cosine';

// ドキュメントのチャンク分割設定(固定トークン長 + オーバーラップ率)
export const CHUNK_MAX_TOKENS = 300;
export const CHUNK_OVERLAP_PERCENT = 20;

// Bedrock KB が S3 Vectors に書き込む本文系メタデータキー(フィルタ非対象にする)
export const NON_FILTERABLE_METADATA_KEYS = [
  'AMAZON_BEDROCK_TEXT',
  'AMAZON_BEDROCK_METADATA',
];
