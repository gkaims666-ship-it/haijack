// Запуск CLI без top-level await — этот файл служит точкой входа и для bin/lcc.js,
// и для бандла (Windows exe собирается в CommonJS, где top-level await недоступен).

import { main } from './index.js';

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  },
);
