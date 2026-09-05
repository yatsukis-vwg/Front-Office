import { NextResponse } from 'next/server';
import { adminFetch, ApiError } from '@/lib/api';

/**
 * Authenticated proxy for client components.
 *
 * Interactive widgets (takeover, staff reply, KB save, manual booking) POST
 * here; this route re-signs the call with the admin key server-side. The key
 * never reaches the browser, and every call still lands in the API's audit log
 * attributed to the signed-in staff member.
 */

async function forward(request: Request, params: Promise<{ path: string[] }>, method: string) {
  const { path } = await params;
  const url = new URL(request.url);
  const search = url.search ? url.search : '';
  const target = `/${path.join('/')}${search}`;

  let body: unknown;
  if (method !== 'GET' && method !== 'DELETE') {
    body = await request.json().catch(() => undefined);
  }

  try {
    const data = await adminFetch<unknown>(target, { method, body });
    return NextResponse.json(data ?? { ok: true });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(error.body ?? { error: 'upstream_error' }, { status: error.status });
    }
    return NextResponse.json({ error: 'proxy_failed', message: (error as Error).message }, { status: 502 });
  }
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context.params, 'GET');
}
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context.params, 'POST');
}
export async function PUT(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context.params, 'PUT');
}
export async function PATCH(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context.params, 'PATCH');
}
export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context.params, 'DELETE');
}
