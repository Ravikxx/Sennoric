#!/usr/bin/env python3
"""
Resolve Bridge - TCP socket server that runs INSIDE DaVinci Resolve.

Place in Scripts/Utility, then in Resolve:
  Workspace > Scripts > Utility > resolve_bridge

Listens on localhost:9876 for the MCP server to connect.
"""

import sys
import os
import json
import traceback
import socket
import threading

BRIDGE_PORT = 9876

_RESOLVE = None

def get_resolve():
    global _RESOLVE
    if _RESOLVE is not None:
        return _RESOLVE
    # Scripts launched from Resolve's own menu run in a Resolve-attached host
    # (fuscript -a <port>) that INJECTS `resolve` and `bmd` into the script's
    # globals. On the FREE edition that injected channel is the ONLY one that
    # works — scriptapp('Resolve') from any host returns None. Try injected
    # globals first, then fall back to scriptapp (Studio / external hosts).
    g = globals()
    injected = g.get('resolve')
    if injected is not None:
        _RESOLVE = injected
        return _RESOLVE
    b = g.get('bmd')
    if b is not None:
        try:
            r = b.scriptapp('Resolve')
            if r is not None:
                _RESOLVE = r
                return _RESOLVE
        except Exception:
            pass
    try:
        import DaVinciResolveScript as dvr
        _RESOLVE = dvr.scriptapp("Resolve")
        return _RESOLVE
    except ImportError:
        return None

def require_resolve():
    r = get_resolve()
    if r is None:
        raise RuntimeError(
            "DaVinci Resolve refused the scripting connection.\n"
            "- FREE Resolve blocks external scripting hosts entirely. Start this bridge from\n"
            "  INSIDE Resolve instead: Workspace -> Scripts -> Utility -> resolve_bridge\n"
            "  (then retry the tool).\n"
            "- STUDIO: enable Preferences (Ctrl+,) -> System -> General ->\n"
            "  'External scripting using' -> Local -> Save, then retry."
        )
    return r

def project_list():
    # Real API: GetProjectsInCurrentFolder() -> {index: name}. Methods like
    # GetProjectListCount/GetProjectList don't exist — Resolve's remote objects
    # return None for unknown attributes, so calling them dies with
    # "'NoneType' object is not callable".
    r = require_resolve()
    pm = r.GetProjectManager()
    projects = pm.GetProjectsInCurrentFolder() or {}
    return sorted(v for v in projects.values() if v)

def timeline_info(timeline=None):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        raise RuntimeError("No project open")
    tl = timeline if timeline else proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError("No timeline in current project")
    start = tl.GetStartFrame()
    end = tl.GetEndFrame()
    return {
        "name": tl.GetName(),
        "duration_frames": (end - start) if (start is not None and end is not None) else None,
        "start_timecode": tl.GetStartTimecode(),
        "current_timecode": tl.GetCurrentTimecode(),
        "video_track_count": tl.GetTrackCount("video"),
        "audio_track_count": tl.GetTrackCount("audio"),
        "subtitle_track_count": tl.GetTrackCount("subtitle"),
    }

# ── Tool handlers ────────────────────────────────────────────────────────

def handle_get_info(args):
    r = require_resolve()
    projects = project_list()
    current = None
    try:
        proj = r.GetCurrentProject()
        current = proj.GetName() if proj else None
    except Exception:
        pass
    info = {"current_project": current, "project_count": len(projects), "projects": projects}
    if current:
        try:
            proj = r.GetCurrentProject()
            info["timeline_count"] = proj.GetTimelineCount()
            tl = proj.GetCurrentTimeline()
            if tl:
                info["current_timeline"] = timeline_info(tl)
        except Exception:
            pass
    return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}]}

