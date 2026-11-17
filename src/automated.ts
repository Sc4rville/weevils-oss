// A browser driven by a script (Playwright, Puppeteer, Selenium) says so on every request: the server never lets it
// speak as the user to weevboss (server/http.ts userVoice), even on this machine.
export const automatedBrowser = () => typeof navigator !== 'undefined' && navigator.webdriver === true
export const automatedHeaders = (): Record<string, string> => (automatedBrowser() ? { 'x-weevils-automated': '1' } : {})
