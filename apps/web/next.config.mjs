/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // slim Docker image (see Dockerfile)
  transpilePackages: ["@ledgerline/shared"],
};

export default nextConfig;
