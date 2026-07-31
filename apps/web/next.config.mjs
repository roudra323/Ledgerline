/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // slim Docker image (see Dockerfile)
  transpilePackages: ["@chainstake/shared"],
};

export default nextConfig;
