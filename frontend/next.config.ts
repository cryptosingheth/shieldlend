import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // Required for snarkjs WASM support
    config.resolve.fallback = { fs: false, path: false, os: false };
    return config;
  },
};

export default nextConfig;
