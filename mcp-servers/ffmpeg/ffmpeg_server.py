#!/usr/bin/env python3.13
"""FFmpeg MCP server — convert, probe, and manipulate media files via MCP stdio."""
import sys, os, json, subprocess, re, traceback

def run_ffmpeg(args, input_path=None):
    cmd = ['ffmpeg', '-y', '-v', 'warning']
    if input_path and not any(a.startswith('-i') for a in args if a.startswith('-i')):
        cmd += ['-i', input_path]
    cmd += args
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr

def run_ffprobe(path):
    cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip()
    try:
        return json.loads(r.stdout), None
    except json.JSONDecodeError as e:
        return None, str(e)

def result_text(text):
    return {'content': [{'type': 'text', 'text': str(text)}]}

def result_error(text):
    return {'content': [{'type': 'text', 'text': str(text)}], 'isError': True}

def handle_probe(args):
    path = args.get('path', '')
    if not path:
        return result_error('"path" is required')
    if not os.path.isfile(path):
        return result_error(f'File not found: {path}')
    data, err = run_ffprobe(path)
    if err:
        return result_error(f'ffprobe failed: {err}')
    summary = {'file': path, 'size': data.get('format', {}).get('size'), 'duration': data.get('format', {}).get('duration'), 'bit_rate': data.get('format', {}).get('bit_rate'), 'format_name': data.get('format', {}).get('format_name'), 'streams': []}
    for s in data.get('streams', []):
        info = {'index': s['index'], 'codec_type': s.get('codec_type'), 'codec_name': s.get('codec_name')}
        if s.get('codec_type') == 'video':
            info.update({'width': s.get('width'), 'height': s.get('height'), 'fps': eval_calc(s.get('r_frame_rate', '0/1')), 'pix_fmt': s.get('pix_fmt')})
        elif s.get('codec_type') == 'audio':
            info.update({'sample_rate': s.get('sample_rate'), 'channels': s.get('channels'), 'channel_layout': s.get('channel_layout')})
        summary['streams'].append(info)
    return result_text(json.dumps(summary, indent=2))

def eval_calc(expr):
    try:
        if '/' in str(expr):
            a, b = str(expr).split('/')
            return round(float(a) / float(b), 3)
        return float(expr)
    except: return 0

