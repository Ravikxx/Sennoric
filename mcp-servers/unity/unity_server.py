#!/usr/bin/env python3
"""Unity MCP server — JSON-RPC 2.0 over stdio, forwards tool calls to the
SennoricBridge C# editor script running inside Unity.

Usage
-----
  python3 unity_server.py

Requires the Unity editor open on a project that contains
`SennoricBridge.cs` in an `Editor/` folder (Sennoric copies it there via /unity).
The bridge listens on localhost:9877.

Environment
-----------
  SENNORIC_UNITY_PORT  Bridge port (default 9877)
"""

import sys
import os
import json
import socket
import threading
import traceback

BRIDGE_PORT = int(os.environ.get('SENNORIC_UNITY_PORT', '9877'))

def result_text(text):
    return {'content': [{'type': 'text', 'text': str(text)}]}

def result_error(text):
    return {'content': [{'type': 'text', 'text': str(text)}], 'isError': True}

# ── Bridge connection (TCP, newline-delimited JSON) ──────────────────────────

def _try_bridge():
    try:
        s = socket.create_connection(('127.0.0.1', BRIDGE_PORT), timeout=2)
        s.settimeout(None)
        return s
    except (socket.timeout, ConnectionRefusedError, OSError):
        return None

_BRIDGE = {'sock': None, 'buf': b''}
_BRIDGE_LOCK = threading.Lock()

def _bridge_request(msg, timeout=25):
    """Send one JSON-RPC message to the bridge and return its decoded reply,
    or None if no bridge is reachable. Reconnects once on a broken socket."""
    with _BRIDGE_LOCK:
        for attempt in (1, 2):
            sock = _BRIDGE['sock']
            if sock is None:
                sock = _try_bridge()
                if sock is None:
                    return None
                _BRIDGE['sock'] = sock
                _BRIDGE['buf'] = b''
            try:
                sock.settimeout(timeout)
                sock.sendall((json.dumps(msg, default=str) + '\n').encode('utf-8'))
                buf = _BRIDGE['buf']
                while b'\n' not in buf:
                    data = sock.recv(65536)
                    if not data:
                        raise ConnectionError('bridge closed')
                    buf += data
                line, _BRIDGE['buf'] = buf.split(b'\n', 1)
                return json.loads(line.decode('utf-8'))
            except Exception:
                try:
                    sock.close()
                except Exception:
                    pass
                _BRIDGE['sock'] = None
                _BRIDGE['buf'] = b''
                if attempt == 2:
                    return None
    return None

NO_BRIDGE_HELP = (
    f'Cannot reach the Unity bridge on localhost:{BRIDGE_PORT}.\n'
    'Make sure:\n'
    '  1. The Unity editor is open on your project\n'
    '  2. SennoricBridge.cs is in an Editor/ folder of that project\n'
    '     (run /unity in Sennoric to see setup instructions)\n'
    '  3. The Unity console shows "[SennoricBridge] listening on 127.0.0.1:'
    f'{BRIDGE_PORT}"\n'
    'Note: the bridge restarts automatically after script compilation and '
    'when entering/exiting play mode — retry once if a call fails right after either.'
)

# ── Tool registry ─────────────────────────────────────────────────────────────
# Handlers live in the C# bridge (SennoricBridge.cs); this list only describes them.

_VEC3 = {'type': 'array', 'items': {'type': 'number'}, 'minItems': 3, 'maxItems': 3}

