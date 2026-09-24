export const KB_BUCKET = 'kb-files';

export class TenantPathError extends Error {
  constructor() {
    super('object path does not belong to this tenant');
    this.name = 'TenantPathError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Objects live under "<tenant_id>/<source_id>/<file>" (kb_sources.storage_path enforces the prefix too). */
export function kbObjectPath(tenantId: string, sourceId: string, fileName: string): string {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(sourceId)) throw new TenantPathError();
  if (!/^[\w.-]{1,100}$/.test(fileName) || fileName.startsWith('.')) throw new TenantPathError();
  return `${tenantId}/${sourceId}/${fileName}`;
}

export function assertTenantPath(tenantId: string, path: string): void {
  if (!path.startsWith(`${tenantId}/`) || path.includes('..') || path.includes('//'))
    throw new TenantPathError();
}

/**
 * Tenant-scoped object storage. Every call names the tenant and the store
 * refuses paths outside that tenant's prefix, so a bug elsewhere cannot read
 * or delete another tenant's files through it.
 */
export interface BlobStore {
  put(tenantId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(tenantId: string, path: string): Promise<Uint8Array>;
  /** Removes everything under "<tenant_id>/" (hard delete) or a single object. */
  delete(tenantId: string, paths: string[]): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(tenantId: string, path: string, bytes: Uint8Array, contentType: string) {
    assertTenantPath(tenantId, path);
    if (this.objects.has(path)) throw new Error('object already exists');
    this.objects.set(path, { bytes, contentType });
  }

  async get(tenantId: string, path: string) {
    assertTenantPath(tenantId, path);
    const o = this.objects.get(path);
    if (!o) throw new Error('object not found');
    return o.bytes;
  }

  async delete(tenantId: string, paths: string[]) {
    for (const p of paths) {
      assertTenantPath(tenantId, p);
      this.objects.delete(p);
    }
  }
}
