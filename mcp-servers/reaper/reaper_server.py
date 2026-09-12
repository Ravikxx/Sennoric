#!/usr/bin/env python3
"""Reaper MCP server — JSON-RPC 2.0 over stdio, controls Reaper via its built-in Web Interface.

Usage
-----
  python3 reaper_server.py

Requires Reaper running with the Web Interface enabled:
  Preferences → Control/OSC/web → Web interface → Enable

Environment
-----------
  REAPER_PORT  Web interface port (default 8080)
  REAPER_HOST  Web interface host (default localhost)
"""

import sys
import os
import json
import traceback
import urllib.request
import urllib.parse
import urllib.error

REAPER_HOST = os.environ.get('REAPER_HOST', 'localhost')
REAPER_PORT = int(os.environ.get('REAPER_PORT', '8080'))
_BASE = f'http://{REAPER_HOST}:{REAPER_PORT}'

# ── HTTP helpers ─────────────────────────────────────────────────────────────

def _reascript(lua):
    """POST a Lua snippet to /reascript-run. Returns console output as string."""
    url = _BASE + '/reascript-run'
    data = lua.encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST',
                                  headers={'Content-Type': 'text/plain'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except urllib.error.URLError as e:
        raise RuntimeError(
            f'Cannot reach Reaper at {_BASE}.\n'
            f'Make sure Reaper is running with the Web Interface enabled:\n'
            f'  Preferences → Control/OSC/web → Web interface → Enable\n'
            f'Set REAPER_PORT if your port is not 8080 (current: {REAPER_PORT}).'
        ) from e

def result_text(text):
    return {'content': [{'type': 'text', 'text': str(text)}]}

def result_error(text):
    return {'content': [{'type': 'text', 'text': str(text)}], 'isError': True}

def _lua_str(s):
    """Escape a Python string for embedding in a Lua single-quoted string."""
    return str(s or '').replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n').replace('\r', '')

# ── Shared Lua helpers (prepended to scripts that need string escaping) ──────

_LUA_ESC = r"""
local function esc(s)
  if s == nil then return '' end
  s = tostring(s)
  s = s:gsub('\\', '\\\\')
  s = s:gsub('"', '\\"')
  s = s:gsub('\n', '\\n')
  s = s:gsub('\r', '')
  return s
end
"""

# ── Tool handlers ─────────────────────────────────────────────────────────────

def handle_get_project_info(args):
    lua = _LUA_ESC + r"""
local bpm, _ = reaper.GetProjectTimeSignature2(0)
local name = reaper.GetProjectName(0, '')
local length = reaper.GetProjectLength(0)
local ps = reaper.GetPlayState()
local pos = reaper.GetPlayPosition()
local ntracks = reaper.CountTracks(0)
local ps_text = 'stopped'
if ps & 1 ~= 0 then ps_text = 'playing' end
if ps & 2 ~= 0 then ps_text = 'paused' end
if ps & 4 ~= 0 then ps_text = 'recording' end
reaper.ShowConsoleMsg(string.format(
  '{"name":"%s","bpm":%.4f,"length_s":%.3f,"num_tracks":%d,"play_state":"%s","position_s":%.3f}',
  esc(name), bpm, length, ntracks, ps_text, pos
))
"""
    out = _reascript(lua).strip()
    if not out:
        return result_text('{}')
    try:
        return result_text(json.dumps(json.loads(out), indent=2))
    except json.JSONDecodeError:
        return result_text(out)


def handle_get_tracks(args):
    lua = _LUA_ESC + r"""
local n = reaper.CountTracks(0)
local parts = {}
for i = 0, n - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, name = reaper.GetTrackName(tr)
  local vol = reaper.GetMediaTrackInfo_Value(tr, 'D_VOL')
  local pan = reaper.GetMediaTrackInfo_Value(tr, 'D_PAN')
  local mute = reaper.GetMediaTrackInfo_Value(tr, 'B_MUTE')
  local solo = reaper.GetMediaTrackInfo_Value(tr, 'I_SOLO')
  local arm  = reaper.GetMediaTrackInfo_Value(tr, 'I_RECARM')
  local db = vol > 0 and (20 * math.log(vol) / math.log(10)) or -144
  parts[#parts + 1] = string.format(
    '{"index":%d,"name":"%s","volume_db":%.2f,"pan":%.3f,"muted":%s,"soloed":%s,"armed":%s}',
    i + 1, esc(name), db, pan,
    tostring(mute > 0), tostring(solo > 0), tostring(arm > 0)
  )
end
reaper.ShowConsoleMsg('[' .. table.concat(parts, ',') .. ']')
"""
    out = _reascript(lua).strip()
    try:
        return result_text(json.dumps(json.loads(out or '[]'), indent=2))
    except json.JSONDecodeError:
        return result_text(out or '[]')


def handle_transport(args):
    action = (args.get('action') or 'play').lower()
    position_s = args.get('position_s')

    # Reaper native action IDs for transport
    NATIVE = {
        'play':   1007,
        'stop':   1016,
        'pause':  1008,
        'record': 1013,
    }

    if action == 'rewind':
        lua = 'reaper.SetEditCurPos(0, true, false)\nreaper.ShowConsoleMsg("ok")'
    elif action == 'seek':
        if position_s is None:
            return result_error('"position_s" (seconds) is required for seek')
        lua = f'reaper.SetEditCurPos({float(position_s)}, true, false)\nreaper.ShowConsoleMsg("ok")'
    elif action in NATIVE:
        lua = f'reaper.Main_OnCommand({NATIVE[action]}, 0)\nreaper.ShowConsoleMsg("ok")'
    else:
        return result_error(f'Unknown action "{action}". Valid: play, stop, pause, record, rewind, seek')

    _reascript(lua)
    return result_text(f'Transport: {action}')


def handle_set_bpm(args):
    bpm = args.get('bpm')
    if bpm is None:
        return result_error('"bpm" is required')
    bpm = float(bpm)
    if not (20 <= bpm <= 960):
        return result_error('BPM must be between 20 and 960')
    lua = f'reaper.SetCurrentBPM(0, {bpm}, true)\nreaper.ShowConsoleMsg("ok")'
    _reascript(lua)
    return result_text(f'BPM set to {bpm}')


def handle_create_track(args):
    name = _lua_str(args.get('name', ''))
    lua = f"""
local n = reaper.CountTracks(0)
reaper.InsertTrackAtIndex(n, true)
local tr = reaper.GetTrack(0, n)
if tr then
  reaper.GetSetMediaTrackInfo_String(tr, 'P_NAME', '{name}', true)
  reaper.ShowConsoleMsg(tostring(n + 1))
else
  reaper.ShowConsoleMsg('error')
end
"""
    out = _reascript(lua).strip()
    if out == 'error':
        return result_error('Failed to create track')
    display_name = args.get('name', '')
    try:
        idx = int(out)
        return result_text(f'Created track {idx}' + (f': "{display_name}"' if display_name else ''))
    except ValueError:
        return result_text(f'Created track' + (f': "{display_name}"' if display_name else ''))


def handle_set_track_volume(args):
    index = args.get('index')
    if index is None:
        return result_error('"index" (1-based track index) is required')
    index = int(index)
    db = args.get('volume_db')
    pan = args.get('pan')
    if db is None and pan is None:
        return result_error('Provide at least one of "volume_db" or "pan"')

    lines = [
        f'local tr = reaper.GetTrack(0, {index - 1})',
        'if not tr then reaper.ShowConsoleMsg("no_track") return end',
    ]
    if db is not None:
        db = float(db)
        lines.append(f'local vol = math.exp({db} * math.log(10) / 20)')
        lines.append('reaper.SetMediaTrackInfo_Value(tr, "D_VOL", vol)')
    if pan is not None:
        pan = max(-1.0, min(1.0, float(pan)))
        lines.append(f'reaper.SetMediaTrackInfo_Value(tr, "D_PAN", {pan})')
    lines.append('reaper.ShowConsoleMsg("ok")')

    out = _reascript('\n'.join(lines)).strip()
    if out == 'no_track':
        return result_error(f'No track at index {index} (use reaper_get_tracks to list tracks)')
    parts = []
    if db is not None:
        parts.append(f'volume={db:.1f}dB')
    if pan is not None:
        parts.append(f'pan={pan:.3f}')
    return result_text(f'Track {index}: {", ".join(parts)}')


def handle_get_markers(args):
    lua = _LUA_ESC + r"""
local n = reaper.CountProjectMarkers(0)
local parts = {}
for i = 0, n - 1 do
  local retval, isrgn, pos, rgnend, name, markridx = reaper.EnumProjectMarkers2(0, i)
  if retval then
    parts[#parts + 1] = string.format(
      '{"id":%d,"position_s":%.3f,"name":"%s","is_region":%s}',
      markridx, pos, esc(name), tostring(isrgn)
    )
  end
end
reaper.ShowConsoleMsg('[' .. table.concat(parts, ',') .. ']')
"""
    out = _reascript(lua).strip()
    try:
        return result_text(json.dumps(json.loads(out or '[]'), indent=2))
    except json.JSONDecodeError:
        return result_text(out or '[]')


def handle_add_marker(args):
    position_s = float(args.get('position_s', 0.0))
    name = _lua_str(args.get('name', ''))
    lua = f"""
local idx = reaper.AddProjectMarker2(0, false, {position_s}, 0, '{name}', -1, 0)
reaper.ShowConsoleMsg(tostring(idx))
"""
    out = _reascript(lua).strip()
    display_name = args.get('name', '')
    try:
        return result_text(f'Added marker at {position_s}s' + (f': "{display_name}"' if display_name else '') + f' (id={int(out)})')
    except (ValueError, TypeError):
        return result_text(f'Added marker at {position_s}s')


def handle_run_action(args):
    action_id = args.get('action_id')
    if action_id is None:
        return result_error('"action_id" is required (integer command ID from Reaper Actions dialog)')
    lua = f'reaper.Main_OnCommand({int(action_id)}, 0)\nreaper.ShowConsoleMsg("ok")'
    _reascript(lua)
    return result_text(f'Ran action {action_id}')


def handle_create_midi(args):
    try:
        from midiutil import MIDIFile
    except ImportError:
        return result_error(
            'midiutil is not installed.\n'
            'Install it with:  pip install midiutil\n'
            'Then retry reaper_create_midi.'
        )
    import tempfile

    notes = args.get('notes')
    if not notes:
        return result_error(
            '"notes" array is required.\n'
            'Each note: {"pitch": 60, "start_beat": 0, "duration_beats": 1, "velocity": 80}'
        )

    bpm        = float(args.get('bpm', 120))
    track_name = str(args.get('track_name', 'MIDI'))

    mid = MIDIFile(1)
    mid.addTempo(0, 0, bpm)
    for n in notes:
        pitch    = int(n.get('pitch', 60))
        start    = float(n.get('start_beat', 0))
        duration = float(n.get('duration_beats', 1))
        velocity = int(n.get('velocity', 80))
        mid.addNote(0, 0, pitch, start, duration, velocity)

    fd, tmp_path = tempfile.mkstemp(suffix='.mid')
    try:
        with os.fdopen(fd, 'wb') as f:
            mid.writeFile(f)

        escaped_path = _lua_str(tmp_path)
        escaped_name = _lua_str(track_name)
        lua = f"""
local n = reaper.CountTracks(0)
reaper.InsertTrackAtIndex(n, true)
local tr = reaper.GetTrack(0, n)
reaper.GetSetMediaTrackInfo_String(tr, 'P_NAME', '{escaped_name}', true)
reaper.SetOnlyTrackSelected(tr)
reaper.InsertMedia('{escaped_path}', 0)
reaper.UpdateArrange()
reaper.ShowConsoleMsg(tostring(n + 1))
"""
        out = _reascript(lua).strip()
        try:
            tidx = int(out)
            return result_text(
                f'Created MIDI track "{track_name}" at index {tidx}\n'
                f'{len(notes)} notes, {bpm} BPM'
            )
        except (ValueError, TypeError):
            return result_text(f'Imported MIDI with {len(notes)} notes into new track "{track_name}"')
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Tool registry ─────────────────────────────────────────────────────────────

TOOLS = [
    {
        'name': 'reaper_get_project_info',
        'description': 'Get current project name, BPM, length (seconds), track count, and transport state',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'reaper_get_tracks',
        'description': 'List all tracks: 1-based index, name, volume (dB), pan (-1..1), muted, soloed, armed',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'reaper_transport',
        'description': 'Control transport: play, stop, pause, record, rewind, or seek to a position in seconds',
        'inputSchema': {'type': 'object', 'properties': {
            'action': {
                'type': 'string',
                'enum': ['play', 'stop', 'pause', 'record', 'rewind', 'seek'],
                'description': 'Transport action',
            },
            'position_s': {
                'type': 'number',
                'description': 'Position in seconds — required when action is "seek"',
            },
        }},
    },
    {
        'name': 'reaper_set_bpm',
        'description': 'Set the project BPM (tempo)',
        'inputSchema': {'type': 'object', 'required': ['bpm'], 'properties': {
            'bpm': {'type': 'number', 'description': 'Tempo in beats per minute (20–960)'},
        }},
    },
    {
        'name': 'reaper_create_track',
        'description': 'Add a new track at the end of the track list',
        'inputSchema': {'type': 'object', 'properties': {
            'name': {'type': 'string', 'description': 'Track name (optional)'},
        }},
    },
    {
        'name': 'reaper_set_track_volume',
        'description': 'Set volume (dB) and/or pan for a track by 1-based index',
        'inputSchema': {'type': 'object', 'required': ['index'], 'properties': {
            'index':     {'type': 'number', 'description': '1-based track index'},
            'volume_db': {'type': 'number', 'description': 'Volume in dB (0 = unity gain, negative = quieter)'},
            'pan':       {'type': 'number', 'description': 'Pan position (-1 = full left, 0 = center, 1 = full right)'},
        }},
    },
    {
        'name': 'reaper_get_markers',
        'description': 'List all project markers: id, position (seconds), name, whether each is a region',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'reaper_add_marker',
        'description': 'Add a named marker at a position in seconds',
        'inputSchema': {'type': 'object', 'properties': {
            'position_s': {'type': 'number', 'description': 'Marker position in seconds (default 0)'},
            'name':       {'type': 'string', 'description': 'Marker label'},
        }},
    },
    {
        'name': 'reaper_run_action',
        'description': 'Run any Reaper action by its integer command ID. Find IDs in the Reaper Actions dialog (Actions menu → Show action list).',
        'inputSchema': {'type': 'object', 'required': ['action_id'], 'properties': {
            'action_id': {'type': 'number', 'description': 'Reaper action command ID (integer)'},
        }},
    },
    {
        'name': 'reaper_create_midi',
        'description': (
            'Generate a MIDI file from a note array and import it into Reaper as a new track. '
            'Requires midiutil (pip install midiutil). '
            'Each note: {pitch (0-127, 60=middle C), start_beat, duration_beats, velocity (1-127)}.'
        ),
        'inputSchema': {'type': 'object', 'required': ['notes'], 'properties': {
            'notes': {
                'type': 'array',
                'description': 'Notes to write into the MIDI file',
                'items': {'type': 'object', 'properties': {
                    'pitch':          {'type': 'number', 'description': 'MIDI pitch 0-127'},
                    'start_beat':     {'type': 'number', 'description': 'Start position in beats'},
                    'duration_beats': {'type': 'number', 'description': 'Duration in beats'},
                    'velocity':       {'type': 'number', 'description': 'Velocity 1-127 (default 80)'},
                }},
            },
            'bpm':        {'type': 'number', 'description': 'BPM for the MIDI file (default 120)'},
            'track_name': {'type': 'string', 'description': 'Name for the new Reaper track (default "MIDI")'},
        }},
    },
]

HANDLERS = {
    'reaper_get_project_info':  handle_get_project_info,
    'reaper_get_tracks':        handle_get_tracks,
    'reaper_transport':         handle_transport,
    'reaper_set_bpm':           handle_set_bpm,
    'reaper_create_track':      handle_create_track,
    'reaper_set_track_volume':  handle_set_track_volume,
    'reaper_get_markers':       handle_get_markers,
    'reaper_add_marker':        handle_add_marker,
    'reaper_run_action':        handle_run_action,
    'reaper_create_midi':       handle_create_midi,
}

# ── MCP stdio transport ───────────────────────────────────────────────────────

def send(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    try:
        sys.stdout.flush()
    except AttributeError:
        pass

def main():
    # Handshake (initialize / tools/list) is answered locally and immediately —
    # never probe Reaper before the handshake completes. Reaper is only hit on
    # tools/call, so the MCP connection succeeds even when Reaper is closed.
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
            send({
                'jsonrpc': '2.0', 'id': msg_id, 'result': {
                    'protocolVersion': '2024-11-05',
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'sennoric-reaper', 'version': '1.0.0'},
                },
            })

        elif method == 'notifications/initialized':
            pass

        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}})

        elif method == 'tools/call':
            name = params.get('name', '')
            tool_args = params.get('arguments', {})
            handler = HANDLERS.get(name)
            if handler is None:
                send({'jsonrpc': '2.0', 'id': msg_id,
                      'result': result_error(f'Unknown tool: {name}')})
                continue
            try:
                result = handler(tool_args)
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result})
            except RuntimeError as e:
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(str(e))})
            except Exception as e:
                tb = traceback.format_exc()
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'{e}\n{tb}')})

        elif msg_id is not None:
            send({
                'jsonrpc': '2.0', 'id': msg_id,
                'error': {'code': -32601, 'message': f'Unknown method: {method}'},
            })

if __name__ == '__main__':
    main()
