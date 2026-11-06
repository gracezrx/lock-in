// Exposes a small, allow-listed IPC surface to the renderer pages as window.lockin.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

const INVOKE = new Set([
  'state:get', 'profile:get', 'profile:save', 'quiz:installedApps', 'settings:get', 'settings:save', 'keys:save',
  'session:start', 'session:startQuick', 'session:end', 'dashboard:get', 'labels:list', 'labels:set', 'labels:current',
  'coach:choose', 'coach:reply', 'coach:talk', 'coach:preview', 'coach:dismissPreview', 'voice:test', 'mute', 'unmute',
  'setup:status', 'setup:promptAccessibility', 'setup:askMic', 'setup:openExtensionFolder', 'setup:browsers', 'setup:addExtension', 'setup:openUrl', 'setup:log',
  'data:export', 'data:delete',
  'action:run', 'todos:get', 'todos:refresh', 'todos:complete', 'todos:add', 'todos:remove', 'todos:roastTest',
  'routines:get', 'routines:save', 'routines:test', 'notify:test', 'sound:test',
  'quiz:apps', 'todos:sheetPreview', 'todos:pickSheetFile', 'todos:connectorScript', 'clipboard:write', 'todos:undo',
  'todos:hide', 'todos:unhide', 'app:loginItem',
  'talk:open', 'talk:tool', 'talk:text', 'talk:closed', 'talk:transcript', 'talk:status',
  'deadlines:get', 'deadlines:add', 'deadlines:update', 'deadlines:done', 'deadlines:remove', 'deadlines:fromTask', 'week:get', 'voices:list', 'voices:search', 'voices:preview', 'voices:stop', 'voices:use', 'calendar:mac', 'intro:claim', 'crew:get', 'crew:create', 'crew:join', 'crew:leave', 'crew:bomb', 'crew:settings', 'data:where', 'data:openFolder', 'data:restore',
  'calendar:get', 'calendar:test', 'calendar:refresh', 'export:now', 'export:open', 'export:chooseFolder', 'export:status',
  'coaches:list', 'coaches:get', 'coaches:create', 'coaches:update', 'coaches:remove', 'coaches:addFiles', 'coaches:addText', 'coaches:removeSource',
  'coaches:pickSpeaker', 'coaches:retry', 'coaches:distill', 'coaches:setLines', 'coaches:use', 'coaches:hear', 'coaches:clipPlan', 'coaches:audio',
  'coaches:clone', 'coaches:deleteVoice',
  'phone:status', 'phone:enable', 'phone:pair', 'phone:cancelPair', 'phone:remove',
  'panel:data', 'panel:hide', 'panel:resize', 'panel:open', 'panel:show', 'panel:peek', 'app:quit',
  'goals:get', 'goals:add', 'goals:update', 'goals:remove', 'goals:check', 'goals:water', 'goals:later', 'goals:never', 'goals:settings', 'goals:ideas', 'goals:accept', 'goals:answer', 'attention:get', 'attention:set', 'attention:reset',
]);
const SEND = new Set(['toast:resize', 'toast:close', 'voice:ended', 'voice:recorded']);
const ON = new Set(['state', 'nav', 'panel:shown', 'crew:update', 'coaches:update', 'phone:update', 'talk:start', 'talk:event', 'toast:show', 'overlay:show', 'overlay:update', 'overlay:hide', 'voice:play', 'voice:stop', 'voice:listen', 'voice:stopListening', 'voice:sound']);

const api = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  send(channel: string, ...args: unknown[]): void {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(channel: string, cb: (...args: unknown[]) => void): () => void {
    if (!ON.has(channel)) return () => undefined;
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform,
  /** Where a dropped file lives, so it can be added by path. */
  pathFor(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('lockin', api);

export type LockinApi = typeof api;
