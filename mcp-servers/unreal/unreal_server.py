#!/usr/bin/env python3
"""Unreal Engine MCP server — JSON-RPC 2.0 over stdio, talks to Unreal's
Remote Control HTTP API. No in-engine bridge code needed.

Usage
-----
  python3 unreal_server.py

Requires the Unreal editor open with the Remote Control API plugin enabled
(Edit → Plugins → search "Remote Control API" → enable → restart editor).
The HTTP server starts automatically on http://localhost:30010.

Environment
-----------
  UNREAL_RC_PORT  Remote Control port (default 30010)
  UNREAL_RC_HOST  Remote Control host (default localhost)
"""

import sys
import os
import json
import traceback
import urllib.request
import urllib.error

RC_HOST = os.environ.get('UNREAL_RC_HOST', 'localhost')
RC_PORT = int(os.environ.get('UNREAL_RC_PORT', '30010'))
_BASE = f'http://{RC_HOST}:{RC_PORT}'

# Well-known editor subsystem object paths (stable across UE5 versions)
ACTOR_SUBSYSTEM = '/Script/UnrealEd.Default__EditorActorSubsystem'
KISMET_SYSTEM   = '/Script/Engine.Default__KismetSystemLibrary'

def result_text(text):
    return {'content': [{'type': 'text', 'text': str(text)}]}

def result_error(text):
    return {'content': [{'type': 'text', 'text': str(text)}], 'isError': True}

# ── Remote Control HTTP helpers ───────────────────────────────────────────────

def _rc(endpoint, body, method='PUT'):
    """Send one request to the Remote Control API and return the parsed JSON reply."""
    url = _BASE + endpoint
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')
        try:
            detail = json.loads(detail).get('errorMessage', detail)
        except (json.JSONDecodeError, AttributeError):
            pass
        raise RuntimeError(f'Unreal returned HTTP {e.code}: {detail}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f'Cannot reach Unreal Remote Control at {_BASE}.\n'
            f'Make sure:\n'
            f'  1. The Unreal editor is open on your project\n'
            f'  2. The "Remote Control API" plugin is enabled '
            f'(Edit → Plugins → search "Remote Control API" → enable → restart)\n'
            f'Set UNREAL_RC_PORT if your port is not 30010 (current: {RC_PORT}).'
        ) from e

def _call(object_path, function_name, parameters=None):
    """Call a UFunction on an object via /remote/object/call."""
    body = {'objectPath': object_path, 'functionName': function_name}
    if parameters:
        body['parameters'] = parameters
    return _rc('/remote/object/call', body)

def _vec(v, keys=('X', 'Y', 'Z')):
    """[x, y, z] list → Unreal struct dict."""
    return {k: float(v[i]) for i, k in enumerate(keys)}

# ── Tool handlers ─────────────────────────────────────────────────────────────

def handle_list_actors(args):
    reply = _call(ACTOR_SUBSYSTEM, 'GetAllLevelActors')
    paths = reply.get('ReturnValue', [])
    actors = []
    for p in paths:
        # Object path looks like /Game/Maps/Map.Map:PersistentLevel.ActorName_0
        label = p.rsplit('.', 1)[-1]
        actors.append({'label': label, 'path': p})
    return result_text(json.dumps(actors, indent=2))

def handle_spawn_actor(args):
    actor_class = args.get('class')
    if not actor_class:
        return result_error(
            '"class" is required — an Unreal class path, e.g.\n'
            '  /Script/Engine.StaticMeshActor\n'
            '  /Script/Engine.PointLight\n'
            '  /Script/Engine.CameraActor\n'
            'or a Blueprint: /Game/Blueprints/BP_Thing.BP_Thing_C'
        )
    params = {'ActorClass': actor_class}
    if args.get('location') is not None:
        params['Location'] = _vec(args['location'])
    reply = _call(ACTOR_SUBSYSTEM, 'SpawnActorFromClass', params)
    spawned = reply.get('ReturnValue')
    if not spawned:
        return result_error(f'Spawn returned nothing — is "{actor_class}" a valid, loaded class?')
    return result_text(json.dumps({'spawned': spawned}, indent=2))

def handle_delete_actor(args):
    path = args.get('actor_path')
    if not path:
        return result_error('"actor_path" is required (use unreal_list_actors to find it)')
    reply = _call(ACTOR_SUBSYSTEM, 'DestroyActor', {'ActorToDestroy': path})
    if reply.get('ReturnValue'):
        return result_text(f'Deleted {path}')
    return result_error(f'Failed to delete {path} (already gone, or not destroyable)')

def handle_set_actor_transform(args):
    path = args.get('actor_path')
    if not path:
        return result_error('"actor_path" is required (use unreal_list_actors to find it)')
    loc, rot, scale = args.get('location'), args.get('rotation'), args.get('scale')
    if loc is None and rot is None and scale is None:
        return result_error('Provide at least one of "location", "rotation", "scale"')
    applied = []
    if loc is not None:
        _call(path, 'K2_SetActorLocation',
              {'NewLocation': _vec(loc), 'bSweep': False, 'bTeleport': True})
        applied.append(f'location={loc}')
    if rot is not None:
        _call(path, 'K2_SetActorRotation',
              {'NewRotation': _vec(rot, ('Pitch', 'Yaw', 'Roll')), 'bTeleportPhysics': True})
        applied.append(f'rotation={rot}')
    if scale is not None:
        _call(path, 'SetActorScale3D', {'NewScale3D': _vec(scale)})
        applied.append(f'scale={scale}')
    return result_text(f'{path}: {", ".join(applied)}')

