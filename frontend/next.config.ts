import type { NextConfig } from 'next';

// Applied to every page. nginx adds X-Frame-Options, X-Content-Type-Options,
// and HSTS in production, so they are not repeated here. A script-src policy
// would need per-request nonces for Next's inline scripts and Emotion's styles.
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Lets the browser call the APIs through Next during local development.
  // Behind nginx in production /api/* never reaches Next. Rewrites are
  // resolved at build time, so these URLs are the build machine's.
  async rewrites() {
    const userService = process.env.USER_SERVICE_URL || 'http://localhost:3003';
    const backend = process.env.BACKEND_URL || 'http://localhost:3002';
    return [
      {
        source: '/api/auth/:path*',
        destination: `${userService}/auth/:path*`,
      },
      {
        source: '/api/users/:path*',
        destination: `${userService}/users/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${backend}/:path*`,
      },
    ];
  },
  env: {
    NEXT_PUBLIC_AUTH_URL:
      process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3003/auth/google',
  },
};

export default nextConfig;
