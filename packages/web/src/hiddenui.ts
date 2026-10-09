// Right-click "Hide <file>" menu and the "N hidden" chip + popover for the summary bars.
import { hiddenEntry, type HiddenStore, type HideTarget } from './hidden.ts';

export interface HiddenUI {
  /** Open the context menu for a file or folder at viewport coordinates. */
  openMenu(target: HideTarget, x: number, y: number): void;
  /** A fresh "N hidden" chip for a summary bar (hidden when nothing is hidden). */
  chip(): HTMLElement;
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

function place(el: HTMLElement, x: number, y: number): void {
  el.style.left = '0px';
  el.style.top = '0px';
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
}

export function createHiddenUI(store: HiddenStore): HiddenUI {
  const menu = document.createElement('div');
  menu.className = 'ctxmenu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const pop = document.createElement('div');
  pop.className = 'hidden-pop';
  pop.hidden = true;
  document.body.append(menu, pop);

  const closeAll = () => {
    menu.hidden = true;
    pop.hidden = true;
  };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!menu.contains(t)) menu.hidden = true;
    if (!pop.contains(t) && !(t instanceof Element && t.closest('.hidden-chip'))) pop.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
  window.addEventListener('blur', closeAll);

  function renderPop(): void {
    const paths = store.list();
    if (!paths.length) {
      pop.hidden = true;
      return;
    }
    const ul = document.createElement('ul');
    for (const p of paths) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p;
      name.title = p;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Unhide';
      b.dataset.path = p;
      b.addEventListener('click', () => store.remove(p));
      li.append(name, b);
      ul.append(li);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn hidden-clear';
    clear.textContent = 'Clear all';
    clear.addEventListener('click', () => store.clear());
    const h = document.createElement('div');
    h.className = 'hidden-pop-head';
    h.textContent = 'Hidden from the analysis';
    pop.replaceChildren(h, ul, clear);
  }
  store.onChange(() => {
    if (!pop.hidden) renderPop();
  });

  return {
    openMenu(target, x, y) {
      pop.hidden = true;
      const entry = hiddenEntry(target);
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = `Hide ${basename(target.path)}${target.kind === 'dir' ? '/' : ''}`;
      item.title = entry;
      item.addEventListener('click', () => {
        menu.hidden = true;
        store.add(entry);
      });
      menu.replaceChildren(item);
      place(menu, x, y);
      item.focus();
    },
    chip() {
      const n = store.list().length;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hidden-chip';
      b.textContent = `${n} hidden`;
      b.hidden = n === 0;
      b.title = 'Files and folders hidden from the analysis';
      b.addEventListener('click', () => {
        if (!pop.hidden) {
          pop.hidden = true;
          return;
        }
        renderPop();
        const r = b.getBoundingClientRect();
        place(pop, r.left, r.bottom + 4);
      });
      return b;
    },
  };
}
