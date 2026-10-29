'use strict';
const { app } = require('electron');
app.whenReady().then(async () => {
  const stream = require('../src/main/stream');
  for (const input of ['https://www.youtube.com/@LofiGirl/live', 'https://www.youtube.com/watch?v=0sfDth4lMLc']) {
    const t = Date.now();
    const result = await stream.resolveStream(input);
    console.log('RESULT', input, JSON.stringify(result), 'ms', Date.now() - t);
  }
  app.quit();
});
