// AxionBridge.cs — Sennoric's Unity editor bridge.
//
// Place this file in an Editor/ folder anywhere inside your project's Assets/
// (e.g. Assets/Editor/AxionBridge.cs). Unity compiles it automatically and the
// bridge starts listening on 127.0.0.1:9877 (override with the AXION_UNITY_PORT
// environment variable, set before launching Unity).
//
// Protocol: newline-delimited JSON-RPC 2.0 over TCP. The Sennoric MCP server
// (unity_server.py) forwards tools/call requests here; all Unity API work is
// marshaled onto the main thread via EditorApplication.update, because Unity
// APIs throw when called from any other thread.
//
// The bridge survives domain reloads ([InitializeOnLoad] re-runs the static
// constructor after script compilation and play-mode transitions) and releases
// its port before each reload so the restart never collides with itself.

#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

[InitializeOnLoad]
public static class AxionBridge
{
    const int DefaultPort = 9877;

    static TcpListener listener;
    static Thread acceptThread;
    static volatile bool running;

    class Job
    {
        public Dictionary<string, object> msg;
        public string reply;
        public readonly ManualResetEventSlim done = new ManualResetEventSlim(false);
    }

    static readonly ConcurrentQueue<Job> jobs = new ConcurrentQueue<Job>();

    static AxionBridge()
    {
        EditorApplication.update += Pump;
        AssemblyReloadEvents.beforeAssemblyReload += Stop;
        EditorApplication.quitting += Stop;
        Start();
    }

    static int Port()
    {
        var env = Environment.GetEnvironmentVariable("AXION_UNITY_PORT");
        return int.TryParse(env, out var p) && p > 0 && p < 65536 ? p : DefaultPort;
    }

