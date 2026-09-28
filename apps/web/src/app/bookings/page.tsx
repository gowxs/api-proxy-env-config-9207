'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BookingList, BookingSetupCard, FormsPanel } from '@/components/bookings';
import { ModuleBar, ModuleOff, Tabs, useModuleToggle, useTab } from '@/components/module';
import { AppPage } from '@/components/shell';
import { ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { BookingSetup } from '@/lib/bookings';
import { useTenantId } from '@/lib/session';

const TABS = ['upcoming', 'forms', 'setup'] as const;
const TAB_LABELS = { upcoming: 'Upcoming', forms: 'Forms', setup: 'Setup' };

/** Bookings (beta), PLAN.md §29.8. */
function BookingsModule() {
  const tenantId = useTenantId();
  const params = useSearchParams();
  const setup = useLoad(
    () => api<BookingSetup>(`/v1/tenants/${tenantId}/bookings/setup`),
    [tenantId],
  );
  const toggle = useModuleToggle(tenantId, 'bookingsEnabled', setup.reload);
  const [tab, setTab] = useTab(TABS);
  if (setup.error) return <ErrorText>{setup.error}</ErrorText>;
  if (!setup.data) return <Loading />;
  const s = setup.data;
  if (!s.enabled)
    return (
      <ModuleOff
        name="Bookings"
        lead="Let customers book a meeting, a call or a visit, without the back and forth."
        points={[
          {
            title: 'Your booking page',
            text: 'Customers pick one of your free times; your calendar’s busy times are never offered.',
          },
          {
            title: 'Replies offer times',
            text: 'When someone asks to meet, the reply offers your next three free times and the link.',
          },
          {
            title: 'Questions first',
            text: 'Intake forms collect what you need before the visit; answers land on the lead.',
          },
        ]}
        note="Confirmations go out from your mailbox, with a calendar invite."
        onEnable={() => {
          toggle.set(true);
          setTab('setup');
        }}
        busy={toggle.busy}
        error={toggle.error}
      />
    );
  return (
    <>
      <ModuleBar
        name="Bookings"
        line="Customers book free times on your page; replies to meeting requests offer times."
        onDisable={() => toggle.set(false)}
        busy={toggle.busy}
        error={toggle.error}
      />
      <Tabs tabs={TABS} labels={TAB_LABELS} tab={tab} onChange={setTab} />
      {tab === 'upcoming' && <BookingList tenantId={tenantId} timeZone={s.timezone} />}
      {tab === 'forms' && <FormsPanel tenantId={tenantId} />}
      {tab === 'setup' && (
        <BookingSetupCard
          tenantId={tenantId}
          setup={s}
          reload={setup.reload}
          calendarResult={{ status: params.get('calendar'), reason: params.get('reason') }}
        />
      )}
    </>
  );
}

export default function BookingsPage() {
  return (
    <AppPage title="Bookings">
      <Suspense fallback={<Loading />}>
        <BookingsModule />
      </Suspense>
    </AppPage>
  );
}
