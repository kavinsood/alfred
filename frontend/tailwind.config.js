/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FAF7F2",
        ink: "#1a1a1a",
        muted: "#6e6a64",
        accent: "#9b2c2c",
        rule: "#e7e1d4",
        chrome: "#f3eee4",
      },
      fontFamily: {
        serif: [
          "Iowan Old Style",
          "Charter",
          "Source Serif Pro",
          "Georgia",
          "serif",
        ],
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      maxWidth: {
        prose: "720px",
      },
    },
  },
  plugins: [],
};
