import { instantiateBattle } from './runtime.mjs';

let engine = null;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'init') {
      if (msg.module) {
        engine = await instantiateBattle(msg.module);
      } else if (msg.wasmUrl) {
        const res = await fetch(msg.wasmUrl);
        if (!res.ok) throw Error(`WASM fetch failed: ${res.status}`);
        engine = await instantiateBattle(await res.arrayBuffer());
      } else if (msg.bytes) {
        engine = await instantiateBattle(msg.bytes);
      } else {
        throw Error('Missing wasm module/bytes/url');
      }
      self.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.type === 'run') {
      if (!engine) throw Error('DeckGym worker engine not initialized');
      const result = engine(msg.request);
      self.postMessage({ id: msg.id, ok: true, result });
      return;
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err?.message || String(err) });
  }
};
