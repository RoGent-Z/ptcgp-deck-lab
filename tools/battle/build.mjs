import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wasi = process.argv.includes('--wasi') || (process.platform === 'win32' && !process.argv.includes('--native'));
const scratch = join(root, 'tmp', 'battle-build');
const anchor = join(root, 'engine');
const archive = join(anchor, 'deckgym-source.tgz');
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (hash !== '1de0d38c441e4360b7b9f215057fa1eb70a3facd22de50bef0011cbca4391ed6') throw Error('DeckGym source archive checksum mismatch');
// MinGW's linker cannot open its output under some non-ASCII Windows paths.
const buildRoot = process.platform === 'win32' ? join(tmpdir(), 'pocket-lab-native-' + hash.slice(0, 10)) : scratch;
const source = join(buildRoot, 'source');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = 'pocket-lab' + (wasi ? '.wasm' : (process.platform === 'win32' ? '.exe' : ''));
const output = join(scratch, 'bin', file);
function writeManifest() {
  const bridge = join(source,'src/pocket_lab.rs');
  const cli = join(source,'src/bin/pocket-lab.rs');
  if (statSync(output).mtimeMs < Math.max(statSync(bridge).mtimeMs,statSync(cli).mtimeMs) - 2000) {
    throw Error('Compiled program predates its scratch sources');
  }
  const manifest = {filename:file,sha256:digest(output),sourceArchiveSha256:hash,
    bridgeSha256:digest(bridge),cliSha256:digest(cli),target:wasi?'wasm32-wasip1':process.platform+'-'+process.arch};
  if (manifest.bridgeSha256 !== digest(join(anchor,'pocket_lab.rs')) ||
      manifest.cliSha256 !== digest(join(anchor,'pocket_lab_cli.rs'))) throw Error('The source has changed since the build');
  writeFileSync(join(scratch,'bin/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}
if (process.argv.includes('--manifest-only')) {
  writeManifest();
  process.exit(0);
}
mkdirSync(source, { recursive: true });
const spawn = (name, args, opts = {}) => {
  const result = spawnSync(name, args, { stdio: 'inherit', ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
spawn('tar', ['-xzf', archive, '-C', source]);
// The distribution contains the library and its complete compiled dependencies. Remove
// explicit benchmark/example targets from the scratch manifest before compiling the CLI.
const manifest = join(source, 'Cargo.toml');
const original = readFileSync(manifest, 'utf8');
writeFileSync(manifest, original.split('[[bench]]')[0]);
const lib = join(source, 'src/lib.rs');
writeFileSync(lib, readFileSync(lib, 'utf8') + '\npub mod pocket_lab;\n');
copyFileSync(join(anchor, 'pocket_lab.rs'), join(source, 'src/pocket_lab.rs'));
copyFileSync(join(anchor, 'pocket_lab_cli.rs'), join(source, 'src/bin/pocket-lab.rs'));
const env = { ...process.env };
const localRust = join(tmpdir(), 'ptcgp-wasm-20261119');
let cargo = 'cargo';
if (!env.CARGO_HOME && existsSync(join(localRust, 'cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = join(localRust, 'cargo');
  env.RUSTUP_HOME = join(localRust, 'rustup');
  const gnuBin = join(env.RUSTUP_HOME, 'toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained');
  env.PATH = [join(env.CARGO_HOME, 'bin'), gnuBin, env.PATH].join(delimiter);
  cargo = join(env.CARGO_HOME, 'bin/cargo.exe');
}
env.CARGO_TARGET_DIR = resolve(env.CARGO_TARGET_DIR || (wasi && existsSync(join(localRust, 'target')) ? join(localRust, 'target') : join(buildRoot, 'target')));
spawn(cargo, ['rustc','--locked','--release', ...(wasi ? ['--target','wasm32-wasip1'] : []),'--bin','pocket-lab','--',
  ...(wasi ? ['-C','link-arg=-zstack-size=33554432'] : []),
  ...(!wasi && process.platform === 'win32' && (env.RUSTUP_HOME === join(localRust, 'rustup') || env.POCKET_GNU === '1')
    ? ['-C', 'link-arg=-Wl,--stack,33554432'] : [])], { cwd: source, env });
mkdirSync(join(scratch, 'bin'), { recursive: true });
copyFileSync(join(env.CARGO_TARGET_DIR, wasi ? 'wasm32-wasip1' : '', 'release', file), join(scratch, 'bin', file));
writeManifest();
console.error('Local battle engine ready: ' + join(scratch, 'bin', file));
