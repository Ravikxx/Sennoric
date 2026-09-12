import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Write a temp .ps1 file to avoid inline escaping hell, then run it.
function runPowerShell(script, timeoutMs = 10000) {
  const scriptPath = join(tmpdir(), `sennoric-ps-${Date.now()}.ps1`);
  writeFileSync(scriptPath, `﻿${script}`, 'utf8'); // BOM = UTF-8, prevents encoding issues
  try {
    return execSync(
      `powershell -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: timeoutMs, encoding: 'utf8' }
    ).trim();
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

// C# helper loaded once per PowerShell process.
// SendInput with MOUSEEVENTF_ABSOLUTE is the modern, reliable API.
// Coordinates are normalised to 0-65535 as required for absolute mode.
// GetSystemMetrics(0/1) returns physical screen width/height — matches SendInput's coordinate space.
const SENNORIC_INPUT_CS = `
using System;
using System.Runtime.InteropServices;
public class SennoricInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int    dx, dy;
    public uint   mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint      type;
    public MOUSEINPUT mi;
  }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int sz);
  [DllImport("user32.dll")] public static extern int  GetSystemMetrics(int n);

  static int Norm(int v, int total) { return (int)((v * 65535.0) / total); }

  public static void Click(int x, int y, uint downFlag, uint upFlag) {
    int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
    int nx = Norm(x, sw), ny = Norm(y, sh);
    const uint ABS = 0x8000, MOVE = 0x0001;
    var inp = new INPUT[2];
    inp[0].type = 0; inp[0].mi.dwFlags = ABS | MOVE | downFlag; inp[0].mi.dx = nx; inp[0].mi.dy = ny;
    inp[1].type = 0; inp[1].mi.dwFlags = ABS | MOVE | upFlag;   inp[1].mi.dx = nx; inp[1].mi.dy = ny;
    SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Scroll(int x, int y, int delta) {
    int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
    int nx = Norm(x, sw), ny = Norm(y, sh);
    const uint ABS = 0x8000, MOVE = 0x0001, WHEEL = 0x0800;
    var inp = new INPUT[1];
    inp[0].type = 0;
    inp[0].mi.dwFlags     = ABS | MOVE | WHEEL;
    inp[0].mi.dx          = nx;
    inp[0].mi.dy          = ny;
    inp[0].mi.mouseData   = (uint)delta;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
}
`;

// ── Macro recording state ─────────────────────────────────────────────────────
// Mutable object so App.jsx and tools.js always share the same reference.
export const MACRO_STATE = { recording: false, name: null, steps: [] };

// ── Computer-use overlay (orange corner vignette) ─────────────────────────────
// A borderless, always-on-top, fully click-through WPF window with four radial
// orange gradients at the corners. Spawned when a computer use tool runs and
// killed when it finishes. WS_EX_TRANSPARENT makes it click-through at the OS level.

let _overlayProc   = null;
let _overlayScript = null;

// WinForms + UpdateLayeredWindow overlay. No WPF — avoids STA/maximize/transparency quirks.
// Uses GDI+ PathGradientBrush with premultiplied alpha for smooth per-pixel corner glow.
// Log file: %TEMP%\sennoric-overlay.log  — check this if the overlay doesn't appear.

const OVERLAY_SCRIPT = join(tmpdir(), 'sennoric-overlay.ps1');
const OVERLAY_LOG    = join(tmpdir(), 'sennoric-overlay.log');

// The "@ terminator MUST be at column 0 — do not indent it.
const OVERLAY_PS = `﻿Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class SennoricGlow : Form {
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref WP pptDst, ref WS psize, IntPtr hdcSrc, ref WP pptSrc, uint crKey, ref BF pblend, uint dwFlags);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [StructLayout(LayoutKind.Sequential)] public struct WP { public int x, y; public WP(int a, int b) { x=a; y=b; } }
  [StructLayout(LayoutKind.Sequential)] public struct WS { public int cx, cy; public WS(int a, int b) { cx=a; cy=b; } }
  [StructLayout(LayoutKind.Sequential)] public struct BF { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
  Rectangle sc;
  public SennoricGlow() {
    sc = Screen.PrimaryScreen.Bounds;
    FormBorderStyle = FormBorderStyle.None;
    Bounds = sc; TopMost = true; ShowInTaskbar = false;
  }
  protected override CreateParams CreateParams { get {
    var cp = base.CreateParams;
    cp.ExStyle |= 0x80000 | 0x20 | 0x8000000; // WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
    return cp;
  }}
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Render(); }
  void Render() {
    int W = sc.Width, H = sc.Height, S = Math.Min(W, H) / 3;
    using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        g.Clear(Color.FromArgb(0, 0, 0, 0));
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Glow(g, 0,     0,     S, false, false);
        Glow(g, W - S, 0,     S, true,  false);
        Glow(g, 0,     H - S, S, false, true);
        Glow(g, W - S, H - S, S, true,  true);
      }
      // Premultiply alpha — required by UpdateLayeredWindow with AC_SRC_ALPHA
      var bd = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      int len = Math.Abs(bd.Stride) * H;
      var px = new byte[len];
      Marshal.Copy(bd.Scan0, px, 0, len);
      for (int i = 0; i < len; i += 4) {
        byte a = px[i + 3];
        px[i]     = (byte)(px[i]     * a / 255);
        px[i + 1] = (byte)(px[i + 1] * a / 255);
        px[i + 2] = (byte)(px[i + 2] * a / 255);
      }
      Marshal.Copy(px, 0, bd.Scan0, len);
      bmp.UnlockBits(bd);
      IntPtr screenDC = GetDC(IntPtr.Zero);
      IntPtr memDC    = CreateCompatibleDC(screenDC);
      IntPtr hBmp     = bmp.GetHbitmap(Color.FromArgb(0));
      IntPtr oldBmp   = SelectObject(memDC, hBmp);
      var dst   = new WP(sc.Left, sc.Top);
      var sz    = new WS(W, H);
      var src   = new WP(0, 0);
      var blend = new BF { BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
      UpdateLayeredWindow(Handle, screenDC, ref dst, ref sz, memDC, ref src, 0, ref blend, 2);
      SelectObject(memDC, oldBmp); DeleteObject(hBmp); DeleteDC(memDC); ReleaseDC(IntPtr.Zero, screenDC);
    }
  }
  void Glow(Graphics g, int x, int y, int S, bool right, bool bottom) {
    float cx = right ? x + S : x, cy = bottom ? y + S : y;
    using (var path = new GraphicsPath()) {
      path.AddEllipse(cx - S, cy - S, S * 2, S * 2);
      using (var br = new PathGradientBrush(path)) {
        br.CenterPoint    = new PointF(cx, cy);
        br.CenterColor    = Color.FromArgb(185, 232, 103, 10);
        br.SurroundColors = new[] { Color.FromArgb(0, 232, 103, 10) };
        g.FillPath(br, path);
      }
    }
  }
  public static void ShowGlow() {
    Application.EnableVisualStyles();
    Application.Run(new SennoricGlow());
  }
}
"@
try { [SennoricGlow]::ShowGlow() } catch { $_ | Out-File "$env:TEMP\\sennoric-overlay.log" -Append }
`;

const PYTHON_OVERLAY = `
import sys, subprocess, os
try:
    import tkinter as tk
    from math import sqrt
