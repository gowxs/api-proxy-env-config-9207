'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AppPage } from '@/components/shell';
import {
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  inputClass,
  Loading,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { EMAIL_DESIGNS, type EmailDesignId } from '@/lib/email-design';
import { useTenantId } from '@/lib/session';

interface TenantDesign {
  name: string;
  reply_signature: string | null;
  email_template: EmailDesignId;
  brand_company_name: string | null;
  brand_logo_url: string | null;
  brand_color: string | null;
  brand_website: string | null;
  brand_phone: string | null;
  brand_address: string | null;
  brand_social_links: string[];
}

interface Form {
  emailTemplate: EmailDesignId;
  brandCompanyName: string;
  brandLogoUrl: string;
  brandColor: string;
  brandWebsite: string;
  brandPhone: string;
  brandAddress: string;
  social: [string, string, string];
}

interface Preview {
  text: string;
  html: string | null;
  logo: 'shown' | 'none' | 'blocked';
  logoMessage?: string;
  fallback?: 'too_large';
  htmlBytes: number;
}

const toForm = (t: TenantDesign): Form => ({
  emailTemplate: t.email_template,
  brandCompanyName: t.brand_company_name ?? '',
  brandLogoUrl: t.brand_logo_url ?? '',
  brandColor: t.brand_color ?? '',
  brandWebsite: t.brand_website ?? '',
  brandPhone: t.brand_phone ?? '',
  brandAddress: t.brand_address ?? '',
  social: [0, 1, 2].map((i) => t.brand_social_links[i] ?? '') as [string, string, string],
});
const toBody = (f: Form) => ({
  emailTemplate: f.emailTemplate,
  brandCompanyName: f.brandCompanyName,
  brandLogoUrl: f.brandLogoUrl,
  brandColor: f.brandColor,
  brandWebsite: f.brandWebsite,
  brandPhone: f.brandPhone,
  brandAddress: f.brandAddress,
  brandSocialLinks: f.social.map((s) => s.trim()).filter(Boolean),
});

/**
 * Mail apps in dark mode usually invert light e-mails; the dark preview does
 * the same (preview only: nothing like it is ever sent).
 */
const DARK =
  '<style>html{filter:invert(1) hue-rotate(180deg);background:#fff}img{filter:invert(1) hue-rotate(180deg)}</style>';

/** One preview pane: the HTML in a sandboxed frame, or the text as a mail app shows it. */
function Pane({ p, dark }: { p: Preview; dark: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight + 4);
  };
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-1 text-xs font-medium text-neutral-500">
        {dark ? 'Dark mode (as most mail apps show it)' : 'Light'}
      </figcaption>
      <div
        className={cx(
          'overflow-hidden rounded-xl border',
          dark ? 'border-neutral-700 bg-neutral-900' : 'border-neutral-200 bg-white',
        )}
      >
        {p.html ? (
          <iframe
            ref={ref}
            title={dark ? 'Preview, dark mode' : 'Preview, light'}
            // No scripts; same origin only so the frame can be sized to its content.
            sandbox="allow-same-origin"
            srcDoc={dark ? p.html.replace('<head>', `<head>${DARK}`) : p.html}
            onLoad={fit}
            className="block w-full"
            style={{ height }}
          />
        ) : (
          <pre
            className={cx(
              'p-4 font-sans text-[15px] leading-relaxed whitespace-pre-wrap',
              dark ? 'text-neutral-100' : 'text-neutral-900',
            )}
          >
            {p.text}
          </pre>
        )}
      </div>
    </figure>
  );
}

