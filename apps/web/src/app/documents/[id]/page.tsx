'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { DocumentEditor } from '@/components/document-editor';
import { AppPage } from '@/components/shell';
import { ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { Doc } from '@/lib/documents';
import { useTenantId } from '@/lib/session';

function DocumentView() {
  const tenantId = useTenantId();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useLoad(
    () => api<Doc>(`/v1/tenants/${tenantId}/documents/${id}`),
    [tenantId, id],
  );
  const pending = data?.prefill_status === 'pending';
  // The e-mail is read in the background; show the fields as soon as they are filled.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [pending, reload]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  // Remount after a reload so the form starts from the saved data.
  return (
    <DocumentEditor
      key={`${data.id}:${data.status}:${data.number ?? ''}:${data.prefill_status ?? ''}`}
      doc={data}
      tenantId={tenantId}
      reload={reload}
    />
  );
}

export default function DocumentPage() {
  return (
    <AppPage title="Document">
      <DocumentView />
    </AppPage>
  );
}
