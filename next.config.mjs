/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["cheerio", "turndown", "sanitize-html"]
  }
};

export default nextConfig;
