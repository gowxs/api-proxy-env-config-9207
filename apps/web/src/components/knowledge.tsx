'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, ErrorText, Field, inputClass, timeAgo, useAction } from './ui';

export interface KbSource {
  id: string;
  type: 'website' | 'file' | 'note';
  title: string;
  url: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  updated_at: string;
}

const STATUS_TONE = {
  pending: 'amber',
  processing: 'amber',
  ready: 'green',
  failed: 'red',
} as const;
const STATUS_TEXT = {
  pending: 'Queued',
  processing: 'Reading…',
  ready: 'Ready',
  failed: 'Failed',
} as const;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
}

/** Add a website, files or a note. */
export function KnowledgeAdd({ tenantId, onAdded }: { tenantId: string; onAdded: () => void }) {
  const [tab, setTab] = useState<'website' | 'file' | 'note'>('website');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const base = `/v1/tenants/${tenantId}/kb`;

  const after = (msg: string) => {
    setDone(msg);
    onAdded();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1 text-sm">
        {(['website', 'file', 'note'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setDone(null);
            }}
            className={`min-h-10 rounded-md ${tab === t ? 'bg-white font-medium shadow-sm' : 'text-neutral-600'}`}
          >
            {t === 'website' ? 'Website' : t === 'file' ? 'Files' : 'Note'}
          </button>
        ))}
      </div>

      {tab === 'website' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`${base}/website`, { method: 'POST', body: { url } });
              setUrl('');
              after('Website added. Noctiv reads up to 50 pages of it in the background.');
            });
          }}
        >
          <Field
            label="Website address"
            hint="Only pages on the same site are read. Nothing behind a login."
          >
            <input
              className={inputClass}
              required
              placeholder="www.your-shop.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Add website
          </Button>
        </form>
      )}

      {tab === 'file' && (
        <div className="space-y-2">
          <Field
            label="PDF, Word (.docx) or text files, up to 10 MB each"
            hint="Files are read once and then deleted; only the text is kept."
          >
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md,.csv,application/pdf,text/plain"
              className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:text-indigo-800"
              disabled={busy}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void run(async () => {
                  for (const f of files) {
                    if (f.size > 10 * 1024 * 1024)
                      throw new Error(`${f.name} is larger than 10 MB.`);
                    await api(`${base}/files`, {
                      method: 'POST',
                      body: { fileName: f.name, contentBase64: await readAsBase64(f) },
                    });
                  }
                  after(`${files.length} file${files.length === 1 ? '' : 's'} added.`);
                });
              }}
            />
          </Field>
          {busy && <p className="text-sm text-neutral-500">Uploading…</p>}
        </div>
      )}

      {tab === 'note' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`${base}/notes`, { method: 'POST', body: { title, text } });
              setTitle('');
              setText('');
              after('Note added.');
            });
          }}
        >
          <Field label="Title">
            <input
              className={inputClass}
              required
              maxLength={200}
              placeholder="Shipping and returns"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field
            label="Text"
            hint="Prices, delivery times, opening hours, policies — whatever customers ask about."
          >
            <textarea
              className={`${inputClass} min-h-40`}
              required
              maxLength={50000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Add note
          </Button>
        </form>
      )}

      <ErrorText>{error}</ErrorText>
      {done && <p className="text-sm text-green-800">✓ {done}</p>}
    </div>
  );
}

export function SourceList({
  tenantId,
  sources,
  onChange,
  compact = false,
}: {
  tenantId: string;
  sources: KbSource[];
  onChange: () => void;
  compact?: boolean;
}) {
  const { busy, error, run } = useAction();
  if (!sources.length) return <p className="text-sm text-neutral-500">Nothing added yet.</p>;
  return (
    <div>
      <ErrorText>{error}</ErrorText>
      <ul className="divide-y divide-neutral-100">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <span className="w-16 text-xs uppercase text-neutral-400">{s.type}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
            <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[s.status]}</Badge>
            {!compact && (
              <span className="flex w-full gap-2 pl-16 text-xs text-neutral-500 sm:w-auto sm:pl-0">
                {timeAgo(s.updated_at)}
                {s.type !== 'file' && (
                  <button
                    className="text-indigo-700"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/v1/tenants/${tenantId}/kb/sources/${s.id}/refresh`, {
                          method: 'POST',
                          body: {},
                        });
                        onChange();
                      })
                    }
                  >
                    {s.type === 'website' ? 'Re-read' : 'Re-index'}
                  </button>
                )}
                <button
                  className="text-red-700"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Delete "${s.title}" from the knowledge base?`)) return;
                    void run(async () => {
                      await api(`/v1/tenants/${tenantId}/kb/sources/${s.id}`, { method: 'DELETE' });
                      onChange();
                    });
                  }}
                >
                  Delete
                </button>
              </span>
            )}
            {s.status === 'failed' && s.error && (
              <span className="w-full pl-16 text-xs text-red-700">{s.error}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
