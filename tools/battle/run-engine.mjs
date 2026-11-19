import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const suffix = process.platform === 'win32' ? '.exe' : '';
const native = fileURLToPath(new URL('../../tmp/battle-build/bin/pocket-lab' + suffix, import.meta.url));
const binary = process.env.PTCGP_BATTLE_ENGINE ||
  (existsSync(native) ? native : fileURLToPath(new URL('../../tmp/battle-build/bin/pocket-lab.wasm', import.meta.url)));
if (!existsSync(binary)) {
  console.error('Build the local engine with node tools/battle/build.mjs');
  process.exit(1);
}
if (binary.endsWith('.wasm')) {
  const { WASI } = await import('node:wasi');
  const wasi = new WASI({version:'preview1',args:[],env:{},preopens:{},returnOnExit:true});
  const { instance } = await WebAssembly.instantiate(readFileSync(binary), wasi.getImportObject());
  process.exitCode = wasi.start(instance);
} else {
  const child = spawn(binary, [], {stdio: 'inherit', windowsHide: true});
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', error => {console.error(error.message); process.exitCode = 1;});
  child.on('exit', (code, signal) => {process.exitCode = code ?? (signal ? 1 : 0);});
}
