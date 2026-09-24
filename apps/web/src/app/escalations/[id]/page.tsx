'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppPage } from '@/components/shell';
import { ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

/** Links in owner emails point here; the escalation is shown in its conversation. */
function Redirect() {
  const tenantId = useTenantId();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLoad(
    () => api<{ thread_id: string }>(`/v1/tenants/${tenantId}/escalations/${id}`),
    [tenantId, id],
  );
  useEffect(() => {
    if (data) router.replace(`/conversations/${data.thread_id}`);
  }, [data, id, router]);
  return error ? <ErrorText>{error}</ErrorText> : <Loading />;
}

export default function EscalationPage() {
  return (
    <AppPage title="Escalation">
      <Redirect />
    </AppPage>
  );
}
