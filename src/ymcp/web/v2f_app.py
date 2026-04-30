"""Stdlib local web app for the Ymcp v2f editor."""

from __future__ import annotations

import base64
import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlparse

from ymcp.tools.imagegen.session import V2FSessionStore
from ymcp.tools.imagegen.timing import SpeedKeyframe, TimingMapSpec, TimingPoint, timing_from_speed_keyframes, timing_preset
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
    button:disabled { cursor:wait; opacity:.55; }
    button.secondary { background:#242b3d; }
    .preview { min-height:420px; display:flex; align-items:center; justify-content:center; background:
      radial-gradient(circle at center, #26314f, #0d1018 65%); border-radius:12px; overflow:hidden; }
    .preview img { max-width:100%; max-height:420px; image-rendering:auto; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .status { white-space:pre-wrap; color:#aab5d6; font-size:12px; }
    .curve { font-family: ui-monospace, monospace; font-size:12px; background:#0f1320; border-radius:10px; padding:10px; }
    .dropzone { border:1px dashed #5d7bff; border-radius:12px; padding:14px; text-align:center; color:#c8d3ff; background:#101729; margin:10px 0; }
    .dropzone.dragover { background:#1d2a55; border-color:#9fb3ff; }
    .busy { display:none; margin:10px 0; padding:10px; border-radius:10px; background:#25345e; color:#dce6ff; }
    .busy.active { display:block; }
    .keyframe-editor { margin-top:10px; padding:10px; border:1px solid #2f3855; border-radius:12px; background:#12182a; }
    .keyframe-row { display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:6px; align-items:end; margin-top:8px; }
    .keyframe-row button { width:auto; padding:9px 11px; background:#4a2630; border-color:#8a4050; }
    .speed-curve { width:100%; height:170px; margin-top:10px; border-radius:10px; background:#0f1320; touch-action:none; user-select:none; }
    .speed-curve text { fill:#8f9abe; font-size:10px; }
    .speed-handle { cursor:grab; stroke:#0f1320; stroke-width:2; }
    .speed-handle:active { cursor:grabbing; }
    .hint { color:#8f9abe; font-size:11px; line-height:1.45; margin-top:6px; }
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
      <video id="videoPlayer" controls style="display:none;width:100%;margin-top:10px;border-radius:12px;background:#000"></video>
      <label>路径</label><input id="source" placeholder="例如：F:/path/input.mp4 或 framesheet.png" />
      <div class="row"><div><label>帧数</label><input id="count" type="number" value="12" /></div><div><label>网格</label><input id="grid" value="4x3" /></div></div>
      <label>时间范围</label><input id="seconds" placeholder="例如：1-2" />
      <label>解码尺寸</label><input id="decodeSize" value="256" />
      <button onclick="createSession()">创建并抽帧</button>
      <button class="secondary" onclick="loadFramesheet()">载入帧表</button>
      <div class="busy" id="busy">处理中，请稍候……</div>
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
      <label>节奏模板</label><select id="preset"><option value="speed_keyframes">速度关键帧</option><option value="linear">线性</option><option value="hold_then_burst">蓄力后爆发</option><option value="slow_in_fast_out">先慢后快</option><option value="burst_then_settle">爆发后回落</option><option value="anticipation_explosion">预备爆发</option></select>
      <div class="row"><div><label>原视频时长（秒）</label><input id="timingDuration" type="number" min="0.01" step="0.01" placeholder="上传视频后自动读取" /></div><div><label>高级模式</label><select id="advancedTiming"><option value="false">隐藏关键点</option><option value="true">显示关键点</option></select></div></div>
      <div class="keyframe-editor" id="keyframeEditor">
        <div class="row"><button class="secondary" onclick="addSpeedKeyframe()">添加关键帧</button><button class="secondary" onclick="resetSpeedKeyframes()">恢复示例</button></div>
        <div id="keyframeRows"></div>
        <svg id="speedCurve" class="speed-curve" viewBox="0 0 320 170" role="img" aria-label="速度关键帧曲线">
          <line x1="34" y1="134" x2="304" y2="134" stroke="#34405f" />
          <line x1="34" y1="18" x2="34" y2="134" stroke="#34405f" />
          <text x="38" y="154">时间</text><text x="5" y="22">速度</text>
          <polyline id="speedCurveLine" fill="none" stroke="#7aa2ff" stroke-width="3" points="" />
          <g id="speedHandles"></g>
        </svg>
        <div class="hint">拖动圆点调整关键帧时间和“前速度”，拖动菱形调整同一关键帧的“后速度”；下方 JSON 会自动同步。</div>
      </div>
      <label>速度关键帧 JSON（自动同步，可直接编辑）</label><textarea id="speedKeyframes" style="width:100%;height:105px;background:#0f1320;color:#edf1ff;border-radius:10px">[{"time":1,"before":0.4,"after":5},{"time":5,"before":2,"after":1}]</textarea>
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
let busyCount = 0;
function setBusy(active, message='处理中，请稍候……'){
  busyCount += active ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  const busy = document.getElementById('busy');
  busy.textContent = message;
  busy.classList.toggle('active', busyCount > 0);
  for (const button of document.querySelectorAll('button')) button.disabled = busyCount > 0;
}
async function withBusy(message, action){
  setBusy(true, message);
  try {
    const result = await action();
    show({状态:'完成', 操作:message, 结果:result});
    return result;
  } catch (error) {
    show({状态:'失败', 操作:message, 错误:String(error)});
    throw error;
  } finally {
    setBusy(false, message);
  }
}
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
document.getElementById('preset').addEventListener('change', updateSemanticTimingSummary);
document.getElementById('advancedTiming').addEventListener('change', toggleAdvancedTiming);
document.getElementById('timingDuration').addEventListener('input', () => { renderKeyframeEditor(); updateSemanticTimingSummary(); });
document.getElementById('speedKeyframes').addEventListener('input', () => { renderKeyframeEditor(); updateSemanticTimingSummary(); });
async function uploadFile(file){
  return withBusy('正在上传文件……', async () => {
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
  const player = document.getElementById('videoPlayer');
  if (lower.endsWith('.png') || lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    document.getElementById('kind').value = 'framesheet';
    player.pause();
    player.removeAttribute('src');
    player.style.display = 'none';
    return {提示:'已上传帧表，请确认网格后点击“载入帧表”。', upload:data};
  } else {
    document.getElementById('kind').value = 'video';
    player.src = data.url;
    player.style.display = 'block';
    player.load();
    player.onloadedmetadata = () => {
      if (Number.isFinite(player.duration)) {
        document.getElementById('timingDuration').value = String(round3(player.duration));
        updateSemanticTimingSummary();
      }
    };
    return {提示:'已上传视频，请设置帧数/时间范围后点击“创建并抽帧”。', upload:data};
  }
  });
}
async function createSession(){
  return withBusy('正在创建会话并抽取视频帧……', async () => {
  const source = document.getElementById('source').value;
  const count = Number(document.getElementById('count').value);
  const seconds = document.getElementById('seconds').value || null;
  const decode_size = document.getElementById('decodeSize').value || null;
  const created = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'video'})});
  sessionId = created.id;
  const captured = await api(`/api/sessions/${sessionId}/capture`,{method:'POST',body:JSON.stringify({source,count,seconds,decode_size})});
  const preview = await renderPreview();
  return {captured, preview};
  });
}
async function loadFramesheet(){
  return withBusy('正在载入帧表……', async () => {
  const source = document.getElementById('source').value;
  const grid = document.getElementById('grid').value;
  const data = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'framesheet',source,grid})});
  sessionId = data.id;
  const preview = await renderPreview();
  return {session:data, preview};
  });
}
async function updateVisual(){
  if (!sessionId) return;
  return withBusy('正在应用视觉参数并刷新预览……', async () => {
  const w = document.getElementById('outW').value, h = document.getElementById('outH').value;
  const keyColor = document.getElementById('keyColor').value.trim();
  const crop = document.getElementById('crop').value.trim();
  const body = {remove_background: document.getElementById('removeBg').value === 'true', background_tolerance:Number(document.getElementById('bgTolerance').value), fade:buildFadeValue()};
  if (w && h) body.output_size = [Number(w), Number(h)];
  if (keyColor) body.key_color = keyColor.split(',').map(Number);
  if (crop) body.crop = crop.split(',').map(Number);
  const data = await api(`/api/sessions/${sessionId}/visual`,{method:'PATCH',body:JSON.stringify(body)});
  await renderPreview();
  return data;
  });
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
function round3(value){ return Math.round(value * 1000) / 1000; }
function defaultSpeedKeyframes(){
  return [{time:1,before:0.4,after:5},{time:5,before:2,after:1}];
}
function timingDuration(){
  const explicit = Number(document.getElementById('timingDuration').value);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  let lastTime = 5;
  try {
    const raw = JSON.parse(document.getElementById('speedKeyframes').value || '[]');
    if (Array.isArray(raw) && raw.length) {
      lastTime = Math.max(...raw.map(item => Number(item.time ?? item.time_seconds)).filter(Number.isFinite));
    }
  } catch (_error) {}
  return Math.max(lastTime + 1, 1);
}
function readSpeedKeyframes(strict=true){
  try {
    const raw = JSON.parse(document.getElementById('speedKeyframes').value || '[]');
    if (!Array.isArray(raw)) throw new Error('速度关键帧必须是数组');
    const duration = timingDuration();
    return raw.map(item => ({
      time: Math.max(0.001, Math.min(duration - 0.001, Number(item.time ?? item.time_seconds))),
      before: Math.max(0.05, Number(item.before ?? item.before_speed)),
      after: Math.max(0.05, Number(item.after ?? item.after_speed)),
    })).filter(item => Number.isFinite(item.time) && Number.isFinite(item.before) && Number.isFinite(item.after))
      .sort((a, b) => a.time - b.time);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}
function writeSpeedKeyframes(keyframes){
  const duration = timingDuration();
  const normalized = keyframes
    .map(item => ({
      time: Math.max(0.001, Math.min(duration - 0.001, Number(item.time))),
      before: Math.max(0.05, Number(item.before)),
      after: Math.max(0.05, Number(item.after)),
    }))
    .filter(item => Number.isFinite(item.time) && Number.isFinite(item.before) && Number.isFinite(item.after))
    .sort((a, b) => a.time - b.time);
  document.getElementById('speedKeyframes').value = JSON.stringify(normalized.map(item => ({
    time: round3(item.time),
    before: round3(item.before),
    after: round3(item.after),
  })));
  renderKeyframeEditor();
  updateSemanticTimingSummary();
}
function updateSpeedKeyframe(index, field, value){
  const frames = readSpeedKeyframes(false);
  if (!frames[index]) return;
  frames[index][field] = Number(value);
  writeSpeedKeyframes(frames);
}
function addSpeedKeyframe(){
  const frames = readSpeedKeyframes(false);
  const duration = timingDuration();
  const time = frames.length ? Math.min(duration - 0.001, frames[frames.length - 1].time + 1) : Math.min(1, duration / 2);
  frames.push({time, before:1, after:1});
  writeSpeedKeyframes(frames);
}
function removeSpeedKeyframe(index){
  const frames = readSpeedKeyframes(false);
  frames.splice(index, 1);
  writeSpeedKeyframes(frames);
}
function resetSpeedKeyframes(){
  writeSpeedKeyframes(defaultSpeedKeyframes());
}
function speedAt(time, frames, duration){
  if (!frames.length) return 1;
  if (time <= frames[0].time) return frames[0].before;
  for (let index = 0; index < frames.length - 1; index++) {
    const left = frames[index], right = frames[index + 1];
    if (time <= right.time) {
      const span = right.time - left.time || 1;
      const t = (time - left.time) / span;
      return left.after + (right.before - left.after) * t;
    }
  }
  const last = frames[frames.length - 1];
  const tail = duration - last.time || 1;
  const t = Math.max(0, Math.min(1, (time - last.time) / tail));
  return last.before + (last.after - last.before) * t;
}
function renderKeyframeEditor(){
  const rows = document.getElementById('keyframeRows');
  const frames = readSpeedKeyframes(false);
  rows.innerHTML = frames.map((item, index) => `
    <div class="keyframe-row">
      <div><label>时间（秒）</label><input type="number" step="0.01" value="${round3(item.time)}" onchange="updateSpeedKeyframe(${index}, 'time', this.value)" /></div>
      <div><label>前速度</label><input type="number" min="0.05" step="0.05" value="${round3(item.before)}" onchange="updateSpeedKeyframe(${index}, 'before', this.value)" /></div>
      <div><label>后速度</label><input type="number" min="0.05" step="0.05" value="${round3(item.after)}" onchange="updateSpeedKeyframe(${index}, 'after', this.value)" /></div>
      <button onclick="removeSpeedKeyframe(${index})">删除</button>
    </div>`).join('');
  renderSpeedCurve(frames);
}
function curvePoint(time, speed, duration, maxSpeed){
  const x = 34 + (time / duration) * 270;
  const y = 134 - (Math.min(speed, maxSpeed) / maxSpeed) * 116;
  return {x, y};
}
function renderSpeedCurve(frames){
  const duration = timingDuration();
  const maxSpeed = Math.max(1, 8, ...frames.flatMap(item => [item.before, item.after]));
  const samples = Array.from({length:80}, (_, index) => {
    const time = duration * index / 79;
    const point = curvePoint(time, speedAt(time, frames, duration), duration, maxSpeed);
    return `${round3(point.x)},${round3(point.y)}`;
  }).join(' ');
  document.getElementById('speedCurveLine').setAttribute('points', samples);
  document.getElementById('speedHandles').innerHTML = frames.map((item, index) => {
    const before = curvePoint(item.time, item.before, duration, maxSpeed);
    const after = curvePoint(item.time, item.after, duration, maxSpeed);
    return `<circle class="speed-handle" data-index="${index}" data-field="before" cx="${before.x}" cy="${before.y}" r="6" fill="#ffcf6e"></circle>
            <rect class="speed-handle" data-index="${index}" data-field="after" x="${after.x - 6}" y="${after.y - 6}" width="12" height="12" transform="rotate(45 ${after.x} ${after.y})" fill="#71f2b5"></rect>
            <text x="${before.x + 7}" y="${Math.min(before.y, after.y) - 8}">${round3(item.time)}s</text>`;
  }).join('');
}
document.getElementById('speedCurve').addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!target.classList || !target.classList.contains('speed-handle')) return;
  const curve = document.getElementById('speedCurve');
  const index = Number(target.dataset.index);
  const field = target.dataset.field;
  curve.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const rect = curve.getBoundingClientRect();
    const x = (moveEvent.clientX - rect.left) * 320 / rect.width;
    const y = (moveEvent.clientY - rect.top) * 170 / rect.height;
    const duration = timingDuration();
    const frames = readSpeedKeyframes(false);
    if (!frames[index]) return;
    const maxSpeed = Math.max(1, 8, ...frames.flatMap(item => [item.before, item.after]));
    const time = Math.max(0.001, Math.min(duration - 0.001, ((x - 34) / 270) * duration));
    const speed = Math.max(0.05, Math.min(maxSpeed, ((134 - y) / 116) * maxSpeed));
    frames[index].time = time;
    frames[index][field] = speed;
    writeSpeedKeyframes(frames);
  };
  const up = () => {
    curve.removeEventListener('pointermove', move);
    curve.removeEventListener('pointerup', up);
    curve.removeEventListener('pointercancel', up);
  };
  curve.addEventListener('pointermove', move);
  curve.addEventListener('pointerup', up);
  curve.addEventListener('pointercancel', up);
});
function updateSemanticTimingSummary(){
  const preset = document.getElementById('preset').value;
  if (preset !== 'speed_keyframes') {
    document.getElementById('curve').textContent = `节奏映射：${preset}\\n说明：使用内置预设。`;
    return;
  }
  document.getElementById('curve').textContent = `节奏映射：速度关键帧\\n说明：每个关键帧提供 time、before、after；关键帧前使用 before，两个关键帧之间从“前一个 after”插值到“后一个 before”，最后一段从最后关键帧的 before 插值到 after。`;
}
function toggleAdvancedTiming(){
  document.getElementById('advancedTimingPanel').style.display = document.getElementById('advancedTiming').value === 'true' ? 'block' : 'none';
}
async function applySemanticTiming(){
  return withBusy('正在应用节奏并刷新预览……', async () => {
  const preset = document.getElementById('preset').value;
  let payload;
  if (preset === 'speed_keyframes') {
    payload = {duration_seconds:Number(document.getElementById('timingDuration').value), speed_keyframes:JSON.parse(document.getElementById('speedKeyframes').value)};
  } else {
    payload = {preset};
  }
  const data = await api(`/api/sessions/${sessionId}/timing`,{method:'PATCH',body:JSON.stringify(payload)});
  document.getElementById('points').value = JSON.stringify(data.timing_spec.points.map(p => [p.output, p.source]));
  document.getElementById('curve').textContent = '节奏映射：\\n' + JSON.stringify(data.timing_spec,null,2);
  await renderPreview();
  return data;
  });
}
async function updateTiming(){
  return withBusy('正在应用高级关键点并刷新预览……', async () => {
  const points = JSON.parse(document.getElementById('points').value);
  const data = await api(`/api/sessions/${sessionId}/timing`,{method:'PATCH',body:JSON.stringify({points})});
  document.getElementById('curve').textContent = '节奏映射：\\n' + JSON.stringify(data.timing_spec,null,2);
  await renderPreview();
  return data;
  });
}
async function renderPreview(){
  if (!sessionId) return;
  return withBusy('正在生成预览……', async () => {
  const data = await api(`/api/sessions/${sessionId}/preview`);
  document.getElementById('preview').src = data.url + '?t=' + Date.now(); return data;
  });
}
async function exportOutput(format){
  return withBusy(`正在导出 ${format === 'framesheet' ? '帧表' : format.toUpperCase()}……`, async () => {
  const columns = document.getElementById('columns').value;
  const outDir = document.getElementById('outDir').value;
  const body = {format, duration_ms:Number(document.getElementById('duration').value), lossless:document.getElementById('lossless').value === 'true'};
  if (columns) body.columns = Number(columns);
  if (outDir) body.out_dir = outDir;
  return await api(`/api/sessions/${sessionId}/export`,{method:'POST',body:JSON.stringify(body)});
  });
}
renderKeyframeEditor();
updateSemanticTimingSummary();
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


def _file_response(handler: BaseHTTPRequestHandler, path, content_type: str | None = None) -> None:
    data = path.read_bytes()
    total = len(data)
    range_header = handler.headers.get("Range")
    mime = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    if range_header and range_header.startswith("bytes="):
        raw_start, _, raw_end = range_header.removeprefix("bytes=").partition("-")
        start = int(raw_start) if raw_start else 0
        end = int(raw_end) if raw_end else total - 1
        start = max(0, min(start, total - 1))
        end = max(start, min(end, total - 1))
        chunk = data[start : end + 1]
        handler.send_response(206)
        handler.send_header("content-type", mime)
        handler.send_header("accept-ranges", "bytes")
        handler.send_header("content-range", f"bytes {start}-{end}/{total}")
        handler.send_header("content-length", str(len(chunk)))
        handler.end_headers()
        handler.wfile.write(chunk)
        return
    handler.send_response(200)
    handler.send_header("content-type", mime)
    handler.send_header("accept-ranges", "bytes")
    handler.send_header("content-length", str(total))
    handler.end_headers()
    handler.wfile.write(data)


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
    if payload.get("speed_keyframes"):
        keyframes = tuple(
            SpeedKeyframe(
                time_seconds=float(item.get("time", item.get("time_seconds"))),
                before_speed=float(item.get("before", item.get("before_speed"))),
                after_speed=float(item.get("after", item.get("after_speed"))),
            )
            for item in payload["speed_keyframes"]
        )
        return timing_from_speed_keyframes(float(payload["duration_seconds"]), keyframes)
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
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "cache":
                    _json_response(self, 200, sessions.cache_summary(parts[2]))
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
                if len(parts) == 3 and parts[:2] == ["api", "uploads"]:
                    upload_path = sessions.upload_root / parts[2]
                    if not upload_path.exists():
                        _json_response(self, 404, {"error": "未找到上传文件"})
                        return
                    resolved = upload_path.resolve()
                    upload_root = sessions.upload_root.resolve()
                    if resolved != upload_root and upload_root not in resolved.parents:
                        _json_response(self, 403, {"error": "上传文件路径不在上传目录内"})
                        return
                    _file_response(self, resolved)
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
                    _json_response(self, 200, {"path": str(path), "url": f"/api/uploads/{path.name}", "size": len(raw)})
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
