"""Stdlib local web app for the Ymcp v2f editor."""

from __future__ import annotations

import base64
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlparse

from ymcp.tools.imagegen.session import V2FSessionStore
from ymcp.tools.imagegen.timing import TimingMapSpec, TimingPoint, timing_preset
from ymcp.tools.imagegen.v2f_core import CapturePlan, ExportSpec, VisualPipelineSpec


INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ymcp v2f 编辑器</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background:#101218; color:#edf1ff; }
    body { margin:0; }
    header { padding:18px 24px; border-bottom:1px solid #2b3040; background:#151925; }
    main { display:grid; grid-template-columns: 320px 1fr 360px; gap:16px; padding:16px; }
    section { background:#171c2a; border:1px solid #2b3040; border-radius:14px; padding:14px; }
    h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:0 0 12px; color:#9fb3ff; }
    label { display:block; margin:10px 0 4px; color:#bcc6e6; font-size:12px; }
    input, select, button { width:100%; box-sizing:border-box; border-radius:10px; border:1px solid #3a4260; background:#0f1320; color:#edf1ff; padding:9px; }
    button { cursor:pointer; background:#365cff; border-color:#5d7bff; margin-top:10px; font-weight:700; }
    button.secondary { background:#242b3d; }
    .preview { min-height:420px; display:flex; align-items:center; justify-content:center; background:
      radial-gradient(circle at center, #26314f, #0d1018 65%); border-radius:12px; overflow:hidden; }
    .preview img { max-width:100%; max-height:420px; image-rendering:auto; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .status { white-space:pre-wrap; color:#aab5d6; font-size:12px; }
    .curve { font-family: ui-monospace, monospace; font-size:12px; background:#0f1320; border-radius:10px; padding:10px; }
    .dropzone { border:1px dashed #5d7bff; border-radius:12px; padding:14px; text-align:center; color:#c8d3ff; background:#101729; margin:10px 0; }
    .dropzone.dragover { background:#1d2a55; border-color:#9fb3ff; }
  </style>
</head>
<body>
  <header><h1>Ymcp v2f 编辑器 <small>本地单用户</small></h1></header>
  <main>
    <section>
      <h2>素材来源</h2>
      <label>输入类型</label><select id="kind"><option value="video">视频</option><option value="framesheet">帧表</option></select>
      <div id="dropzone" class="dropzone">拖拽视频或帧表到这里，或点击选择文件</div>
      <input id="fileInput" type="file" style="display:none" />
      <label>路径</label><input id="source" placeholder="例如：F:/path/input.mp4 或 framesheet.png" />
      <div class="row"><div><label>帧数</label><input id="count" type="number" value="12" /></div><div><label>网格</label><input id="grid" value="4x3" /></div></div>
      <label>时间范围</label><input id="seconds" placeholder="例如：1-2" />
      <label>解码尺寸</label><input id="decodeSize" value="256" />
      <button onclick="createSession()">创建并抽帧</button>
      <button class="secondary" onclick="loadFramesheet()">载入帧表</button>
      <pre class="status" id="status">尚未创建会话。</pre>
    </section>
    <section>
      <h2>预览</h2>
      <div class="preview"><img id="preview" alt="预览会显示在这里" /></div>
      <button onclick="renderPreview()">生成预览</button>
      <button class="secondary" onclick="exportOutput('framesheet')">导出帧表</button>
      <button class="secondary" onclick="exportOutput('webp')">导出 WebP</button>
      <button class="secondary" onclick="exportOutput('gif')">导出 GIF</button>
    </section>
    <section>
      <h2>视觉与节奏</h2>
      <div class="row"><div><label>扣除背景</label><select id="removeBg"><option value="true">是</option><option value="false">否</option></select></div><div><label>背景容差</label><input id="bgTolerance" type="number" value="12" /></div></div>
      <label>透明淡出</label>
      <select id="fadeEnabled"><option value="true">启用</option><option value="false">关闭</option></select>
      <div class="row"><div><label>中心不透明半径（%）</label><input id="fadePercent" type="number" min="0" max="100" step="1" value="80" /></div><div><label>边缘衰减速度</label><input id="fadeSpeed" type="number" min="0.1" step="0.1" value="1" /></div></div>
      <label>淡出预设</label><select id="fadePreset"><option value="default">默认柔和</option><option value="none">关闭淡出</option><option value="tight">紧凑淡出</option><option value="wide">宽松淡出</option><option value="fast">快速收边</option></select>
      <pre class="curve" id="fadeSummary">透明淡出：中心 80% 保持不透明，边缘线性淡出</pre>
      <label>背景色 RGB</label><input id="keyColor" placeholder="可选，例如：0,255,0" />
      <label>裁剪区域</label><input id="crop" placeholder="可选：左,上,右,下" />
      <div class="row"><div><label>输出宽度</label><input id="outW" type="number" placeholder="可选" /></div><div><label>输出高度</label><input id="outH" type="number" placeholder="可选" /></div></div>
      <button onclick="updateVisual()">应用视觉参数</button>
      <label>节奏模板</label><select id="preset"><option value="linear">线性</option><option value="hold_then_burst">蓄力后爆发</option><option value="slow_in_fast_out">先慢后快</option><option value="burst_then_settle">爆发后回落</option><option value="anticipation_explosion">预备爆发</option><option value="custom_burst">自定义蓄力爆发</option></select>
      <div class="row"><div><label>蓄力时长（%）</label><input id="anticipation" type="range" min="0" max="80" value="35" /></div><div><label>停顿强度（%）</label><input id="hold" type="range" min="0" max="95" value="70" /></div></div>
      <div class="row"><div><label>爆发位置（%）</label><input id="burstAt" type="range" min="10" max="95" value="60" /></div><div><label>爆发速度</label><input id="burstSpeed" type="range" min="1" max="5" step="0.1" value="2.5" /></div></div>
      <div class="row"><div><label>回落时长（%）</label><input id="settle" type="range" min="0" max="60" value="25" /></div><div><label>高级模式</label><select id="advancedTiming"><option value="false">隐藏关键点</option><option value="true">显示关键点</option></select></div></div>
      <button onclick="applySemanticTiming()">应用节奏</button>
      <div id="advancedTimingPanel" style="display:none">
        <label>高级：关键点 JSON</label><textarea id="points" style="width:100%;height:130px;background:#0f1320;color:#edf1ff;border-radius:10px">[[0,0],[1,1]]</textarea>
        <button onclick="updateTiming()">应用高级关键点</button>
      </div>
      <pre class="curve" id="curve">节奏映射：线性</pre>
      <h2>导出</h2>
      <div class="row"><div><label>列数</label><input id="columns" type="number" placeholder="自动" /></div><div><label>单帧时长（毫秒）</label><input id="duration" type="number" value="80" /></div></div>
      <label>输出目录</label><input id="outDir" placeholder="可选；默认导出到当前会话目录" />
      <label>无损输出</label><select id="lossless"><option value="true">是</option><option value="false">否</option></select>
    </section>
  </main>
<script>
let sessionId = null;
async function api(path, options={}) {
  const res = await fetch(path, {headers:{'content-type':'application/json'}, ...options});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function show(data){ document.getElementById('status').textContent = JSON.stringify(data,null,2); }
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  if (event.dataTransfer.files.length) await uploadFile(event.dataTransfer.files[0]);
});
fileInput.addEventListener('change', async () => {
  if (fileInput.files.length) await uploadFile(fileInput.files[0]);
});
document.getElementById('fadePreset').addEventListener('change', applyFadePreset);
document.getElementById('fadeEnabled').addEventListener('change', updateFadeSummary);
document.getElementById('fadePercent').addEventListener('input', updateFadeSummary);
document.getElementById('fadeSpeed').addEventListener('input', updateFadeSummary);
document.getElementById('preset').addEventListener('change', applyTimingTemplateToSliders);
document.getElementById('advancedTiming').addEventListener('change', toggleAdvancedTiming);
for (const id of ['anticipation','hold','burstAt','burstSpeed','settle']) {
  document.getElementById(id).addEventListener('input', updateSemanticTimingSummary);
}
async function uploadFile(file){
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const base64 = String(dataUrl).split(',')[1];
  const data = await api('/api/uploads',{method:'POST',body:JSON.stringify({filename:file.name,data_base64:base64})});
  document.getElementById('source').value = data.path;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.png') || lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    document.getElementById('kind').value = 'framesheet';
    show({message:'已上传帧表，请确认网格后点击“载入帧表”。', upload:data});
  } else {
    document.getElementById('kind').value = 'video';
    show({message:'已上传视频，请设置帧数/时间范围后点击“创建并抽帧”。', upload:data});
  }
}
async function createSession(){
  const source = document.getElementById('source').value;
  const count = Number(document.getElementById('count').value);
  const seconds = document.getElementById('seconds').value || null;
  const decode_size = document.getElementById('decodeSize').value || null;
  const created = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'video'})});
  sessionId = created.id;
  show(await api(`/api/sessions/${sessionId}/capture`,{method:'POST',body:JSON.stringify({source,count,seconds,decode_size})}));
}
async function loadFramesheet(){
  const source = document.getElementById('source').value;
  const grid = document.getElementById('grid').value;
  const data = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'framesheet',source,grid})});
  sessionId = data.id; show(data);
}
async function updateVisual(){
  const w = document.getElementById('outW').value, h = document.getElementById('outH').value;
  const keyColor = document.getElementById('keyColor').value.trim();
  const crop = document.getElementById('crop').value.trim();
  const body = {remove_background: document.getElementById('removeBg').value === 'true', background_tolerance:Number(document.getElementById('bgTolerance').value), fade:buildFadeValue()};
  if (w && h) body.output_size = [Number(w), Number(h)];
  if (keyColor) body.key_color = keyColor.split(',').map(Number);
  if (crop) body.crop = crop.split(',').map(Number);
  show(await api(`/api/sessions/${sessionId}/visual`,{method:'PATCH',body:JSON.stringify(body)}));
}
function buildFadeValue(){
  if (document.getElementById('fadeEnabled').value !== 'true') return '100';
  const percent = Math.max(0, Math.min(100, Number(document.getElementById('fadePercent').value || 80)));
  const speed = Math.max(0.1, Number(document.getElementById('fadeSpeed').value || 1));
  return `${percent}-${speed}`;
}
function applyFadePreset(){
  const preset = document.getElementById('fadePreset').value;
  const enabled = document.getElementById('fadeEnabled');
  const percent = document.getElementById('fadePercent');
  const speed = document.getElementById('fadeSpeed');
  if (preset === 'none') { enabled.value = 'false'; percent.value = '100'; speed.value = '1'; }
  if (preset === 'default') { enabled.value = 'true'; percent.value = '80'; speed.value = '1'; }
  if (preset === 'tight') { enabled.value = 'true'; percent.value = '65'; speed.value = '1.2'; }
  if (preset === 'wide') { enabled.value = 'true'; percent.value = '90'; speed.value = '1'; }
  if (preset === 'fast') { enabled.value = 'true'; percent.value = '80'; speed.value = '2'; }
  updateFadeSummary();
}
function updateFadeSummary(){
  const summary = document.getElementById('fadeSummary');
  if (document.getElementById('fadeEnabled').value !== 'true') {
    summary.textContent = '透明淡出：关闭（等价于 fade=100）';
    return;
  }
  const value = buildFadeValue();
  const percent = document.getElementById('fadePercent').value || '80';
  const speed = document.getElementById('fadeSpeed').value || '1';
  summary.textContent = `透明淡出：中心 ${percent}% 保持不透明，边缘衰减速度 ${speed}（fade=${value}）`;
}
function semanticTimingPoints(){
  const anticipation = Number(document.getElementById('anticipation').value) / 100;
  const hold = Number(document.getElementById('hold').value) / 100;
  const burstAt = Number(document.getElementById('burstAt').value) / 100;
  const burstSpeed = Number(document.getElementById('burstSpeed').value);
  const settle = Number(document.getElementById('settle').value) / 100;
  const holdEndX = Math.min(0.92, Math.max(0.05, anticipation));
  const holdY = Math.max(0, Math.min(0.35, holdEndX * (1 - hold)));
  const burstX = Math.min(0.97, Math.max(holdEndX + 0.05, burstAt));
  const burstY = Math.min(0.95, Math.max(holdY + 0.05, holdY + (burstX - holdEndX) * burstSpeed));
  const settleX = Math.min(0.99, Math.max(burstX + 0.01, 1 - settle * 0.5));
  const settleY = Math.min(0.99, Math.max(burstY, 1 - settle * 0.2));
  return [[0,0],[round3(holdEndX),round3(holdY)],[round3(burstX),round3(burstY)],[round3(settleX),round3(settleY)],[1,1]];
}
function round3(value){ return Math.round(value * 1000) / 1000; }
function applyTimingTemplateToSliders(){
  const preset = document.getElementById('preset').value;
  const values = {
    linear: [0,0,50,1,0],
    hold_then_burst: [35,70,60,2.8,20],
    slow_in_fast_out: [25,35,72,1.8,15],
    burst_then_settle: [5,0,25,3.2,40],
    anticipation_explosion: [45,85,62,3.5,25],
    custom_burst: [35,70,60,2.5,25],
  }[preset];
  ['anticipation','hold','burstAt','burstSpeed','settle'].forEach((id, index) => document.getElementById(id).value = values[index]);
  updateSemanticTimingSummary();
}
function updateSemanticTimingSummary(){
  const points = semanticTimingPoints();
  document.getElementById('points').value = JSON.stringify(points);
  document.getElementById('curve').textContent = `节奏映射：模板 + 语义参数\\n关键点：${JSON.stringify(points)}\\n说明：蓄力越长/停顿越强，前段越接近静止；爆发速度越高，中段越快推进源视频。`;
}
function toggleAdvancedTiming(){
  document.getElementById('advancedTimingPanel').style.display = document.getElementById('advancedTiming').value === 'true' ? 'block' : 'none';
}
async function applySemanticTiming(){
  const points = semanticTimingPoints();
  document.getElementById('points').value = JSON.stringify(points);
  const data = await api(`/api/sessions/${sessionId}/timing`,{method:'PATCH',body:JSON.stringify({points})});
  document.getElementById('curve').textContent = '节奏映射：\\n' + JSON.stringify(data.timing_spec,null,2); show(data);
}
async function updateTiming(){
  const points = JSON.parse(document.getElementById('points').value);
  const data = await api(`/api/sessions/${sessionId}/timing`,{method:'PATCH',body:JSON.stringify({points})});
  document.getElementById('curve').textContent = '节奏映射：\\n' + JSON.stringify(data.timing_spec,null,2); show(data);
}
async function renderPreview(){
  const data = await api(`/api/sessions/${sessionId}/preview`);
  document.getElementById('preview').src = data.url + '?t=' + Date.now(); show(data);
}
async function exportOutput(format){
  const columns = document.getElementById('columns').value;
  const outDir = document.getElementById('outDir').value;
  const body = {format, duration_ms:Number(document.getElementById('duration').value), lossless:document.getElementById('lossless').value === 'true'};
  if (columns) body.columns = Number(columns);
  if (outDir) body.out_dir = outDir;
  show(await api(`/api/sessions/${sessionId}/export`,{method:'POST',body:JSON.stringify(body)}));
}
</script>
</body>
</html>"""


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _bytes_response(handler: BaseHTTPRequestHandler, status: int, body: bytes, content_type: str) -> None:
    handler.send_response(status)
    handler.send_header("content-type", content_type)
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _visual_from_payload(payload: dict[str, Any]) -> VisualPipelineSpec:
    output_size = payload.get("output_size")
    return VisualPipelineSpec(
        remove_background=bool(payload.get("remove_background", True)),
        background_tolerance=int(payload.get("background_tolerance", 12)),
        key_color=tuple(payload["key_color"]) if payload.get("key_color") else None,  # type: ignore[arg-type]
        crop=tuple(payload["crop"]) if payload.get("crop") else None,  # type: ignore[arg-type]
        output_size=tuple(output_size) if output_size else None,  # type: ignore[arg-type]
        fade=payload.get("fade", "default"),
    )


def _timing_from_payload(payload: dict[str, Any]) -> TimingMapSpec:
    if payload.get("preset"):
        return timing_preset(str(payload["preset"]))
    points = tuple(TimingPoint(float(item[0]), float(item[1])) for item in payload.get("points", [[0, 0], [1, 1]]))
    return TimingMapSpec(points=points)


def create_v2f_app(store: V2FSessionStore | None = None) -> type[BaseHTTPRequestHandler]:
    sessions = store or V2FSessionStore()

    class V2FHandler(BaseHTTPRequestHandler):
        server_version = "YmcpV2FEditor/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _read_json(self) -> dict[str, Any]:
            raw = self.rfile.read(int(self.headers.get("content-length", "0") or "0"))
            return json.loads(raw.decode("utf-8")) if raw else {}

        def do_GET(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
                if parsed.path in {"", "/"}:
                    _bytes_response(self, 200, INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "status":
                    _json_response(self, 200, sessions.status(parts[2]))
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "preview":
                    path = sessions.render_preview(parts[2])
                    _json_response(self, 200, {"path": str(path), "url": f"/api/sessions/{parts[2]}/artifact/preview"})
                    return
                if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3] == "artifact":
                    session = sessions.get(parts[2])
                    artifact_name = parts[4]
                    path = session.preview_path if artifact_name == "preview" else None
                    if path is None or not path.exists():
                        _json_response(self, 404, {"error": "未找到产物"})
                        return
                    session_root = session.temp_root.resolve()
                    resolved = path.resolve()
                    if resolved != session_root and session_root not in resolved.parents:
                        _json_response(self, 403, {"error": "产物路径不在当前会话目录内"})
                        return
                    _bytes_response(self, 200, resolved.read_bytes(), "image/webp")
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_POST(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                payload = self._read_json()
                if parts == ["api", "uploads"]:
                    raw = base64.b64decode(payload["data_base64"], validate=True)
                    path = sessions.save_upload(str(payload.get("filename", "upload.bin")), raw)
                    _json_response(self, 200, {"path": str(path), "size": len(raw)})
                    return
                if parts == ["api", "sessions"]:
                    if payload.get("kind") == "framesheet":
                        session = sessions.create_from_framesheet(payload["source"], payload["grid"])
                    else:
                        session = sessions.create_empty()
                    _json_response(self, 200, session.to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "capture":
                    plan = CapturePlan(
                        source=payload["source"],
                        count=int(payload["count"]),
                        seconds=payload.get("seconds"),
                        decode_size=payload.get("decode_size"),
                    )
                    _json_response(self, 200, sessions.capture_video(parts[2], plan).to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "export":
                    export = ExportSpec(
                        columns=payload.get("columns"),
                        duration_ms=int(payload.get("duration_ms", 80)),
                        loop=int(payload.get("loop", 0)),
                        lossless=bool(payload.get("lossless", True)),
                    )
                    export_format = str(payload.get("format", "bundle"))
                    if export_format == "framesheet":
                        out = sessions.export_framesheet(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "framesheet", "path": str(out), "framesheet": str(out)})
                    elif export_format == "webp":
                        out = sessions.export_webp(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "webp", "path": str(out), "animation": str(out)})
                    elif export_format == "gif":
                        out = sessions.export_gif(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "gif", "path": str(out), "animation": str(out)})
                    else:
                        out = sessions.export(parts[2], payload.get("out_dir"), export)
                        _json_response(self, 200, {"format": "bundle", "path": str(out), "framesheet": str(out / "framesheet.png"), "animation": str(out / "animation.webp")})
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_PATCH(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                payload = self._read_json()
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "visual":
                    _json_response(self, 200, sessions.update_visual(parts[2], _visual_from_payload(payload)).to_dict())
                    return
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "timing":
                    session = sessions.update_timing(parts[2], _timing_from_payload(payload))
                    _json_response(self, 200, sessions.status(session.id))
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

        def do_DELETE(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip("/").split("/") if part]
                if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
                    sessions.reset(parts[2])
                    _json_response(self, 200, {"deleted": True})
                    return
                _json_response(self, 404, {"error": "未找到请求的资源"})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})

    return V2FHandler


def run_v2f_editor(host: str = "127.0.0.1", port: int = 0, *, open_browser: bool = True) -> tuple[ThreadingHTTPServer, str]:
    handler = create_v2f_app()
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{server.server_address[0]}:{server.server_address[1]}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    if open_browser:
        webbrowser.open(url)
    return server, url


__all__ = ["create_v2f_app", "run_v2f_editor"]
