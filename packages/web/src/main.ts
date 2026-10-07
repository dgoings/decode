import './style.css';
import { startApp } from './app.ts';
import { pickDataSource } from './data.ts';

const root = document.getElementById('app')!;
pickDataSource()
  .then((source) => startApp(root, source))
  .catch((err: unknown) => {
    root.textContent = `codeviz failed to start: ${(err as Error).message}`;
  });
