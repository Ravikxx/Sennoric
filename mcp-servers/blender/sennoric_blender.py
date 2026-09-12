bl_info = {
    "name": "Sennoric MCP Bridge",
    "author": "Sennoric Labs",
    "version": (1, 0, 0),
    "blender": (3, 0, 0),
    "description": "HTTP bridge that lets Sennoric AI control Blender via MCP",
    "category": "System",
}

import bpy
import json
import threading
import queue
import uuid
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8765

# ── Thread-safe command queue (HTTP thread → main thread) ─────────────────────
# Blender's bpy API can only be called from the main thread.
# The HTTP handler queues requests; a bpy.app.timer drains them on the main thread.

_cmd_queue = queue.Queue()
_results   = {}   # req_id → result dict
_events    = {}   # req_id → threading.Event

def _process_queue():
    """Called by bpy.app.timers every 50ms on the main thread."""
    while not _cmd_queue.empty():
        try:
            req_id, cmd, params = _cmd_queue.get_nowait()
            try:
                result = _dispatch(cmd, params)
                _results[req_id] = {"success": True, "result": result}
            except Exception as e:
                _results[req_id] = {"success": False, "error": str(e), "detail": traceback.format_exc()}
            _events[req_id].set()
        except Exception:
            pass
    return 0.05  # re-schedule in 50ms


# ── Command dispatch ──────────────────────────────────────────────────────────

def _dispatch(cmd, params):
    handlers = {
        "get_scene_info":          _get_scene_info,
        "create_object":           _create_object,
        "delete_object":           _delete_object,
        "set_transform":           _set_transform,
        "get_object_info":         _get_object_info,
        "set_material":            _set_material,
        "add_modifier":            _add_modifier,
        "select_object":           _select_object,
        "extrude_faces":           _extrude_faces,
        "render":                  _render,
        "get_viewport_screenshot": _get_viewport_screenshot,
        "import_model":            _import_model,
        "execute_python":          _execute_python,
    }
    if cmd not in handlers:
        raise ValueError(f"Unknown command {cmd!r}. Available: {sorted(handlers)}")
    return handlers[cmd](params)


# ── Blender operations ────────────────────────────────────────────────────────

def _get_scene_info(p):
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        objects.append({
            "name":     obj.name,
            "type":     obj.type,
            "location": list(obj.location),
            "rotation": list(obj.rotation_euler),
            "scale":    list(obj.scale),
            "visible":  obj.visible_get(),
            "selected": obj.select_get(),
        })
    return {
        "scene_name":    scene.name,
        "frame_current": scene.frame_current,
        "frame_end":     scene.frame_end,
        "object_count":  len(objects),
        "objects":       objects,
        "active_object": bpy.context.active_object.name if bpy.context.active_object else None,
    }


def _create_object(p):
    kind = p.get("type", "CUBE").upper()
    loc  = tuple(p.get("location", [0, 0, 0]))

    bpy.ops.object.select_all(action="DESELECT")

    ops = {
        "CUBE":     lambda: bpy.ops.mesh.primitive_cube_add(location=loc),
        "SPHERE":   lambda: bpy.ops.mesh.primitive_uv_sphere_add(location=loc),
        "CYLINDER": lambda: bpy.ops.mesh.primitive_cylinder_add(location=loc),
        "PLANE":    lambda: bpy.ops.mesh.primitive_plane_add(location=loc),
        "CONE":     lambda: bpy.ops.mesh.primitive_cone_add(location=loc),
        "TORUS":    lambda: bpy.ops.mesh.primitive_torus_add(location=loc),
        "MONKEY":   lambda: bpy.ops.mesh.primitive_monkey_add(location=loc),
        "EMPTY":    lambda: bpy.ops.object.empty_add(location=loc),
        "CAMERA":   lambda: bpy.ops.object.camera_add(location=loc),
        "LIGHT":    lambda: bpy.ops.object.light_add(
                        type=p.get("light_type", "POINT"), location=loc),
    }
    if kind not in ops:
        raise ValueError(f"Unknown type {kind!r}. Choose from: {sorted(ops)}")
    ops[kind]()

    obj = bpy.context.active_object
    if name := p.get("name"):
        obj.name = name
        if obj.data:
            obj.data.name = name
    if "scale"    in p: obj.scale          = tuple(p["scale"])
    if "rotation" in p: obj.rotation_euler = tuple(p["rotation"])

    return {"name": obj.name, "type": obj.type, "location": list(obj.location)}


