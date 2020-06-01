import { WebContents, webContents } from 'electron';
import { promises, existsSync } from 'fs';
import { resolve, join } from 'path';
import { format } from 'url';
import { IpcExtension } from '../models/ipc-extension';
import { ExtensibleSession, storages } from '../main';
import { getPath } from './paths';
import { StorageArea } from '../models/storage-area';
import { PROTOCOL } from '../constants';

export const manifestToExtensionInfo = (manifest: chrome.runtime.Manifest) => {
  return {
    startPage: format({
      protocol: PROTOCOL,
      slashes: true,
      hostname: manifest.extensionId,
      pathname: manifest.devtools_page,
    }),
    srcDirectory: manifest.srcDirectory,
    name: manifest.name,
    exposeExperimentalAPIs: true,
  };
};

export const getIpcExtension = (extension: IpcExtension): IpcExtension => {
  const ipcExtension: IpcExtension = { ...extension };

  delete ipcExtension.backgroundPage;

  return ipcExtension;
};

export const startBackgroundPage = async (
  { background, srcDirectory, extensionId }: chrome.runtime.Manifest,
  preload: string,
  partition: string,
) => {
  if (background) {
    const { page, scripts } = background;

    let html = Buffer.from('');
    let fileName: string;

    if (page) {
      fileName = page;
      html = await promises.readFile(resolve(srcDirectory, page));
    } else if (scripts) {
      fileName = 'generated.html';
      html = Buffer.from(
        `<html>
          <body>${scripts
            .map(script => `<script src="${script}"></script>`)
            .join('')}
          </body>
        </html>`,
        'utf8',
      );
    }

    const contents: WebContents = (webContents as any).create({
      partition,
      preload,
      type: 'backgroundPage',
      commandLineSwitches: ['--background-page'],
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    } as Electron.BrowserWindowConstructorOptions);

    contents.loadURL(
      format({
        protocol: PROTOCOL,
        slashes: true,
        hostname: extensionId,
        pathname: fileName,
      }),
    );

    return {
      html,
      fileName,
      webContents: contents,
    };
  }
  return null;
};

export const sendToBackgroundPages = (
  ses: ExtensibleSession,
  msg: string,
  ...args: any[]
) => {
  for (const key in ses.extensions) {
    if (!ses.extensions[key].backgroundPage) return;
    const { webContents } = ses.extensions[key].backgroundPage;
    if (!webContents.isDestroyed()) {
      webContents.send(msg, ...args);
    }
  }
};

const loadStorages = (manifest: chrome.runtime.Manifest) => {
  const storagePath = getPath('storage/extensions', manifest.extensionId);
  const local = new StorageArea(resolve(storagePath, 'local'));
  const sync = new StorageArea(resolve(storagePath, 'sync'));
  const managed = new StorageArea(resolve(storagePath, 'managed'));

  return { local, sync, managed };
};

const loadI18n = async (manifest: chrome.runtime.Manifest) => {
  if (typeof manifest.default_locale === 'string') {
    const defaultLocalePath = resolve(
      manifest.srcDirectory,
      '_locales',
      manifest.default_locale,
    );

    if (!existsSync(defaultLocalePath)) return;

    const messagesPath = resolve(defaultLocalePath, 'messages.json');
    const stats = await promises.stat(messagesPath);

    if (!existsSync(messagesPath) || stats.isDirectory()) return;

    let buf = await promises.readFile(messagesPath);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      buf = buf.slice(3);
    }
    const locale = JSON.parse(buf.toString('utf8'));

    return locale;
  }
};

export const loadExtension = async (manifest: chrome.runtime.Manifest) => {
  const extension: IpcExtension = {
    manifest,
    alarms: [],
    locale: await loadI18n(manifest),
    id: manifest.extensionId,
    path: manifest.srcDirectory,
    popupPage: manifest?.browser_action?.default_popup
      ? format({
          protocol: PROTOCOL,
          slashes: true,
          hostname: manifest.extensionId,
          pathname: manifest.browser_action.default_popup,
        })
      : null,
  };

  if (manifest.content_scripts) {
    const readArrayOfFiles = async (relativePath: string) => ({
      url: `${PROTOCOL}://${manifest.extensionId}/${relativePath}`,
      code: await promises.readFile(
        join(manifest.srcDirectory, relativePath),
        'utf8',
      ),
    });

    try {
      const contentScripts = await Promise.all(
        manifest.content_scripts.map(async script => ({
          matches: script.matches,
          js: script.js
            ? await Promise.all(script.js.map(readArrayOfFiles))
            : [],
          css: script.css
            ? await Promise.all(script.css.map(readArrayOfFiles))
            : [],
          runAt: script.run_at || 'document_idle',
        })),
      );

      extension.contentScripts = contentScripts;
    } catch (readError) {
      console.error('Failed to read content scripts', readError);
    }
  }

  if (!storages.get(manifest.extensionId)) {
    storages.set(manifest.extensionId, loadStorages(manifest));
  }

  return extension;
};

export const loadDevToolsExtensions = (
  webContents: WebContents,
  manifests: chrome.runtime.Manifest[],
) => {
  if (!webContents.devToolsWebContents) return;

  const extensionInfoArray = manifests.map(manifestToExtensionInfo);
  extensionInfoArray.forEach(extension => {
    if (!extension.startPage) return;
    (webContents.devToolsWebContents as any)._grantOriginAccess(
      extension.startPage,
    );
  });

  /*webContents.devToolsWebContents.executeJavaScript(
    `InspectorFrontendAPI.addExtensions(${JSON.stringify(extensionInfoArray)})`,
  );*/
};

export const extensionsToManifests = (extensions: {
  [key: string]: IpcExtension;
}) => Object.values(extensions).map(item => item.manifest);
