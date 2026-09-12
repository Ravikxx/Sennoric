#!/usr/bin/env python3.13
"""DaVinci Resolve MCP server — speaks MCP protocol (JSON-RPC 2.0) over stdio.

Usage
-----
  python3.13 resolve_server.py

Requires DaVinci Resolve 18+ running on the same machine.
Requires Python 3.13 (matching the fusionscript.dll ABI).

Environment
-----------
  RESOLVE_SCRIPT_API  Path to the DaVinci Resolve Scripting API Modules directory
  RESOLVE_SCRIPT_LIB  Path to the DaVinci Resolve scripting library (fbs.so/fbs.dll).
"""

import sys
import os
import json
import traceback
import platform
import socket
import threading
import time

_RESOLVE = None

def _find_resolve_lib():
    """Locate fusionscript.dll and set RESOLVE_SCRIPT_LIB so the wrapper can load it."""
    lib = os.environ.get('RESOLVE_SCRIPT_LIB')
    if lib and os.path.isfile(lib):
        return lib
    candidates = []
    if sys.platform == 'win32':
        for base in [
            os.environ.get('PROGRAMFILES', 'C:\\Program Files'),
            os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'),
            'E:\\', 'D:\\', 'C:\\',
        ]:
            p = os.path.join(base, 'Blackmagic Design', 'DaVinci Resolve', 'fusionscript.dll')
            candidates.append(p)
            candidates.append(os.path.join(base, 'fusionscript.dll'))
        candidates.append(os.path.join(os.environ.get('PROGRAMDATA', ''), 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules', 'fusionscript.dll'))
        # Try locating via Resolve.exe in PATH or common locations
        for d in os.environ.get('PATH', '').split(';'):
            d = d.strip().strip('"')
            if d and os.path.isfile(os.path.join(d, 'fusionscript.dll')):
                candidates.append(os.path.join(d, 'fusionscript.dll'))
    elif sys.platform == 'darwin':
        candidates.append('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.dylib')
    else:
        candidates.append('/opt/resolve/libs/Fusion/fusionscript.so')

    for c in candidates:
        if c and os.path.isfile(c):
            os.environ['RESOLVE_SCRIPT_LIB'] = c
            return c
    return None

def _find_resolve_module():
    api = os.environ.get('RESOLVE_SCRIPT_API')
    if api and os.path.isdir(api):
        return api
    candidates = []
    if sys.platform == 'win32':
        base = os.environ.get('PROGRAMDATA', '')
        candidates.append(os.path.join(base, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules'))
    elif sys.platform == 'darwin':
        candidates.append('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules')
        candidates.append(os.path.expanduser('~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules'))
    else:
        candidates.append('/opt/resolve/Developer/Scripting/Modules')
        candidates.append('/opt/resolve/libs/Fusion/Modules')
    for p in candidates:
        if os.path.isdir(p):
            return p
    return None

def get_resolve():
    global _RESOLVE
    if _RESOLVE is not None:
        return _RESOLVE
    lib_path = _find_resolve_lib()
    mod_path = _find_resolve_module()
    if lib_path and sys.platform == 'win32':
        lib_dir = os.path.dirname(lib_path)
        os.environ['PATH'] = lib_dir + os.pathsep + os.environ.get('PATH', '')
        try:
            os.add_dll_directory(lib_dir)
        except AttributeError:
            pass
    if mod_path and mod_path not in sys.path:
        sys.path.insert(0, mod_path)
    try:
        import DaVinciResolveScript as dvr
    except ImportError:
        _resolve_diagnose('import DaVinciResolveScript failed')
        return None
    try:
        _RESOLVE = dvr.scriptapp('Resolve')
    except Exception as e:
        _resolve_diagnose(f'scriptapp("Resolve") raised: {e}')
        return None
    if _RESOLVE is None:
        _resolve_diagnose('scriptapp("Resolve") returned None — Resolve is not accepting scripting connections')
    return _RESOLVE

def _resolve_diagnose(msg):
    if sys.version_info[:2] != (3, 13):
        from_ver = '.'.join(str(v) for v in sys.version_info[:2])
        raise RuntimeError(
            f'Python {from_ver} is incompatible with fusionscript.dll (requires Python 3.13).\n'
            f'Use /resolve status to auto-configure, or run the server manually with:\n'
            f'  python3.13 mcp-servers/davinci-resolve/resolve_server.py'
        )
    raise RuntimeError(
        f'Cannot connect to DaVinci Resolve.\n'
        f'{msg}\n\n'
        f'Troubleshooting:\n'
        f'  1. Is Resolve running? (start it)\n'
        f'  2. FREE Resolve: start the bridge from inside Resolve —\n'
        f'     Workspace -> Scripts -> Utility -> resolve_bridge, then retry\n'
        f'  3. STUDIO: Preferences (Ctrl+,) -> System -> General ->\n'
        f'     "External scripting using" -> Local -> Save, then run /resolve in Sennoric'
    )

def require_resolve():
    r = get_resolve()
    if r is None:
        raise RuntimeError('Cannot connect to DaVinci Resolve. Is it running?')
    return r

def _try_bridge():
    """Try connecting to the resolve_bridge.py TCP server."""
    try:
        s = socket.create_connection(('127.0.0.1', 9876), timeout=2)
        s.settimeout(None)
        return s
    except socket.timeout:
        return None
    except ConnectionRefusedError:
        return None
    except OSError:
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

def project_list():
    # Real API: GetProjectsInCurrentFolder() -> {index: name}
    r = require_resolve()
    pm = r.GetProjectManager()
    projects = pm.GetProjectsInCurrentFolder() or {}
    return sorted(v for v in projects.values() if v)

def timeline_info(timeline=None):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        raise RuntimeError('No project open')
    tl = timeline if timeline else proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError('No timeline in current project')
    start = tl.GetStartFrame()
    end = tl.GetEndFrame()
    return {
        'name': tl.GetName(),
        'duration_frames': (end - start) if (start is not None and end is not None) else None,
        'start_timecode': tl.GetStartTimecode(),
        'current_timecode': tl.GetCurrentTimecode(),
        'video_track_count': tl.GetTrackCount('video'),
        'audio_track_count': tl.GetTrackCount('audio'),
        'subtitle_track_count': tl.GetTrackCount('subtitle'),
    }

def result_text(text):
    return {"content": [{"type": "text", "text": str(text)}]}

def result_error(text):
    return {"content": [{"type": "text", "text": str(text)}], "isError": True}

# ── Tool handlers ────────────────────────────────────────────────────────

def handle_get_resolve_info(args):
    r = require_resolve()
    projects = project_list()
    current = None
    try:
        proj = r.GetCurrentProject()
        current = proj.GetName() if proj else None
    except Exception:
        pass
    info = {
        'current_project': current,
        'project_count': len(projects),
        'projects': projects,
    }
    if current:
        try:
            proj = r.GetCurrentProject()
            info['timeline_count'] = proj.GetTimelineCount()
            tl = proj.GetCurrentTimeline()
            if tl:
                info['current_timeline'] = timeline_info(tl)
        except Exception:
            pass
    return result_text(json.dumps(info, indent=2))

def handle_load_project(args):
    name = args.get('name', '')
    if not name:
        return result_error('"name" is required')
    r = require_resolve()
    pm = r.GetProjectManager()
    if pm.LoadProject(name):
        return result_text(f'Loaded project: {name}')
    return result_error(f'Failed to load project: {name}')

def handle_create_project(args):
    name = args.get('name', '')
    if not name:
        return result_error('"name" is required')
    r = require_resolve()
    pm = r.GetProjectManager()
    proj = pm.CreateProject(name)
    if proj:
        return result_text(f'Created project: {name}')
    return result_error(f'Failed to create project: {name} (may already exist)')

def handle_save_project(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    pm = r.GetProjectManager()
    if pm.SaveProject():  # SaveProject lives on ProjectManager, not Project
        return result_text(f'Saved project: {proj.GetName()}')
    return result_error('Failed to save project')

def handle_project_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    info = {
        'name': proj.GetName(),
        'timeline_count': proj.GetTimelineCount(),
        'render_job_count': len(proj.GetRenderJobList() or []),
        'render_presets': proj.GetRenderPresetList() or [],
    }
    return result_text(json.dumps(info, indent=2))

def handle_import_media(args):
    paths = args.get('paths', [])
    if isinstance(paths, str):
        paths = [paths]
    if not paths:
        return result_error('"paths" (string or array) is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    ms = r.GetMediaStorage()
    items = []
    for p in paths:
        abs_path = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(abs_path):
            items.append({'path': p, 'status': 'not found'})
            continue
        result = ms.AddItemListToMediaPool([abs_path])  # real API takes a list
        items.append({'path': p, 'status': 'imported' if result else 'failed'})
    return result_text(json.dumps(items, indent=2))

def handle_media_pool_list(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    if root is None:
        return result_text('[]')
    items = root.GetClipList()
    result = []
    for clip in items or []:
        result.append({
            'name': clip.GetName(),
            'duration': clip.GetClipProperty('Duration'),  # no GetDuration on MediaPoolItem
        })
    return result_text(json.dumps(result, indent=2))

def handle_create_timeline(args):
    name = args.get('name', 'Timeline 1')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    tl = mp.CreateEmptyTimeline(name)
    if tl:
        return result_text(f'Created timeline: {name}')
    return result_error(f'Failed to create timeline: {name}')

def handle_get_timeline_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    return result_text(json.dumps(timeline_info(tl), indent=2))

def handle_set_timecode(args):
    tc = args.get('timecode', '')
    if not tc:
        return result_error('"timecode" is required (HH:MM:SS:FF)')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    if tl.SetCurrentTimecode(tc):
        return result_text(f'Set timecode to {tc}')
    return result_error(f'Failed to set timecode')

def handle_get_timecode(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    tc = tl.GetCurrentTimecode()
    return result_text(tc or '00:00:00:00')

def handle_add_clip_to_timeline(args):
    clip_name = args.get('clip_name', '')
    if not clip_name:
        return result_error('"clip_name" is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    clips = root.GetClipList() if root else []
    target = None
    for clip in clips or []:
        if clip.GetName() == clip_name:
            target = clip
            break
    if target is None:
        return result_error(f'Clip not found: {clip_name}')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    item = mp.AppendToTimeline([target])
    if item:
        return result_text(f'Added clip "{clip_name}" to timeline')
    return result_error('Failed to add clip')

def handle_add_transition(args):
    # Resolve's scripting API has no way to add transitions programmatically.
    return result_error(
        "Resolve's scripting API does not support adding transitions programmatically. "
        "Add it manually in the Edit page (drag from Effects Library), or set a default "
        "transition and use the Edit page shortcuts."
    )

def handle_add_title(args):
    text = args.get('text', 'Title')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    # Real API: InsertFusionTitleIntoTimeline inserts at the playhead position.
    item = tl.InsertFusionTitleIntoTimeline('Text+')
    if not item:
        return result_error('Failed to insert title (is the playhead over the timeline?)')
    try:
        comp = item.GetFusionCompByIndex(1)
        tool = comp.FindTool('Template') if comp else None
        if tool:
            tool.SetInput('StyledText', text)
            return result_text(f'Added Text+ title with text "{text}" at the playhead')
    except Exception:
        pass
    return result_text('Added Text+ title at the playhead (set its text in the Inspector — automated text set failed)')

def handle_render_presets(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    presets = proj.GetRenderPresetList()
    return result_text(json.dumps(presets, indent=2) if presets else '[]')

def handle_add_render_job(args):
    preset_name = args.get('preset_name', '')
    preset_index = args.get('preset_index')
    render_path = args.get('render_path', '')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    # Real API: AddRenderJob() takes no arguments; presets apply via LoadRenderPreset(name).
    if not preset_name and preset_index is not None:
        presets = proj.GetRenderPresetList() or []
        idx = int(preset_index) - 1
        if 0 <= idx < len(presets):
            preset_name = presets[idx]
    if preset_name:
        if not proj.LoadRenderPreset(preset_name):
            return result_error(f'Unknown render preset: {preset_name}')
    if render_path:
        proj.SetRenderSettings({'TargetDir': os.path.abspath(os.path.expanduser(render_path))})
    job_id = proj.AddRenderJob()
    if job_id:
        return result_text(json.dumps({'job_id': job_id, 'preset': preset_name or '(current settings)'}))
    return result_error('Failed to add render job')

def handle_start_render(args):
    job_id = args.get('job_id')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    if job_id is not None:
        proj.StartRendering(job_id)
    else:
        proj.StartRendering()
    return result_text('Render started')

def handle_render_status(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    job_id = args.get('job_id')
    if job_id is not None:
        status = proj.GetRenderJobStatus(job_id)
        return result_text(json.dumps(status, indent=2) if status else '{}')
    is_rendering = proj.IsRenderingInProgress()
    return result_text(json.dumps({'is_rendering': is_rendering}, indent=2))

def handle_delete_clip(args):
    clip_index = int(args.get('clip_index', 1))
    track_type = args.get('track_type', 'video')
    track_index = int(args.get('track_index', 1))
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    # Real API: DeleteClips takes TimelineItem objects, not indices
    items = tl.GetItemListInTrack(track_type, track_index) or []
    if clip_index < 1 or clip_index > len(items):
        return result_error(f'No clip at index {clip_index} on {track_type} track {track_index} ({len(items)} clips)')
    target = items[clip_index - 1]
    if tl.DeleteClips([target]):
        return result_text(f'Deleted clip at index {clip_index}')
    return result_error('Failed to delete clip')

# ── Inspection / markers / export (added tools) ──────────────────────────

MARKER_COLORS = ['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple',
                 'Fuchsia', 'Rose', 'Lavender', 'Sky', 'Mint', 'Lemon', 'Sand',
                 'Cocoa', 'Cream']

def _timeline_item_dict(item, index):
    d = {'index': index}
    for key, meth in (('name', 'GetName'), ('start', 'GetStart'),
                      ('end', 'GetEnd'), ('duration', 'GetDuration')):
        try:
            d[key] = getattr(item, meth)()
        except Exception:
            pass
    return d

def handle_list_timeline_clips(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    out = {'timeline': tl.GetName(), 'video': {}, 'audio': {}}
    for ttype in ('video', 'audio'):
        for ti in range(1, (tl.GetTrackCount(ttype) or 0) + 1):
            items = tl.GetItemListInTrack(ttype, ti) or []
            out[ttype][f'track_{ti}'] = [_timeline_item_dict(it, i + 1) for i, it in enumerate(items)]
    return result_text(json.dumps(out, indent=2))

def handle_list_timelines(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    cur = proj.GetCurrentTimeline()
    cur_name = cur.GetName() if cur else None
    out = []
    for i in range(1, (proj.GetTimelineCount() or 0) + 1):
        t = proj.GetTimelineByIndex(i)
        if t:
            nm = t.GetName()
            out.append({'index': i, 'name': nm, 'current': nm == cur_name})
    return result_text(json.dumps(out, indent=2) if out else 'No timelines in this project.')

def handle_set_current_timeline(args):
    name = args.get('name')
    index = args.get('index')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    n = proj.GetTimelineCount() or 0
    target = None
    if index is not None:
        idx = int(index)
        if 1 <= idx <= n:
            target = proj.GetTimelineByIndex(idx)
    elif name:
        for i in range(1, n + 1):
            t = proj.GetTimelineByIndex(i)
            if t and t.GetName() == name:
                target = t
                break
    else:
        return result_error('Provide "name" or "index"')
    if target is None:
        return result_error('Timeline not found (use resolve_list_timelines to see valid names/indices)')
    if proj.SetCurrentTimeline(target):
        return result_text(f'Switched to timeline: {target.GetName()}')
    return result_error('Failed to switch timeline')

def handle_add_marker(args):
    frame = int(args.get('frame', 0))
    color = args.get('color', 'Blue')
    name = args.get('name', '')
    note = args.get('note', '')
    duration = max(1, int(args.get('duration', 1)))
    custom = args.get('custom_data', '')
    if color not in MARKER_COLORS:
        return result_error(f"Invalid marker color '{color}'. Valid: {', '.join(MARKER_COLORS)}")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    if tl.AddMarker(frame, color, name, note, duration, custom):
        return result_text(f'Added {color} marker at frame {frame}' + (f': "{name}"' if name else ''))
    return result_error(f'Failed to add marker at frame {frame} (a marker may already exist there, or the frame is out of range)')

def handle_list_markers(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    markers = tl.GetMarkers() or {}
    out = []
    for frame in sorted(markers.keys()):
        m = markers[frame]
        out.append({'frame': frame, 'color': m.get('color'), 'name': m.get('name'),
                    'note': m.get('note'), 'duration': m.get('duration'),
                    'custom_data': m.get('customData')})
    return result_text(json.dumps(out, indent=2) if out else 'No markers on this timeline.')

def handle_open_page(args):
    r = require_resolve()
    page = args.get('page', '')
    valid = ['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver']
    if page not in valid:
        return result_error(f"Invalid page '{page}'. Valid: {valid}")
    if r.OpenPage(page):
        return result_text(f"Opened {page} page")
    return result_error(f'Failed to open {page} page')

def handle_get_project_setting(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    name = args.get('name', '')
    val = proj.GetSetting(name)
    if val is None:
        return result_error(f"Setting '{name}' not found")
    if name == '':
        return result_text(val)
    return result_text(str(val))

def handle_set_project_setting(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    name = args.get('name', '')
    value = args.get('value', '')
    if not name or not value:
        return result_error('Both "name" and "value" are required')
    if proj.SetSetting(name, value):
        return result_text(f'Set {name} = {value}')
    return result_error(f'Failed to set {name}')

def handle_create_bin(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    name = args.get('name', '')
    if not name:
        return result_error('"name" is required')
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    if root is None:
        return result_error('No media pool root folder')
    new_bin = mp.AddSubFolder(root, name)
    if new_bin is None:
        return result_error(f'Failed to create bin "{name}"')
    return result_text(f'Created bin "{name}"')

def handle_clear_render_queue(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    proj.DeleteAllRenderJobs()
    return result_text('Render queue cleared')

def handle_export_timeline(args):
    path = args.get('path', '')
    fmt = (args.get('format') or 'edl').lower()
    if not path:
        return result_error('"path" is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return result_error('No project open')
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return result_error('No timeline')
    def const(*names):
        for nm in names:
            v = getattr(r, nm, None)
            if v is not None:
                return v
        return None
    none_sub = const('EXPORT_NONE')
    fmts = {
        'edl':     (const('EXPORT_EDL'), none_sub),
        'aaf':     (const('EXPORT_AAF'), const('EXPORT_AAF_NEW')),
        'drt':     (const('EXPORT_DRT'), none_sub),
        'otio':    (const('EXPORT_OTIO'), none_sub),
        'fcp7xml': (const('EXPORT_FCP_7_XML'), none_sub),
        'fcpxml':  (const('EXPORT_FCPXML_1_10', 'EXPORT_FCPXML_1_9', 'EXPORT_FCPXML_1_8',
                          'EXPORT_FCPXML_1_7', 'EXPORT_FCPXML_1_6', 'EXPORT_FCPXML_1_5',
                          'EXPORT_FCPXML_1_4', 'EXPORT_FCPXML_1_3'), none_sub),
        'csv':     (const('EXPORT_TEXT_CSV'), none_sub),
        'tab':     (const('EXPORT_TEXT_TAB'), none_sub),
    }
    if fmt not in fmts:
        return result_error(f"Unknown format '{fmt}'. Valid: {', '.join(fmts.keys())}")
    etype, esub = fmts[fmt]
    if etype is None:
        return result_error(f"This Resolve build doesn't expose the '{fmt}' export constant")
    abs_path = os.path.abspath(os.path.expanduser(path))
    try:
        done = tl.Export(abs_path, etype, esub) if esub is not None else tl.Export(abs_path, etype)
    except Exception as e:
        return result_error(f'Export failed: {e}')
    if done:
        return result_text(f'Exported timeline to {abs_path} ({fmt})')
    return result_error('Export returned failure (is the output directory writable?)')

# ── Tool registry ────────────────────────────────────────────────────────

TOOLS = [
    {
        'name': 'resolve_get_info',
        'description': 'Get Resolve version, current project, timeline info, and list all projects',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_load_project',
        'description': 'Load an existing project by name',
        'inputSchema': {'type': 'object', 'required': ['name'], 'properties': {
            'name': {'type': 'string', 'description': 'Project name'},
        }},
    },
    {
        'name': 'resolve_create_project',
        'description': 'Create a new project',
        'inputSchema': {'type': 'object', 'required': ['name'], 'properties': {
            'name': {'type': 'string', 'description': 'Project name'},
        }},
    },
    {
        'name': 'resolve_save_project',
        'description': 'Save the current project',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_project_info',
        'description': 'Get project metadata (timeline count, render jobs, etc.)',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_import_media',
        'description': 'Import media files into the Media Pool',
        'inputSchema': {'type': 'object', 'required': ['paths'], 'properties': {
            'paths': {
                'oneOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                'description': 'File path(s) to import',
            },
        }},
    },
    {
        'name': 'resolve_media_pool_list',
        'description': 'List all clips in the Media Pool root folder',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_create_timeline',
        'description': 'Create a new empty timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'name': {'type': 'string', 'description': 'Timeline name'},
        }},
    },
    {
        'name': 'resolve_get_timeline_info',
        'description': 'Get current timeline details: name, duration, timecode, track counts',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_set_timecode',
        'description': 'Move the playhead to a specific timecode (HH:MM:SS:FF)',
        'inputSchema': {'type': 'object', 'required': ['timecode'], 'properties': {
            'timecode': {'type': 'string', 'description': 'Timecode HH:MM:SS:FF'},
        }},
    },
    {
        'name': 'resolve_get_timecode',
        'description': 'Get the current playhead timecode',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_add_clip_to_timeline',
        'description': 'Find a clip by name in Media Pool and append it to the timeline',
        'inputSchema': {'type': 'object', 'required': ['clip_name'], 'properties': {
            'clip_name': {'type': 'string', 'description': 'Clip name from Media Pool'},
        }},
    },
    {
        'name': 'resolve_add_transition',
        'description': "NOT SUPPORTED: Resolve's scripting API cannot add transitions — this tool only returns manual instructions. Do not call it expecting a transition to be added.",
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_add_title',
        'description': 'Insert a Text+ title at the playhead position on the current timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'text': {'type': 'string', 'description': 'Title text'},
        }},
    },
    {
        'name': 'resolve_get_render_presets',
        'description': 'List available render presets',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_add_render_job',
        'description': 'Add a render job to the queue (optionally applying a render preset first)',
        'inputSchema': {'type': 'object', 'properties': {
            'preset_name': {'type': 'string', 'description': 'Render preset name (see resolve_get_render_presets)'},
            'preset_index': {'type': 'number', 'description': '1-based index into the preset list (alternative to preset_name)'},
            'render_path': {'type': 'string', 'description': 'Output directory'},
        }},
    },
    {
        'name': 'resolve_start_render',
        'description': 'Start rendering queued jobs',
        'inputSchema': {'type': 'object', 'properties': {
            'job_id': {'type': 'string', 'description': 'Job id from resolve_add_render_job (omit to render all queued jobs)'},
        }},
    },
    {
        'name': 'resolve_render_status',
        'description': 'Check if rendering is in progress or get job status',
        'inputSchema': {'type': 'object', 'properties': {
            'job_id': {'type': 'string'},
        }},
    },
    {
        'name': 'resolve_delete_clip',
        'description': 'Delete a clip from the timeline',
        'inputSchema': {'type': 'object', 'properties': {
            'clip_index': {'type': 'number'},
            'track_type': {'type': 'string', 'enum': ['video', 'audio']},
            'track_index': {'type': 'number'},
        }},
    },
    {
        'name': 'resolve_list_timeline_clips',
        'description': 'List every clip on the current timeline, per video/audio track, with name and start/end/duration frames. Use this to SEE the timeline before editing it.',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_list_timelines',
        'description': 'List all timelines in the current project with their index and which one is current',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_set_current_timeline',
        'description': 'Switch the active timeline by name or 1-based index',
        'inputSchema': {'type': 'object', 'properties': {
            'name': {'type': 'string', 'description': 'Timeline name'},
            'index': {'type': 'number', 'description': '1-based index (from resolve_list_timelines)'},
        }},
    },
    {
        'name': 'resolve_add_marker',
        'description': 'Add a colored marker/note at a timeline frame (frame is relative to timeline start; one marker per frame)',
        'inputSchema': {'type': 'object', 'properties': {
            'frame': {'type': 'number', 'description': 'Frame relative to timeline start (default 0)'},
            'color': {'type': 'string', 'enum': MARKER_COLORS, 'description': 'Marker color (default Blue)'},
            'name': {'type': 'string', 'description': 'Short marker name'},
            'note': {'type': 'string', 'description': 'Longer note text'},
            'duration': {'type': 'number', 'description': 'Duration in frames (default 1)'},
            'custom_data': {'type': 'string', 'description': 'Optional machine-readable tag'},
        }},
    },
    {
        'name': 'resolve_list_markers',
        'description': 'List all markers on the current timeline (frame, color, name, note, duration)',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'resolve_export_timeline',
        'description': 'Export the current timeline to a file. Formats: edl, aaf, fcpxml, fcp7xml, drt, otio, csv, tab',
        'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {
            'path': {'type': 'string', 'description': 'Output file path'},
            'format': {'type': 'string', 'enum': ['edl', 'aaf', 'fcpxml', 'fcp7xml', 'drt', 'otio', 'csv', 'tab'], 'description': 'Export format (default edl)'},
        }},
    },
    {
        'name': 'resolve_open_page',
        'description': 'Switch the DaVinci Resolve UI to a specific page: media, cut, edit, fusion, color, fairlight, deliver',
        'inputSchema': {'type': 'object', 'required': ['page'], 'properties': {
            'page': {'type': 'string', 'enum': ['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver']},
        }},
    },
    {
        'name': 'resolve_get_project_setting',
        'description': 'Get a project setting by name (omit name to list all)',
        'inputSchema': {'type': 'object', 'properties': {
            'name': {'type': 'string', 'description': 'Setting name (omit to list all settings)'},
        }},
    },
    {
        'name': 'resolve_set_project_setting',
        'description': 'Set a project setting',
        'inputSchema': {'type': 'object', 'required': ['name', 'value'], 'properties': {
            'name': {'type': 'string', 'description': 'Setting name'},
            'value': {'type': 'string', 'description': 'Setting value'},
        }},
    },
    {
        'name': 'resolve_create_bin',
        'description': 'Create a new bin in the media pool root folder',
        'inputSchema': {'type': 'object', 'required': ['name'], 'properties': {
            'name': {'type': 'string', 'description': 'Bin name'},
        }},
    },
    {
        'name': 'resolve_clear_render_queue',
        'description': 'Delete all render jobs from the render queue',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
]

HANDLERS = {
    'resolve_get_info': handle_get_resolve_info,
    'resolve_load_project': handle_load_project,
    'resolve_create_project': handle_create_project,
    'resolve_save_project': handle_save_project,
    'resolve_project_info': handle_project_info,
    'resolve_import_media': handle_import_media,
    'resolve_media_pool_list': handle_media_pool_list,
    'resolve_create_timeline': handle_create_timeline,
    'resolve_get_timeline_info': handle_get_timeline_info,
    'resolve_set_timecode': handle_set_timecode,
    'resolve_get_timecode': handle_get_timecode,
    'resolve_add_clip_to_timeline': handle_add_clip_to_timeline,
    'resolve_add_transition': handle_add_transition,
    'resolve_add_title': handle_add_title,
    'resolve_get_render_presets': handle_render_presets,
    'resolve_add_render_job': handle_add_render_job,
    'resolve_start_render': handle_start_render,
    'resolve_render_status': handle_render_status,
    'resolve_delete_clip': handle_delete_clip,
    'resolve_list_timeline_clips': handle_list_timeline_clips,
    'resolve_list_timelines': handle_list_timelines,
    'resolve_set_current_timeline': handle_set_current_timeline,
    'resolve_add_marker': handle_add_marker,
    'resolve_list_markers': handle_list_markers,
    'resolve_export_timeline': handle_export_timeline,
    'resolve_open_page': handle_open_page,
    'resolve_get_project_setting': handle_get_project_setting,
    'resolve_set_project_setting': handle_set_project_setting,
    'resolve_create_bin': handle_create_bin,
    'resolve_clear_render_queue': handle_clear_render_queue,
}

# ── MCP stdio transport ──────────────────────────────────────────────────

def send(msg):
    sys.stdout.write(json.dumps(msg, default=str) + '\n')
    try:
        sys.stdout.flush()
    except AttributeError:
        pass

def main():
    # CRITICAL TRANSPORT NOTES (this bit stumped multiple debuggers — see git log):
    #
    # 1. Read stdin with readline(), NEVER BufferedReader.read(65536).
    #    read(n) blocks until it has ALL n bytes or hits EOF. A real MCP client
    #    writes one ~150-byte initialize line and keeps the pipe open, so
    #    read(65536) blocks forever and the client times out. Manual testing
    #    with `echo ... | python server.py` closes stdin (EOF), which is why
    #    pipe tests always passed while the real client always hung.
    #
    # 2. Answer initialize/tools/list locally and IMMEDIATELY. Never probe
    #    Resolve (scriptapp/fusionscript.dll takes 4s+, can be worse) before
    #    responding to the handshake. Backends connect lazily on first
    #    tools/call: bridge first (instant), direct scriptapp as fallback.
    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:  # EOF — client closed stdin
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
                    'serverInfo': {'name': 'sennoric-davinci-resolve', 'version': '1.1.0'},
                },
            })

        elif method == 'notifications/initialized':
            pass

        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}})

        elif method == 'tools/call':
            # Prefer the bridge (runs inside Resolve, always authorized).
            reply = _bridge_request({'jsonrpc': '2.0', 'id': msg_id, 'method': method, 'params': params})
            if reply is not None:
                send(reply)
                continue
            # No bridge — fall back to a direct scriptapp connection.
            name = params.get('name', '')
            args = params.get('arguments', {})
            handler = HANDLERS.get(name)
            if handler is None:
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result_error(f'Unknown tool: {name}')})
                continue
            try:
                result = handler(args)
                send({'jsonrpc': '2.0', 'id': msg_id, 'result': result})
            except RuntimeError as e:
                # Expected operational errors — message only, no traceback noise
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
