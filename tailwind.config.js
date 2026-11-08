/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#080a12',
        panel: '#10131f',
        panel2: '#161a2b',
        line: 'rgba(255,255,255,0.08)',
        brand: {
          50: '#f2f0ff',
          100: '#e6e1ff',
          200: '#ccc2ff',
          300: '#a99bff',
          400: '#8b73ff',
          500: '#7255f5',
          600: '#5f3ee0',
          700: '#4d30bb',
          800: '#3f2896',
          900: '#332475',
        },
        accent: '#22d3ee',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 20px 60px -20px rgba(114,85,245,0.55)',
        card: '0 12px 40px -18px rgba(0,0,0,0.8)',
      },
      keyframes: {
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-12px)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        fadeUp: 'fadeUp 0.35s ease-out both',
      },
    },
  },
  plugins: [],
};
