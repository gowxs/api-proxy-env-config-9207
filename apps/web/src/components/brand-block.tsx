'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, ErrorText, Field, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import {
  brandTextColor,
  contrast,
  DEFAULT_BRAND,
  isHexColor,
  LOGO_ACCEPT,
  LOGO_MAX_BYTES,
  onBrand,
} from '@/lib/brand';

export interface UploadedLogo {
  dataUrl: string;
  width: number;
  height: number;
  sourceType: 'png' | 'jpeg' | 'svg';
}

/** The uploaded logo (null: none), loaded once; `set` after an upload or removal. */
export function useUploadedLogo(tenantId: string) {
  const [logo, setLogo] = useState<UploadedLogo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api<{ logo: UploadedLogo | null }>(`/v1/tenants/${tenantId}/brand/logo`)
      .then((r) => live && setLogo(r.logo))
      .catch(() => live && setLogo(null));
    return () => {
      live = false;
    };
  }, [tenantId]);
  return [logo, setLogo] as const;
}

const readBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(f);
  });

function ContrastNote({ color }: { color: string }) {
  if (!isHexColor(color)) return null;
  const ratio = contrast(color, '#FFFFFF');
  const text = `${ratio.toFixed(1)}:1 on white`;
  if (ratio >= 4.5)
    return <p className="text-xs text-green-800">✓ Reads well on white ({text}).</p>;
  if (ratio >= 3)
    return (
      <p className="text-xs text-green-800">
        ✓ Fine for your name and headings ({text}); body text stays dark.
      </p>
    );
  return (
    <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">
      Too light to read on white ({text}). Your name and links will use dark navy instead; the
      colour is still used for bars and buttons.
    </p>
  );
}