def handle_get_property(args):
    path = args.get('object_path')
    prop = args.get('property')
    if not path:
        return result_error('"object_path" is required')
    body = {'objectPath': path, 'access': 'READ_ACCESS'}
    if prop:
        body['propertyName'] = prop
    reply = _rc('/remote/object/property', body)
    return result_text(json.dumps(reply, indent=2))

def handle_set_property(args):
    path = args.get('object_path')
    prop = args.get('property')
    if not path or not prop or 'value' not in args:
        return result_error('"object_path", "property", and "value" are all required')
    _rc('/remote/object/property', {
        'objectPath': path,
        'access': 'WRITE_ACCESS',
        'propertyName': prop,
        'propertyValue': {prop: args['value']},
    })
    return result_text(f'Set {prop} on {path}')

def handle_call_function(args):
    path = args.get('object_path')
    func = args.get('function')
    if not path or not func:
        return result_error('"object_path" and "function" are required')
    reply = _call(path, func, args.get('parameters') or None)
    return result_text(json.dumps(reply, indent=2) if reply else 'OK (no return value)')

def handle_console_command(args):
    command = args.get('command')
    if not command:
        return result_error('"command" is required (e.g. "stat fps", "t.MaxFPS 120")')
    _call(KISMET_SYSTEM, 'ExecuteConsoleCommand', {'Command': command})
    return result_text(f'Executed console command: {command}')

# ── Tool registry ─────────────────────────────────────────────────────────────

_VEC3 = {'type': 'array', 'items': {'type': 'number'}, 'minItems': 3, 'maxItems': 3}

TOOLS = [
    {
        'name': 'unreal_list_actors',
        'description': 'List every actor in the current level with its label and full object path (paths are needed by the other tools)',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'unreal_spawn_actor',
        'description': 'Spawn an actor from a class path, e.g. /Script/Engine.StaticMeshActor, /Script/Engine.PointLight, or a Blueprint class /Game/BP_Thing.BP_Thing_C',
        'inputSchema': {'type': 'object', 'required': ['class'], 'properties': {
            'class':    {'type': 'string', 'description': 'Unreal class path to spawn'},
            'location': {**_VEC3, 'description': 'World location [x, y, z] in cm (default origin)'},
        }},
    },
    {
        'name': 'unreal_delete_actor',
        'description': 'Delete an actor from the level by its object path',
        'inputSchema': {'type': 'object', 'required': ['actor_path'], 'properties': {
            'actor_path': {'type': 'string', 'description': 'Actor object path (from unreal_list_actors)'},
        }},
    },
    {
        'name': 'unreal_set_actor_transform',
        'description': 'Set location (cm), rotation (degrees: pitch/yaw/roll), and/or scale of an actor',
        'inputSchema': {'type': 'object', 'required': ['actor_path'], 'properties': {
            'actor_path': {'type': 'string', 'description': 'Actor object path (from unreal_list_actors)'},
            'location':   {**_VEC3, 'description': 'World location [x, y, z] in cm'},
            'rotation':   {**_VEC3, 'description': 'Rotation [pitch, yaw, roll] in degrees'},
            'scale':      {**_VEC3, 'description': 'Scale [x, y, z]'},
        }},
    },
    {
        'name': 'unreal_get_property',
        'description': 'Read a property from any UObject by object path (omit "property" to read all exposed properties)',
        'inputSchema': {'type': 'object', 'required': ['object_path'], 'properties': {
            'object_path': {'type': 'string', 'description': 'UObject path (an actor path works)'},
            'property':    {'type': 'string', 'description': 'Property name (omit for all)'},
        }},
    },
    {
        'name': 'unreal_set_property',
        'description': 'Write a property on any UObject by object path',
        'inputSchema': {'type': 'object', 'required': ['object_path', 'property', 'value'], 'properties': {
            'object_path': {'type': 'string', 'description': 'UObject path'},
            'property':    {'type': 'string', 'description': 'Property name'},
            'value':       {'description': 'New value — scalar or struct object matching the property type'},
        }},
    },
    {
        'name': 'unreal_call_function',
        'description': 'Call any BlueprintCallable UFunction on an object — the generic escape hatch. Example: object_path=<actor path>, function="SetActorHiddenInGame", parameters={"bNewHidden": true}',
        'inputSchema': {'type': 'object', 'required': ['object_path', 'function'], 'properties': {
            'object_path': {'type': 'string', 'description': 'UObject path to call on'},
            'function':    {'type': 'string', 'description': 'UFunction name'},
            'parameters':  {'type': 'object', 'description': 'Function parameters by name (optional)'},
        }},
    },
    {
        'name': 'unreal_console_command',
        'description': 'Run an Unreal console command, e.g. "stat fps", "t.MaxFPS 120", "r.ScreenPercentage 50"',
        'inputSchema': {'type': 'object', 'required': ['command'], 'properties': {
            'command': {'type': 'string', 'description': 'Console command string'},
        }},
    },
]

HANDLERS = {
    'unreal_list_actors':         handle_list_actors,
    'unreal_spawn_actor':         handle_spawn_actor,
    'unreal_delete_actor':        handle_delete_actor,
    'unreal_set_actor_transform': handle_set_actor_transform,
    'unreal_get_property':        handle_get_property,
    'unreal_set_property':        handle_set_property,
    'unreal_call_function':       handle_call_function,
    'unreal_console_command':     handle_console_command,
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
    # never probe Unreal before the handshake completes. Unreal is only
    # contacted on tools/call, so the MCP connection succeeds even when the
    # editor is closed.
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
                    'serverInfo': {'name': 'sennoric-unreal', 'version': '1.0.0'},
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
