/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    config.resolve.fallback = {
      fs: false,
      path: false,
      os: false,
      "pino-pretty": false,
      "@react-native-async-storage/async-storage": false,
    };
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "web-worker": false,
      };
    }
    return config;
  },
};

export default nextConfig;
