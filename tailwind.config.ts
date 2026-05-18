import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#151515",
        paper: "#f7f5ef",
        moss: "#52694f",
        clay: "#c36c43",
        mist: "#dce3dc"
      },
      boxShadow: {
        soft: "0 24px 80px rgba(31, 35, 32, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
