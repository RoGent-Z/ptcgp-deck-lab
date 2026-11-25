// 统一 1.65px 线性图标集（不引入 emoji 作为界面图标）
const paths = {
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  catalog: '<rect x="3" y="4" width="7" height="9" rx="1.5"/><rect x="14" y="4" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="18" height="4" rx="1.5"/>',
  decks: '<rect x="4" y="5" width="11" height="15" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v13"/>',
  meta: '<path d="M4 19V11"/><path d="M10 19V5"/><path d="M16 19v-8"/><path d="M22 19V8"/>',
  battle: '<path d="M14.5 4.5l5 5L8 21H3v-5L14.5 4.5z"/><path d="M12 7l5 5"/>',
  crown: '<path d="M3 18h18l-1.5-10-4.5 4-3-6-3 6-4.5-4L3 18z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  alert: '<path d="M12 4L3 19h18L12 4z"/><path d="M12 10v4"/><circle cx="12" cy="16.8" r=".6" fill="currentColor"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 16V5"/><path d="M7.5 9.5L12 5l4.5 4.5"/><path d="M4 20h16"/>',
  play: '<polygon points="7,5 19,12 7,19" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><line x1="4" y1="12" x2="20" y2="12"/>',
  camera: '<path d="M4 8a2 2 0 0 1 2-2h2.2l1.4-2h4.8l1.4 2H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="13" r="3.5"/>'
};

export function icon(name, size = 18) {
  const body = paths[name] || '';
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
