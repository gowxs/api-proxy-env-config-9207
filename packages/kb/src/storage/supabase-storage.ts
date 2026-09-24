import { assertTenantPath, KB_BUCKET, type BlobStore } from './blob-store.ts';

export interface SupabaseStorageOptions {
  /** "https://<ref>.supabase.co/storage/v1" in the cloud; "http://localhost:54330" for the local container. */
  baseUrl: string;
  /** Bearer token Storage accepts for server-side access (see README: Storage credential). */
  token: string;
  /** Supabase's API gateway also wants an "apikey" header (the anon/publishable key). */
  apiKey?: string;
  bucket?: string;
  fetch?: typeof fetch;
}

export class StorageError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    // Never includes the path or body: paths contain tenant ids and file names.
    super(`storage ${operation} failed (HTTP ${status})`);
    this.status = status;
    this.name = 'StorageError';
  }
}

/** Supabase Storage over its REST API, private bucket, tenant-prefixed paths. */
export class SupabaseStorageBlobStore implements BlobStore {
  private readonly base: string;
  private readonly bucket: string;
  private readonly f: typeof fetch;
  private readonly opts: SupabaseStorageOptions;

  constructor(opts: SupabaseStorageOptions) {
    this.opts = opts;
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.bucket = opts.bucket ?? KB_BUCKET;
    this.f = opts.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      ...(this.opts.apiKey ? { apikey: this.opts.apiKey } : {}),
      ...extra,
    };
  }

  private objectUrl(path: string): string {
    return `${this.base}/object/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(tenantId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertTenantPath(tenantId, path);
    const res = await this.f(this.objectUrl(path), {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'x-upsert': 'false' }),
      body: bytes,
    });
    if (!res.ok) throw new StorageError('upload', res.status);
  }

  async get(tenantId: string, path: string): Promise<Uint8Array> {
    assertTenantPath(tenantId, path);
    const res = await this.f(this.objectUrl(path), { headers: this.headers() });
    if (!res.ok) throw new StorageError('download', res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(tenantId: string, paths: string[]): Promise<void> {
    paths.forEach((p) => assertTenantPath(tenantId, p));
    if (paths.length === 0) return;
    const res = await this.f(`${this.base}/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) throw new StorageError('delete', res.status);
  }

  /** One-time setup: private bucket with a size limit and the three allowed types. */
  async ensureBucket(): Promise<void> {
    const res = await this.f(`${this.base}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        id: this.bucket,
        name: this.bucket,
        public: false,
        file_size_limit: 10 * 1024 * 1024,
        allowed_mime_types: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
        ],
      }),
    });
    if (!res.ok && res.status !== 409 && res.status !== 400)
      throw new StorageError('create bucket', res.status);
  }
}
