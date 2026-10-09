// Fixture: tiny node:http server for the Bun preload harness (`bun server.ts`). GET /work calls into src/.
import { createServer } from 'node:http';
import { work } from './src/util.ts';

const port = Number(process.env.PORT ?? 4173);
const server = createServer((req, res) => {
  if (req.url?.startsWith('/work')) res.end(String(work(5)));
  else if (req.url === '/quit') {
    res.end('bye');
    server.close();
  } else res.end('ok');
});
server.listen(port, '127.0.0.1');
