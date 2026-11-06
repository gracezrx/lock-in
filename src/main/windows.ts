// Creates and manages the windows: the menu bar panel, the main app (settings), corner toast,
// full-screen overlay, the talk panel, and a hidden voice window that plays audio and records replies.
import { app, BrowserWindow, screen, shell, type Rectangle } from 'electron';
import type { OverlayPayload, ToastPayload } from '../shared/types';
import { preloadPath, rendererPage } from './paths';

const TOAST_W = 400;
/** The panel page draws its card inside a clear margin, so the shadow has room. */
const PANEL_W = 392;
const PANEL_MARGIN = 12;
const PANEL_MAX_H = 720;
const TALK_W = 400;
const TALK_H = 560;

function secure(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

const webPreferences = () => ({
  preload: preloadPath,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  backgroundThrottling: false,
});

export class Windows {
  main: BrowserWindow | null = null;
  panel: BrowserWindow | null = null;
  toast: BrowserWindow | null = null;
  overlay: BrowserWindow | null = null;
  voice: BrowserWindow | null = null;
  talk: BrowserWindow | null = null;
  private talkPayload: unknown = null;
  private talkReady = false;
  private toastPayload: ToastPayload | null = null;
  private toastReady = false;
  private overlayPayload: OverlayPayload | null = null;
  private overlayReady = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private panelReady = false;
  private panelHeight = 560;
  private panelAnchor: Rectangle | null = null;
  private panelHiddenAt = 0;
  /** The settings window opened or closed (the Dock icon shows only while it's open). */
  onMain: ((open: boolean) => void) | null = null;
  /** Title for the main window: "Lock In", or "Lock In Settings" when the panel is the app. */
  mainTitle = 'Lock In';

  constructor(private log: (m: string) => void) {}

  createVoice(): BrowserWindow {
    if (this.voice && !this.voice.isDestroyed()) return this.voice;
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: webPreferences() });
    secure(win);
    void win.loadFile(rendererPage('voice'));
    win.on('closed', () => (this.voice = null));
    this.voice = win;
    return win;
  }

  openMain(route?: string): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) {
      if (route) this.main.webContents.send('nav', route);
      this.main.show();
      this.main.focus();
      return this.main;
    }
    const win = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 820,
      minHeight: 600,
      show: false,
      title: this.mainTitle,
      backgroundColor: '#0c0c0c',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: webPreferences(),
    });
    secure(win);
    // Keep "Lock In Settings" (the page's own <title> would replace it).
    win.on('page-title-updated', (e) => e.preventDefault());
    void win.loadFile(rendererPage('app'), route ? { hash: route } : undefined);
    win.once('ready-to-show', () => win.show());
    win.on('focus', () => app.dock?.setBadge(''));
    win.on('closed', () => {
      this.main = null;
      this.onMain?.(false);
    });
    this.main = win;
    this.onMain?.(true);
    return win;
  }

  // ---- menu bar panel ------------------------------------------------------------

  get panelVisible(): boolean {
    return !!this.panel && !this.panel.isDestroyed() && this.panel.isVisible();
  }

  /** A click on the menu bar icon: open the panel under it, or close it. */
  togglePanel(anchor?: Rectangle): void {
    if (this.panelVisible) {
      this.hidePanel();
      return;
    }
    // Clicking the icon while the panel is open blurs it first (which closes it): don't reopen it at once.
    if (Date.now() - this.panelHiddenAt < 300) return;
    this.showPanel(anchor);
  }

  showPanel(anchor?: Rectangle): void {
    if (anchor && anchor.width > 0) this.panelAnchor = anchor;
    const win = this.ensurePanel();
    this.positionPanel(win);
    if (this.panelReady) {
      win.webContents.send('panel:shown');
      win.show();
      win.focus();
    }
  }

  hidePanel(): void {
    if (!this.panel || this.panel.isDestroyed() || !this.panel.isVisible()) return;
    this.panel.hide();
    this.panelHiddenAt = Date.now();
  }

  /** The page measured its card: fit the window to it. */
  resizePanel(height: number): void {
    this.panelHeight = Math.round(height);
    if (this.panel && !this.panel.isDestroyed()) this.positionPanel(this.panel);
  }

  sendPanel(channel: string, payload: unknown): void {
    if (this.panel && !this.panel.isDestroyed() && this.panelReady) this.panel.webContents.send(channel, payload);
  }

  private positionPanel(win: BrowserWindow): void {
    const a = this.panelAnchor;
    const display = a ? screen.getDisplayMatching(a) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    // A small panel: past this it scrolls (and never taller than the screen).
    const height = Math.max(240, Math.min(this.panelHeight + PANEL_MARGIN * 2, PANEL_MAX_H, wa.height - 8));
    // Centered under the icon, kept on screen; without an icon, the top right corner.
    const centre = a ? a.x + a.width / 2 : wa.x + wa.width - PANEL_W / 2 - 8;
    const x = Math.round(Math.min(wa.x + wa.width - PANEL_W, Math.max(wa.x, centre - PANEL_W / 2)));
    win.setBounds({ x, y: wa.y + 2, width: PANEL_W, height });
  }

  private ensurePanel(): BrowserWindow {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    this.panelReady = false;
    const win = new BrowserWindow({
      width: PANEL_W,
      height: this.panelHeight + PANEL_MARGIN * 2,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Lock In',
      webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    secure(win);
    // Like a menu: a click anywhere else closes it.
    win.on('blur', () => this.hidePanel());
    win.webContents.once('did-finish-load', () => {
      this.panelReady = true;
      this.positionPanel(win);
      win.webContents.send('panel:shown');
      win.show();
      win.focus();
    });
    void win.loadFile(rendererPage('panel'));
    win.on('closed', () => {
      this.panel = null;
      this.panelReady = false;
    });
    this.panel = win;
    return win;
  }

  sendMain(channel: string, payload: unknown): void {
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send(channel, payload);
  }

  // ---- toast -----------------------------------------------------------------

  /** Told when a corner card appears, times out, is closed or is covered by the next one (Lock In learns from it). */
  onToast: ((p: ToastPayload, ev: 'shown' | 'timer' | 'closed' | 'replaced') => void) | null = null;

  /** The corner card showing now, if any. */
  currentToast(): ToastPayload | null {
    return this.toastPayload;
  }

  showToast(p: ToastPayload): void {
    if (this.toastPayload && this.toastPayload !== p) this.onToast?.(this.toastPayload, 'replaced');
    this.toastPayload = p;
    this.onToast?.(p, 'shown');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = p.autoHideMs
      ? setTimeout(() => {
          if (this.toastPayload === p) this.onToast?.(p, 'timer');
          this.hideToast(p.kind);
        }, p.autoHideMs)
      : null;
    const win = this.ensureToast();
    this.positionToast(win, 200);
    if (this.toastReady) {
      win.webContents.send('toast:show', p);
      win.showInactive();
    }
  }

  /** The close button on the corner card. */
  closeToast(): void {
    if (this.toastPayload) this.onToast?.(this.toastPayload, 'closed');
    this.hideToast();
  }

  hideToast(kind?: ToastPayload['kind']): void {
    if (kind && this.toastPayload && this.toastPayload.kind !== kind) return;
    this.toastPayload = null;
    if (this.toast && !this.toast.isDestroyed()) this.toast.hide();
  }

  resizeToast(height: number): void {
    if (!this.toast || this.toast.isDestroyed()) return;
    this.positionToast(this.toast, Math.min(520, Math.max(120, Math.round(height))));
  }

  private ensureToast(): BrowserWindow {
    if (this.toast && !this.toast.isDestroyed()) return this.toast;
    this.toastReady = false;
    const win = new BrowserWindow({
      width: TOAST_W,
      height: 200,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    secure(win);
    win.webContents.once('did-finish-load', () => {
      this.toastReady = true;
      if (this.toastPayload) {
        win.webContents.send('toast:show', this.toastPayload);
        win.showInactive();
      }
    });
    void win.loadFile(rendererPage('toast'));
    win.on('closed', () => {
      this.toast = null;
      this.toastReady = false;
    });
    this.toast = win;
    return win;
  }

  private positionToast(win: BrowserWindow, height: number): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    win.setBounds({ x: wa.x + wa.width - TOAST_W - 16, y: wa.y + 16, width: TOAST_W, height });
  }

  // ---- overlay ---------------------------------------------------------------

  showOverlay(p: OverlayPayload): void {
    this.overlayPayload = p;
    const win = this.ensureOverlay();
    if (this.overlayReady) {
      win.webContents.send('overlay:show', p);
      this.revealOverlay(win);
    }
  }

  updateOverlay(p: Partial<OverlayPayload>): void {
    if (!this.overlayPayload) return;
    this.overlayPayload = { ...this.overlayPayload, ...p };
    if (this.overlay && !this.overlay.isDestroyed() && this.overlayReady) this.overlay.webContents.send('overlay:update', p);
  }

  hideOverlay(): void {
    this.overlayPayload = null;
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.webContents.send('overlay:hide');
      this.overlay.hide();
    }
  }

  get overlayVisible(): boolean {
    return !!this.overlayPayload;
  }

  private revealOverlay(win: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(display.bounds);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
  }

  private ensureOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    this.overlayReady = false;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: webPreferences(),
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    secure(win);
    win.webContents.once('did-finish-load', () => {
      this.overlayReady = true;
      if (this.overlayPayload) {
        win.webContents.send('overlay:show', this.overlayPayload);
        this.revealOverlay(win);
      }
    });
    void win.loadFile(rendererPage('overlay'));
    win.on('closed', () => {
      this.overlay = null;
      this.overlayReady = false;
    });
    this.overlay = win;
    return win;
  }

  // ---- talk panel (live conversation) -------------------------------------------

  showTalk(p: unknown): void {
    this.talkPayload = p;
    this.hideToast();
    const win = this.ensureTalk();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    win.setBounds({ x: wa.x + wa.width - TALK_W - 16, y: wa.y + 12, width: TALK_W, height: Math.min(TALK_H, wa.height - 24) });
    if (this.talkReady) {
      win.webContents.send('talk:start', p);
      this.revealTalk(win, p);
    }
  }

  private revealTalk(win: BrowserWindow, p: unknown): void {
    if ((p as { focus?: boolean }).focus === false) win.showInactive();
    else {
      win.show();
      win.focus();
    }
  }

  sendTalk(e: unknown): void {
    if (this.talk && !this.talk.isDestroyed() && this.talkReady) this.talk.webContents.send('talk:event', e);
  }

  /** Closing destroys the window, so the microphone and audio are fully released. */
  hideTalk(): void {
    this.talkPayload = null;
    if (this.talk && !this.talk.isDestroyed()) this.talk.destroy();
    this.talk = null;
    this.talkReady = false;
  }

  get talkVisible(): boolean {
    return !!this.talkPayload;
  }

  private ensureTalk(): BrowserWindow {
    if (this.talk && !this.talk.isDestroyed()) return this.talk;
    this.talkReady = false;
    const win = new BrowserWindow({
      show: false,
      width: TALK_W,
      height: TALK_H,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Talk to Lock In',
      webPreferences: { ...webPreferences(), autoplayPolicy: 'no-user-gesture-required' },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    secure(win);
    win.webContents.once('did-finish-load', () => {
      this.talkReady = true;
      if (this.talkPayload) {
        win.webContents.send('talk:start', this.talkPayload);
        this.revealTalk(win, this.talkPayload);
      }
    });
    void win.loadFile(rendererPage('talk'));
    win.on('closed', () => {
      if (this.talk === win) {
        this.talk = null;
        this.talkReady = false;
      }
    });
    this.talk = win;
    return win;
  }

  destroyAll(): void {
    for (const w of [this.main, this.panel, this.toast, this.overlay, this.voice, this.talk]) if (w && !w.isDestroyed()) w.destroy();
  }
}
