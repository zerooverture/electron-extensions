import { webContents } from 'electron';
import extendElectronWebRequest from '../utils/web-request';

const requestIsFromBackgroundPage = (details: any): boolean => {
  const { webContentsId } = details;

  if (webContentsId) {
    const wc = webContents.fromId(webContentsId);

    if (wc) {
      return wc.getURL().startsWith('chrome-extension://');
    }

    return false;
  }

  return false;
};

export const hookExtensionWebRequestBypass = (session: Electron.Session) => {
  extendElectronWebRequest(session);

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (requestIsFromBackgroundPage(details)) {
      return callback({
        requestHeaders: {
          ...details.requestHeaders,
          Origin: null,
        },
      });
    }

    callback({ requestHeaders: details.requestHeaders });
  });

  session.webRequest.onHeadersReceived((details, callback) => {
    for (const key in details.responseHeaders) {
      const val = details.responseHeaders[key];
      delete details.responseHeaders[key];
      details.responseHeaders[key.toLowerCase()] = val;
    }

    const accessControlAllowOrigin =
      details.responseHeaders['access-control-allow-origin'] || [];
    const allowedOriginIsWildcard = accessControlAllowOrigin.includes('*');

    details.responseHeaders['access-control-allow-credentials'] = ['true'];

    if (requestIsFromBackgroundPage(details) || allowedOriginIsWildcard) {
      details.responseHeaders['access-control-allow-headers'] = ['*'];
      details.responseHeaders['access-control-allow-origin'] = ['*'];
    }

    callback({ responseHeaders: details.responseHeaders });
  });
};
