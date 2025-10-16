// main.js
import { bootstrap } from './ui.js';

bootstrap().catch(err => {
  console.error('Failed to start app:', err);
  alert('Failed to start app: ' + (err?.message || err));
});