except ImportError:
    sys.exit(0)

root = tk.Tk()
root.attributes('-fullscreen', True)
root.attributes('-topmost', True)
root.attributes('-alpha', 0.0)
root.overrideredirect(True)
root.configure(bg='black')
root.wm_attributes('-transparentcolor', 'black')

W = root.winfo_screenwidth()
H = root.winfo_screenheight()
S = min(W, H) // 3

canvas = tk.Canvas(root, width=W, height=H, bg='black', highlightthickness=0)
canvas.pack()

# Corner glow: gradient ellipse drawn with concentric ovals, fading out
COLOR = (232, 103, 10)  # amber

def glow(cx, cy):
    steps = 30
    for i in range(steps, 0, -1):
        r = S * i // steps
        alpha = int(185 * (i / steps) ** 2)
        hex_col = '#{:02x}{:02x}{:02x}'.format(
            min(255, int(COLOR[0] * alpha / 255)),
            min(255, int(COLOR[1] * alpha / 255)),
            min(255, int(COLOR[2] * alpha / 255)),
        )
        canvas.create_oval(cx - r, cy - r, cx + r, cy + r, fill=hex_col, outline='')

glow(0,   0)
glow(W,   0)
glow(0,   H)
glow(W,   H)

# Make click-through on Linux via xprop (best-effort)
def set_clickthrough():
    try:
        wid = hex(root.winfo_id())
        subprocess.run(['xprop', '-id', wid, '-f', '_NET_WM_WINDOW_TYPE', '32a',
                        '-set', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_SPLASH'],
                       capture_output=True, timeout=2)
    except Exception:
        pass

root.after(200, set_clickthrough)
root.mainloop()
`;

export function showOverlay() {
  if (_overlayProc) return;

  if (process.platform === 'win32') {
    try {
      writeFileSync(OVERLAY_SCRIPT, OVERLAY_PS, 'utf8');
      _overlayProc = spawn('powershell.exe', [
        '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', OVERLAY_SCRIPT,
      ], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });

      const log = (d) => { try { writeFileSync(OVERLAY_LOG, d.toString(), { flag: 'a' }); } catch {} };
      _overlayProc.stdout.on('data', log);
      _overlayProc.stderr.on('data', log);
      _overlayProc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          try { writeFileSync(OVERLAY_LOG, `exited ${code}\n`, { flag: 'a' }); } catch {}
        }
        _overlayProc = null;
      });
    } catch (err) {
      try { writeFileSync(OVERLAY_LOG, err.message + '\n'); } catch {}
    }

  } else {
    // Linux / macOS: Python tkinter corner-glow overlay
    const pyPath = join(tmpdir(), 'sennoric-overlay.py');
    try {
      writeFileSync(pyPath, PYTHON_OVERLAY, 'utf8');
      const py = process.platform === 'darwin' ? 'python3' : 'python3';
      _overlayProc = spawn(py, [pyPath], { stdio: 'ignore', detached: false });
      _overlayProc.on('exit', () => { _overlayProc = null; });
    } catch {}
  }
}

export function hideOverlay() {
  if (_overlayProc) {
    try { _overlayProc.kill(); } catch {}
    _overlayProc = null;
  }
}

// Clean up if the Node process exits while overlay is showing
process.on('exit', hideOverlay);

// ── Screen capture ────────────────────────────────────────────────────────────

// Plain screenshot — used for the `screenshot` description tool.
export function captureScreen() {
  const imgPath = join(tmpdir(), `sennoric-screen-${Date.now()}.png`);

  if (process.platform === 'win32') {
    const escaped = imgPath.replace(/\\/g, '\\\\');
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screen  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap  = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gfx     = [System.Drawing.Graphics]::FromImage($bitmap)
$gfx.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save('${escaped}')
$gfx.Dispose()
$bitmap.Dispose()
Write-Output "$($screen.Width)x$($screen.Height)"
`;
    const dims = runPowerShell(script, 8000);
    const data = readFileSync(imgPath);
    try { unlinkSync(imgPath); } catch {}
    const [w, h] = (dims || '0x0').split('x').map(Number);
    return { base64: data.toString('base64'), mediaType: 'image/png', width: w || 0, height: h || 0 };

  } else if (process.platform === 'darwin') {
    execSync(`screencapture -x "${imgPath}"`, { timeout: 5000 });
    const data = readFileSync(imgPath);
    try { unlinkSync(imgPath); } catch {}
    return { base64: data.toString('base64'), mediaType: 'image/png', width: 0, height: 0 };

  } else {
    captureLinuxScreen(imgPath);
    const data = readFileSync(imgPath);
    try { unlinkSync(imgPath); } catch {}
    return { base64: data.toString('base64'), mediaType: 'image/png', width: 0, height: 0 };
  }
}

