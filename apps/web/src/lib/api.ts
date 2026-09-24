'use client';

import { getAccessToken } from './auth';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls the Noctiv API through the same-origin /api proxy (next.config.ts). */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'Please sign in.');
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const msg =
      (data as { error?: string; message?: string } | undefined)?.error ??
      (data as { message?: string } | undefined)?.message ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}
