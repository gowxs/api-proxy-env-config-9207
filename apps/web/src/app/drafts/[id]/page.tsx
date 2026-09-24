'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppPage } from '@/components/shell';
import { ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

/** Links in owner emails point here; the draft is shown in its conversation. */
function Redirect() {
  const tenantId = useTenantId();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLoad(
    () => api<{ thread_id: string }>(`/v1/tenants/${tenantId}/drafts/${id}`),
    [tenantId, id],
  );
  useEffect(() => {
    if (data) router.replace(`/conversations/${data.thread_id}#draft-${id}`);
  }, [data, id, router]);
  return error ? <ErrorText>{error}</ErrorText> : <Loading />;
}

export default function DraftPage() {
  return (
    <AppPage title="Draft">
      <Redirect />
    </AppPage>
  );
}