// Draw a labeled coordinate grid onto an image file using ImageMagick.
// logW/logH are the logical (click-coordinate) dimensions; the image may be
// larger on HiDPI/Retina displays — identify resolves the actual size.
function annotateWithImageMagick(imgPath, logW, logH) {
  const outPath = imgPath.replace('.png', '-ann.png');

  let imgW = logW, imgH = logH;
  try {
    const dims = execSync(`identify -format "%wx%h" "${imgPath}"`, { encoding: 'utf8', timeout: 3000 }).trim();
    const [w, h] = dims.split('x').map(Number);
    if (w && h) { imgW = w; imgH = h; }
  } catch {}

  const sx = imgW / logW;
  const sy = imgH / logH;
  const fs = Math.max(11, Math.round(11 * Math.min(sx, sy)));
  const cw = Math.round(fs * 0.65); // approx char width for label box sizing

  const draws = [];
  for (let p = 5; p < 100; p += 5) {
    const lx = Math.round(logW * p / 100);
    const ly = Math.round(logH * p / 100);
    const px = Math.round(lx * sx);
    const py = Math.round(ly * sy);
    const major = p % 10 === 0;
    draws.push(`-stroke "rgba(255,60,60,${major ? '0.7' : '0.4'})" -strokewidth ${major ? 2 : 1} ` +
               `-draw "line ${px},0 ${px},${imgH}" -draw "line 0,${py} ${imgW},${py}"`);
    if (major) {
      const xl = String(lx), yl = String(ly);
      draws.push(
        `-fill "rgba(0,0,0,0.75)" -draw "rectangle ${px+1},1 ${px+xl.length*cw+4},${fs+5}" ` +
        `-fill yellow -pointsize ${fs} -draw "text ${px+2},${fs+2} '${xl}'"`,
        `-fill "rgba(0,0,0,0.75)" -draw "rectangle 1,${py+1} ${yl.length*cw+4},${py+fs+5}" ` +
        `-fill yellow -pointsize ${fs} -draw "text 2,${py+fs+2} '${yl}'"`,
      );
    }
  }
  // Corner anchor
  draws.push(`-fill "rgba(0,0,0,0.75)" -draw "rectangle 1,1 38,${fs+5}" -fill yellow -pointsize ${fs} -draw "text 2,${fs+2} '0,0'"`);

  execSync(`convert "${imgPath}" ${draws.join(' ')} "${outPath}"`, { timeout: 15000 });
  return outPath;
}

// Annotated screenshot — overlays a labeled grid every 5% so the vision model
// has dense reference markers when locating elements for click_on.
// "0%" labels at all four edges anchor the coordinate space.
export function captureScreenAnnotated() {
  const imgPath = join(tmpdir(), `sennoric-screen-${Date.now()}.png`);

  if (process.platform === 'win32') {
    const escaped = imgPath.replace(/\\/g, '\\\\');
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$W = $screen.Width
$H = $screen.Height
$bitmap = New-Object System.Drawing.Bitmap($W, $H)
$gfx = [System.Drawing.Graphics]::FromImage($bitmap)
$gfx.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)

$penMajor = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 255, 60, 60), 2)
$penMinor = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(100, 255, 60, 60), 1)
$font     = New-Object System.Drawing.Font("Arial", 10, [System.Drawing.FontStyle]::Bold)
$bg       = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 0, 0, 0))
$fg       = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Yellow)

# Helper: draw a label with dark background at (lx, ly)
function DrawLabel($text, $lx, $ly) {
  $sz = $gfx.MeasureString($text, $font)
  $gfx.FillRectangle($bg, [float]$lx, [float]$ly, $sz.Width + 2, $sz.Height)
  $gfx.DrawString($text, $font, $fg, [float]($lx + 1), [float]$ly)
}

# Grid lines every 5%; major (labeled) every 10% with actual pixel values
for ($i = 1; $i -le 19; $i++) {
  $pct = $i * 5
  $x = [int]($W * $pct / 100)
  $y = [int]($H * $pct / 100)
  $pen = if ($pct % 10 -eq 0) { $penMajor } else { $penMinor }
  $gfx.DrawLine($pen, $x, 0, $x, $H)
  $gfx.DrawLine($pen, 0, $y, $W, $y)
  if ($pct % 10 -eq 0) {
    DrawLabel "$x" ($x + 2) 2            # top edge: actual X pixel value
    DrawLabel "$y" 2 ($y + 2)            # left edge: actual Y pixel value
  }
}

# Corner anchors showing exact pixel bounds
DrawLabel "0,0" 2 2
DrawLabel "0,$H" 2 ($H - 18)
DrawLabel "$W,0" ($W - 46) 2
DrawLabel "$W,$H" ($W - 60) ($H - 18)