def handle_load_project(args):
    name = args.get("name", "")
    if not name:
        return {"content": [{"type": "text", "text": '"name" is required'}], "isError": True}
    r = require_resolve()
    pm = r.GetProjectManager()
    if pm.LoadProject(name):
        return {"content": [{"type": "text", "text": f"Loaded project: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to load project: {name}"}], "isError": True}

def handle_create_project(args):
    name = args.get("name", "")
    if not name:
        return {"content": [{"type": "text", "text": '"name" is required'}], "isError": True}
    r = require_resolve()
    pm = r.GetProjectManager()
    proj = pm.CreateProject(name)
    if proj:
        return {"content": [{"type": "text", "text": f"Created project: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to create project: {name}"}], "isError": True}

def handle_save_project(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    pm = r.GetProjectManager()
    if pm.SaveProject():  # SaveProject lives on ProjectManager, not Project
        return {"content": [{"type": "text", "text": f"Saved project: {proj.GetName()}"}]}
    return {"content": [{"type": "text", "text": "Failed to save project"}], "isError": True}

def handle_project_info(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    info = {
        "name": proj.GetName(),
        "timeline_count": proj.GetTimelineCount(),
        "render_job_count": len(proj.GetRenderJobList() or []),
        "render_presets": proj.GetRenderPresetList() or [],
    }
    return {"content": [{"type": "text", "text": json.dumps(info, indent=2)}]}

def handle_import_media(args):
    paths = args.get("paths", [])
    if isinstance(paths, str):
        paths = [paths]
    if not paths:
        return {"content": [{"type": "text", "text": '"paths" is required'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    ms = r.GetMediaStorage()
    items = []
    for p in paths:
        abs_path = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(abs_path):
            items.append({"path": p, "status": "not found"})
            continue
        result = ms.AddItemListToMediaPool([abs_path])  # real API takes a list
        items.append({"path": p, "status": "imported" if result else "failed"})
    return {"content": [{"type": "text", "text": json.dumps(items, indent=2)}]}

def handle_media_pool_list(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    if root is None:
        return {"content": [{"type": "text", "text": "[]"}]}
    clips = root.GetClipList()
    result = []
    for clip in clips or []:
        # MediaPoolItem has no GetDuration — duration is a clip property
        result.append({"name": clip.GetName(), "duration": clip.GetClipProperty("Duration")})
    return {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]}

def handle_create_timeline(args):
    name = args.get("name", "Timeline 1")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    tl = mp.CreateEmptyTimeline(name)
    if tl:
        return {"content": [{"type": "text", "text": f"Created timeline: {name}"}]}
    return {"content": [{"type": "text", "text": f"Failed to create timeline: {name}"}], "isError": True}

def handle_get_timeline_info(args):
    return {"content": [{"type": "text", "text": json.dumps(timeline_info(), indent=2)}]}

def handle_set_timecode(args):
    tc = args.get("timecode", "")
    if not tc:
        return {"content": [{"type": "text", "text": '"timecode" is required (HH:MM:SS:FF)'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    if tl.SetCurrentTimecode(tc):
        return {"content": [{"type": "text", "text": f"Set timecode to {tc}"}]}
    return {"content": [{"type": "text", "text": f"Failed to set timecode"}], "isError": True}

def handle_get_timecode(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    tc = tl.GetCurrentTimecode()
    return {"content": [{"type": "text", "text": tc or "00:00:00:00"}]}

def handle_add_clip_to_timeline(args):
    clip_name = args.get("clip_name", "")
    if not clip_name:
        return {"content": [{"type": "text", "text": '"clip_name" is required'}], "isError": True}
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder()
    clips = root.GetClipList() if root else []
    target = None
    for clip in clips or []:
        if clip.GetName() == clip_name:
            target = clip
            break
    if target is None:
        return {"content": [{"type": "text", "text": f"Clip not found: {clip_name}"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    item = mp.AppendToTimeline([target])
    if item:
        return {"content": [{"type": "text", "text": f'Added clip "{clip_name}" to timeline'}]}
    return {"content": [{"type": "text", "text": "Failed to add clip"}], "isError": True}

def handle_add_transition(args):
    # Resolve's scripting API has no way to add transitions (no such method on
    # Timeline/TimelineItem). Be honest instead of calling a method that
    # doesn't exist and dying with "'NoneType' object is not callable".
    return {"content": [{"type": "text", "text": (
        "Resolve's scripting API does not support adding transitions programmatically. "
        "Add it manually in the Edit page (drag from Effects Library), or set a default "
        "transition and use the Edit page shortcuts."
    )}], "isError": True}

def handle_add_title(args):
    text = args.get("text", "Title")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    # Real API: InsertFusionTitleIntoTimeline inserts at the playhead position.
    item = tl.InsertFusionTitleIntoTimeline("Text+")
    if not item:
        return {"content": [{"type": "text", "text": "Failed to insert title (is the playhead over the timeline?)"}], "isError": True}
    # Best-effort: set the title's text via its Fusion comp
    try:
        comp = item.GetFusionCompByIndex(1)
        tool = comp.FindTool("Template") if comp else None
        if tool:
            tool.SetInput("StyledText", text)
            return {"content": [{"type": "text", "text": f'Added Text+ title with text "{text}" at the playhead'}]}
    except Exception:
        pass
    return {"content": [{"type": "text", "text": 'Added Text+ title at the playhead (set its text in the Inspector — automated text set failed)'}]}

def handle_render_presets(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    presets = proj.GetRenderPresetList()
    return {"content": [{"type": "text", "text": json.dumps(presets, indent=2) if presets else "[]"}]}

def handle_add_render_job(args):
    preset_name = args.get("preset_name", "")
    preset_index = args.get("preset_index")
    render_path = args.get("render_path", "")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    # Real API: AddRenderJob() takes no arguments; presets are applied first
    # via LoadRenderPreset(name).
    if not preset_name and preset_index is not None:
        presets = proj.GetRenderPresetList() or []
        idx = int(preset_index) - 1
        if 0 <= idx < len(presets):
            preset_name = presets[idx]
    if preset_name:
        if not proj.LoadRenderPreset(preset_name):
            return {"content": [{"type": "text", "text": f"Unknown render preset: {preset_name}"}], "isError": True}
    if render_path:
        proj.SetRenderSettings({"TargetDir": os.path.abspath(os.path.expanduser(render_path))})
    job_id = proj.AddRenderJob()
    if job_id:
        return {"content": [{"type": "text", "text": json.dumps({"job_id": job_id, "preset": preset_name or "(current settings)"})}]}
    return {"content": [{"type": "text", "text": "Failed to add render job"}], "isError": True}

def handle_start_render(args):
    job_id = args.get("job_id")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    if job_id is not None:
        proj.StartRendering(job_id)
    else:
        proj.StartRendering()
    return {"content": [{"type": "text", "text": "Render started"}]}

def handle_render_status(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    job_id = args.get("job_id")
    if job_id is not None:
        status = proj.GetRenderJobStatus(job_id)
        return {"content": [{"type": "text", "text": json.dumps(status, indent=2) if status else "{}"}]}
    is_rendering = proj.IsRenderingInProgress()
    return {"content": [{"type": "text", "text": json.dumps({"is_rendering": is_rendering}, indent=2)}]}

def handle_delete_clip(args):
    clip_index = int(args.get("clip_index", 1))
    track_type = args.get("track_type", "video")
    track_index = int(args.get("track_index", 1))
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return {"content": [{"type": "text", "text": "No project open"}], "isError": True}
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return {"content": [{"type": "text", "text": "No timeline"}], "isError": True}
    # Real API: DeleteClips takes TimelineItem objects, not indices
    items = tl.GetItemListInTrack(track_type, track_index) or []
    if clip_index < 1 or clip_index > len(items):
        return {"content": [{"type": "text", "text": f"No clip at index {clip_index} on {track_type} track {track_index} ({len(items)} clips)"}], "isError": True}
    target = items[clip_index - 1]
    name = None
    try:
        name = target.GetName()
    except Exception:
        pass
    if tl.DeleteClips([target]):
        return {"content": [{"type": "text", "text": f"Deleted clip {clip_index}" + (f' ("{name}")' if name else "")}]}
    return {"content": [{"type": "text", "text": "Failed to delete clip"}], "isError": True}

# ── Inspection / markers / export (added tools) ──────────────────────────

def _ok(text):
    return {"content": [{"type": "text", "text": text}]}

def _err(text):
    return {"content": [{"type": "text", "text": text}], "isError": True}

# Valid DaVinci Resolve marker colors (AddMarker rejects anything else).
MARKER_COLORS = ["Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple",
                 "Fuchsia", "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand",
                 "Cocoa", "Cream"]

def _timeline_item_dict(item, index):
    # TimelineItem (unlike MediaPoolItem) DOES have GetStart/GetEnd/GetDuration.
    d = {"index": index}
    for key, meth in (("name", "GetName"), ("start", "GetStart"),
                      ("end", "GetEnd"), ("duration", "GetDuration")):
        try:
            d[key] = getattr(item, meth)()
        except Exception:
            pass
    return d

def handle_list_timeline_clips(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return _err("No timeline")
    out = {"timeline": tl.GetName(), "video": {}, "audio": {}}
    for ttype in ("video", "audio"):
        for ti in range(1, (tl.GetTrackCount(ttype) or 0) + 1):
            items = tl.GetItemListInTrack(ttype, ti) or []
            out[ttype][f"track_{ti}"] = [_timeline_item_dict(it, i + 1) for i, it in enumerate(items)]
    return _ok(json.dumps(out, indent=2))

def handle_list_timelines(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
    cur = proj.GetCurrentTimeline()
    cur_name = cur.GetName() if cur else None
    out = []
    for i in range(1, (proj.GetTimelineCount() or 0) + 1):
        t = proj.GetTimelineByIndex(i)  # 1-based
        if t:
            nm = t.GetName()
            out.append({"index": i, "name": nm, "current": nm == cur_name})
    return _ok(json.dumps(out, indent=2) if out else "No timelines in this project.")

def handle_set_current_timeline(args):
    name = args.get("name")
    index = args.get("index")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
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
        return _err('Provide "name" or "index"')
    if target is None:
        return _err("Timeline not found (use resolve_list_timelines to see valid names/indices)")
    if proj.SetCurrentTimeline(target):
        return _ok(f"Switched to timeline: {target.GetName()}")
    return _err("Failed to switch timeline")

def handle_add_marker(args):
    frame = int(args.get("frame", 0))
    color = args.get("color", "Blue")
    name = args.get("name", "")
    note = args.get("note", "")
    duration = max(1, int(args.get("duration", 1)))
    custom = args.get("custom_data", "")
    if color not in MARKER_COLORS:
        return _err(f"Invalid marker color '{color}'. Valid: {', '.join(MARKER_COLORS)}")
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return _err("No timeline")
    # AddMarker(frameId, color, name, note, duration, customData). frameId is
    # relative to the timeline start; only ONE marker may exist per frame.
    if tl.AddMarker(frame, color, name, note, duration, custom):
        return _ok(f"Added {color} marker at frame {frame}" + (f': "{name}"' if name else ""))
    return _err(f"Failed to add marker at frame {frame} (a marker may already exist there, or the frame is out of range)")

def handle_list_markers(args):
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return _err("No timeline")
    markers = tl.GetMarkers() or {}  # {frameId: {color, duration, note, name, customData}}
    out = []
    for frame in sorted(markers.keys()):
        m = markers[frame]
        out.append({"frame": frame, "color": m.get("color"), "name": m.get("name"),
                    "note": m.get("note"), "duration": m.get("duration"),
                    "custom_data": m.get("customData")})
    return _ok(json.dumps(out, indent=2) if out else "No markers on this timeline.")

def handle_export_timeline(args):
    path = args.get("path", "")
    fmt = (args.get("format") or "edl").lower()
    if not path:
        return _err('"path" is required')
    r = require_resolve()
    proj = r.GetCurrentProject()
    if proj is None:
        return _err("No project open")
    tl = proj.GetCurrentTimeline()
    if tl is None:
        return _err("No timeline")
    # Export type/subtype are CONSTANTS on the resolve object, and their exact
    # set varies by build (FCPXML especially has many versioned names) — resolve
    # them by name and pick the newest available.
    def const(*names):
        for nm in names:
            v = getattr(r, nm, None)
            if v is not None:
                return v
        return None
    none_sub = const("EXPORT_NONE")
    fmts = {
        "edl":     (const("EXPORT_EDL"), none_sub),
        "aaf":     (const("EXPORT_AAF"), const("EXPORT_AAF_NEW")),
        "drt":     (const("EXPORT_DRT"), none_sub),
        "otio":    (const("EXPORT_OTIO"), none_sub),
        "fcp7xml": (const("EXPORT_FCP_7_XML"), none_sub),
        "fcpxml":  (const("EXPORT_FCPXML_1_10", "EXPORT_FCPXML_1_9", "EXPORT_FCPXML_1_8",
                          "EXPORT_FCPXML_1_7", "EXPORT_FCPXML_1_6", "EXPORT_FCPXML_1_5",
                          "EXPORT_FCPXML_1_4", "EXPORT_FCPXML_1_3"), none_sub),
        "csv":     (const("EXPORT_TEXT_CSV"), none_sub),
        "tab":     (const("EXPORT_TEXT_TAB"), none_sub),
    }
    if fmt not in fmts:
        return _err(f"Unknown format '{fmt}'. Valid: {', '.join(fmts.keys())}")
    etype, esub = fmts[fmt]
    if etype is None:
        return _err(f"This Resolve build doesn't expose the '{fmt}' export constant")
    abs_path = os.path.abspath(os.path.expanduser(path))
    try:
        done = tl.Export(abs_path, etype, esub) if esub is not None else tl.Export(abs_path, etype)
    except Exception as e:
        return _err(f"Export failed: {e}")
    if done:
        return _ok(f"Exported timeline to {abs_path} ({fmt})")
    return _err("Export returned failure (is the output directory writable?)")

def handle_open_page(args):
    try:
        r = require_resolve()
        page = args.get('page', '')
        valid = ['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver']
        if page not in valid:
            return _err(f"Invalid page '{page}'. Valid: {valid}")
        if r.OpenPage(page):
            return _ok(f"Opened {page} page")
        return _err(f'Failed to open {page} page')
    except RuntimeError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f'{e}\n{traceback.format_exc()}')

def handle_get_project_setting(args):
    try:
        r = require_resolve()
        proj = r.GetCurrentProject()
        if proj is None:
            return _err('No project open')
        name = args.get('name', '')
        val = proj.GetSetting(name)
        if val is None:
            return _err(f"Setting '{name}' not found")
        if name == '':
            return _ok(val)
        return _ok(str(val))
    except RuntimeError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f'{e}\n{traceback.format_exc()}')

def handle_set_project_setting(args):
    try:
        r = require_resolve()
        proj = r.GetCurrentProject()
        if proj is None:
            return _err('No project open')
        name = args.get('name', '')
        value = args.get('value', '')
        if not name or not value:
            return _err('Both "name" and "value" are required')
        if proj.SetSetting(name, value):
            return _ok(f'Set {name} = {value}')
        return _err(f'Failed to set {name}')
    except RuntimeError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f'{e}\n{traceback.format_exc()}')

def handle_create_bin(args):
    try:
        r = require_resolve()
        proj = r.GetCurrentProject()
        if proj is None:
            return _err('No project open')
        name = args.get('name', '')
        if not name:
            return _err('"name" is required')
        mp = proj.GetMediaPool()
        root = mp.GetRootFolder()
        if root is None:
            return _err('No media pool root folder')
        new_bin = mp.AddSubFolder(root, name)
        if new_bin is None:
            return _err(f'Failed to create bin "{name}"')
        return _ok(f'Created bin "{name}"')
    except RuntimeError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f'{e}\n{traceback.format_exc()}')

def handle_clear_render_queue(args):
    try:
        r = require_resolve()
        proj = r.GetCurrentProject()
        if proj is None:
            return _err('No project open')
        proj.DeleteAllRenderJobs()
        return _ok('Render queue cleared')
    except RuntimeError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f'{e}\n{traceback.format_exc()}')

# ── Tool registry ────────────────────────────────────────────────────────

TOOLS = [
    {"name": "resolve_get_info", "description": "Get Resolve version, current project, timeline info, and list all projects", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_load_project", "description": "Load an existing project by name", "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "Project name"}}}},
    {"name": "resolve_create_project", "description": "Create a new project", "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "Project name"}}}},
    {"name": "resolve_save_project", "description": "Save the current project", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_project_info", "description": "Get project metadata (timeline count, render jobs, etc.)", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_import_media", "description": "Import media files into the Media Pool", "inputSchema": {"type": "object", "required": ["paths"], "properties": {"paths": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}], "description": "File path(s) to import"}}}},
    {"name": "resolve_media_pool_list", "description": "List all clips in the Media Pool root folder", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_create_timeline", "description": "Create a new empty timeline", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Timeline name"}}}},
    {"name": "resolve_get_timeline_info", "description": "Get current timeline details: name, duration, timecode, track counts", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_set_timecode", "description": "Move the playhead to a specific timecode (HH:MM:SS:FF)", "inputSchema": {"type": "object", "required": ["timecode"], "properties": {"timecode": {"type": "string", "description": "Timecode HH:MM:SS:FF"}}}},
    {"name": "resolve_get_timecode", "description": "Get the current playhead timecode", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_add_clip_to_timeline", "description": "Find a clip by name in Media Pool and append it to the timeline", "inputSchema": {"type": "object", "required": ["clip_name"], "properties": {"clip_name": {"type": "string", "description": "Clip name from Media Pool"}}}},
    {"name": "resolve_add_transition", "description": "NOT SUPPORTED: Resolve's scripting API cannot add transitions — this tool only returns manual instructions. Do not call it expecting a transition to be added.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_add_title", "description": "Insert a Text+ title at the playhead position on the current timeline", "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "description": "Title text"}}}},
    {"name": "resolve_get_render_presets", "description": "List available render presets", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_add_render_job", "description": "Add a render job to the queue (optionally applying a render preset first)", "inputSchema": {"type": "object", "properties": {"preset_name": {"type": "string", "description": "Render preset name (see resolve_get_render_presets)"}, "preset_index": {"type": "number", "description": "1-based index into the preset list (alternative to preset_name)"}, "render_path": {"type": "string", "description": "Output directory"}}}},
    {"name": "resolve_start_render", "description": "Start rendering queued jobs", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string", "description": "Job id returned by resolve_add_render_job (omit to render all queued jobs)"}}}},
    {"name": "resolve_render_status", "description": "Check if rendering is in progress or get job status", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}}},
    {"name": "resolve_delete_clip", "description": "Delete a clip from the timeline", "inputSchema": {"type": "object", "properties": {"clip_index": {"type": "number"}, "track_type": {"type": "string", "enum": ["video", "audio"]}, "track_index": {"type": "number"}}}},
    {"name": "resolve_list_timeline_clips", "description": "List every clip on the current timeline, per video/audio track, with name and start/end/duration frames. Use this to SEE the timeline before editing it.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_list_timelines", "description": "List all timelines in the current project with their index and which one is current", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_set_current_timeline", "description": "Switch the active timeline by name or 1-based index", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Timeline name"}, "index": {"type": "number", "description": "1-based index (from resolve_list_timelines)"}}}},
    {"name": "resolve_add_marker", "description": "Add a colored marker/note at a timeline frame (frame is relative to timeline start; one marker per frame)", "inputSchema": {"type": "object", "properties": {"frame": {"type": "number", "description": "Frame relative to timeline start (default 0)"}, "color": {"type": "string", "enum": MARKER_COLORS, "description": "Marker color (default Blue)"}, "name": {"type": "string", "description": "Short marker name"}, "note": {"type": "string", "description": "Longer note text"}, "duration": {"type": "number", "description": "Duration in frames (default 1)"}, "custom_data": {"type": "string", "description": "Optional machine-readable tag"}}}},
    {"name": "resolve_list_markers", "description": "List all markers on the current timeline (frame, color, name, note, duration)", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "resolve_export_timeline", "description": "Export the current timeline to a file. Formats: edl, aaf, fcpxml, fcp7xml, drt, otio, csv, tab", "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string", "description": "Output file path"}, "format": {"type": "string", "enum": ["edl", "aaf", "fcpxml", "fcp7xml", "drt", "otio", "csv", "tab"], "description": "Export format (default edl)"}}}},
    {"name": "resolve_open_page", "description": "Switch the DaVinci Resolve UI to a specific page: media, cut, edit, fusion, color, fairlight, deliver", "inputSchema": {"type": "object", "required": ["page"], "properties": {"page": {"type": "string", "enum": ["media", "cut", "edit", "fusion", "color", "fairlight", "deliver"]}}}},
    {"name": "resolve_get_project_setting", "description": "Get a project setting by name (omit name to list all)", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Setting name (omit to list all settings)"}}}},
    {"name": "resolve_set_project_setting", "description": "Set a project setting", "inputSchema": {"type": "object", "required": ["name", "value"], "properties": {"name": {"type": "string", "description": "Setting name"}, "value": {"type": "string", "description": "Setting value"}}}},
    {"name": "resolve_create_bin", "description": "Create a new bin in the media pool root folder", "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "Bin name"}}}},
    {"name": "resolve_clear_render_queue", "description": "Delete all render jobs from the render queue", "inputSchema": {"type": "object", "properties": {}}},
]

HANDLERS = {
    "resolve_get_info": handle_get_info,
    "resolve_load_project": handle_load_project,
    "resolve_create_project": handle_create_project,
    "resolve_save_project": handle_save_project,
    "resolve_project_info": handle_project_info,
    "resolve_import_media": handle_import_media,
    "resolve_media_pool_list": handle_media_pool_list,
    "resolve_create_timeline": handle_create_timeline,
    "resolve_get_timeline_info": handle_get_timeline_info,
    "resolve_set_timecode": handle_set_timecode,
    "resolve_get_timecode": handle_get_timecode,
    "resolve_add_clip_to_timeline": handle_add_clip_to_timeline,
    "resolve_add_transition": handle_add_transition,
    "resolve_add_title": handle_add_title,
    "resolve_get_render_presets": handle_render_presets,
    "resolve_add_render_job": handle_add_render_job,
    "resolve_start_render": handle_start_render,
    "resolve_render_status": handle_render_status,
    "resolve_delete_clip": handle_delete_clip,
    "resolve_list_timeline_clips": handle_list_timeline_clips,
    "resolve_list_timelines": handle_list_timelines,
    "resolve_set_current_timeline": handle_set_current_timeline,
    "resolve_add_marker": handle_add_marker,
    "resolve_list_markers": handle_list_markers,
    "resolve_export_timeline": handle_export_timeline,
    "resolve_open_page": handle_open_page,
    "resolve_get_project_setting": handle_get_project_setting,
    "resolve_set_project_setting": handle_set_project_setting,
    "resolve_create_bin": handle_create_bin,
    "resolve_clear_render_queue": handle_clear_render_queue,
}

# ── TCP server ───────────────────────────────────────────────────────────

def handle_client(conn):
    buf = ""
    while True:
        try:
            data = conn.recv(65536)
        except Exception:
            break
        if not data:
            break
        buf += data.decode("utf-8")
        while "\n" in buf:
            raw, buf = buf.split("\n", 1)
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_id = msg.get("id")
            method = msg.get("method", "")
            params = msg.get("params", {})
            if method == "initialize":
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "sennoric-davinci-resolve-bridge", "version": "1.0.0"}}})
            elif method == "notifications/initialized":
                pass
            elif method == "tools/list":
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
            elif method == "tools/call":
                name = params.get("name", "")
                args = params.get("arguments", {})
                handler = HANDLERS.get(name)
                if handler is None:
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True}})
                    continue
                try:
                    result = handler(args)
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": result})
                except RuntimeError as e:
                    # Expected operational errors (no project, scripting disabled…) — message only, no traceback noise
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}})
                except Exception as e:
                    send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"{e}\n{traceback.format_exc()}"}], "isError": True}})
            elif msg_id is not None:
                send_conn(conn, {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}})
    conn.close()

