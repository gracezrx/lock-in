// Where people get the things Lock In for Mac doesn't ship with.

/** Lock In Extended (the Chrome extension) is its own download, next to the Mac app on the releases page. */
export const EXTENSION_DOWNLOAD = 'https://github.com/gracezrx/lock-in/releases/latest';
/** Connected extensions older than this are asked to update. */
export const EXTENSION_MIN_VERSION = '1.0.0';

/** Where to make each API key. */
export const KEY_PAGES = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
} as const;
