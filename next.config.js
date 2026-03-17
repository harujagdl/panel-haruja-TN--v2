/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium', 'googleapis'],
};

module.exports = nextConfig;