def send_conn(conn, msg):
    data = json.dumps(msg, default=str) + "\n"
    conn.sendall(data.encode("utf-8"))

def main():
    r = get_resolve()
    if r is None:
        # No Resolve scripting handle in THIS launch context. This happens when
        # the bridge is started anywhere other than Resolve's Scripts menu — e.g.
        # the fuscript external host (blocked on the FREE edition) or the Fusion
        # Scripts/Startup auto-run — neither of which receives Resolve's injected
        # `resolve`/`bmd` globals. Such a bridge can only answer every tool call
        # with "refused the scripting connection". Worse, because we bind with
        # SO_EXCLUSIVEADDRUSE, it would squat port 9876 and block the WORKING
        # menu-launched bridge from ever starting. So refuse to run: exit WITHOUT
        # binding, leaving the port free for a bridge that can actually reach
        # Resolve.
        print("=" * 64)
        print("Sennoric Resolve bridge: no scripting handle in this launch context —")
        print("exiting so it can't occupy port 9876 and mask the real bridge.")
        print("")
        print("Start the bridge from INSIDE Resolve so it gets a live handle:")
        print("  Workspace -> Scripts -> Utility -> resolve_bridge")
        print("(FREE edition: this menu launch is the ONLY way that works.)")
        print("STUDIO: Preferences -> System -> General -> 'External scripting")
        print("  using' -> Local -> Save, then this host launch will work too.")
        print("=" * 64)
        return
    print("Resolve connected: " + r.GetVersionString())
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sys.platform == "win32":
        # On Windows SO_REUSEADDR lets MULTIPLE bridges bind the same port and
        # steal each other's connections. Exclusive bind makes a second launch
        # fail fast instead.
        server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(("127.0.0.1", BRIDGE_PORT))
    except OSError:
        print("Bridge already running on port " + str(BRIDGE_PORT) + " — nothing to do.")
        return
    server.listen(4)
    server.settimeout(1.0)
    print("Bridge listening on 127.0.0.1:" + str(BRIDGE_PORT))
    print("Sennoric MCP server can now connect. Keep this window/console open.")
    try:
        while True:
            try:
                conn, addr = server.accept()
                print("Client connected from " + str(addr))
                # Thread per client — a stale/hung client must never starve the
                # accept loop (connects would still succeed via the backlog but
                # never get served, which looks like a mystery timeout).
                threading.Thread(target=handle_client, args=(conn,), daemon=True).start()
            except socket.timeout:
                continue
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        print("Bridge stopped")

if __name__ == "__main__":
    main()
