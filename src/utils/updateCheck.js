import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function localPkg() {
  try { return require('../../package.json'); }
  catch { return { name: 'sennoric-cli', version: '0.0.0' }; }
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Looks up the published `latest` version of this package on npm and compares
// it against the locally installed version. Scoped names (e.g. @org/pkg) need
// their slash percent-encoded for the registry's single-package GET route.
export async function checkForUpdate() {
  const pkg = localPkg();
  const name = pkg.name || 'sennoric-cli';
  const current = pkg.version || '0.0.0';
  const result = { name, current, latest: null, updateAvailable: false };
  try {
    const path = name.replace('/', '%2f');
    const res = await fetch(`https://registry.npmjs.org/${path}/latest`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return result;
    const json = await res.json();
    if (json?.version) {
      result.latest = json.version;
      result.updateAvailable = cmpVer(json.version, current) > 0;
    }
  } catch {}
  return result;
}
