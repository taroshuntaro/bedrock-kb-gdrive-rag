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

// ドキュメントのチャンク分割設定(セマンティック分割)
export const CHUNK_STRATEGY = 'SEMANTIC' as const;
export const SEMANTIC_MAX_TOKENS = 300;        // 分割後チャンクの最大トークン数
export const SEMANTIC_BUFFER_SIZE = 1;          // 境界検出時に前後に含める文数
export const SEMANTIC_BREAKPOINT_THRESHOLD = 95; // 類似度のパーセンタイル閾値(高いほど大きなチャンク)

// Bedrock KB が S3 Vectors に書き込む本文系メタデータキー(フィルタ非対象にする)
export const NON_FILTERABLE_METADATA_KEYS = [
  'AMAZON_BEDROCK_TEXT',
  'AMAZON_BEDROCK_METADATA',
];

// 回答生成モデル: Claude Haiku 4.5 の日本ジオ・クロスリージョン推論プロファイル。
// 東京⇔大阪間でルーティングされ、推論処理が日本国内で完結する。
export const GENERATION_PROFILE_ID = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';
// 推論プロファイルが内部で呼び出す基盤モデル ID(IAM の foundation-model 許可の組み立てに使用)
export const GENERATION_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

// リランクモデル: Cohere Rerank 3.5。ap-northeast-1 内で完結するため CRIS 不要。
// stack の IAM ARN 組み立てに使う。日本語ドキュメントに強い多言語リランカー。
export const RERANK_MODEL_ID = 'cohere.rerank-v3-5:0';
