/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        deloitte: {
          green: '#86BC25',
          'dark-green': '#00A758',
          black: '#000000',
          gray: {
            dark: '#53565A',
            medium: '#97999B',
            light: '#E0E0E0',
          }
        }
      }
    },
  },
  plugins: [],
}
