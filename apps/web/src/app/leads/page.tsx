'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppPage } from '@/components/shell';
import {
  Badge,
  Button,
  ErrorText,
  inputClass,
  Loading,
  timeAgo,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

const STAGES = [
  'received',
  'drafted',
  'sent',
  'followed_up',
  'replied',
  'quoted',
  'accepted',
  'converted',
  'escalated',
] as const;
type Stage = (typeof STAGES)[number];
const STAGE_TEXT: Record<Stage, string> = {
  received: 'New',
  drafted: 'Draft ready',
  sent: 'Answered',
  followed_up: 'Followed up',
  replied: 'Replied',
  quoted: 'Quoted',
  accepted: 'Quote accepted',
  converted: 'Won',
  escalated: 'Needs you',
};
const STAGE_TONE: Record<Stage, 'gray' | 'amber' | 'green' | 'red' | 'blue'> = {
  received: 'gray',
  drafted: 'amber',
  sent: 'blue',
  followed_up: 'blue',
  replied: 'amber',
  quoted: 'blue',
  accepted: 'green',
  converted: 'green',
  escalated: 'red',
};

interface Lead {
  id: string;
  email: string;
  name: string | null;
  stage: Stage;
  last_activity_at: string;
  notes: string | null;
  thread_id: string | null;
  billing_name: string | null;
  billing_address: string | null;
  billing_reg_no: string | null;
  billing_vat_no: string | null;
  billing_updated_at: string | null;
}

function LeadRow({
  lead,
  tenantId,
  onChange,
}: {
  lead: Lead;
  tenantId: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [name, setName] = useState(lead.name ?? '');
  const [billing, setBilling] = useState({
    name: lead.billing_name ?? '',
    address: lead.billing_address ?? '',
    regNo: lead.billing_reg_no ?? '',
    vatNo: lead.billing_vat_no ?? '',
  });
  const setB = (k: keyof typeof billing, v: string) => setBilling((b) => ({ ...b, [k]: v }));
  const { busy, error, run } = useAction();
  const save = (body: Record<string, unknown>) =>
    run(async () => {
      await api(`/v1/tenants/${tenantId}/leads/${lead.id}`, { method: 'PATCH', body });
      onChange();
    });
  return (
    <li className="px-4 py-3">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{lead.name || lead.email}</span>
          {lead.name && (
            <span className="block truncate text-xs text-neutral-500">{lead.email}</span>
          )}
        </span>
        <Badge tone={STAGE_TONE[lead.stage]}>{STAGE_TEXT[lead.stage]}</Badge>
        <span className="w-16 text-right text-xs text-neutral-500">
          {timeAgo(lead.last_activity_at)}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Stage
              <select
                className={inputClass}
                value={lead.stage}
                disabled={busy}
                onChange={(e) => void save({ stage: e.target.value })}
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_TEXT[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Name
              <input
                className={inputClass}
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Notes
            <textarea
              className={`${inputClass} min-h-20`}
              maxLength={5000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <fieldset className="space-y-3 rounded-lg bg-neutral-50 p-3">
            <legend className="float-left w-full text-sm font-semibold">Billing details</legend>
            <p className="clear-both text-xs text-neutral-500">
              Used on invoices for this customer. The customer can also give them when accepting a
              quote.
              {lead.billing_updated_at && ` Last changed ${timeAgo(lead.billing_updated_at)}.`}
            </p>
            <label className="block text-sm">
              Company or name
              <input
                className={inputClass}
                value={billing.name}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => setB('name', e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Billing address
              <textarea
                className={`${inputClass} min-h-16`}
                value={billing.address}
                maxLength={500}
                onChange={(e) => setB('address', e.target.value)}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Registration number
                <input
                  className={inputClass}
                  value={billing.regNo}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(e) => setB('regNo', e.target.value)}
                />
              </label>
              <label className="text-sm">
                VAT number
                <input
                  className={inputClass}
                  value={billing.vatNo}
                  maxLength={30}
                  autoComplete="off"
                  placeholder="e.g. LV40003123456"
                  onChange={(e) => setB('vatNo', e.target.value)}
                />
              </label>
            </div>
          </fieldset>
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void save({ notes, name, billing })}
            >
              Save
            </Button>
            {lead.thread_id && (
              <Link
                className="inline-flex min-h-11 items-center px-3 text-sm text-indigo-700"
                href={`/conversations/${lead.thread_id}`}
              >
                Open conversation →
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Leads() {
  const tenantId = useTenantId();
  const [stage, setStage] = useState<Stage | ''>('');
  const { data, error, reload } = useLoad(
    () =>
      api<{ leads: Lead[]; counts: Record<string, number> }>(
        `/v1/tenants/${tenantId}/leads${stage ? `?stage=${stage}` : ''}`,
      ),
    [tenantId, stage],
  );
  return (
    <>
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {(['', ...STAGES] as const).map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStage(s)}
            className={`min-h-9 shrink-0 rounded-full px-3 text-sm ring-1 ${stage === s ? 'bg-indigo-700 text-white ring-indigo-700' : 'bg-white text-neutral-700 ring-neutral-300'}`}
          >
            {s ? STAGE_TEXT[s] : 'All'}
            {s && data?.counts[s] ? ` (${data.counts[s]})` : ''}
          </button>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {!data ? (
        <Loading />
      ) : data.leads.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No leads here yet. Everyone who writes to you appears here.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
          {data.leads.map((l) => (
            <LeadRow key={l.id} lead={l} tenantId={tenantId} onChange={() => void reload()} />
          ))}
        </ul>
      )}
    </>
  );
}

export default function LeadsPage() {
  return (
    <AppPage title="Leads">
      <Leads />
    </AppPage>
  );
}
