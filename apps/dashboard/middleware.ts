import { NextResponse, type NextRequest } from 'next/server';

/**
 * Auth gate.
 *
 * A single shared password guards the console. That is appropriate for a sales
 * demo and a small clinic; the README flags SSO/per-user accounts as the step
 * before real patient data goes in.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }
  if (!request.cookies.get('fo_session')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
