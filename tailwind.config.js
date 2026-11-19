/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces : suivent le thème (clair/sombre) via variables.
        ink: 'rgb(var(--vy-bg) / <alpha-value>)',
        panel: 'rgb(var(--vy-surface) / <alpha-value>)',
        panel2: 'rgb(var(--vy-surface-2) / <alpha-value>)',
        panel3: 'rgb(var(--vy-surface-3) / <alpha-value>)',
        line: 'rgb(var(--vy-line) / var(--vy-line-a))',
        'line-strong': 'rgb(var(--vy-line-strong) / 0.26)',
        // `white` porte l'encre : blanc sur fond sombre, encre sur fond clair.
        white: 'rgb(var(--vy-white) / <alpha-value>)',
        // Échelle `slate` inversée en thème clair : tout le texte existant
        // devient automatiquement lisible sans réécrire un seul composant.
        slate: {
          50: 'rgb(var(--vy-slate-50) / <alpha-value>)',
          100: 'rgb(var(--vy-slate-100) / <alpha-value>)',
          200: 'rgb(var(--vy-slate-200) / <alpha-value>)',
          300: 'rgb(var(--vy-slate-300) / <alpha-value>)',
          400: 'rgb(var(--vy-slate-400) / <alpha-value>)',
          500: 'rgb(var(--vy-slate-500) / <alpha-value>)',
          600: 'rgb(var(--vy-slate-600) / <alpha-value>)',
          700: 'rgb(var(--vy-slate-700) / <alpha-value>)',
          800: 'rgb(var(--vy-slate-800) / <alpha-value>)',
          900: 'rgb(var(--vy-slate-900) / <alpha-value>)',
          950: 'rgb(var(--vy-slate-950) / <alpha-value>)',
        },
        // Accent de l'univers actif (Business Grow ou Studio).
        accent: 'var(--vy-accent)',
        'accent-2': 'var(--vy-accent-2)',
        'accent-soft': 'var(--vy-accent-soft)',
        signal: 'var(--vy-signal)',
        // `brand` suit l'univers : échelle complète remplacée par data-univers.
        brand: {
          50: 'rgb(var(--vy-brand-50) / <alpha-value>)',
          100: 'rgb(var(--vy-brand-100) / <alpha-value>)',
          200: 'rgb(var(--vy-brand-200) / <alpha-value>)',
          300: 'rgb(var(--vy-brand-300) / <alpha-value>)',
          400: 'rgb(var(--vy-brand-400) / <alpha-value>)',
          500: 'rgb(var(--vy-brand-500) / <alpha-value>)',
          600: 'rgb(var(--vy-brand-600) / <alpha-value>)',
          700: 'rgb(var(--vy-brand-700) / <alpha-value>)',
          800: 'rgb(var(--vy-brand-800) / <alpha-value>)',
          900: 'rgb(var(--vy-brand-900) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Space Grotesk', 'DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 18px 48px -22px var(--vy-glow)',
        card: 'var(--vy-shadow-md)',
        soft: 'var(--vy-shadow-sm)',
        deep: 'var(--vy-shadow-lg)',
      },
      borderRadius: {
        sm: 'var(--vy-r-sm)',
        DEFAULT: 'var(--vy-r)',
        lg: 'var(--vy-r-lg)',
        xl: 'var(--vy-r-xl)',
      },
      transitionTimingFunction: {
        vy: 'var(--vy-ease)',
      },
      transitionDuration: {
        fast: 'var(--vy-dur-fast)',
        DEFAULT: 'var(--vy-dur)',
        slow: 'var(--vy-dur-slow)',
      },
      fontSize: {
        '2xs': ['var(--vy-text-2xs)', { lineHeight: '1.35' }],
        xs: ['var(--vy-text-xs)', { lineHeight: '1.45' }],
        sm: ['var(--vy-text-sm)', { lineHeight: '1.5' }],
        base: ['var(--vy-text-base)', { lineHeight: '1.6' }],
        lg: ['var(--vy-text-lg)', { lineHeight: '1.55' }],
        xl: ['var(--vy-text-xl)', { lineHeight: '1.4' }],
        '2xl': ['var(--vy-text-2xl)', { lineHeight: '1.25' }],
        '3xl': ['var(--vy-text-3xl)', { lineHeight: '1.15' }],
        '4xl': ['var(--vy-text-4xl)', { lineHeight: '1.08' }],
        '5xl': ['var(--vy-text-5xl)', { lineHeight: '1.02' }],
      },
      maxWidth: {
        prose: '68ch',
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
