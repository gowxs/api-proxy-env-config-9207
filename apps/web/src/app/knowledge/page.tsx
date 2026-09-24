'use client';

import { KnowledgeAdd, SourceList, type KbSource } from '@/components/knowledge';
import { AppPage } from '@/components/shell';
import { Card, ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

function Knowledge() {
  const tenantId = useTenantId();
  const { data, error, reload } = useLoad(
    () => api<KbSource[]>(`/v1/tenants/${tenantId}/kb/sources`),
    [tenantId],
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Add knowledge">
        <KnowledgeAdd tenantId={tenantId} onAdded={() => void reload()} />
      </Card>
      <Card
        title="Sources"
        action={
          <button className="text-sm text-indigo-700" onClick={() => void reload()}>
            Refresh
          </button>
        }
      >
        <ErrorText>{error}</ErrorText>
        {data ? (
          <SourceList tenantId={tenantId} sources={data} onChange={() => void reload()} />
        ) : (
          <Loading />
        )}
      </Card>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <AppPage title="Knowledge base">
      <Knowledge />
    </AppPage>
  );
}