    static void Start()
    {
        try
        {
            var port = Port();
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            running = true;
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "AxionBridge" };
            acceptThread.Start();
            Debug.Log($"[AxionBridge] listening on 127.0.0.1:{port}");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[AxionBridge] failed to start: {e.Message} " +
                             "(is another Unity instance already running the bridge?)");
        }
    }

    static void Stop()
    {
        running = false;
        try { listener?.Stop(); } catch { }
        listener = null;
    }

    static void AcceptLoop()
    {
        while (running)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch { break; } // listener stopped
            var t = new Thread(() => HandleClient(client)) { IsBackground = true };
            t.Start();
        }
    }

    static void HandleClient(TcpClient client)
    {
        try
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
            {
                string line;
                while (running && (line = reader.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    var job = new Job();
                    try { job.msg = MiniJson.Parse(line) as Dictionary<string, object>; }
                    catch { continue; }
                    if (job.msg == null) continue;
                    jobs.Enqueue(job);
                    // Main thread executes via Pump; wait here on the socket thread.
                    if (!job.done.Wait(TimeSpan.FromSeconds(20)))
                        job.reply = ErrorReply(job.msg, "Timed out waiting for the Unity main thread (editor busy or a modal dialog is open)");
                    writer.Write(job.reply);
                    writer.Write('\n');
                }
            }
        }
        catch { /* client disconnected */ }
    }

    static void Pump()
    {
        while (jobs.TryDequeue(out var job))
        {
            try { job.reply = Execute(job.msg); }
            catch (Exception e) { job.reply = ErrorReply(job.msg, e.Message); }
            job.done.Set();
        }
    }

    // ── JSON-RPC handling (main thread from here down) ────────────────────

    static string Execute(Dictionary<string, object> msg)
    {
        var method = msg.TryGetValue("method", out var m) ? m as string : null;
        if (method != "tools/call")
            return ErrorReply(msg, $"Unknown method: {method}");

        var p = msg.TryGetValue("params", out var pv) ? pv as Dictionary<string, object> : null;
        var name = p != null && p.TryGetValue("name", out var n) ? n as string : "";
        var args = p != null && p.TryGetValue("arguments", out var a)
            ? a as Dictionary<string, object> : null;
        args = args ?? new Dictionary<string, object>();

        string text;
        bool isError = false;
        try
        {
            switch (name)
            {
                case "unity_get_scene_info":    text = GetSceneInfo(); break;
                case "unity_list_gameobjects":  text = ListGameObjects(); break;
                case "unity_select_gameobject": text = SelectGameObject(args); break;
                case "unity_create_gameobject": text = CreateGameObject(args); break;
                case "unity_delete_gameobject": text = DeleteGameObject(args); break;
                case "unity_set_transform":     text = SetTransform(args); break;
                case "unity_run_menu_command":  text = RunMenuCommand(args); break;
                case "unity_play_mode":         text = PlayMode(args); break;
                default: text = $"Unknown tool: {name}"; isError = true; break;
            }
        }
        catch (Exception e)
        {
            text = $"{e.GetType().Name}: {e.Message}";
            isError = true;
        }
        return Reply(msg, text, isError);
    }

    static string Reply(Dictionary<string, object> msg, string text, bool isError)
    {
        var result = new Dictionary<string, object>
        {
            ["content"] = new List<object>
            {
                new Dictionary<string, object> { ["type"] = "text", ["text"] = text },
            },
        };
        if (isError) result["isError"] = true;
        return MiniJson.Serialize(new Dictionary<string, object>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = msg.TryGetValue("id", out var id) ? id : null,
            ["result"] = result,
        });
    }

    static string ErrorReply(Dictionary<string, object> msg, string text) => Reply(msg, text, true);

    // ── Tool implementations ───────────────────────────────────────────────

    static string GetSceneInfo()
    {
        var scene = SceneManager.GetActiveScene();
        var info = new Dictionary<string, object>
        {
            ["name"] = scene.name,
            ["path"] = scene.path,
            ["root_object_count"] = scene.rootCount,
            ["is_dirty"] = scene.isDirty,
            ["is_playing"] = EditorApplication.isPlaying,
            ["is_paused"] = EditorApplication.isPaused,
            ["unity_version"] = Application.unityVersion,
        };
        return MiniJson.Serialize(info);
    }

    static string ListGameObjects()
    {
        var scene = SceneManager.GetActiveScene();
        var list = new List<object>();
        foreach (var root in scene.GetRootGameObjects())
            AddHierarchy(root.transform, root.name, list);
        return MiniJson.Serialize(list);
    }

    static void AddHierarchy(Transform t, string path, List<object> list)
    {
        list.Add(new Dictionary<string, object>
        {
            ["path"] = path,
            ["active"] = t.gameObject.activeSelf,
        });
        foreach (Transform child in t)
            AddHierarchy(child, path + "/" + child.name, list);
    }

    static GameObject FindByPath(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var segments = path.Split('/');
        // GameObject.Find skips inactive objects, so walk the hierarchy manually.
        foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
        {
            if (root.name != segments[0]) continue;
            if (segments.Length == 1) return root;
            var child = root.transform.Find(string.Join("/", segments, 1, segments.Length - 1));
            if (child != null) return child.gameObject;
        }
        return null;
    }

    static string SelectGameObject(Dictionary<string, object> args)
    {
        var path = Str(args, "path");
        var go = FindByPath(path);
        if (go == null) throw new Exception($"GameObject not found: {path} (use unity_list_gameobjects to see paths)");
        Selection.activeGameObject = go;
        EditorGUIUtility.PingObject(go);
        var comps = new List<object>();
        foreach (var c in go.GetComponents<Component>())
            comps.Add(c != null ? c.GetType().Name : "(missing script)");
        var t = go.transform;
        return MiniJson.Serialize(new Dictionary<string, object>
        {
            ["path"] = path,
            ["active"] = go.activeSelf,
            ["position"] = Vec(t.position),
            ["rotation_euler"] = Vec(t.eulerAngles),
            ["scale"] = Vec(t.localScale),
            ["components"] = comps,
        });
    }

    static string CreateGameObject(Dictionary<string, object> args)
    {
        var name = Str(args, "name");
        var prim = Str(args, "primitive")?.ToLowerInvariant() ?? "empty";
        GameObject go;
        switch (prim)
        {
            case "":
            case "empty":    go = new GameObject(); break;
            case "cube":     go = GameObject.CreatePrimitive(PrimitiveType.Cube); break;
            case "sphere":   go = GameObject.CreatePrimitive(PrimitiveType.Sphere); break;
            case "capsule":  go = GameObject.CreatePrimitive(PrimitiveType.Capsule); break;
            case "cylinder": go = GameObject.CreatePrimitive(PrimitiveType.Cylinder); break;
            case "plane":    go = GameObject.CreatePrimitive(PrimitiveType.Plane); break;
            case "quad":     go = GameObject.CreatePrimitive(PrimitiveType.Quad); break;
            default: throw new Exception($"Unknown primitive: {prim}");
        }
        if (!string.IsNullOrEmpty(name)) go.name = name;

        var parentPath = Str(args, "parent");
        if (!string.IsNullOrEmpty(parentPath))
        {
            var parent = FindByPath(parentPath);
            if (parent == null) { UnityEngine.Object.DestroyImmediate(go); throw new Exception($"Parent not found: {parentPath}"); }
            go.transform.SetParent(parent.transform, false);
        }
        if (TryVec3(args, "position", out var pos)) go.transform.position = pos;

        Undo.RegisterCreatedObjectUndo(go, "Sennoric create " + go.name);
        Selection.activeGameObject = go;
        return $"Created {go.name} at {go.transform.position}";
    }

    static string DeleteGameObject(Dictionary<string, object> args)
    {
        var path = Str(args, "path");
        var go = FindByPath(path);
        if (go == null) throw new Exception($"GameObject not found: {path}");
        Undo.DestroyObjectImmediate(go);
        return $"Deleted {path}";
    }

    static string SetTransform(Dictionary<string, object> args)
    {
        var path = Str(args, "path");
        var go = FindByPath(path);
        if (go == null) throw new Exception($"GameObject not found: {path}");
        var t = go.transform;
        Undo.RecordObject(t, "Sennoric set transform");
        var applied = new List<string>();
        if (TryVec3(args, "position", out var pos)) { t.position = pos; applied.Add($"position={pos}"); }
        if (TryVec3(args, "rotation", out var rot)) { t.eulerAngles = rot; applied.Add($"rotation={rot}"); }
        if (TryVec3(args, "scale", out var scl))    { t.localScale = scl; applied.Add($"scale={scl}"); }
        if (applied.Count == 0) throw new Exception("Provide at least one of position, rotation, scale");
        return $"{path}: {string.Join(", ", applied)}";
    }

    static string RunMenuCommand(Dictionary<string, object> args)
    {
        var menuPath = Str(args, "menu_path");
        if (string.IsNullOrEmpty(menuPath)) throw new Exception("\"menu_path\" is required");
        if (EditorApplication.ExecuteMenuItem(menuPath))
            return $"Executed menu item: {menuPath}";
        throw new Exception($"Menu item not found or disabled: {menuPath}");
    }

    static string PlayMode(Dictionary<string, object> args)
    {
        var action = Str(args, "action")?.ToLowerInvariant();
        switch (action)
        {
            case "enter":   EditorApplication.isPlaying = true;  return "Entering play mode (scripts reload — bridge reconnects shortly)";
            case "exit":    EditorApplication.isPlaying = false; return "Exiting play mode (scripts reload — bridge reconnects shortly)";
            case "pause":   EditorApplication.isPaused = true;   return "Paused";
            case "unpause": EditorApplication.isPaused = false;  return "Unpaused";
            default: throw new Exception($"Unknown action: {action}. Valid: enter, exit, pause, unpause");
        }
    }

    // ── Arg helpers ────────────────────────────────────────────────────────

    static string Str(Dictionary<string, object> args, string key) =>
        args.TryGetValue(key, out var v) ? v as string : null;

    static bool TryVec3(Dictionary<string, object> args, string key, out Vector3 vec)
    {
        vec = Vector3.zero;
        if (!args.TryGetValue(key, out var v) || !(v is List<object> list) || list.Count < 3)
            return false;
        vec = new Vector3(ToF(list[0]), ToF(list[1]), ToF(list[2]));
        return true;
    }

    static float ToF(object o) => o is double d ? (float)d : o is long l ? l : 0f;

    static List<object> Vec(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };

    // ── Minimal JSON (no external deps — Newtonsoft isn't guaranteed) ──────
    // Parses to Dictionary<string,object> / List<object> / string / double /
    // long / bool / null. Serializes the same types back.

    static class MiniJson
    {
        public static object Parse(string json)
        {
            int i = 0;
            var v = ParseValue(json, ref i);
            return v;
        }

        static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            switch (s[i])
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return ParseString(s, ref i);
                case 't': i += 4; return true;
                case 'f': i += 5; return false;
                case 'n': i += 4; return null;
                default:  return ParseNumber(s, ref i);
            }
        }

        static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var d = new Dictionary<string, object>();
            i++; // {
            SkipWs(s, ref i);
            if (s[i] == '}') { i++; return d; }
            while (true)
            {
                SkipWs(s, ref i);
                var key = ParseString(s, ref i);
                SkipWs(s, ref i);
                i++; // :
                d[key] = ParseValue(s, ref i);
                SkipWs(s, ref i);
                if (s[i] == ',') { i++; continue; }
                i++; // }
                return d;
            }
        }

        static List<object> ParseArray(string s, ref int i)
        {
            var list = new List<object>();
            i++; // [
            SkipWs(s, ref i);
            if (s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (s[i] == ',') { i++; continue; }
                i++; // ]
                return list;
            }
        }

        static string ParseString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening "
            while (s[i] != '"')
            {
                if (s[i] == '\\')
                {
                    i++;
                    switch (s[i])
                    {
                        case '"':  sb.Append('"');  break;
                        case '\\': sb.Append('\\'); break;
                        case '/':  sb.Append('/');  break;
                        case 'b':  sb.Append('\b'); break;
                        case 'f':  sb.Append('\f'); break;
                        case 'n':  sb.Append('\n'); break;
                        case 'r':  sb.Append('\r'); break;
                        case 't':  sb.Append('\t'); break;
                        case 'u':
                            sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16));
                            i += 4;
                            break;
                    }
                }
                else sb.Append(s[i]);
                i++;
            }
            i++; // closing "
            return sb.ToString();
        }

        static object ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            var str = s.Substring(start, i - start);
            if (str.IndexOf('.') < 0 && str.IndexOf('e') < 0 && str.IndexOf('E') < 0
                && long.TryParse(str, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l))
                return l;
            return double.Parse(str, CultureInfo.InvariantCulture);
        }

        static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        public static string Serialize(object o)
        {
            var sb = new StringBuilder();
            Write(o, sb);
            return sb.ToString();
        }

        static void Write(object o, StringBuilder sb)
        {
            switch (o)
            {
                case null: sb.Append("null"); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case string s: WriteString(s, sb); break;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); break;
                case int n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); break;
                case float f: sb.Append(f.ToString("R", CultureInfo.InvariantCulture)); break;
                case double d: sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); break;
                case Dictionary<string, object> dict:
                    sb.Append('{');
                    bool firstK = true;
                    foreach (var kv in dict)
                    {
                        if (!firstK) sb.Append(',');
                        firstK = false;
                        WriteString(kv.Key, sb);
                        sb.Append(':');
                        Write(kv.Value, sb);
                    }
                    sb.Append('}');
                    break;
                case IEnumerable e:
                    sb.Append('[');
                    bool firstI = true;
                    foreach (var item in e)
                    {
                        if (!firstI) sb.Append(',');
                        firstI = false;
                        Write(item, sb);
                    }
                    sb.Append(']');
                    break;
                default: WriteString(o.ToString(), sb); break;
            }
        }

        static void WriteString(string s, StringBuilder sb)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b");  break;
                    case '\f': sb.Append("\\f");  break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
#endif
