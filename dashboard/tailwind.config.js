/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                'bg-primary': '#0a0e27',
                'bg-secondary': '#151a35',
                'accent-blue': '#00d9ff',
                'accent-purple': '#a855f7',
                'accent-gold': '#fbbf24',
            },
            animation: {
                'fade-in': 'fadeIn 0.5s ease-in',
                'slide-up': 'slideUp 0.5s ease-out',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideUp: {
                    '0%': { transform: 'translateY(20px)', opacity: '0' },
                    100% ': { transform: 'translateY(0)', opacity: '1' },
        },
            },
        },
    },
    plugins: [],
}
