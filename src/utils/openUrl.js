import { spawn } from 'child_process';

// Opens an http(s) URL in the system browser without going through a shell.
// On Windows this uses url.dll rather than `cmd /c start`, because cmd would
// treat `&` in a query string (common in checkout/portal links) as a command
// separator. Returns false when the URL is refused or no opener could be
// spawned, so the caller can print the link for the user to open by hand.
export function openUrl(url, spawnImpl = spawn) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const href = parsed.href;
  try {
    const [cmd, args] =
      process.platform === 'win32'  ? ['rundll32', ['url.dll,FileProtocolHandler', href]] :
      process.platform === 'darwin' ? ['open', [href]] :
                                      ['xdg-open', [href]];
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
