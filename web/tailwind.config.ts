import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        void: "#0B0D11",
        sidebar: "#0F1218",
        elevated: "#151821",
        hairline: "rgba(255, 255, 255, 0.08)",
        "hairline-hover": "rgba(255, 255, 255, 0.16)",
        accent: {
          cyan: "#22D3EE",
          amber: "#F59E0B",
          emerald: "#10B981",
          coral: "#F43F5E",
        },
        genesis: {
          primary: "#F3F4F6",
          secondary: "#9CA3AF",
          muted: "#4B5563",
          code: "#E5E7EB",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "-apple-system", "sans-serif"],
        serif: ["Newsreader", "Lora", "Georgia", "serif"],
        mono: ["var(--font-geist-mono)", "JetBrains Mono", "monospace"],
      },
      borderWidth: {
        hairline: "1px",
      },
    },
  },
  plugins: [],
};
export default config;