$bitmap.Save('${escaped}')
$gfx.Dispose()
$bitmap.Dispose()
Write-Output "$W x $H"
`;
    const dims = runPowerShell(script, 10000);
    const data = readFileSync(imgPath);
    try { unlinkSync(imgPath); } catch {}
    const m = (dims || '').match(/(\d+)\s*x\s*(\d+)/);
    const w = m ? Number(m[1]) : 0;
    const h = m ? Number(m[2]) : 0;
    return { base64: data.toString('base64'), mediaType: 'image/png', width: w || 0, height: h || 0 };

  } else {
    // Linux / macOS: annotate with ImageMagick if available, else plain screenshot
    const hasConvert = (() => {
      try { execSync('which convert', { stdio: 'ignore', timeout: 1000 }); return true; } catch { return false; }
    })();
    if (!hasConvert) return captureScreen();

    const { width: logW, height: logH } = getScreenSize();
    const imgPath = join(tmpdir(), `sennoric-screen-${Date.now()}.png`);

    if (process.platform === 'darwin') {
      execSync(`screencapture -x "${imgPath}"`, { timeout: 5000 });
    } else {
      captureLinuxScreen(imgPath);
    }

    try {
      const annPath = annotateWithImageMagick(imgPath, logW || 1920, logH || 1080);
      const data = readFileSync(annPath);
      try { unlinkSync(annPath); } catch {}
      return { base64: data.toString('base64'), mediaType: 'image/png', width: logW, height: logH };
    } catch {
      const data = readFileSync(imgPath);
      return { base64: data.toString('base64'), mediaType: 'image/png', width: logW, height: logH };
    } finally {
      try { unlinkSync(imgPath); } catch {}
    }
  }
}

// Crop a 200×80px region centred on (cx, cy) from the current screen.
// Used by find_text to let the agent verify the match visually.
// Returns { base64, mediaType } or null if cropping tools are unavailable.
export function cropScreenRegion(cx, cy) {
  const PAD_X = 200, PAD_Y = 60;
  const { width: sw, height: sh } = getScreenSize();
  const x0 = Math.max(0, cx - PAD_X);
  const y0 = Math.max(0, cy - PAD_Y);
  const x1 = Math.min(sw, cx + PAD_X);
  const y1 = Math.min(sh, cy + PAD_Y);
  const w  = x1 - x0, h = y1 - y0;

  if (process.platform === 'win32') {
    const outPath = join(tmpdir(), `sennoric-crop-${Date.now()}.png`).replace(/\\/g, '\\\\');
    const script  = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$full = New-Object System.Drawing.Bitmap(${w}, ${h})
$g    = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen(${x0}, ${y0}, 0, 0, [System.Drawing.Size]::new(${w}, ${h}))
$full.Save('${outPath}'); $g.Dispose(); $full.Dispose()
`;
    try {
      runPowerShell(script, 6000);
      const data = readFileSync(outPath.replace(/\\\\/g, '\\'));
      try { unlinkSync(outPath.replace(/\\\\/g, '\\')); } catch {}
      return { base64: data.toString('base64'), mediaType: 'image/png' };
    } catch { return null; }
  }

  const imgPath = join(tmpdir(), `sennoric-crop-${Date.now()}.png`);
  try {
    if (process.platform === 'darwin') {
      execSync(`screencapture -x -R ${x0},${y0},${w},${h} "${imgPath}"`, { timeout: 5000 });
    } else if (isWayland() && which('grim')) {
      // grim supports direct region capture: -g "x,y WxH"
      execSync(`grim -g "${x0},${y0} ${w}x${h}" "${imgPath}"`, { timeout: 5000 });
    } else if (which('convert')) {
      const full = join(tmpdir(), `sennoric-crop-full-${Date.now()}.png`);
      captureLinuxScreen(full);
      execSync(`convert "${full}" -crop ${w}x${h}+${x0}+${y0} +repage "${imgPath}"`, { timeout: 5000 });
      try { unlinkSync(full); } catch {}
    } else {
      return null;
    }
    const data = readFileSync(imgPath);
    try { unlinkSync(imgPath); } catch {}
    return { base64: data.toString('base64'), mediaType: 'image/png' };
  } catch { return null; }
}

function which(bin) {
  try { execSync(`which ${bin}`, { stdio: 'ignore', timeout: 1000 }); return true; } catch { return false; }
}

// True when running under a native Wayland compositor (WAYLAND_DISPLAY is set).
// Note: DISPLAY may also be set (XWayland), so we check WAYLAND_DISPLAY specifically.
function isWayland() {
  return process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
}

// Capture the full Linux screen to imgPath.
// Uses grim on Wayland, scrot on X11.
function captureLinuxScreen(imgPath) {
  if (isWayland()) {
    if (!which('grim')) throw new Error('grim not installed — run: sudo apt install grim  (Wayland screenshot tool)');
    execSync(`grim "${imgPath}"`, { timeout: 5000 });
  } else {
    if (!which('scrot')) throw new Error('scrot not installed — run: sudo apt install scrot');
    execSync(`scrot "${imgPath}"`, { timeout: 5000 });
  }
}

// ── Mouse ─────────────────────────────────────────────────────────────────────

