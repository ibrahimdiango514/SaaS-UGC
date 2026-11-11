/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#070b12',
        panel: '#0e141d',
        panel2: '#141c27',
        line: 'rgba(148,163,184,0.13)',
        brand: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
        accent: '#a78bfa',
      },
      fontFamily: {
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Space Grotesk', 'DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 18px 48px -22px rgba(6,182,212,0.55)',
        card: '0 12px 40px -18px rgba(0,0,0,0.8)',
      },
      keyframes: {
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-12px)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        fadeRight: { '0%': { opacity: '0', transform: 'translateX(-14px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        aurora: {
          '0%,100%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '0.55' },
          '50%': { transform: 'translate3d(3%, -4%, 0) scale(1.12)', opacity: '0.85' },
        },
        pulseGlow: {
          '0%,100%': { opacity: '0.35', transform: 'scale(0.96)' },
          '50%': { opacity: '0.7', transform: 'scale(1.04)' },
        },
        marquee: { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(18px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        fadeUp: 'fadeUp 0.35s ease-out both',
        fadeRight: 'fadeRight 0.5s ease-out both',
        aurora: 'aurora 16s ease-in-out infinite',
        pulseGlow: 'pulseGlow 7s ease-in-out infinite',
        marquee: 'marquee 32s linear infinite',
        riseIn: 'riseIn 0.7s cubic-bezier(0.22,1,0.36,1) both',
      },
    },
  },
  plugins: [],
};
