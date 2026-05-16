const fs = require('fs');
const path = require('path');

module.exports = function aboutGridman({ version }) {
  const currentYear = new Date().getFullYear();
  const iconPath = path.join(__dirname, '..', 'about', '256x256.png');
  const iconData = fs.readFileSync(iconPath).toString('base64');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, minimum-scale=1.0, initial-scale=1, user-scalable=yes">
        <title>About Gridman</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                text-align: center;
                margin: 0;
                padding: 16px;
                background-color: #f4f4f4;
                color: #333;
            }
            .logo {
                width: 96px;
                height: 96px;
                border-radius: 20px;
                margin-top: 6px;
            }
            .title {
                font-size: 24px;
                margin-top: 8px;
                margin-bottom: 0;
                font-weight: bold;
                color: #222;
            }
            .footer {
                margin-top: 10px;
                padding: 5px;
                font-size: 14px;
                color: #555;
            }
        </style>
    </head>
    <body>
      <img class="logo" src="data:image/png;base64,${iconData}" alt="Gridman" />
      <h2 class="title">Gridman ${version}</h2>
      <footer class="footer">
          ©${currentYear} Gridman
      </footer>
    </body>
    </html>
  `;
};
