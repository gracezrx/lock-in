// What the shared engine and crew code need from node:crypto, in the browser.
export const randomUUID = (): string => crypto.randomUUID();
