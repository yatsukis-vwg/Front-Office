import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete('fo_session');
  response.cookies.delete('fo_staff');
  return response;
}
