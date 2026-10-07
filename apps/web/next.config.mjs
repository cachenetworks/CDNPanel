/** @type {import('next').NextConfig} */
const apiOrigin = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js needs inline scripts for hydration; no third-party script origins are allowed.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@cdn/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // In development the dashboard proxies API/CDN routes so everything is same-origin.
  // In production Nginx routes these paths to the API directly.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/files/:path*', destination: `${apiOrigin}/files/:path*` },
      { source: '/p/:path*', destination: `${apiOrigin}/p/:path*` },
      { source: '/openapi.json', destination: `${apiOrigin}/openapi.json` },
    ];
  },
};

export default nextConfig;