def _delete_object(p):
    name = p.get("name") or (_ for _ in ()).throw(ValueError("'name' required"))
    obj  = bpy.data.objects.get(name)
    if not obj:
        raise ValueError(f"Object '{name}' not found")
    bpy.data.objects.remove(obj, do_unlink=True)
    return {"deleted": name}


def _set_transform(p):
    name = p.get("name")
    if not name: raise ValueError("'name' required")
    obj  = bpy.data.objects.get(name)
    if not obj:  raise ValueError(f"Object '{name}' not found")
    if "location" in p: obj.location       = tuple(p["location"])
    if "rotation" in p: obj.rotation_euler = tuple(p["rotation"])
    if "scale"    in p:
        s = p["scale"]
        obj.scale = (s, s, s) if isinstance(s, (int, float)) else tuple(s)
    return {
        "name":     obj.name,
        "location": list(obj.location),
        "rotation": list(obj.rotation_euler),
        "scale":    list(obj.scale),
    }


def _get_object_info(p):
    name = p.get("name")
    if not name: raise ValueError("'name' required")
    obj  = bpy.data.objects.get(name)
    if not obj:  raise ValueError(f"Object '{name}' not found")
    return {
        "name":         obj.name,
        "type":         obj.type,
        "location":     list(obj.location),
        "rotation":     list(obj.rotation_euler),
        "scale":        list(obj.scale),
        "dimensions":   list(obj.dimensions),
        "materials":    [s.material.name for s in obj.material_slots if s.material],
        "modifiers":    [{"name": m.name, "type": m.type} for m in obj.modifiers],
        "vertex_count": len(obj.data.vertices) if obj.type == "MESH" else None,
    }


def _set_material(p):
    name = p.get("name")
    if not name: raise ValueError("'name' required")
    obj  = bpy.data.objects.get(name)
    if not obj:  raise ValueError(f"Object '{name}' not found")

    mat_name  = p.get("material_name", f"{name}_mat")
    color     = p.get("color", [0.8, 0.8, 0.8, 1.0])
    metallic  = p.get("metallic",  0.0)
    roughness = p.get("roughness", 0.5)
    emission  = p.get("emission",  [0, 0, 0, 1])
    ior       = p.get("ior", None)

    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(name=mat_name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf  = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value  = color if len(color) == 4 else [*color, 1.0]
        bsdf.inputs["Metallic"].default_value    = metallic
        bsdf.inputs["Roughness"].default_value   = roughness
        bsdf.inputs["Emission Color"].default_value = emission if len(emission) == 4 else [*emission, 1.0]
        if ior is not None:
            bsdf.inputs["IOR"].default_value = ior

    if obj.material_slots:
        obj.material_slots[0].material = mat
    else:
        obj.data.materials.append(mat)

    return {"object": name, "material": mat_name}


def _add_modifier(p):
    name     = p.get("name")
    mod_type = p.get("modifier", "").upper()
    if not name or not mod_type:
        raise ValueError("'name' and 'modifier' required")
    obj = bpy.data.objects.get(name)
    if not obj: raise ValueError(f"Object '{name}' not found")

    mod = obj.modifiers.new(name=mod_type, type=mod_type)
    for k, v in p.get("settings", {}).items():
        if hasattr(mod, k):
            setattr(mod, k, v)

    if p.get("apply", False):
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return {"object": name, "modifier": mod_type, "applied": True}

    return {"object": name, "modifier": mod.name, "type": mod.type}


def _select_object(p):
    if p.get("deselect_others", True):
        bpy.ops.object.select_all(action="DESELECT")
    name = p.get("name")
    if name:
        obj = bpy.data.objects.get(name)
        if not obj: raise ValueError(f"Object '{name}' not found")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
    return {"selected": name}


def _extrude_faces(p):
    name   = p.get("name")
    amount = p.get("amount", 1.0)
    axis   = p.get("axis", "Z").upper()
    if not name: raise ValueError("'name' required")
    obj = bpy.data.objects.get(name)
    if not obj: raise ValueError(f"Object '{name}' not found")

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    vec = {"X": (amount,0,0), "Y": (0,amount,0), "Z": (0,0,amount)}.get(axis, (0,0,amount))
    bpy.ops.mesh.extrude_region_move(TRANSFORM_OT_translate={"value": vec})
    bpy.ops.object.mode_set(mode="OBJECT")
    return {"object": name, "extruded": True, "amount": amount, "axis": axis}


def _read_image_b64(path):
    import base64, os
    if not os.path.exists(path):
        return None, None
    ext = os.path.splitext(path)[1].lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "exr": "image/x-exr"}.get(ext.lstrip("."), "image/png")
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8"), mime


