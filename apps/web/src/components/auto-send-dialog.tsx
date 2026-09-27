'use client';

/** The confirmation before Noctiv sends on its own (Settings → Reply mode and the assistant). */

import { useState } from 'react';
import { Button } from '@/components/ui';
import { modeInfo, type Mode } from '@/lib/modes';

export function AutoSendDialog({
  target,
  onConfirm,
  onCancel,
  busy,
}: {
  target: Mode;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [ok, setOk] = useState(false);
  const info = modeInfo(target);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-dialog-title"
    >
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5">
        <h2 id="mode-dialog-title" className="text-lg font-semibold">
          Switch to mode {info.number}: {info.title}?
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>Replies that pass every safety check are sent without asking you.</li>
          {target === 'full_auto' && (
            <li>
              When a question can&apos;t be answered from your knowledge base, the customer
              immediately gets “Thanks — I&apos;ll check this and get back to you as soon as
              possible.” (in their language), and you get the email to answer yourself.
            </li>
          )}
          <li>
            Complaints, refunds, legal questions, discount requests, angry or urgent emails always
            come to you, with no automatic reply.
          </li>
          <li>
            A reply is only sent automatically if every fact in it is in your knowledge base and a
            second check confirms it. No prices, dates or promises are ever invented.
          </li>
          <li>
            The per-hour and per-customer limits in these settings apply. You can switch back to
            approving everything at any time.
          </li>
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={ok}
            onChange={(e) => setOk(e.target.checked)}
          />
          <span>
            I have reviewed Noctiv&apos;s drafts and want{' '}
            {target === 'full_auto' ? 'safe replies and acknowledgements' : 'safe replies'} to be
            sent automatically.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!ok || busy} onClick={onConfirm}>
            Switch on
          </Button>
        </div>
      </div>
    </div>
  );
}