/** Invoice header and e-mail signature, as your customers will see them. */
export function BrandPreview({
  name,
  color,
  logoSrc,
}: {
  name: string;
  color: string;
  logoSrc: string | null;
}) {
  const brand = isHexColor(color) ? color.toUpperCase() : DEFAULT_BRAND;
  const text = brandTextColor(brand);
  const mark = (maxH: number) =>
    logoSrc ? (
      <img src={logoSrc} alt={name} style={{ maxHeight: maxH, maxWidth: 150 }} />
    ) : (
      <span className="font-bold" style={{ color: text, fontSize: maxH >= 40 ? 18 : 15 }}>
        {name}
      </span>
    );
  return (
    <div className="space-y-3" aria-label="Brand preview">
      <figure>
        <figcaption className="mb-1 text-xs font-medium text-neutral-500">
          Invoice header
        </figcaption>
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div style={{ height: 5, background: brand }} />
          <div className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0">{mark(44)}</div>
            <div className="text-right">
              <p className="text-lg font-bold text-neutral-900">INVOICE</p>
              <p className="text-xs text-neutral-500">INV-2026-0001</p>
            </div>
          </div>
        </div>
      </figure>
      <figure>
        <figcaption className="mb-1 text-xs font-medium text-neutral-500">
          E-mail signature
        </figcaption>
        <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm">
          <div className="mb-3">{mark(36)}</div>
          <p className="text-neutral-800">Kind regards,</p>
          <div className="mt-2 flex gap-3">
            <span className="w-[3px] shrink-0 rounded" style={{ background: brand }} />
            <div>
              <p className="font-medium text-neutral-900">{name}</p>
              <p style={{ color: text }}>your-site.com</p>
              <span
                className="mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: brand, color: onBrand(brand) }}
              >
                Instagram
              </span>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}

/**
 * "Your brand": logo (upload, or an image address for those who have one)
 * and brand colour with a contrast check. The upload is saved at once; the
 * colour and the address go with the surrounding form's Save.
 */
export function BrandBlock({
  tenantId,
  name,
  color,
  logoUrl,
  onColor,
  onLogoUrl,
  logo,
  setLogo,
  showPreview = true,
}: {
  tenantId: string;
  name: string;
  color: string;
  logoUrl: string;
  onColor: (c: string) => void;
  onLogoUrl: (u: string) => void;
  logo: UploadedLogo | null | undefined;
  setLogo: (l: UploadedLogo | null) => void;
  showPreview?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useAddress, setUseAddress] = useState(Boolean(logoUrl));

  const upload = async (f: File) => {
    setError(null);
    if (!/\.(png|jpe?g|svg)$/i.test(f.name) && !/^image\/(png|jpeg|svg\+xml)$/.test(f.type))
      return setError('Use a PNG, JPG or SVG file.');
    if (f.size > LOGO_MAX_BYTES)
      return setError('The logo is larger than 500 KB. Use a smaller file.');
    setBusy(true);
    try {
      const r = await api<{ logo: UploadedLogo }>(`/v1/tenants/${tenantId}/brand/logo`, {
        method: 'PUT',
        body: { data: await readBase64(f) },
      });
      setLogo(r.logo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The logo could not be uploaded.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/tenants/${tenantId}/brand/logo`, { method: 'DELETE' });
      setLogo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The logo could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const shownLogo = logo?.dataUrl ?? null;
  return (
    <div className="space-y-4">
      <Field
        label="Logo"
        hint="PNG, JPG or SVG, up to 500 KB; resized to 400 px. Used on your quotes, invoices, delivery notes, e-mail designs 3–5 and the page where customers accept a quote. Without a logo, your name is shown in your brand colour."
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white p-2">
            {shownLogo ? (
              <img src={shownLogo} alt="Your logo" className="max-h-12 max-w-full" />
            ) : (
              <span className="text-xs text-neutral-500">No logo yet</span>
            )}
          </div>
          <input
            ref={file}
            type="file"
            accept={LOGO_ACCEPT}
            className="sr-only"
            id="brand-logo-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || logo === undefined}
            onClick={() => file.current?.click()}
          >
            {busy ? 'Uploading…' : shownLogo ? 'Replace logo' : 'Upload logo'}
          </Button>
          {shownLogo && (
            <button
              type="button"
              className="text-sm text-neutral-600 underline"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remove
            </button>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        {!useAddress ? (
          <button
            type="button"
            className="mt-2 text-sm text-indigo-700"
            onClick={() => setUseAddress(true)}
          >
            Or use an image address from your website
          </button>
        ) : (
          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium" htmlFor="brand-logo-url">
              Logo address {shownLogo ? '(the uploaded logo is used first)' : ''}
            </label>
            <input
              id="brand-logo-url"
              className={inputClass}
              type="url"
              inputMode="url"
              value={logoUrl}
              placeholder="https://your-site.com/logo.png"
              onChange={(e) => onLogoUrl(e.target.value)}
            />
            <p className="mt-1 text-xs text-neutral-500">
              An https:// image on your own website (a site in your knowledge base).
            </p>
          </div>
        )}
      </Field>
      <Field label="Brand colour">
        <div className="flex gap-2">
          <input
            type="color"
            aria-label="Pick a colour"
            className="h-11 w-14 cursor-pointer rounded-lg border border-neutral-300 bg-white p-1"
            value={isHexColor(color) ? color.toLowerCase() : DEFAULT_BRAND.toLowerCase()}
            onChange={(e) => onColor(e.target.value.toUpperCase())}
          />
          <input
            className={inputClass}
            value={color}
            placeholder={DEFAULT_BRAND}
            aria-label="Brand colour (hex)"
            onChange={(e) => onColor(e.target.value)}
          />
        </div>
        <div className="mt-1">
          <ContrastNote color={color} />
        </div>
      </Field>
      {showPreview && (
        <BrandPreview
          name={name}
          color={color}
          logoSrc={shownLogo ?? (/^https:\/\//.test(logoUrl) ? logoUrl : null)}
        />
      )}
    </div>
  );
}