TOOLS = [
    {
        'name': 'unity_get_scene_info',
        'description': 'Get the active scene: name, asset path, root object count, dirty flag, and play-mode state',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'unity_list_gameobjects',
        'description': 'List every GameObject in the active scene with its full hierarchy path and active state',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'unity_select_gameobject',
        'description': 'Select a GameObject in the editor by hierarchy path (e.g. "Player/Arm/Hand") and return its transform and components',
        'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {
            'path': {'type': 'string', 'description': 'Hierarchy path, "/"-separated (see unity_list_gameobjects)'},
        }},
    },
    {
        'name': 'unity_create_gameobject',
        'description': 'Create a GameObject in the active scene — empty or a primitive (cube, sphere, capsule, cylinder, plane, quad)',
        'inputSchema': {'type': 'object', 'properties': {
            'name':      {'type': 'string', 'description': 'GameObject name (default "GameObject")'},
            'primitive': {'type': 'string', 'enum': ['empty', 'cube', 'sphere', 'capsule', 'cylinder', 'plane', 'quad'],
                          'description': 'Primitive type (default empty)'},
            'position':  {**_VEC3, 'description': 'World position [x, y, z] (default [0,0,0])'},
            'parent':    {'type': 'string', 'description': 'Hierarchy path of the parent GameObject (optional)'},
        }},
    },
    {
        'name': 'unity_delete_gameobject',
        'description': 'Delete a GameObject (and its children) by hierarchy path. Undo-able in the editor.',
        'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {
            'path': {'type': 'string', 'description': 'Hierarchy path of the GameObject to delete'},
        }},
    },
    {
        'name': 'unity_set_transform',
        'description': 'Set position, rotation (euler degrees), and/or scale of a GameObject by hierarchy path',
        'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {
            'path':     {'type': 'string', 'description': 'Hierarchy path of the GameObject'},
            'position': {**_VEC3, 'description': 'World position [x, y, z]'},
            'rotation': {**_VEC3, 'description': 'Euler angles in degrees [x, y, z]'},
            'scale':    {**_VEC3, 'description': 'Local scale [x, y, z]'},
        }},
    },
    {
        'name': 'unity_run_menu_command',
        'description': 'Execute a Unity editor menu item by its path, e.g. "File/Save Project" or "GameObject/Create Empty"',
        'inputSchema': {'type': 'object', 'required': ['menu_path'], 'properties': {
            'menu_path': {'type': 'string', 'description': 'Menu path exactly as shown in the editor menus'},
        }},
    },
    {
        'name': 'unity_play_mode',
        'description': 'Enter or exit play mode, or toggle pause. Note: entering/exiting play mode reloads scripts, so the bridge briefly disconnects — retry the next call once if it fails.',
        'inputSchema': {'type': 'object', 'required': ['action'], 'properties': {
            'action': {'type': 'string', 'enum': ['enter', 'exit', 'pause', 'unpause'],
                       'description': 'Play-mode action'},
        }},
    },
]

# ── MCP stdio transport ───────────────────────────────────────────────────────

def send(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    try:
        sys.stdout.flush()
    except AttributeError:
        pass

def main():
    # Handshake (initialize / tools/list) is answered locally and immediately —
    # never probe Unity before the handshake completes. The bridge is only
    # contacted on tools/call, so the MCP connection succeeds even when the
    # Unity editor is closed.
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
                    'serverInfo': {'name': 'sennoric-unity', 'version': '1.0.0'},
                },
            })

        elif method == 'notifications/initialized':
            pass

        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}})

        elif method == 'tools/call':
            name = params.get('name', '')
            if name not in {t['name'] for t in TOOLS}:
                send({'jsonrpc': '2.0', 'id': msg_id,
                      'result': result_error(f'Unknown tool: {name}')})
                continue
            try:
                reply = _bridge_request({'jsonrpc': '2.0', 'id': msg_id,
                                         'method': method, 'params': params})
                if reply is None:
                    send({'jsonrpc': '2.0', 'id': msg_id,
                          'result': result_error(NO_BRIDGE_HELP)})
                else:
                    send(reply)
            except Exception as e:
                tb = traceback.format_exc()
                send({'jsonrpc': '2.0', 'id': msg_id,
                      'result': result_error(f'{e}\n{tb}')})

        elif msg_id is not None:
            send({
                'jsonrpc': '2.0', 'id': msg_id,
                'error': {'code': -32601, 'message': f'Unknown method: {method}'},
            })

if __name__ == '__main__':
    main()