def _render(p):
    import os, tempfile
    scene = bpy.context.scene
    fmt   = p.get("format", "PNG").upper()
    scene.render.image_settings.file_format = fmt

    out = p.get("output_path") or os.path.join(
        tempfile.gettempdir(), f"sennoric_render.{fmt.lower()}")
    scene.render.filepath = out

    if res := p.get("resolution"):
        scene.render.resolution_x, scene.render.resolution_y = int(res[0]), int(res[1])

    bpy.ops.render.render(write_still=True)
    image_data, mime_type = _read_image_b64(out)
    return {"output_path": out, "exists": os.path.exists(out), "image_data": image_data, "mime_type": mime_type}


def _get_viewport_screenshot(p):
    import os, tempfile
    out = p.get("output_path") or os.path.join(tempfile.gettempdir(), "sennoric_viewport.png")
    # Find a 3D viewport area
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            with bpy.context.temp_override(area=area):
                bpy.ops.screen.screenshot_area(filepath=out)
            break
    image_data, mime_type = _read_image_b64(out)
    return {"output_path": out, "exists": os.path.exists(out), "image_data": image_data, "mime_type": mime_type}


def _import_model(p):
    import os
    filepath = p.get("filepath", "")
    if not filepath: raise ValueError("'filepath' required")
    if not os.path.exists(filepath): raise ValueError(f"File not found: {filepath!r}")

    ext = os.path.splitext(filepath)[1].lower()
    before = set(bpy.data.objects.keys())

    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == ".obj":
        try:
            bpy.ops.wm.obj_import(filepath=filepath)   # Blender 4.x
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=filepath)  # Blender 3.x
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == ".stl":
        try:
            bpy.ops.wm.stl_import(filepath=filepath)   # Blender 4.x
        except AttributeError:
            bpy.ops.import_mesh.stl(filepath=filepath)  # Blender 3.x
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=filepath)
    elif ext == ".ply":
        bpy.ops.import_mesh.ply(filepath=filepath)
    elif ext == ".abc":
        bpy.ops.wm.alembic_import(filepath=filepath)
    else:
        raise ValueError(f"Unsupported format: {ext!r}. Supported: .glb .gltf .obj .fbx .stl .dae .ply .abc")

    after    = set(bpy.data.objects.keys())
    imported = sorted(after - before)

    # Optional uniform scale applied to all imported objects
    if scale := p.get("scale"):
        for name in imported:
            obj = bpy.data.objects.get(name)
            if obj:
                obj.scale = (scale, scale, scale)

    return {"imported": imported, "count": len(imported), "filepath": filepath, "format": ext}


def _execute_python(p):
    code = p.get("code", "")
    if not code: raise ValueError("'code' required")
    ns = {"bpy": bpy, "result": None, "__builtins__": __builtins__}
    exec(compile(code, "<sennoric>", "exec"), ns)
    return {"executed": True, "result": str(ns.get("result", ""))}


# ── HTTP server ───────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Health check."""
        body = json.dumps({"status": "ok", "port": PORT}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length  = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length).decode())

        req_id = str(uuid.uuid4())
        event  = threading.Event()
        _events[req_id] = event
        _cmd_queue.put((req_id, payload.get("command", ""), payload.get("params", {})))

        timed_out = not event.wait(timeout=30)
        result    = _results.pop(req_id, None)
        _events.pop(req_id, None)

        if timed_out or result is None:
            body = json.dumps({"success": False, "error": "timeout"}).encode()
            code = 504
        elif result["success"]:
            body = json.dumps({"success": True, "result": result["result"]}).encode()
            code = 200
        else:
            body = json.dumps({"success": False, "error": result["error"]}).encode()
            code = 500

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # suppress access logs


# ── Add-on lifecycle ──────────────────────────────────────────────────────────

_server        = None
_server_thread = None


def register():
    global _server, _server_thread
    if _server:
        return

    if not bpy.app.timers.is_registered(_process_queue):
        bpy.app.timers.register(_process_queue, persistent=True)

    _server = HTTPServer(("127.0.0.1", PORT), _Handler)
    _server_thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _server_thread.start()
    print(f"[Sennoric] MCP bridge started on http://127.0.0.1:{PORT}")


def unregister():
    global _server, _server_thread
    if _server:
        _server.shutdown()
        _server = None
    if bpy.app.timers.is_registered(_process_queue):
        bpy.app.timers.unregister(_process_queue)
    print("[Sennoric] MCP bridge stopped")