def handle_convert(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    if not input_path or not output_path:
        return result_error('Both "input" and "output" are required')
    codec = args.get('vcodec', '')
    acodec = args.get('acodec', '')
    bitrate = args.get('bitrate', '')
    extra = args.get('extra_args', '')
    cmd = []
    if codec: cmd += ['-c:v', codec]
    if acodec: cmd += ['-c:a', acodec]
    if bitrate: cmd += ['-b:v', bitrate]
    if extra: cmd += extra.split()
    cmd.append(output_path)
    rc, out, err = run_ffmpeg(cmd, input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Converted {input_path} → {output_path}')

def handle_extract_audio(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    if not input_path or not output_path:
        return result_error('Both "input" and "output" are required')
    codec = args.get('codec', 'libmp3lame')
    bitrate = args.get('bitrate', '192k')
    rc, out, err = run_ffmpeg(['-vn', '-c:a', codec, '-b:a', bitrate, output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Extracted audio to {output_path}')

def handle_extract_video(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    if not input_path or not output_path:
        return result_error('Both "input" and "output" are required')
    rc, out, err = run_ffmpeg(['-an', '-c:v', 'copy', output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Extracted video to {output_path}')

def handle_resize(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    width = args.get('width', 0)
    height = args.get('height', 0)
    if not input_path or not output_path or not width or not height:
        return result_error('"input", "output", "width", and "height" are required')
    rc, out, err = run_ffmpeg(['-vf', f'scale={width}:{height}', '-c:a', 'copy', output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Resized to {width}x{height}: {output_path}')

def handle_crop(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    w = args.get('width', 0)
    h = args.get('height', 0)
    x = args.get('x', 0)
    y = args.get('y', 0)
    if not input_path or not output_path or not w or not h:
        return result_error('"input", "output", "width", and "height" are required')
    rc, out, err = run_ffmpeg(['-vf', f'crop={w}:{h}:{x}:{y}', '-c:a', 'copy', output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Cropped to {w}x{h}+{x}+{y}: {output_path}')

def handle_trim(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    start = args.get('start', '')
    duration = args.get('duration', '')
    end = args.get('end', '')
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    cmd = []
    if start: cmd += ['-ss', str(start)]
    if duration: cmd += ['-t', str(duration)]
    if end: cmd += ['-to', str(end)]
    cmd += ['-c', 'copy', output_path]
    rc, out, err = run_ffmpeg(cmd, input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Trimmed to {output_path}')

def handle_concat(args):
    inputs = args.get('inputs', [])
    output_path = args.get('output', '')
    if not inputs or not output_path:
        return result_error('"inputs" (array) and "output" are required')
    if not isinstance(inputs, list):
        inputs = [inputs]
    list_path = None
    try:
        import tempfile
        f = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8')
        list_path = f.name
        for p in inputs:
            abs_p = os.path.abspath(p)
            escaped = abs_p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
        f.close()
        cmd = ['-f', 'concat', '-safe', '0', '-i', list_path, '-c', 'copy', output_path]
        rc, out, err = run_ffmpeg(cmd, None)
        if rc != 0:
            return result_error(f'Concat failed:\n{err}')
        return result_text(f'Concatenated {len(inputs)} files → {output_path}')
    finally:
        if list_path and os.path.exists(list_path):
            os.unlink(list_path)

def handle_screenshot(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    timestamp = args.get('timestamp', '00:00:00')
    width = args.get('width', 0)
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    vf = f'select=gte(n\\,{timestamp_to_frames(timestamp)})'
    if width:
        vf += f',scale={width}:-1'
    rc, out, err = run_ffmpeg(['-vf', vf, '-vframes', '1', output_path], input_path)
    if rc != 0:
        return result_error(f'Screenshot failed:\n{err}')
    return result_text(f'Screenshot saved to {output_path}')

def timestamp_to_frames(ts):
    parts = str(ts).split(':')
    if len(parts) == 3:
        return str(int(parts[0])*3600*30 + int(parts[1])*60*30 + float(parts[2])*30)
    elif len(parts) == 2:
        return str(int(parts[0])*60*30 + float(parts[1])*30)
    return '0'

def handle_gif(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    start = args.get('start', '0')
    duration = args.get('duration', '5')
    fps = args.get('fps', 10)
    width = args.get('width', 480)
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    vf = f'fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse'
    rc, out, err = run_ffmpeg(['-ss', str(start), '-t', str(duration), '-vf', vf, output_path], input_path)
    if rc != 0:
        return result_error(f'GIF failed:\n{err}')
    return result_text(f'GIF saved to {output_path}')

def handle_metadata(args):
    path = args.get('path', '')
    action = args.get('action', 'read')
    if not path:
        return result_error('"path" is required')
    if not os.path.isfile(path):
        return result_error(f'File not found: {path}')
    if action == 'read':
        data, err = run_ffprobe(path)
        if err:
            return result_error(f'ffprobe failed: {err}')
        fmt = data.get('format', {})
        meta = fmt.get('tags', {})
        meta['duration'] = fmt.get('duration')
        meta['size'] = fmt.get('size')
        meta['bit_rate'] = fmt.get('bit_rate')
        return result_text(json.dumps(meta, indent=2))
    elif action in ('write', 'set'):
        key = args.get('key', '')
        value = args.get('value', '')
        if not key:
            return result_error('"key" is required for write action')
        suffix = args.get('output', path)
        rc, out, err = run_ffmpeg(['-metadata', f'{key}={value}', '-c', 'copy', suffix], path)
        if rc != 0:
            return result_error(f'ffmpeg failed:\n{err}')
        return result_text(f'Set {key}={value} on {suffix}')
    return result_error(f'Unknown action: {action}')

def handle_speed(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    speed = args.get('speed', 1.0)
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    speed = float(speed)
    if speed <= 0:
        return result_error('Speed must be > 0')
    atempo = f'{speed:.2f}'
    if speed > 100:
        atempo = '100'
    if speed >= 0.5 and speed <= 100:
        vf = f'setpts={1/speed:.3f}*PTS'
        af = f'atempo={atempo}'
        rc, out, err = run_ffmpeg(['-vf', vf, '-af', af, output_path], input_path)
    else:
        atempo_chain = calculate_atempo_chain(speed)
        vf = f'setpts={1/speed:.3f}*PTS'
        af = ','.join(f'atempo={t}' for t in atempo_chain)
        rc, out, err = run_ffmpeg(['-vf', vf, '-af', af, output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Speed {speed}x: {output_path}')

def calculate_atempo_chain(speed):
    import math
    chain = []
    while speed > 2.0:
        chain.append('2.0')
        speed /= 2.0
    while speed < 0.5:
        chain.append('0.5')
        speed /= 0.5
    chain.append(f'{speed:.3f}')
    return chain

def handle_overlay(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    overlay_path = args.get('overlay', '')
    text = args.get('text', '')
    position = args.get('position', 'bottom-right')
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    pos_map = {'top-left': '10:10', 'top-right': 'W-w-10:10', 'bottom-left': '10:H-h-10', 'bottom-right': 'W-w-10:H-h-10', 'center': '(W-w)/2:(H-h)/2'}
    pos = pos_map.get(position, position)
    if overlay_path:
        vf = f'movie={overlay_path}[logo];[in][logo]overlay={pos}[out]'
        rc, out, err = run_ffmpeg(['-vf', vf, '-c:a', 'copy', output_path], input_path)
    elif text:
        fontsize = args.get('fontsize', 24)
        fontcolor = args.get('fontcolor', 'white')
        vf = f"drawtext=text='{text}':fontsize={fontsize}:fontcolor={fontcolor}:x={pos.split(':')[0]}:y={pos.split(':')[1]}"
        rc, out, err = run_ffmpeg(['-vf', vf, '-c:a', 'copy', output_path], input_path)
    else:
        return result_error('Either "overlay" (file path) or "text" is required')
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Overlay applied: {output_path}')

def handle_merge(args):
    video_path = args.get('video', '')
    audio_path = args.get('audio', '')
    output_path = args.get('output', '')
    if not video_path or not audio_path or not output_path:
        return result_error('"video", "audio", and "output" are required')
    cmd = ['-i', video_path, '-i', audio_path, '-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0', '-shortest', output_path]
    rc, out, err = run_ffmpeg(cmd, None)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Merged into {output_path}')

def handle_transcribe(args):
    path = args.get('path', '')
    model = args.get('model', 'base')
    language = args.get('language', '')
    task = args.get('task', 'transcribe')
    timestamps = args.get('timestamps', False)
    if not path:
        return result_error('"path" is required')
    if not os.path.isfile(path):
        return result_error(f'File not found: {path}')
    import tempfile, shutil
    tmp_wav = None
    try:
        tmp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        rc, _, err = run_ffmpeg(['-ac', '1', '-ar', '16000', '-f', 'wav', tmp_wav], path)
        if rc != 0:
            return result_error(f'Failed to extract audio: {err}')
        whisper_cmd = shutil.which('whisper')
        if whisper_cmd:
            cmd = [whisper_cmd, tmp_wav, '--model', model, '--output_format', 'json']
            if language: cmd += ['--language', language]
            if task == 'translate': cmd += ['--task', 'translate']
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                return result_error(f'whisper failed:\n{r.stderr}')
            import glob as glob_mod
            out_dir = os.path.dirname(tmp_wav)
            json_files = glob_mod.glob(os.path.join(out_dir, '*.json'))
            result_data = None
            for jf in sorted(json_files, key=os.path.getmtime, reverse=True):
                try:
                    with open(jf) as f:
                        result_data = json.load(f)
                    break
                except: pass
            if result_data:
                text = result_data.get('text', '')
                segments = result_data.get('segments', [])
                if timestamps and segments:
                    lines = []
                    for seg in segments:
                        start = seg.get('start', 0)
                        end = seg.get('end', 0)
                        txt = seg.get('text', '').strip()
                        lines.append(f'[{fmt_ts(start)} --> {fmt_ts(end)}] {txt}')
                    return result_text('\n'.join(lines))
                return result_text(text)
            return result_text(r.stdout.strip())
        try:
            from faster_whisper import WhisperModel
            model_obj = WhisperModel(model, device='cpu', compute_type='int8')
            segs, info = model_obj.transcribe(tmp_wav, language=language if language else None, task=task)
            result_parts = []
            for seg in segs:
                if timestamps:
                    result_parts.append(f'[{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}] {seg.text.strip()}')
                else:
                    result_parts.append(seg.text.strip())
            return result_text('\n'.join(result_parts) if result_parts else '(no speech detected)')
        except ImportError:
            return result_error('No transcription backend found. Install one:\n  pip install openai-whisper\n  pip install faster-whisper\nOr use whisper.cpp CLI named "whisper" on PATH')
    except subprocess.TimeoutExpired:
        return result_error('Transcription timed out (600s limit)')
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            try: os.unlink(tmp_wav)
            except: pass

def fmt_ts(secs):
    h = int(secs // 3600)
    m = int((secs % 3600) // 60)
    s = int(secs % 60)
    ms = int((secs - int(secs)) * 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

def handle_volume(args):
    input_path = args.get('input', '')
    output_path = args.get('output', '')
    volume = args.get('volume', 1.0)
    if not input_path or not output_path:
        return result_error('"input" and "output" are required')
    vol_str = str(volume)
    if isinstance(volume, str) and 'dB' in volume:
        rc, out, err = run_ffmpeg(['-af', f'volume={vol_str}', output_path], input_path)
    else:
        rc, out, err = run_ffmpeg(['-af', f'volume={float(volume)}', output_path], input_path)
    if rc != 0:
        return result_error(f'ffmpeg failed:\n{err}')
    return result_text(f'Volume adjusted to {volume}: {output_path}')

TOOLS = [
    {'name': 'ffmpeg_probe', 'description': 'Get detailed info about a media file (codecs, resolution, duration, streams) using ffprobe', 'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {'path': {'type': 'string', 'description': 'Path to media file'}}}},
    {'name': 'ffmpeg_convert', 'description': 'Convert a media file between formats', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'vcodec': {'type': 'string', 'description': 'Video codec (e.g. libx264, libx265, h264_nvenc, copy)'}, 'acodec': {'type': 'string', 'description': 'Audio codec (e.g. aac, libmp3lame, copy)'}, 'bitrate': {'type': 'string', 'description': 'Video bitrate (e.g. 2M, 500k)'}, 'extra_args': {'type': 'string', 'description': 'Extra ffmpeg arguments as a space-separated string'}}}},
    {'name': 'ffmpeg_extract_audio', 'description': 'Extract audio track from a video file', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output audio path (e.g. output.mp3)'}, 'codec': {'type': 'string', 'description': 'Audio codec (default libmp3lame)'}, 'bitrate': {'type': 'string', 'description': 'Audio bitrate (default 192k)'}}}},
    {'name': 'ffmpeg_extract_video', 'description': 'Extract video track without re-encoding (removes audio)', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output video path'}}}},
    {'name': 'ffmpeg_resize', 'description': 'Resize/scale video to given dimensions', 'inputSchema': {'type': 'object', 'required': ['input', 'output', 'width', 'height'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'width': {'type': 'number', 'description': 'Target width in pixels'}, 'height': {'type': 'number', 'description': 'Target height in pixels'}}}},
    {'name': 'ffmpeg_crop', 'description': 'Crop a video to given dimensions and offset', 'inputSchema': {'type': 'object', 'required': ['input', 'output', 'width', 'height'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'width': {'type': 'number', 'description': 'Crop width'}, 'height': {'type': 'number', 'description': 'Crop height'}, 'x': {'type': 'number', 'description': 'X offset (default 0)'}, 'y': {'type': 'number', 'description': 'Y offset (default 0)'}}}},
    {'name': 'ffmpeg_trim', 'description': 'Trim a video/audio file by start time, duration, or end time', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'start': {'type': 'string', 'description': 'Start time (e.g. 00:01:30 or 90)'}, 'duration': {'type': 'string', 'description': 'Duration (e.g. 30 for 30 seconds)'}, 'end': {'type': 'string', 'description': 'End time (e.g. 00:02:00)'}}}},
    {'name': 'ffmpeg_concat', 'description': 'Concatenate multiple media files (same codecs expected)', 'inputSchema': {'type': 'object', 'required': ['inputs', 'output'], 'properties': {'inputs': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Array of file paths to concatenate'}, 'output': {'type': 'string', 'description': 'Output file path'}}}},
    {'name': 'ffmpeg_screenshot', 'description': 'Capture a screenshot from a video at a given timestamp', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input video path'}, 'output': {'type': 'string', 'description': 'Output image path (e.g. frame.png)'}, 'timestamp': {'type': 'string', 'description': 'Timestamp (default 00:00:00)'}, 'width': {'type': 'number', 'description': 'Scale width (optional)'}}}},
    {'name': 'ffmpeg_gif', 'description': 'Create an animated GIF from a video segment', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input video path'}, 'output': {'type': 'string', 'description': 'Output GIF path'}, 'start': {'type': 'string', 'description': 'Start time (default 0)'}, 'duration': {'type': 'string', 'description': 'Duration in seconds (default 5)'}, 'fps': {'type': 'number', 'description': 'Frame rate (default 10)'}, 'width': {'type': 'number', 'description': 'Output width (default 480)'}}}},
    {'name': 'ffmpeg_metadata', 'description': 'Read or write metadata tags on a media file', 'inputSchema': {'type': 'object', 'required': ['path', 'action'], 'properties': {'path': {'type': 'string', 'description': 'File path'}, 'action': {'type': 'string', 'enum': ['read', 'write'], 'description': 'read or write'}, 'key': {'type': 'string', 'description': 'Metadata key (required for write)'}, 'value': {'type': 'string', 'description': 'Metadata value (required for write)'}, 'output': {'type': 'string', 'description': 'Output path for write (default: overwrite input)'}}}},
    {'name': 'ffmpeg_speed', 'description': 'Change playback speed of a video/audio file', 'inputSchema': {'type': 'object', 'required': ['input', 'output', 'speed'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'speed': {'type': 'number', 'description': 'Speed multiplier (e.g. 2 for 2x, 0.5 for half speed)'}}}},
    {'name': 'ffmpeg_overlay', 'description': 'Overlay text or an image logo onto a video', 'inputSchema': {'type': 'object', 'required': ['input', 'output'], 'properties': {'input': {'type': 'string', 'description': 'Input video path'}, 'output': {'type': 'string', 'description': 'Output video path'}, 'overlay': {'type': 'string', 'description': 'Image path to overlay (alternative to text)'}, 'text': {'type': 'string', 'description': 'Text to overlay (alternative to overlay)'}, 'position': {'type': 'string', 'enum': ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'], 'description': 'Position (default bottom-right)'}, 'fontsize': {'type': 'number', 'description': 'Font size for text (default 24)'}, 'fontcolor': {'type': 'string', 'description': 'Font color (default white)'}}}},
    {'name': 'ffmpeg_merge', 'description': 'Merge a video file with a separate audio file', 'inputSchema': {'type': 'object', 'required': ['video', 'audio', 'output'], 'properties': {'video': {'type': 'string', 'description': 'Input video file path'}, 'audio': {'type': 'string', 'description': 'Input audio file path'}, 'output': {'type': 'string', 'description': 'Output file path'}}}},
    {'name': 'ffmpeg_volume', 'description': 'Adjust audio volume of a media file', 'inputSchema': {'type': 'object', 'required': ['input', 'output', 'volume'], 'properties': {'input': {'type': 'string', 'description': 'Input file path'}, 'output': {'type': 'string', 'description': 'Output file path'}, 'volume': {'description': 'Volume multiplier (e.g. 2.0 for 2x) or dB value (e.g. "5dB"). Default 1.0'}}}},
    {'name': 'ffmpeg_transcribe', 'description': 'Transcribe or translate speech from a media file to text using Whisper (requires openai-whisper or faster-whisper installed)', 'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {'path': {'type': 'string', 'description': 'Path to media file with speech'}, 'model': {'type': 'string', 'description': 'Whisper model size: tiny, base, small, medium, large, large-v2, large-v3 (default base)'}, 'language': {'type': 'string', 'description': 'Language code (e.g. en, es, fr). Auto-detected if omitted'}, 'task': {'type': 'string', 'enum': ['transcribe', 'translate'], 'description': 'transcribe or translate to English (default transcribe)'}, 'timestamps': {'type': 'boolean', 'description': 'Include timestamped segments (default false)'}}}},
]

HANDLERS = {
    'ffmpeg_probe': handle_probe,
    'ffmpeg_convert': handle_convert,
    'ffmpeg_extract_audio': handle_extract_audio,
    'ffmpeg_extract_video': handle_extract_video,
    'ffmpeg_resize': handle_resize,
    'ffmpeg_crop': handle_crop,
    'ffmpeg_trim': handle_trim,
    'ffmpeg_concat': handle_concat,
    'ffmpeg_screenshot': handle_screenshot,
    'ffmpeg_gif': handle_gif,
    'ffmpeg_metadata': handle_metadata,
    'ffmpeg_speed': handle_speed,
    'ffmpeg_overlay': handle_overlay,
    'ffmpeg_merge': handle_merge,
    'ffmpeg_volume': handle_volume,
    'ffmpeg_transcribe': handle_transcribe,
}

def send(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    try: sys.stdout.flush()
    except AttributeError: pass

def main():
    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:
            break
        raw = raw.decode('utf-8', errors='replace').strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        msg_id = msg.get('id')
        method = msg.get('method', '')
        params = msg.get('params', {})

        if method == 'initialize':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {
                'protocolVersion': '2024-11-05',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'sennoric-ffmpeg', 'version': '1.0.0'},
            }})
        elif method == 'notifications/initialized':
            pass
        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}})
        elif method == 'tools/call':
            name = params.get('name', '')
            args = params.get('arguments', {})
            handler = HANDLERS.get(name)
            if handler is None:
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'Unknown tool: {name}')})
                continue
            try:
                result = handler(args)
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result})
            except Exception as e:
                tb = traceback.format_exc()
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'{e}\n{tb}')})
        elif msg_id is not None:
            send({'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': -32601, 'message': f'Unknown method: {method}'}})

if __name__ == '__main__':
    main()
