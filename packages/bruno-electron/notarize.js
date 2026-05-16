require('dotenv').config({ path: process.env.DOTENV_PATH });
const fs = require('fs');
const path = require('path');
const electron_notarize = require('electron-notarize');

const notarize = async function (params) {
  if (process.platform !== 'darwin') {
    return;
  }

  let appId = 'com.vasl.gridman';

  let appPath = path.join(params.appOutDir, `${params.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`Cannot find application at: ${appPath}`);
    return;
  }

  if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD) {
    console.log(`Skipping notarization for ${appId}; Apple ID credentials are not configured.`);
    return;
  }

  console.log(`Notarizing ${appId} found at ${appPath} using Apple ID ${process.env.APPLE_ID}`);

  try {
    await electron_notarize.notarize({
      appBundleId: appId,
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      ascProvider: process.env.APPLE_ASC_PROVIDER
    });
  } catch (error) {
    console.error(error);
  }

  console.log(`Done notarizing ${appId}`);
};

module.exports = notarize;
