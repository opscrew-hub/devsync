import type { NextConfig } from "next";
const config: NextConfig = { transpilePackages: ["@devsync/db", "@devsync/core", "@devsync/contracts"] };
export default config;