export function mouseClick(x, y, button = 'left', times = 1) {
  const xi    = Math.round(x);
  const yi    = Math.round(y);
  const count = Math.max(1, Math.min(times, 20));

  if (process.platform === 'win32') {
    const downFlag = button === 'right' ? '0x0008' : '0x0002';
    const upFlag   = button === 'right' ? '0x0010' : '0x0004';
    const script = `
Add-Type -TypeDefinition @"${SENNORIC_INPUT_CS}"@
for ($i = 0; $i -lt ${count}; $i++) {
  [SennoricInput]::Click(${xi}, ${yi}, ${downFlag}, ${upFlag})
  if ($i -lt ${count - 1}) { Start-Sleep -Milliseconds 80 }
}
`;
    runPowerShell(script);

  } else if (process.platform === 'darwin') {
    if (count === 2) {
      // Try cliclick first — it fires a native double-click within the OS threshold
      try { execSync(`cliclick dc:${xi},${yi}`, { timeout: 3000 }); return; } catch {}
    }
    // Single osascript invocation so all clicks happen within the double-click time window
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(`click at {${xi}, ${yi}}`);
      if (i < count - 1) lines.push('delay 0.05');
    }
    const tmp = join(tmpdir(), `sennoric-click-${Date.now()}.scpt`);
    writeFileSync(tmp, `tell application "System Events"\n${lines.join('\n')}\nend tell`);
    try { execSync(`osascript "${tmp}"`, { timeout: 5000 }); } finally { try { unlinkSync(tmp); } catch {} }

  } else if (isWayland()) {
    // Wayland: ydotool (requires ydotoold daemon running)
    if (!which('ydotool')) throw new Error('ydotool not found — run: sudo apt install ydotool  (Wayland input tool)');
    // Button flags: 0x40000000 = click, low bits = button ID (0=left,1=right,2=middle)
    const btnId = button === 'right' ? 1 : button === 'middle' ? 2 : 0;
    const btn = `0x${(0x40000000 | btnId).toString(16)}`;
    const cmds = Array.from({ length: count }, (_, i) =>
      `ydotool mousemove --absolute -x ${xi} -y ${yi} && ydotool click ${btn}` +
      (i < count - 1 ? ' && sleep 0.08' : '')
    ).join(' && ');
    execSync(cmds, { timeout: 10000, shell: true });

  } else {
    const btn = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
    execSync(`xdotool mousemove ${xi} ${yi} click --repeat ${count} --delay 80 ${btn}`, { timeout: 5000 });
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

// Uses clipboard paste to avoid SendKeys encoding/escaping issues with special chars.
export function typeText(text) {
  if (process.platform === 'win32') {
    const txtPath = join(tmpdir(), `sennoric-type-${Date.now()}.txt`);
    writeFileSync(txtPath, text, 'utf8');
    const escapedPath = txtPath.replace(/\\/g, '\\\\');
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText([System.IO.File]::ReadAllText('${escapedPath}'))
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;
    try { runPowerShell(script, 8000); } finally { try { unlinkSync(txtPath); } catch {} }

  } else if (process.platform === 'darwin') {
    const escaped = text.replace(/'/g, "'\\''");
    execSync(`printf '%s' '${escaped}' | pbcopy && osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 5000 });

  } else if (isWayland()) {
    // Wayland: wtype is the lightest option; ydotool type works too
    const esc = text.replace(/'/g, "'\\''");
    if (which('wtype')) {
      execSync(`wtype -- '${esc}'`, { timeout: 10000 });
    } else if (which('ydotool')) {
      const esc2 = text.replace(/'/g, "'\\''");
      execSync(`ydotool type --key-delay 0 -- '${esc2}'`, { timeout: 10000 });
    } else {
      throw new Error('No Wayland keyboard tool found. Install wtype or ydotool:\n  sudo apt install wtype    (recommended)\n  sudo apt install ydotool  (requires ydotoold daemon)');
    }

  } else {
    // X11: prefer xdotool type; fall back to xclip clipboard paste
    const escaped = text.replace(/'/g, "'\\''");
    try {
      execSync(`xdotool type --clearmodifiers --delay 0 -- '${escaped}'`, { timeout: 10000 });
    } catch {
      execSync(`printf '%s' '${escaped}' | xclip -selection clipboard && xdotool key ctrl+v`, { timeout: 5000 });
    }
  }
}

// macOS key codes for non-printable keys (used with `key code N using {mod down}`)
const MAC_KEY_CODES = {
  RETURN: 36, ENTER: 36, TAB: 48, SPACE: 49,
  ESC: 53, ESCAPE: 53,
  BACKSPACE: 51, BS: 51, DELETE: 51,
  DEL: 117,
  HOME: 115, END: 119,
  PGUP: 116, PGDN: 121,
  UP: 126, DOWN: 125, LEFT: 123, RIGHT: 124,
  F1: 122, F2: 120, F3: 99,  F4: 118, F5: 96,
  F6: 97,  F7: 98,  F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

// Parse Windows SendKeys string into AppleScript keystroke/key-code lines.
// ^ maps to command (macOS convention), % to option, + to shift.
function sendKeysToMacOS(keys) {
  const lines = [];
  let i = 0;
  const mods = [];
  while (i < keys.length) {
    const ch = keys[i];
    if (ch === '^') { mods.push('command down'); i++; continue; }
    if (ch === '%') { mods.push('option down');  i++; continue; }
    if (ch === '+') { mods.push('shift down');   i++; continue; }
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    if (ch === '{') {
      const close = keys.indexOf('}', i);
      const name  = close === -1 ? '' : keys.slice(i + 1, close).toUpperCase();
      const code  = MAC_KEY_CODES[name];
      lines.push(code != null ? `key code ${code}${using}` : `keystroke "${name.toLowerCase().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${using}`);
      mods.length = 0;
      i = close === -1 ? keys.length : close + 1;
      continue;
    }
    lines.push(`keystroke "${ch.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${using}`);
    mods.length = 0;
    i++;
  }
  return lines;
}

// Windows SendKeys format: ^c=Ctrl+C, %{F4}=Alt+F4, {ENTER}, {TAB}, {ESC}, {BACKSPACE}, +{TAB}=Shift+Tab
export function pressKey(keys) {
  if (process.platform === 'win32') {
    const keysPath = join(tmpdir(), `sennoric-keys-${Date.now()}.txt`);
    writeFileSync(keysPath, keys, 'utf8');
    const escapedKeysPath = keysPath.replace(/\\/g, '\\\\');
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait([System.IO.File]::ReadAllText('${escapedKeysPath}'))
`;
    try { runPowerShell(script); } finally { try { unlinkSync(keysPath); } catch {} }

  } else if (process.platform === 'darwin') {
    const lines = sendKeysToMacOS(keys);
    if (!lines.length) return;
    const tmp = join(tmpdir(), `sennoric-key-${Date.now()}.scpt`);
    writeFileSync(tmp, `tell application "System Events"\n${lines.join('\n')}\nend tell`);
    try { execSync(`osascript "${tmp}"`, { timeout: 5000 }); } finally { try { unlinkSync(tmp); } catch {} }

  } else if (isWayland()) {
    if (!which('ydotool')) throw new Error('ydotool not found — run: sudo apt install ydotool  (Wayland input tool, requires ydotoold daemon)');
    const yk = sendKeysToX11(keys);
    if (/[^A-Za-z0-9+_ ]/.test(yk)) throw new Error('Invalid keysym in pressKey');
    execSync(`ydotool key ${yk}`, { timeout: 5000 });

  } else {
    const xk = sendKeysToX11(keys);
    if (/[^A-Za-z0-9+_ ]/.test(xk)) throw new Error('Invalid keysym in pressKey');
    execSync(`xdotool key ${xk}`, { timeout: 5000 });
  }
}

// Translate Windows SendKeys format to xdotool X11 key names.
// SendKeys: ^=Ctrl, %=Alt, +=Shift, {NAME}=special key, bare chars=literal
function sendKeysToX11(keys) {
  const SPECIAL = {
    ENTER: 'Return', RETURN: 'Return', TAB: 'Tab', ESC: 'Escape', ESCAPE: 'Escape',
    BACKSPACE: 'BackSpace', BS: 'BackSpace', DELETE: 'Delete', DEL: 'Delete',
    INSERT: 'Insert', INS: 'Insert', HOME: 'Home', END: 'End',
    PGUP: 'Prior', PGDN: 'Next', UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    SPACE: 'space', PLUS: 'plus', TILDE: 'asciitilde',
  };

  const tokens = [];
  let i = 0;
  const mods = [];

  while (i < keys.length) {
    const ch = keys[i];
    if (ch === '^') { mods.push('ctrl'); i++; continue; }
    if (ch === '%') { mods.push('alt');  i++; continue; }
    if (ch === '+') { mods.push('shift'); i++; continue; }
    if (ch === '{') {
      const close = keys.indexOf('}', i);
      const name = close === -1 ? '' : keys.slice(i + 1, close).toUpperCase();
      const x11  = SPECIAL[name] || name.toLowerCase();
      const combo = [...mods, x11].join('+');
      tokens.push(combo);
      mods.length = 0;
      i = close === -1 ? keys.length : close + 1;
      continue;
    }
    // Bare character — map to xdotool key name
    const x11 = ch === ' ' ? 'space' : ch;
    tokens.push([...mods, x11].join('+'));
    mods.length = 0;
    i++;
  }

  return tokens.join(' ');
}

// ── Scroll ────────────────────────────────────────────────────────────────────

export function scrollAt(x, y, direction = 'down', amount = 3) {
  const xi = Math.round(x);
  const yi = Math.round(y);

  if (process.platform === 'win32') {
    // Positive delta = scroll up, negative = scroll down (Windows convention)
    const delta = direction === 'up' ? 120 * amount : -(120 * amount);
    const script = `
Add-Type -TypeDefinition @"${SENNORIC_INPUT_CS}"@
[SennoricInput]::Scroll(${xi}, ${yi}, ${delta})
`;
    runPowerShell(script);

  } else if (process.platform === 'darwin') {
    // cliclick handles scroll wheel correctly on macOS; fall back to arrow keys
    const btn = direction === 'up' ? 'su' : 'sd';
    try {
      execSync(`cliclick ${btn}:${xi},${yi}`, { timeout: 3000 });
    } catch {
      const keyCode = direction === 'up' ? 126 : 125;
      execSync(
        `osascript -e 'tell application "System Events"' -e 'repeat ${amount} times' -e 'key code ${keyCode}' -e 'end repeat' -e 'end tell'`,
        { timeout: 5000 }
      );
    }

  } else if (isWayland()) {
    if (!which('ydotool')) throw new Error('ydotool not found — run: sudo apt install ydotool  (Wayland input tool)');
    execSync(`ydotool mousemove --absolute -x ${xi} -y ${yi}`, { timeout: 3000 });
    // ydotool scroll --axis: 0=vertical, value: negative=up, positive=down (120 units per notch)
    const delta = direction === 'up' ? -(amount * 120) : amount * 120;
    try {
      execSync(`ydotool scroll --axis 0 -- ${delta}`, { timeout: 5000 });
    } catch {
      // Fallback: arrow keys if scroll axis unsupported
      const key = direction === 'up' ? 'Up' : 'Down';
      execSync(`ydotool key ${Array(amount).fill(key).join(' ')}`, { timeout: 5000 });
    }

  } else {
    const btn = direction === 'up' ? 4 : 5;
    execSync(`xdotool mousemove ${xi} ${yi} click --repeat ${amount} ${btn}`, { timeout: 5000 });
  }
}

// ── UIAutomation element finder ───────────────────────────────────────────────

// Find a UI element by name and activate it via UIAutomation.
// Tries InvokePattern first (programmatic click — no mouse needed, works even if covered).
// Falls back to returning coordinates for a physical click if InvokePattern unavailable.
// Returns { invoked: true } | { x, y } | null
export function uiaClickElement(searchTerm) {
  if (process.platform === 'darwin') {
    // macOS: search the frontmost app's UI tree via System Events accessibility API
    const esc = searchTerm.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
tell application "System Events"
  set fp to first process whose frontmost is true
  repeat with w in windows of fp
    set allEls to every UI element of w
    repeat with el in allEls
      try
        set nm to name of el
        if nm is not missing value and nm contains "${esc}" then
          set pos to position of el
          set sz to size of el
          return ((item 1 of pos) + (item 1 of sz) / 2) & "," & ((item 2 of pos) + (item 2 of sz) / 2)
        end if
      end try
    end repeat
  end repeat
  return ""
end tell
`;
    try {
      const tmp = join(tmpdir(), `sennoric-uia-${Date.now()}.scpt`);
      writeFileSync(tmp, script);
      const out = execSync(`osascript "${tmp}"`, { encoding: 'utf8', timeout: 6000 }).trim();
      try { unlinkSync(tmp); } catch {}
      const m = out.match(/([\d.]+),\s*([\d.]+)/);
      if (m) return { invoked: false, x: Math.round(parseFloat(m[1])), y: Math.round(parseFloat(m[2])), name: searchTerm };
    } catch {}
    return null;
  }

  if (process.platform !== 'win32') {
    // Linux: use xdotool to find a window matching the search term
    try {
      const escapedSearch = searchTerm.replace(/'/g, "'\\''");
      const wid = execSync(`xdotool search --name '${escapedSearch}' 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 3000 }).trim();
      if (!wid) return null;
      const geo = execSync(`xdotool getwindowgeometry ${wid} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      const pos = geo.match(/Position:\s*(\d+),(\d+)/);
      const siz = geo.match(/Geometry:\s*(\d+)x(\d+)/);
      if (pos && siz) {
        return {
          invoked: false,
          x: Number(pos[1]) + Math.round(Number(siz[1]) / 2),
          y: Number(pos[2]) + Math.round(Number(siz[2]) / 2),
          name: searchTerm,
        };
      }
    } catch {}
    return null;
  }

  const core = searchTerm
    .replace(/\b(the|a|an|on|in|at|of|icon|button|link|tab|window|app|application|desktop|taskbar|tray|menu|item)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();

  const terms = [...new Set([searchTerm, core].filter(Boolean))];

  const termsPath = join(tmpdir(), `sennoric-uia-terms-${Date.now()}.txt`);
  writeFileSync(termsPath, terms.join('\n'), 'utf8');
  const escapedTermsPath = termsPath.replace(/\\/g, '\\\\');

  const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$found = $null

function TryFind($name) {
  $prop = [System.Windows.Automation.AutomationElement]::NameProperty
  $cond = New-Object System.Windows.Automation.PropertyCondition($prop, $name,
    [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
}

function TryFindPartial($name) {
  foreach ($cls in @("Progman","Shell_TrayWnd","WorkerW")) {
    $clsCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
    $container = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $clsCond)
    if ($container -eq $null) { continue }
    $all = $container.FindAll([System.Windows.Automation.TreeScope]::Subtree,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $all) {
      try { if ($item.Current.Name -like "*$name*") { return $item } } catch {}
    }
  }
  return $null
}

$searches = Get-Content '${escapedTermsPath}'
foreach ($term in $searches) {
  $found = TryFind $term
  if ($found) { break }
}
if (-not $found) {
  foreach ($term in $searches) {
    $found = TryFindPartial $term
    if ($found) { break }
  }
}

if ($found) {
  # Try programmatic invoke first — no mouse, no Z-order issues
  try {
    $ip = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
    Write-Output "INVOKED [$($found.Current.Name)]"
  } catch {
    # Fall back to physical click coordinates
    try {
      $r = $found.Current.BoundingRectangle
      if ($r.Width -gt 0) {
        $cx = [int]($r.Left + $r.Width / 2)
        $cy = [int]($r.Top + $r.Height / 2)
        Write-Output "COORDS $cx,$cy [$($found.Current.Name)]"
      } else { Write-Output "NOT_FOUND" }
    } catch { Write-Output "NOT_FOUND" }
  }
} else { Write-Output "NOT_FOUND" }
`;

  try {
    const out = runPowerShell(script, 15000);
    if (/^INVOKED/i.test(out))  return { invoked: true,  name: (out.match(/\[(.+)\]/) || [])[1] };
    const m = out.match(/COORDS (\d+),(\d+)/);
    if (m) return { invoked: false, x: Number(m[1]), y: Number(m[2]), name: (out.match(/\[(.+)\]/) || [])[1] };
  } catch {} finally { try { unlinkSync(termsPath); } catch {} }
  return null;
}

// ── Windows OCR element finder ────────────────────────────────────────────────

// Uses the Windows built-in OCR engine (Windows.Media.Ocr) to find text on
// screen and return its pixel center. Works without any external dependencies
// on Windows 10/11. On Linux/macOS uses tesseract (if installed).
// Returns { x, y } | { error } | null.
export function ocrFindText(searchTerm) {
  if (process.platform !== 'win32') {
    // Linux/macOS: use tesseract hOCR output
    try { execSync('which tesseract', { stdio: 'ignore', timeout: 1000 }); }
    catch { return { error: 'tesseract not installed — run: sudo apt install tesseract-ocr  (Linux) or  brew install tesseract  (macOS)' }; }

    const imgPath = join(tmpdir(), `sennoric-ocr-${Date.now()}.png`);
    const ocrBase = imgPath.replace('.png', '');
    const hocrPath = ocrBase + '.hocr';

    try {
      // Capture screen
      if (process.platform === 'darwin') {
        execSync(`screencapture -x "${imgPath}"`, { timeout: 5000 });
      } else {
        captureLinuxScreen(imgPath);
      }

      // Run tesseract in hOCR mode
      execSync(`tesseract "${imgPath}" "${ocrBase}" hocr 2>/dev/null`, { timeout: 15000 });

      const hocr = readFileSync(hocrPath, 'utf8');
      const needle = searchTerm.toLowerCase();

      // Parse hOCR: <span class='ocrx_word' title='bbox x0 y0 x1 y1; ...' ...>word</span>
      // Try multi-word phrase match across adjacent words first
      const wordRe = /<span[^>]+class=['"]ocrx_word['"][^>]+title=['"]bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)[^'"]*['"][^>]*>([^<]+)<\/span>/gi;
      const words = [];
      let wm;
      while ((wm = wordRe.exec(hocr)) !== null) {
        words.push({ x0: +wm[1], y0: +wm[2], x1: +wm[3], y1: +wm[4], text: wm[5].trim() });
      }

      // Slide a window over adjacent words to find phrase matches
      const tokens = needle.split(/\s+/);
      for (let i = 0; i <= words.length - tokens.length; i++) {
        const chunk = words.slice(i, i + tokens.length);
        const joined = chunk.map(w => w.text.toLowerCase()).join(' ');
        if (joined.includes(needle) || tokens.every((t, j) => chunk[j].text.toLowerCase().includes(t))) {
          const x = Math.round((chunk[0].x0 + chunk[chunk.length - 1].x1) / 2);
          const y = Math.round((chunk[0].y0 + chunk[0].y1) / 2);
          return { x, y };
        }
      }

      // Single-word partial match fallback
      for (const w of words) {
        if (w.text.toLowerCase().includes(needle)) {
          return { x: Math.round((w.x0 + w.x1) / 2), y: Math.round((w.y0 + w.y1) / 2) };
        }
      }
    } catch (e) {
      return { error: `OCR error: ${e.message}` };
    } finally {
      try { unlinkSync(imgPath); } catch {}
      try { unlinkSync(hocrPath); } catch {}
    }
    return null;
  }

  // Write the search term to a temp file to avoid PowerShell escaping issues.
  const termPath = join(tmpdir(), `sennoric-ocr-term-${Date.now()}.txt`);
  writeFileSync(termPath, searchTerm, 'utf8');
  const escapedTerm = termPath.replace(/\\/g, '\\\\');

  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Windows.Forms, System.Drawing

# Generic WinRT async helper — works on PS 5.1 and PS 7
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

try {
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
} catch {
  Write-Output "OCR_UNAVAILABLE"
  exit
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output "OCR_UNAVAILABLE"; exit }

$searchTerm = [System.IO.File]::ReadAllText('${escapedTerm}').Trim()

# Capture screen
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$W = $screen.Width; $H = $screen.Height
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# Convert to WinRT stream
$ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$wstream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForWrite($ras)
$ms.Position = 0
$ms.CopyTo($wstream)
$wstream.Flush()
$ras.Seek(0)

$decoder  = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sb       = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$ocrResult = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])

$found = $false
foreach ($line in $ocrResult.Lines) {
  $lineText = ($line.Words | ForEach-Object { $_.Text }) -join ' '
  # Full phrase match on line
  if ($lineText -match [regex]::Escape($searchTerm)) {
    $singleMatch = $line.Words | Where-Object { $_.Text -match [regex]::Escape($searchTerm) } | Select-Object -First 1
    if ($singleMatch) {
      $b  = $singleMatch.BoundingRect
      $cx = [int]($b.X + $b.Width  / 2)
      $cy = [int]($b.Y + $b.Height / 2)
    } else {
      $first = $line.Words[0].BoundingRect
      $last  = $line.Words[-1].BoundingRect
      $cx    = [int](($first.X + $last.X + $last.Width) / 2)
      $cy    = [int]($first.Y + $first.Height / 2)
    }
    Write-Output "FOUND $cx,$cy [$lineText]"
    $found = $true; break
  }
}
# Word-level partial match fallback
if (-not $found) {
  foreach ($line in $ocrResult.Lines) {
    foreach ($word in $line.Words) {
      if ($word.Text -like "*$searchTerm*") {
        $b  = $word.BoundingRect
        $cx = [int]($b.X + $b.Width  / 2)
        $cy = [int]($b.Y + $b.Height / 2)
        Write-Output "FOUND $cx,$cy [$($word.Text)]"
        $found = $true; break
      }
    }
    if ($found) { break }
  }
}
if (-not $found) { Write-Output "NOT_FOUND" }
Write-Output "SCREEN $W x $H"
`;

  try {
    const out = runPowerShell(script, 20000);
    try { unlinkSync(termPath); } catch {}
    if (out.includes('OCR_UNAVAILABLE')) return { error: 'Windows OCR unavailable on this system.' };
    const m = out.match(/FOUND (\d+),(\d+)/);
    if (m) return { x: Number(m[1]), y: Number(m[2]) };
  } catch {
    try { unlinkSync(termPath); } catch {}
  }
  return null;
}

// ── Screen info ───────────────────────────────────────────────────────────────

export function getScreenSize() {
  if (process.platform === 'win32') {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output "$($s.Width)x$($s.Height)"
`;
    const out = runPowerShell(script, 5000);
    const [w, h] = (out || '1920x1080').split('x').map(Number);
    return { width: w || 1920, height: h || 1080 };
  }
  if (process.platform === 'darwin') {
    try {
      const out = execSync(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`, { encoding: 'utf8', timeout: 3000 }).trim();
      // Returns "0, 0, width, height"
      const parts = out.split(',').map(s => Number(s.trim()));
      if (parts.length === 4 && parts[2] && parts[3]) return { width: parts[2], height: parts[3] };
    } catch {}
  } else {
    // Wayland compositors: try wlr-randr first (wlroots-based: Sway, Hyprland, etc.)
    if (isWayland()) {
      try {
        const out = execSync(`wlr-randr 2>/dev/null | grep -m1 ' px'`, { encoding: 'utf8', timeout: 3000 }).trim();
        const m = out.match(/(\d+)x(\d+)\s+px/);
        if (m) return { width: Number(m[1]), height: Number(m[2]) };
      } catch {}
    }
    // X11 or XWayland fallback
    try {
      const out = execSync(`xrandr 2>/dev/null | grep -m1 'current' | sed "s/.*current \\([0-9]*\\) x \\([0-9]*\\).*/\\1 \\2/"`, { encoding: 'utf8', timeout: 3000 }).trim();
      const [w, h] = out.split(' ').map(Number);
      if (w && h) return { width: w, height: h };
    } catch {}
  }
  return { width: 1920, height: 1080 };
}