function DesignEditor({ tenant, reload }: { tenant: TenantDesign; reload: () => Promise<void> }) {
  const tenantId = useTenantId();
  const [form, setForm] = useState<Form>(() => toForm(tenant));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  // Live preview, a moment after the last change.
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>(`/v1/tenants/${tenantId}/email-design/preview`, {
        method: 'POST',
        body: toBody(form),
      })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: Error) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [form, tenantId]);

  const html = form.emailTemplate !== 'plain';
  const logo =
    form.emailTemplate === 'logo' ||
    form.emailTemplate === 'branded' ||
    form.emailTemplate === 'card';

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="Design">
          <p className="mb-3 text-sm text-neutral-600">
            The frame around every reply, follow-up and acknowledgement. The reply text itself is
            not changed.
          </p>
          <div className="space-y-2" role="radiogroup" aria-label="E-mail design">
            {EMAIL_DESIGNS.map((d) => (
              <label
                key={d.id}
                className={cx(
                  'flex cursor-pointer gap-3 rounded-lg border p-3',
                  form.emailTemplate === d.id
                    ? 'border-indigo-600 bg-indigo-50'
                    : 'border-neutral-200',
                )}
              >
                <input
                  type="radio"
                  name="design"
                  className="mt-1"
                  checked={form.emailTemplate === d.id}
                  onChange={() => set('emailTemplate', d.id)}
                />
                <span>
                  <span className="block text-sm font-semibold">
                    {d.title}
                    {d.id === 'plain' && (
                      <span className="ml-1 font-normal text-neutral-500">(default)</span>
                    )}
                  </span>
                  <span className="block text-sm text-neutral-600">{d.line}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void save.run(async () => {
              await api(`/v1/tenants/${tenantId}`, { method: 'PATCH', body: toBody(form) });
              await reload();
              setSaved(true);
            });
          }}
        >
          <Card title="Your details">
            <div className="space-y-3">
              {html && (
                <>
                  <Field label="Company name">
                    <input
                      className={inputClass}
                      value={form.brandCompanyName}
                      placeholder={tenant.name}
                      onChange={(e) => set('brandCompanyName', e.target.value)}
                    />
                  </Field>
                  {logo && (
                    <Field
                      label="Logo address"
                      hint="An image on your own website (a site in your knowledge base), starting with https://. Shown at most 160 px wide. Dark text on a transparent background can disappear in dark mode; a logo with its own background works everywhere."
                    >
                      <input
                        className={inputClass}
                        type="url"
                        inputMode="url"
                        value={form.brandLogoUrl}
                        placeholder="https://your-site.com/logo.png"
                        onChange={(e) => set('brandLogoUrl', e.target.value)}
                      />
                    </Field>
                  )}
                  {(form.emailTemplate === 'branded' || form.emailTemplate === 'card') && (
                    <Field label="Brand colour">
                      <div className="flex gap-2">
                        <input
                          type="color"
                          aria-label="Pick a colour"
                          className="h-11 w-14 cursor-pointer rounded-lg border border-neutral-300 bg-white p-1"
                          value={
                            /^#[0-9a-f]{6}$/i.test(form.brandColor) ? form.brandColor : '#2f3a56'
                          }
                          onChange={(e) => set('brandColor', e.target.value.toUpperCase())}
                        />
                        <input
                          className={inputClass}
                          value={form.brandColor}
                          placeholder="#2F3A56"
                          onChange={(e) => set('brandColor', e.target.value)}
                        />
                      </div>
                    </Field>
                  )}
                </>
              )}
              <Field label="Website">
                <input
                  className={inputClass}
                  type="url"
                  inputMode="url"
                  value={form.brandWebsite}
                  placeholder="https://your-site.com"
                  onChange={(e) => set('brandWebsite', e.target.value)}
                />
              </Field>
              <Field label="Phone">
                <input
                  className={inputClass}
                  type="tel"
                  value={form.brandPhone}
                  onChange={(e) => set('brandPhone', e.target.value)}
                />
              </Field>
              <Field label="Address">
                <input
                  className={inputClass}
                  value={form.brandAddress}
                  onChange={(e) => set('brandAddress', e.target.value)}
                />
              </Field>
              <Field label="Social links (up to 3)">
                <div className="space-y-2">
                  {form.social.map((v, i) => (
                    <input
                      key={i}
                      className={inputClass}
                      type="url"
                      inputMode="url"
                      value={v}
                      placeholder={
                        [
                          'https://instagram.com/…',
                          'https://facebook.com/…',
                          'https://linkedin.com/…',
                        ][i]
                      }
                      onChange={(e) => {
                        const next = [...form.social] as Form['social'];
                        next[i] = e.target.value;
                        set('social', next);
                      }}
                    />
                  ))}
                </div>
              </Field>
              <p className="text-xs text-neutral-500">
                {form.emailTemplate === 'plain'
                  ? 'Plain e-mails carry your signature only; these details are used by the other designs.'
                  : 'In the text version of every e-mail these details follow your signature.'}{' '}
                The signature itself is in{' '}
                <Link className="text-indigo-700" href="/settings">
                  Settings
                </Link>
                .
              </p>
            </div>
          </Card>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.busy}>
              {save.busy ? 'Saving…' : 'Save design'}
            </Button>
            {saved && (
              <span className="text-sm text-green-700">
                Saved. Every e-mail from now on uses it.
              </span>
            )}
          </div>
          <ErrorText>{save.error}</ErrorText>
        </form>
      </div>

      <section aria-label="Preview" className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-700">Preview with a sample reply</h2>
        {preview?.logo === 'blocked' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {preview.logoMessage} The logo is left out until then.
          </p>
        )}
        {preview?.fallback === 'too_large' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Very long replies are sent as plain text (the design would exceed 40 KB).
          </p>
        )}
        <ErrorText>{previewError}</ErrorText>
        {preview ? (
          <div className="flex flex-col gap-4 xl:flex-row">
            <Pane p={preview} dark={false} />
            <Pane p={preview} dark />
          </div>
        ) : (
          <Loading />
        )}
        {preview?.html && (
          <p className="text-xs text-neutral-500">
            Sent with a complete plain-text version for every mail app ·{' '}
            {Math.ceil(preview.htmlBytes / 1024)} KB of HTML · no tracking.
          </p>
        )}
      </section>
    </div>
  );
}

function EmailDesign() {
  const tenantId = useTenantId();
  const { data, error, reload } = useLoad(
    () => api<TenantDesign>(`/v1/tenants/${tenantId}`),
    [tenantId],
  );
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  return <DesignEditor tenant={data} reload={reload} />;
}

export default function EmailDesignPage() {
  return (
    <AppPage title="E-mail design">
      <Link className="mb-3 inline-block text-sm text-indigo-700" href="/settings">
        ← Settings
      </Link>
      <EmailDesign />
    </AppPage>
  );
}
