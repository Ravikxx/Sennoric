import os
import json
import time
import uuid
import asyncio
import threading
import queue as queue_mod
import gradio as gr
from fastapi import Request
from fastapi.responses import StreamingResponse, JSONResponse
from huggingface_hub import hf_hub_download
import spaces
from llama_cpp import Llama

HF_TOKEN    = os.environ.get("HF_TOKEN")
MODEL_PATH  = "/tmp/fresco-dpo.gguf"
MEMORY_FILE = "/tmp/memories.json"

SYSTEM_PROMPT = (
    """
      You are Fresco, an AI assistant made by Sennoric Labs. You're helpful, direct, and honest.
  - Answer questions clearly and concisely. Don't over-explain.
  - If you don't know something, say so — don't guess and present it as fact.
  - Refuse requests that would harm people, violate privacy, or involve illegal activity.
  """
)

llm = None
infer_lock = threading.Lock()


# ── Memory ────────────────────────────────────────────────────────────────────

def _load_memories():
    try:
        if not os.path.exists(MEMORY_FILE):
            return []
        with open(MEMORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def _save_memories(memories):
    try:
        with open(MEMORY_FILE, "w") as f:
            json.dump(memories, f, indent=2)
    except Exception:
        pass


def get_memories():
    return _load_memories()


def add_memory(text):
    memories = _load_memories()
    memories.append({"text": text.strip(), "addedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    _save_memories(memories)
    return memories


def remove_all_memories():
    _save_memories([])


def remove_memory_by_index(index):
    memories = _load_memories()
    if 0 <= index < len(memories):
        memories.pop(index)
        _save_memories(memories)
        return True
    return False


def build_system_prompt():
    memories = get_memories()
    prompt = SYSTEM_PROMPT
    if memories:
        notes = "\n".join(f"- {m['text']}" for m in memories)
        prompt += f"\n\nPersistent notes (always keep in mind):\n{notes}"
    return prompt


def memories_display_text():
    memories = get_memories()
    if not memories:
        return "No memories saved."
    return "\n".join(f"{i + 1}. {m['text']}" for i, m in enumerate(memories))


# ── Model loading ─────────────────────────────────────────────────────────────

def _load_model():
    global llm
    if not os.path.exists(MODEL_PATH):
        print("Downloading Fresco DPO model\u2026")
        hf_hub_download(
            repo_id   = "RavikxxBGamin/Fresco",
            filename  = "fresco-dpo.gguf",
            token     = HF_TOKEN,
            local_dir = "/tmp",
        )

    print("Loading model\u2026")
    llm = Llama(
        model_path = MODEL_PATH,
        n_ctx      = 8192,
        n_threads  = 2,
        verbose    = False,
    )
    print("Model ready.")

# Start loading in background before Gradio builds UI
threading.Thread(target=_load_model, daemon=True).start()


# ── Gradio chat helpers ───────────────────────────────────────────────────────

def user_submit(message, history):
    if not message.strip():
        return "", history
    return "", history + [{"role": "user", "content": message}]


@spaces.GPU
def bot_respond(history, temperature, max_tokens):
    if llm is None:
        yield history + [{"role": "assistant", "content": "Model is still loading — please wait a moment and try again."}]
        return

    messages = [{"role": "system", "content": build_system_prompt()}]
    for item in history:
        if not isinstance(item, dict):
            continue
        content = item.get("content", "")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        messages.append({"role": item["role"], "content": content})

    response = ""
    working_history = history + [{"role": "assistant", "content": ""}]
    with infer_lock:
        for chunk in llm.create_chat_completion(
            messages    = messages,
            max_tokens  = int(max_tokens),
            temperature = float(temperature),
            stream      = True,
        ):
            delta            = chunk["choices"][0]["delta"].get("content", "")
            response        += delta
            working_history[-1]["content"] = response
            yield working_history


def model_status():
    if llm is not None:
        return "<p class='status ready'>\u25cf Model ready</p>"
    return "<p class='status loading'>\u25cf Loading model\u2026 (first boot takes a few minutes)</p>"


def do_add_memory(text):
    if not text.strip():
        return "", memories_display_text()
    add_memory(text.strip())
    return "", memories_display_text()


def do_clear_memories():
    remove_all_memories()
    return memories_display_text()


# ── Gradio UI must be defined before API routes ──────────────────────────────

THEME = gr.themes.Base(
    primary_hue   = gr.themes.colors.orange,
    secondary_hue = gr.themes.colors.stone,
    neutral_hue   = gr.themes.colors.stone,
    font      = [gr.themes.GoogleFont("Inter"), "ui-sans-serif", "system-ui", "sans-serif"],
    font_mono = [gr.themes.GoogleFont("JetBrains Mono"), "ui-monospace", "monospace"],
).set(
    body_background_fill               = "#110d08",
    body_background_fill_dark          = "#110d08",
    block_background_fill              = "#1c1510",
    block_background_fill_dark         = "#1c1510",
    block_border_color                 = "#2e2218",
    block_border_color_dark            = "#2e2218",
    block_label_background_fill        = "#1c1510",
    block_label_background_fill_dark   = "#1c1510",
    input_background_fill              = "#150f0a",
    input_background_fill_dark         = "#150f0a",
    input_border_color                 = "#2e2218",
    input_border_color_dark            = "#2e2218",
    button_primary_background_fill     = "#cc785c",
    button_primary_background_fill_hover = "#b8664a",
    button_primary_background_fill_dark  = "#cc785c",
    button_primary_text_color          = "#fff",
    button_secondary_background_fill   = "#2e2218",
    button_secondary_background_fill_hover = "#3a2c1e",
    button_secondary_background_fill_dark  = "#2e2218",
    button_secondary_text_color        = "#d4b896",
    body_text_color                    = "#e8ddd0",
    body_text_color_dark               = "#e8ddd0",
    block_label_text_color             = "#a08060",
    block_label_text_color_dark        = "#a08060",
)

CSS = """
.gradio-container { max-width: 820px !important; margin: 0 auto !important; padding: 0 12px !important; }
footer { display: none !important; }
#fresco-header { padding: 24px 0 8px; border-bottom: 1px solid #2e2218; margin-bottom: 16px; }
#fresco-header h1 { font-size: 1.6em; font-weight: 700; margin: 0 0 2px; color: #e8ddd0; letter-spacing: -0.01em; }
#fresco-header h1 span { color: #cc785c; }
#fresco-header p { color: #7a6050; margin: 0; font-size: 0.85em; }
.status { margin: 0 0 10px; font-size: 0.8em; font-weight: 500; }
.status.ready   { color: #6aa87a; }
.status.loading { color: #c9994a; }
.chatbot-wrap .message.user { background: #2a1e14 !important; border: 1px solid #3a2c1e !important; }
.chatbot-wrap .message.bot  { background: #1c1510 !important; border: 1px solid #2e2218 !important; }
.chatbot-wrap .message      { border-radius: 8px !important; }
.input-row textarea {
    background: #150f0a !important; border: 1px solid #3a2c1e !important;
    border-radius: 8px !important; color: #e8ddd0 !important; resize: none !important;
}
.input-row textarea:focus { border-color: #cc785c !important; outline: none !important; }
.send-btn {
    background: #cc785c !important; border: none !important;
    border-radius: 8px !important; color: #fff !important;
    font-size: 1.1em !important; min-width: 48px !important;
}
.send-btn:hover { background: #b8664a !important; }
.settings-row { margin: 10px 0 4px; gap: 16px; }
.settings-row label { color: #a08060 !important; font-size: 0.8em !important; }
.memory-panel { margin-top: 8px; border-top: 1px solid #2e2218; padding-top: 10px; }
.memory-panel .gr-accordion-header { color: #a08060 !important; font-size: 0.82em !important; }
.memory-list textarea {
    font-size: 0.82em !important; color: #a08060 !important;
    background: #110d08 !important; border: 1px solid #2e2218 !important; border-radius: 6px !important;
}
#fresco-footer { color: #4a3828; font-size: 0.75em; text-align: center; padding: 14px 0; border-top: 1px solid #2e2218; margin-top: 12px; }
#fresco-footer code { background: #1c1510; padding: 1px 5px; border-radius: 4px; color: #7a6050; }
"""

with gr.Blocks(title="Fresco \u2014 Sennoric Labs", fill_height=True) as demo:

    gr.HTML("""
        <div id="fresco-header">
            <h1>\u269b <span>Fresco</span></h1>
            <p>Fine-tuned Llama 3.1 8B \u00b7 by Sennoric Labs \u00b7 free, no key needed</p>
        </div>
    """)

    status_html = gr.HTML(model_status)

    chatbot = gr.Chatbot(
        height = 440,
        label  = "",
    )

    with gr.Row(elem_classes=["input-row"]):
        msg_box = gr.Textbox(
            placeholder = "Message Fresco\u2026",
            show_label  = False,
            scale       = 5,
            lines       = 1,
            max_lines   = 6,
        )
        send_btn = gr.Button("\u2191", scale=1, variant="primary", min_width=48)

    with gr.Row(elem_classes=["settings-row"]):
        temperature = gr.Slider(0.1, 1.5, value=0.7, step=0.1, label="Temperature", scale=1)
        max_tokens  = gr.Slider(64, 1024, value=512, step=64,   label="Max tokens",  scale=1)

    with gr.Accordion("Memory", open=False, elem_classes=["memory-panel"]):
        mem_display = gr.Textbox(
            value       = memories_display_text,
            label       = "",
            lines       = 4,
            interactive = False,
        )
        with gr.Row():
            mem_input   = gr.Textbox(placeholder="Add a memory\u2026", show_label=False, scale=3)
            mem_add_btn = gr.Button("Save",      scale=1)
            mem_clr_btn = gr.Button("Clear all", scale=1)

    gr.HTML("""
        <div id="fresco-footer">
            OpenAI-compatible API: <code>POST /v1/chat/completions</code>
            &nbsp;\u00b7&nbsp; use with Sennoric CLI via <code>/model fresco</code>
        </div>
    """)

    msg_box.submit(
        user_submit, [msg_box, chatbot], [msg_box, chatbot]
    ).then(
        bot_respond, [chatbot, temperature, max_tokens], chatbot
    )
    send_btn.click(
        user_submit, [msg_box, chatbot], [msg_box, chatbot]
    ).then(
        bot_respond, [chatbot, temperature, max_tokens], chatbot
    )

    mem_add_btn.click(do_add_memory, [mem_input], [mem_input, mem_display])
    mem_input.submit(do_add_memory, [mem_input], [mem_input, mem_display])
    mem_clr_btn.click(do_clear_memories, [], [mem_display])

    demo.load(model_status, outputs=status_html)


# ── API routes mounted on Gradio's internal FastAPI ──────────────────────────
# Gradio 6's SvelteKit proxy only forwards /gradio_api/* to the FastAPI
# backend, so we prefix all custom routes accordingly.  Must come AFTER
# the `with gr.Blocks() as demo:` block so demo.app exists.

@demo.app.get("/gradio_api/health")
def health():
    return {"status": "ready" if llm is not None else "loading"}


@demo.app.get("/gradio_api/v1/memories")
def api_list_memories():
    return {"memories": get_memories()}


@demo.app.post("/gradio_api/v1/memories")
async def api_add_memory(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    updated = add_memory(text)
    return {"memories": updated}


@demo.app.delete("/gradio_api/v1/memories/{index}")
def api_delete_memory(index: int):
    if remove_memory_by_index(index):
        return {"memories": get_memories()}
    return JSONResponse({"error": "index out of range"}, status_code=404)


@demo.app.post("/gradio_api/v1/chat/completions")
async def chat_completions(request: Request):
    if llm is None:
        return JSONResponse({"error": "Model is still loading, try again in a moment."}, status_code=503)

    body         = await request.json()
    messages     = body.get("messages", [])
    max_tokens   = int(body.get("max_tokens", 512))
    temperature  = float(body.get("temperature", 0.7))
    stream       = body.get("stream", False)
    model_id     = body.get("model", "fresco")
    use_memories = body.get("use_memories", False)

    sys_prompt = build_system_prompt() if use_memories else SYSTEM_PROMPT
    if not any(m.get("role") == "system" for m in messages):
        messages = [{"role": "system", "content": sys_prompt}] + messages

    if stream:
        async def event_stream():
            resp_id = "chatcmpl-" + uuid.uuid4().hex
            created = int(time.time())
            q    = queue_mod.Queue(maxsize=64)
            DONE = object()

            @spaces.GPU
            def produce():
                try:
                    with infer_lock:
                        for chunk in llm.create_chat_completion(
                            messages    = messages,
                            max_tokens  = max_tokens,
                            temperature = temperature,
                            stream      = True,
                        ):
                            q.put(chunk)
                except Exception as e:
                    q.put(e)
                finally:
                    q.put(DONE)

            threading.Thread(target=produce, daemon=True).start()
            while True:
                chunk = await asyncio.to_thread(q.get)
                if chunk is DONE:
                    break
                if isinstance(chunk, Exception):
                    yield f"data: {json.dumps({'error': str(chunk)})}\n\n"
                    break
                delta  = chunk["choices"][0]["delta"]
                finish = chunk["choices"][0].get("finish_reason")
                data   = {
                    "id":      resp_id,
                    "object":  "chat.completion.chunk",
                    "created": created,
                    "model":   model_id,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                yield f"data: {json.dumps(data)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @spaces.GPU
    def generate():
        with infer_lock:
            return llm.create_chat_completion(
                messages    = messages,
                max_tokens  = max_tokens,
                temperature = temperature,
                stream      = False,
            )

    result = await asyncio.to_thread(generate)
    return JSONResponse(result)

demo.launch(theme=THEME, css=CSS)