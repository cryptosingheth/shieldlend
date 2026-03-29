/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      path: false,
      os: false,
      "pino-pretty": false,
      "@react-native-async-storage/async-storage": false,
    };
    // Do NOT alias web-worker to false — snarkjs needs it to run
    // Groth16 proof generation off the main thread via Web Workers.
    // The "critical dependency" warning from ffjavascript is harmless.
    return config;
  },
};

export default nextConfig;
