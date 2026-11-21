const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleCache = new WeakMap();

function toByteView(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw TypeError('instantiateBattle expects ArrayBuffer or TypedArray bytes');
}

function getCryptoRandom(target) {
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(target);
    return;
  }
  for (let i = 0; i < target.length; i++) {
    target[i] = (Math.random() * 256) | 0;
  }
}

function createWasiImports(getMemory) {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);

  return {
    wasi_snapshot_preview1: {
      random_get(buf, len) {
        getCryptoRandom(new Uint8Array(getMemory().buffer, buf, len));
        return 0;
      },
      clock_time_get(_id, _precision, outPtr) {
        const nowNs = BigInt(Date.now()) * 1000000n;
        view().setBigUint64(outPtr, nowNs, true);
        return 0;
      },
      environ_sizes_get(countPtr, sizePtr) {
        const v = view();
        v.setUint32(countPtr, 0, true);
        v.setUint32(sizePtr, 0, true);
        return 0;
      },
      environ_get() {
        return 0;
      },
      fd_close() {
        return 0;
      },
      fd_fdstat_get(_fd, statPtr) {
        const v = view();
        v.setUint8(statPtr, 2); // FILETYPE_CHARACTER_DEVICE
        v.setUint16(statPtr + 2, 0, true);
        v.setBigUint64(statPtr + 8, 0n, true);
        v.setBigUint64(statPtr + 16, 0n, true);
        return 0;
      },
      fd_prestat_get() {
        return 8; // EBADF
      },
      fd_prestat_dir_name() {
        return 8; // EBADF
      },
      fd_read(_fd, _iovs, _iovsLen, nreadPtr) {
        view().setUint32(nreadPtr, 0, true);
        return 0;
      },
      fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
        const v = view();
        const mem = bytes();
        let written = 0;
        let errText = '';
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          written += len;
          if (fd === 2 && len > 0) {
            errText += decoder.decode(mem.subarray(ptr, ptr + len));
          }
        }
        v.setUint32(nwrittenPtr, written, true);
        if (errText) {
          console.error('[deckgym]', errText.trimEnd());
        }
        return 0;
      },
      path_create_directory() {
        return 52; // ENOSYS
      },
      path_filestat_get() {
        return 52;
      },
      path_open() {
        return 52;
      },
      poll_oneoff() {
        return 52;
      },
      proc_exit(code) {
        throw Error(`DeckGym WASI exited with code ${code}`);
      }
    }
  };
}

async function compileModule(wasmSource) {
  if (wasmSource instanceof WebAssembly.Module) return wasmSource;
  if (typeof wasmSource === 'object' && wasmSource !== null && moduleCache.has(wasmSource)) {
    return moduleCache.get(wasmSource);
  }
  const mod = await WebAssembly.compile(toByteView(wasmSource));
  if (typeof wasmSource === 'object' && wasmSource !== null) {
    moduleCache.set(wasmSource, mod);
  }
  return mod;
}

export async function instantiateBattle(wasmSource) {
  const mod = await compileModule(wasmSource);
  let memory = null;
  const instance = await WebAssembly.instantiate(mod, createWasiImports(() => memory));
  const { memory: exportedMemory, lab_alloc, lab_run, lab_output_len } = instance.exports;
  if (!exportedMemory || !lab_alloc || !lab_run || !lab_output_len) {
    throw Error('deckgym.wasm 缺少 lab_alloc / lab_run / lab_output_len 匯出');
  }
  memory = exportedMemory;

  return function invokeEngine(request) {
    const payload = typeof request === 'string' ? request : JSON.stringify(request);
    const encoded = encoder.encode(payload);
    const inPtr = lab_alloc(encoded.length);
    new Uint8Array(memory.buffer, inPtr, encoded.length).set(encoded);
    const outPtr = lab_run(inPtr, encoded.length);
    const outLen = lab_output_len();
    const slice = new Uint8Array(memory.buffer, outPtr, outLen);
    return JSON.parse(decoder.decode(slice));
  };
}
