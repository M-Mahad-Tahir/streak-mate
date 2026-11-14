/** A color scale read from the CSS variables in src/index.css, so dark mode can swap it. */
const themeScale = (name) => Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]),
);

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ...Object.fromEntries(['slate', 'brand', 'emerald', 'rose', 'amber', 'sky', 'violet', 'flame'].map((name) => [name, themeScale(name)])),
      },
      boxShadow: { card: '0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.06)' },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
        pop: { '0%': { transform: 'scale(.9)' }, '60%': { transform: 'scale(1.06)' }, '100%': { transform: 'scale(1)' } },
      },
      animation: { 'fade-in': 'fade-in .2s ease-out', pop: 'pop .35s ease-out' },
    },
  },
  plugins: [],
};
