# Unity MCP server — available tools

The Unity MCP server controls the Unity editor through SennoricBridge.cs, a C#
editor script that listens on `127.0.0.1:9877` (override with the
`SENNORIC_UNITY_PORT` env var, set before launching Unity). Every `tools/call`
requires the Unity editor to be open with the bridge compiled — the bridge
prints `[SennoricBridge] listening on 127.0.0.1:9877` in the Unity console when
ready. `/unity` copies the bridge into `Assets/Editor/` automatically when run
from a Unity project directory.

## Tools

| Tool | Purpose |
|---|---|
| `unity_get_scene_info` | Active scene name/path, root count, dirty flag, play-mode state |
| `unity_list_gameobjects` | All GameObjects with full hierarchy paths and active state |
| `unity_select_gameobject` | Select by path; returns transform + component list |
| `unity_create_gameobject` | Create empty or primitive (cube, sphere, capsule, cylinder, plane, quad) |
| `unity_delete_gameobject` | Delete a GameObject by path (undo-able) |
| `unity_set_transform` | Set position / rotation (euler) / scale by path |
| `unity_run_menu_command` | Execute any editor menu item, e.g. "File/Save Project" |
| `unity_play_mode` | enter / exit / pause / unpause play mode |

## Notes

- GameObject paths are `/`-separated hierarchy paths (e.g. `Player/Arm/Hand`) —
  get them from `unity_list_gameobjects`. Inactive objects are found too.
- All mutating tools register with Unity's Undo system.
- **Entering or exiting play mode triggers a domain reload** which restarts the
  bridge. The first call after a play-mode transition (or a script
  recompilation) may fail with "cannot reach the bridge" — just retry it once.
- If the editor is busy (modal dialog, long import), calls time out after 20s
  with a clear message rather than hanging.

## How to add new tools

Two files must stay in sync:

1. `mcp-servers/unity/SennoricBridge.cs` — add a `case "unity_<name>":` to the
   switch in `Execute()` and implement the handler as a static method. Unity
   API calls are already on the main thread there. Return a string (JSON via
   `MiniJson.Serialize` for structured data); throw exceptions for errors.
2. `mcp-servers/unity/unity_server.py` — add the matching entry to `TOOLS`
   (name, description, inputSchema). The server only forwards; no Python
   handler is needed.

After editing the C# file, re-run `/unity` from the Unity project directory to
copy the updated bridge into `Assets/Editor/`, then let Unity recompile.
