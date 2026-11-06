// Lock In.app loader. The app bundle never changes between updates (so macOS keeps its
// permissions); it runs the code that install-mac.sh keeps in
// ~/Library/Application Support/Lock In/runtime.
import { app, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

app.setName('Lock In');
const entry = join(app.getPath('appData'), 'Lock In', 'runtime', 'dist', 'main', 'index.js');

if (existsSync(entry)) {
  await import(pathToFileURL(entry).href);
} else {
  app.whenReady().then(() => {
    dialog.showErrorBox('Lock In needs one more step', 'Double-click "Start Lock In" in your lockin-app folder to finish installing.');
    app.quit();
  });
}
