import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// After bundling this file lives at dist/main/index.js. appRoot is the project folder when
// run with `npm run dev`, and ~/Library/Application Support/Lock In/runtime in the installed app.
const here = dirname(fileURLToPath(import.meta.url));
export const appRoot = resolve(here, '../..');
export const distDir = resolve(here, '..');

export const preloadPath = join(distDir, 'preload/index.cjs');
export const rendererPage = (page: 'app' | 'panel' | 'toast' | 'overlay' | 'voice' | 'talk') => join(distDir, 'renderer', `${page}.html`);

const firstExisting = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[0];

export function helperPath(): string {
  return firstExisting(join(appRoot, 'native/mac-helper/build/lockin-helper'), join(process.resourcesPath ?? '', 'lockin-helper'));
}

export function keyWatcherPath(): string | null {
  const p = firstExisting(join(appRoot, 'native/mac-helper/build/lockin-keys'), join(process.resourcesPath ?? '', 'lockin-keys'));
  return existsSync(p) ? p : null;
}

export function calendarReaderPath(): string | null {
  const p = firstExisting(join(appRoot, 'native/mac-helper/build/lockin-calendar'), join(process.resourcesPath ?? '', 'lockin-calendar'));
  return existsSync(p) ? p : null;
}

export function extensionPath(): string {
  return firstExisting(join(appRoot, 'extension'), join(process.resourcesPath ?? '', 'extension'));
}

export function assetPath(name: string): string {
  return firstExisting(join(appRoot, 'assets', name), join(app.getAppPath(), 'assets', name));
}

/** True in the installed "Lock In.app" (not when run from Terminal with npm run dev). */
export function isInstalledApp(): boolean {
  return process.platform === 'darwin' && /\/Lock In\.app\/Contents\/MacOS\//.test(process.execPath);
}

export function userDir(): string {
  return app.getPath('userData');
}
