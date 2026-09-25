import type { TransactionSql } from 'postgres';

/**
 * Moves a lead forward and records the event. A converted lead stays
 * converted; an accepted quote stays accepted until the lead is converted.
 */
export async function setLeadStage(
  tx: TransactionSql,
  tenantId: string,
  leadId: string,
  to: string,
  reason: string,
) {
  const [lead] = await tx<{ stage: string }[]>`select stage from public.leads where id = ${leadId}`;
  if (!lead || lead.stage === to || lead.stage === 'converted') return;
  if (lead.stage === 'accepted' && to !== 'converted') return;
  await tx`update public.leads set stage = ${to}, stage_changed_at = now(), last_activity_at = now() where id = ${leadId}`;
  await tx`insert into public.lead_events (tenant_id, lead_id, from_stage, to_stage, actor, reason)
           values (${tenantId}, ${leadId}, ${lead.stage}, ${to}, 'system', ${reason})`;
}
