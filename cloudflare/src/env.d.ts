declare namespace Cloudflare {
  interface Env {
    // Anthropic — required secrets.
    WEBHOOK_SECRET: string;
    ANTHROPIC_BASE_URL?: string;

    // Browser Rendering / R2 / API credentials (optional, from template).
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    BACKUP_BUCKET_NAME?: string;
    EMAIL_FORWARD?: string;

    // Alfred D1 database (profiles, documents, proposals, decisions, panopticon).
    ALFRED_DB: D1Database;

    // Alfred Vectorize index for voice memory.
    ALFRED_VECTORS: VectorizeIndex;
  }
}
