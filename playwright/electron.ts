const path = require('path');
const { _electron: electron } = require('playwright');

const electronAppPath = path.join(__dirname, '../packages/bruno-electron');

exports.startApp = async () => {
  const app = await electron.launch({
    args: [electronAppPath],
    // The other launch path (playwright/index.ts) sets these; without them here
    // the app has no idea it is under test, so it shows and focuses its window —
    // which on macOS drags the user out of whatever full-screen Space they are
    // in. Set GRIDMAN_E2E_SHOW_WINDOW=true to watch a run.
    env: {
      ...process.env,
      PLAYWRIGHT: 'true'
    }
  });
  const context = await app.context();

  app.process().stdout.on('data', (data) => {
    process.stdout.write(data.toString().replace(/^(?=.)/gm, '[Electron] |'));
  });
  app.process().stderr.on('data', (error) => {
    process.stderr.write(error.toString().replace(/^(?=.)/gm, '[Electron] |'));
  });
  return { app, context };
};
