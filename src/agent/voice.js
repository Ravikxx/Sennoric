import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { API_KEYS } from '../config.js';

const AUDIO_FILE = join(tmpdir(), 'sennoric-voice.wav');
const TTS_FILE   = join(tmpdir(), 'sennoric-tts.mp3');
let recordingProcess = null;

function getWindowsAudioDevice() {
  try {
    execSync('ffmpeg -list_devices true -f dshow -i dummy', {
      encoding: 'utf8', timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const out = String(e.stderr || '') + String(e.stdout || '');
    for (const line of out.split('\n')) {
      if (!line.includes('(audio)')) continue;
      const m = line.match(/"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

export function startRecording() {
  if (recordingProcess) return { ok: false, error: 'Already recording' };
  if (existsSync(AUDIO_FILE)) { try { unlinkSync(AUDIO_FILE); } catch {} }

  const { platform } = process;
  let cmd, args;

  if (platform === 'win32') {
    const device = getWindowsAudioDevice();
    if (!device) return { ok: false, error: 'No microphone found.\nInstall ffmpeg: winget install ffmpeg  or  choco install ffmpeg' };
    cmd  = 'ffmpeg';
    args = ['-f', 'dshow', '-i', `audio=${device}`, '-ar', '16000', '-ac', '1', '-y', AUDIO_FILE];
  } else if (platform === 'darwin') {
    cmd  = 'ffmpeg';
    args = ['-f', 'avfoundation', '-i', ':0', '-ar', '16000', '-ac', '1', '-y', AUDIO_FILE];
  } else {
    cmd  = 'ffmpeg';
    args = ['-f', 'alsa', '-i', 'default', '-ar', '16000', '-ac', '1', '-y', AUDIO_FILE];
  }

  try {
    // Use pipe for stdin so we can send 'q' for graceful stop
    recordingProcess = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    recordingProcess.on('error', () => { recordingProcess = null; });
    return { ok: true };
  } catch (err) {
    recordingProcess = null;
    return { ok: false, error: `Could not start recording: ${err.message}\nMake sure ffmpeg is installed.` };
  }
}

export function isRecording() {
  return recordingProcess !== null;
}

export async function stopRecording() {
  if (!recordingProcess) return null;
  const proc = recordingProcess;
  recordingProcess = null;
  await new Promise((resolve) => {
    proc.on('exit', resolve);
    try { proc.stdin.write('q'); proc.stdin.end(); } catch {}
    // Fallback: force-kill after 2s if graceful stop didn't work
    setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 2000);
  });
  return existsSync(AUDIO_FILE) ? AUDIO_FILE : null;
}

export async function transcribeAudio(filePath) {
  const openaiKey = API_KEYS.openai;
  const groqKey   = API_KEYS.groq;

  let endpoint, key, model;
  if (openaiKey) {
    endpoint = 'https://api.openai.com/v1/audio/transcriptions';
    key      = openaiKey;
    model    = 'whisper-1';
  } else if (groqKey) {
    endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
    key      = groqKey;
    model    = 'whisper-large-v3-turbo';
  } else {
    throw new Error('Voice transcription needs an OpenAI or Groq key.\nSet one: /api openai <key>  or  /api groq <key>');
  }

  const audioData = readFileSync(filePath);
  const boundary  = `SennoricVoiceBoundary${Date.now()}`;

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audioData,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const { default: fetch } = await import('node-fetch');
  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${key}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`Whisper API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.text || '').trim();
}

export async function speakText(text, { voice = 'alloy', model = 'tts-1' } = {}) {
  const openaiKey = API_KEYS.openai;
  if (!openaiKey) throw new Error('Text-to-speech needs an OpenAI key.\nSet one: /api openai <key>');

  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
  });

  if (!res.ok) throw new Error(`TTS API error ${res.status}: ${await res.text()}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(TTS_FILE, buffer);

  playAudio(TTS_FILE);
  return TTS_FILE;
}

function playAudio(filePath) {
  const { platform } = process;
  try {
    if (platform === 'darwin') {
      execSync(`afplay "${filePath}"`, { stdio: 'ignore', timeout: 120000 });
    } else if (platform === 'win32') {
      execSync(`powershell -c (New-Object Media.SoundPlayer '"${filePath}"').PlaySync()`, { timeout: 120000 });
    } else {
      try { execSync(`ffplay -nodisp -autoexit "${filePath}"`, { stdio: 'ignore', timeout: 120000 }); }
      catch { execSync(`aplay "${filePath}"`, { stdio: 'ignore', timeout: 120000 }); }
    }
  } catch (err) {
    throw new Error(`Could not play audio: ${err.message}\nInstall afplay (macOS), aplay/ffplay (Linux), or use a media player.`);
  } finally {
    try { unlinkSync(TTS_FILE); } catch {}
  }
}
