"""Static HTML for the local v2f/image utility workbench."""

from __future__ import annotations


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ymcp Frame Workbench</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11130f;
      --panel: #1b1d17;
      --panel-2: #24261f;
      --ink: #f4ecd8;
      --muted: #b7ac91;
      --line: #4d4839;
      --accent: #d36f38;
      --accent-2: #5fb6a6;
      --danger: #cf4b45;
      --shadow: 0 18px 46px rgba(0, 0, 0, .34);
      font-family: Candara, "Segoe UI", "Microsoft YaHei", sans-serif;
      background:
        linear-gradient(135deg, rgba(211,111,56,.10), transparent 34%),
        linear-gradient(180deg, #151710 0%, #0f120e 100%);
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .28;
      background-image:
        linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
      background-size: 28px 28px;
      mask-image: linear-gradient(180deg, #000, transparent 82%);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 16px 22px;
      border-bottom: 1px solid rgba(211,111,56,.34);
      background: rgba(17,19,15,.9);
      backdrop-filter: blur(14px);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 4px; font-size: clamp(22px, 3vw, 34px); line-height: 1; letter-spacing: 0; }
    h2 { margin-bottom: 10px; font-size: 18px; color: #ffd29d; }
    h3 { margin-bottom: 8px; font-size: 14px; color: #f5dfbd; }
    small, .muted { color: var(--muted); }
    button, input, select, textarea {
      font: inherit;
      color: var(--ink);
    }
    button {
      min-height: 38px;
      border: 1px solid rgba(211,111,56,.62);
      border-radius: 8px;
      padding: 8px 12px;
      background: linear-gradient(180deg, #c76532, #8f4126);
      color: #fff7ea;
      cursor: pointer;
      font-weight: 800;
      box-shadow: 0 8px 18px rgba(0,0,0,.2);
    }
    button:hover { filter: brightness(1.07); }
    button:disabled { cursor: wait; opacity: .55; filter: grayscale(.25); }
    button.secondary { border-color: rgba(95,182,166,.52); background: #22352f; box-shadow: none; }
    button.ghost { border-color: rgba(183,172,145,.42); background: transparent; box-shadow: none; }
    input, select, textarea {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #11150f;
      outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px rgba(95,182,166,.14); }
    label { display: block; margin: 10px 0 5px; color: var(--muted); font-size: 12px; font-weight: 800; }
    main { width: min(1440px, 100%); margin: 0 auto; padding: 18px; }
    .header-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .dashboard {
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .tool-nav, .panel, .preview-panel, .utility-panel {
      border: 1px solid rgba(183,172,145,.34);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(36,38,31,.96), rgba(27,29,23,.96));
      box-shadow: var(--shadow);
    }
    .tool-nav { padding: 12px; position: sticky; top: 90px; }
    .tool-grid { display: grid; gap: 8px; }
    .tool-card {
      width: 100%;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      min-height: 76px;
      padding: 10px;
      border: 1px solid rgba(183,172,145,.28);
      border-radius: 8px;
      background: #151912;
      color: var(--ink);
      text-align: left;
      box-shadow: none;
    }
    .tool-card.active { border-color: var(--accent); background: linear-gradient(135deg, rgba(211,111,56,.28), rgba(21,25,18,.92)); }
    .tool-card strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-card small { display: block; margin-top: 2px; line-height: 1.35; }
    .tool-icon {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 7px;
      background: #273830;
      color: #9fe0d3;
      font-weight: 900;
    }
    .workbench { display: grid; gap: 16px; min-width: 0; }
    .workspace { display: none; grid-template-columns: minmax(300px, 390px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .workspace.active { display: grid; }
    .panel, .preview-panel, .utility-panel { padding: 14px; }
    .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .triple { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .stack { display: flex; flex-direction: column; gap: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .actions button { width: auto; }
    .dropzone {
      min-height: 108px;
      display: grid;
      place-items: center;
      padding: 14px;
      border: 1px dashed rgba(95,182,166,.76);
      border-radius: 8px;
      background: repeating-linear-gradient(45deg, rgba(95,182,166,.08) 0 8px, transparent 8px 16px), #121810;
      color: #d7eadf;
      text-align: center;
      cursor: pointer;
    }
    .dropzone.dragover { border-color: #ffd29d; background-color: #213025; }
    .media-frame {
      min-height: 320px;
      display: grid;
      place-items: center;
      overflow: auto;
      border: 1px solid rgba(183,172,145,.28);
      border-radius: 8px;
      background:
        linear-gradient(45deg, #20231b 25%, transparent 25%),
        linear-gradient(-45deg, #20231b 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #20231b 75%),
        linear-gradient(-45deg, transparent 75%, #20231b 75%),
        #151811;
      background-position: 0 0, 0 12px, 12px -12px, -12px 0;
      background-size: 24px 24px;
    }
    .media-frame img, .media-frame canvas, .media-frame video {
      display: block;
      max-width: 100%;
      max-height: min(68vh, 720px);
      image-rendering: auto;
    }
    .thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(82px, 1fr)); gap: 8px; margin-top: 10px; max-height: 360px; overflow: auto; }
    .thumb { min-height: 82px; display: grid; place-items: center; border: 1px solid rgba(183,172,145,.28); border-radius: 7px; background: #141810; }
    .thumb img, .thumb canvas { max-width: 100%; max-height: 110px; image-rendering: pixelated; }
    .status {
      min-height: 88px;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid rgba(183,172,145,.24);
      border-radius: 8px;
      padding: 10px;
      background: #10140e;
      color: #c7bea6;
      font: 12px/1.45 Consolas, "Courier New", monospace;
    }
    .busy { display: none; margin-top: 10px; padding: 10px; border-radius: 8px; background: #2e3f37; color: #d9fff0; }
    .busy.active { display: block; }
    .video-shell { display: none; position: relative; overflow: hidden; border-radius: 8px; background: #050605; }
    .video-shell video { width: 100%; max-height: 300px; background: #000; }
    .video-timebar { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 8px; border-top: 1px solid #32372c; }
    .video-timebar button { margin: 0; width: auto; min-height: 32px; padding: 6px 9px; }
    .crop-box { display: none; position: absolute; border: 2px solid #9fe0d3; box-shadow: 0 0 0 9999px rgba(0,0,0,.36); cursor: move; }
    .crop-box::after { content: ""; position: absolute; right: -7px; bottom: -7px; width: 14px; height: 14px; border-radius: 50%; background: #9fe0d3; border: 2px solid #10140e; cursor: nwse-resize; }
    .crop-active .crop-box { display: block; }
    .playback-status { margin-top: 8px; color: var(--muted); font: 12px Consolas, monospace; text-align: center; }
    .note { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .swatch { width: 38px; min-width: 38px; padding: 0; overflow: hidden; }
    .canvas-stage { width: 100%; min-height: 460px; }
    @media (max-width: 1060px) {
      header { grid-template-columns: 1fr; }
      .dashboard, .workspace { grid-template-columns: 1fr; }
      .tool-nav { position: static; }
    }
    @media (max-width: 680px) {
      main { padding: 10px; }
      header { padding: 14px; }
      .row, .triple { grid-template-columns: 1fr; }
      .video-timebar { grid-template-columns: 1fr; }
      .actions button { width: 100%; }
    }
  </style>
</head>
<body>
<header>
  <div>
    <h1>Ymcp v2f 编辑器</h1>
    <small>Frame Workbench · 本地视频抽帧 + 浏览器端像素素材工具</small>
  </div>
  <div class="header-actions">
    <button class="ghost" type="button" onclick="showTool('video')">视频转序列帧</button>
    <button class="ghost" type="button" onclick="showTool('clientVideo')">参考版抽帧</button>
    <button class="ghost" type="button" onclick="showTool('spriteSplit')">Sprite 拆分</button>
    <button class="ghost" type="button" onclick="showTool('matte')">抠图</button>
  </div>
</header>
<main>
  <div class="dashboard">
    <nav class="tool-nav" aria-label="功能入口">
      <h2>功能入口</h2>
      <p class="note">当前页面把可在客户端完成的功能做成本地工具板块；视频转序列帧保留现有 Ymcp 后端流程，方便继续导出帧表、WebP 和 GIF。</p>
      <div class="tool-grid" id="toolGrid"></div>
    </nav>
    <div class="workbench">
      <section id="tool-video" class="workspace active">
        <div class="panel">
          <h2>视频转序列帧</h2>
          <h3>素材来源</h3>
          <label>输入类型</label>
          <select id="kind"><option value="video">视频</option><option value="framesheet">帧表</option></select>
          <div id="dropzone" class="dropzone">拖拽视频或帧表到这里，或点击选择文件</div>
          <input id="fileInput" type="file" style="display:none" />
          <div id="videoPreview" class="video-shell">
            <video id="videoPlayer" controls playsinline></video>
            <div class="video-timebar" aria-label="视频时间预览">
              <span id="videoTime" class="muted">当前 00:00 / --:--（0 秒 / -- 秒）</span>
              <button class="secondary" type="button" onclick="setRangePoint('start')">设为起点</button>
              <button class="secondary" type="button" onclick="setRangePoint('end')">设为终点</button>
            </div>
            <div id="cropBox" class="crop-box" aria-label="视频裁剪框"></div>
          </div>
          <div class="row">
            <div><label>视频裁剪</label><select id="cropEnabled"><option value="false">关闭</option><option value="true">启用</option></select></div>
            <div><label>裁剪坐标</label><input id="captureCrop" placeholder="自动：左,上,右,下" /></div>
          </div>
          <button class="secondary" type="button" onclick="resetCropBox()">重置裁剪框</button>
          <p class="note">裁剪、帧数、时间范围、解码尺寸会重新从视频取帧；右侧参数复用已取帧素材。</p>
          <label>路径</label><input id="source" placeholder="例如：F:/path/input.mp4 或 framesheet.png" />
          <div class="row"><div><label>帧数</label><input id="count" type="number" value="12" /></div><div><label>网格</label><input id="grid" value="4x3" /></div></div>
          <label>时间范围</label><input id="seconds" placeholder="例如：1-2" />
          <label>解码尺寸</label><input id="decodeSize" value="256" />
          <div class="actions">
            <button type="button" onclick="createSession()">创建并抽帧</button>
            <button class="secondary" type="button" onclick="loadFramesheet()">载入帧表</button>
          </div>
        </div>
        <div class="preview-panel">
          <h2>预览与导出</h2>
          <div class="media-frame"><img id="preview" alt="预览会显示在这里" /></div>
          <div class="playback-status" id="playbackStatus">序列帧 0 / 0 · 12 fps</div>
          <div class="row"><div><label>预览 FPS</label><input id="previewFps" type="number" min="1" max="60" step="1" value="12" /></div><div><label>单帧时长（毫秒）</label><input id="duration" type="number" value="80" /></div></div>
          <div class="actions">
            <button class="secondary" type="button" onclick="startSequencePlayback()">播放</button>
            <button class="secondary" type="button" onclick="toggleSequencePlayback()">播放 / 暂停</button>
            <button class="secondary" type="button" onclick="resetSequencePlayback()">重置</button>
            <button type="button" onclick="renderPreview()">生成预览</button>
          </div>
          <h3>视觉参数</h3>
          <div class="row"><div><label>扣除背景</label><select id="removeBg"><option value="true">是</option><option value="false">否</option></select></div><div><label>背景容差</label><input id="bgTolerance" type="number" value="12" /></div></div>
          <div class="row"><div><label>淡出预设</label><select id="fadePreset"><option value="default">默认柔和</option><option value="none">关闭淡出</option><option value="tight">紧凑淡出</option><option value="wide">宽松淡出</option><option value="fast">快速收边</option></select></div><div><label>背景色 RGB</label><input id="keyColor" placeholder="可选，例如：0,255,0" /></div></div>
          <div class="row"><div><label>中心不透明半径（%）</label><input id="fadePercent" type="number" min="0" max="100" step="1" value="80" /></div><div><label>边缘衰减速度</label><input id="fadeSpeed" type="number" min="0.1" step="0.1" value="1" /></div></div>
          <pre class="status" id="fadeSummary">透明淡出：中心 80% 保持不透明，边缘线性淡出</pre>
          <div class="row"><div><label>输出宽度</label><input id="outW" type="number" placeholder="可选" /></div><div><label>输出高度</label><input id="outH" type="number" placeholder="可选" /></div></div>
          <div class="actions">
            <button type="button" onclick="updateVisual()">应用视觉参数</button>
            <button class="secondary" type="button" onclick="exportOutput('framesheet')">导出帧表</button>
            <button class="secondary" type="button" onclick="exportOutput('webp')">导出 WebP</button>
            <button class="secondary" type="button" onclick="exportOutput('gif')">导出 GIF</button>
          </div>
          <div class="row"><div><label>列数</label><input id="columns" type="number" placeholder="自动" /></div><div><label>输出目录</label><input id="outDir" placeholder="可选；默认导出到当前会话目录" /></div></div>
          <label>节奏模板</label><select id="preset"><option value="linear">线性</option><option value="speed_keyframes">速度关键帧</option><option value="hold_then_burst">蓄力后爆发</option><option value="slow_in_fast_out">先慢后快</option><option value="burst_then_settle">爆发后回落</option><option value="anticipation_explosion">预备爆发</option></select>
          <div class="row"><div><label>原视频时长（秒）</label><input id="timingDuration" type="number" min="0.01" step="0.01" placeholder="上传视频后自动读取" /></div><div><label>高级模式</label><select id="advancedTiming"><option value="false">隐藏关键点</option><option value="true">显示关键点</option></select></div></div>
          <div class="panel" style="box-shadow:none;margin-top:10px">
            <h3>速度关键帧</h3>
            <div class="actions"><button class="secondary" type="button" onclick="addSpeedKeyframe()">添加关键帧</button><button class="secondary" type="button" onclick="resetSpeedKeyframes()">恢复单关键帧预设</button></div>
            <svg id="speedCurve" viewBox="0 0 320 170" style="width:100%;height:160px;background:#11150f;border-radius:8px;margin-top:8px" role="img" aria-label="速度关键帧曲线">
              <line x1="34" y1="134" x2="304" y2="134" stroke="#4d4839" />
              <line x1="34" y1="18" x2="34" y2="134" stroke="#4d4839" />
              <polyline id="speedCurveLine" fill="none" stroke="#5fb6a6" stroke-width="3" points="" />
            </svg>
            <p class="note">拖动圆点调整关键帧时间；前速度、后速度会影响序列帧节奏。</p>
            <label>速度关键帧 JSON（自动同步，可直接编辑）</label>
            <textarea id="speedKeyframes" style="height:80px">[]</textarea>
          </div>
          <div class="actions"><button class="secondary" type="button" onclick="applySemanticTiming()">应用节奏</button></div>
          <div class="log-panel">
            <h3>输出日志</h3>
          </div>
          <div class="busy" id="busy">处理中，请稍候……</div>
          <pre class="status" id="status">尚未创建会话。</pre>
        </div>
      </section>

      <section id="tool-clientVideo" class="workspace">
        <div class="panel">
          <h2>参考版视频转序列帧</h2>
          <input id="clientVideoFile" type="file" accept="video/*" />
          <div class="video-shell" id="clientVideoShell" style="display:block;margin-top:10px">
            <video id="clientVideoPlayer" controls playsinline muted></video>
            <div class="video-timebar" aria-label="参考版视频时间预览">
              <span id="clientVideoMeta" class="muted">等待视频。</span>
              <button class="secondary" type="button" onclick="setClientRangePoint('start')">设为起点</button>
              <button class="secondary" type="button" onclick="setClientRangePoint('end')">设为终点</button>
            </div>
          </div>
          <div class="row">
            <div><label>目标 FPS</label><input id="clientVideoFps" type="number" min="1" max="60" step="1" value="12" /></div>
            <div><label>最大帧数</label><input id="clientVideoMaxFrames" type="number" min="1" max="2000" step="1" value="300" /></div>
          </div>
          <div class="row">
            <div><label>起始秒</label><input id="clientVideoStart" type="number" min="0" step="0.05" value="0" /></div>
            <div><label>结束秒</label><input id="clientVideoEnd" type="number" min="0" step="0.05" placeholder="默认视频结尾" /></div>
          </div>
          <div class="row">
            <div><label>输出宽度</label><input id="clientVideoW" type="number" min="1" placeholder="原宽" /></div>
            <div><label>输出高度</label><input id="clientVideoH" type="number" min="1" placeholder="原高" /></div>
          </div>
          <div class="row">
            <div><label>Sprite 列数</label><input id="clientVideoCols" type="number" min="1" value="4" /></div>
            <div><label>透明抠色</label><input id="clientVideoKey" placeholder="可选，如 #00ff00" /></div>
          </div>
          <div class="row">
            <div><label>抠色容差</label><input id="clientVideoTol" type="number" min="0" max="255" value="42" /></div>
            <div><label>边缘羽化</label><input id="clientVideoFeather" type="number" min="1" max="255" value="38" /></div>
          </div>
          <div class="actions">
            <button type="button" onclick="extractClientVideoFrames()">提取序列帧</button>
            <button class="secondary" type="button" onclick="downloadClientFramesZip('clientVideo')">下载 PNG ZIP</button>
            <button class="secondary" type="button" onclick="downloadCanvas('clientVideoSheet','client_video_spritesheet.png')">下载 Sprite Sheet</button>
          </div>
          <p class="note">这个版本参考目标网页的客户端路线：视频文件留在浏览器内，用 video seek + canvas drawImage 抽帧，再用浏览器 Blob 下载。</p>
          <pre class="status" id="clientVideoStatus">等待视频。</pre>
        </div>
        <div class="preview-panel">
          <h2>参考版结果</h2>
          <div class="media-frame canvas-stage"><canvas id="clientVideoSheet"></canvas></div>
          <div id="clientVideoThumbs" class="thumb-grid"></div>
        </div>
      </section>

      <section id="tool-spriteSplit" class="workspace">
        <div class="panel">
          <h2>Sprite Sheet 拆分</h2>
          <input id="splitFile" type="file" accept="image/png,image/jpeg,image/webp" />
          <div class="row"><div><label>列数</label><input id="splitCols" type="number" min="1" value="8" /></div><div><label>行数</label><input id="splitRows" type="number" min="1" value="4" /></div></div>
          <div class="actions">
            <button type="button" onclick="splitSpriteSheet()">拆成 PNG 帧</button>
            <button class="secondary" type="button" onclick="downloadClientFramesZip('split')">下载 ZIP</button>
          </div>
          <p class="note">完全在浏览器内切图；不会上传图片。按行列等分，适合常规 Sprite Sheet。</p>
          <pre class="status" id="splitStatus">等待图片。</pre>
        </div>
        <div class="preview-panel">
          <h2>拆分结果</h2>
          <div class="media-frame"><img id="splitSourcePreview" alt="" /></div>
          <div id="splitThumbs" class="thumb-grid"></div>
        </div>
      </section>

      <section id="tool-sheetCompose" class="workspace">
        <div class="panel">
          <h2>多图合成 Sprite Sheet</h2>
          <input id="composeFiles" type="file" accept="image/png,image/jpeg,image/webp" multiple />
          <div class="triple"><div><label>列数</label><input id="composeCols" type="number" min="1" value="4" /></div><div><label>间距</label><input id="composeGap" type="number" min="0" value="0" /></div><div><label>内边距</label><input id="composePad" type="number" min="0" value="0" /></div></div>
          <div class="row"><div><label>裁切上</label><input id="composeCropTop" type="number" value="0" /></div><div><label>裁切下</label><input id="composeCropBottom" type="number" value="0" /></div></div>
          <div class="row"><div><label>裁切左</label><input id="composeCropLeft" type="number" value="0" /></div><div><label>裁切右</label><input id="composeCropRight" type="number" value="0" /></div></div>
          <div class="actions">
            <button type="button" onclick="composeSpriteSheet()">合成 Sprite Sheet</button>
            <button class="secondary" type="button" onclick="downloadCanvas('composeCanvas','sprite_sheet.png')">下载 PNG</button>
          </div>
          <pre class="status" id="composeStatus">等待图片。</pre>
        </div>
        <div class="preview-panel">
          <h2>合成结果</h2>
          <div class="media-frame canvas-stage"><canvas id="composeCanvas"></canvas></div>
        </div>
      </section>

      <section id="tool-stitch" class="workspace">
        <div class="panel">
          <h2>简单拼接</h2>
          <input id="stitchFiles" type="file" accept="image/png,image/jpeg,image/webp" multiple />
          <label>方向</label><select id="stitchMode"><option value="vertical">纵向</option><option value="horizontal">横向</option><option value="overlay">居中叠放</option></select>
          <div class="actions">
            <button type="button" onclick="stitchImages()">拼接</button>
            <button class="secondary" type="button" onclick="downloadCanvas('stitchCanvas','stitched.png')">下载 PNG</button>
          </div>
          <pre class="status" id="stitchStatus">等待图片。</pre>
        </div>
        <div class="preview-panel">
          <h2>拼接结果</h2>
          <div class="media-frame canvas-stage"><canvas id="stitchCanvas"></canvas></div>
        </div>
      </section>

      <section id="tool-matte" class="workspace">
        <div class="panel">
          <h2>客户端抠图</h2>
          <input id="matteFile" type="file" accept="image/png,image/jpeg,image/webp" />
          <label>算法</label><select id="matteMode"><option value="chroma">颜色键</option><option value="white">白底去除</option></select>
          <div class="row"><div><label>目标颜色</label><input id="matteColor" value="#00ff00" /></div><div><label>容差</label><input id="matteTolerance" type="number" min="0" max="255" value="72" /></div></div>
          <div class="row"><div><label>羽化</label><input id="matteFeather" type="number" min="0" max="255" value="54" /></div><div><label>边缘腐蚀</label><input id="matteErode" type="number" min="0" max="8" value="1" /></div></div>
          <div class="actions">
            <button type="button" onclick="runMatte()">处理</button>
            <button class="secondary" type="button" onclick="downloadCanvas('matteCanvas','matte.png')">下载 PNG</button>
          </div>
          <p class="note">颜色键模式可在左侧原图上点击取色。白底去除适合白色或浅色背景。</p>
          <pre class="status" id="matteStatus">等待图片。</pre>
        </div>
        <div class="preview-panel">
          <h2>原图 / 结果</h2>
          <div class="row">
            <div class="media-frame"><img id="matteSourcePreview" alt="点击取色" onclick="pickMatteColor(event)" /></div>
            <div class="media-frame"><canvas id="matteCanvas"></canvas></div>
          </div>
        </div>
      </section>

      <section id="tool-pixel" class="workspace">
        <div class="panel">
          <h2>像素化 / 缩放</h2>
          <input id="pixelFile" type="file" accept="image/png,image/jpeg,image/webp" />
          <label>模式</label><select id="pixelMode"><option value="pixelate">像素化</option><option value="resize">缩放</option></select>
          <div class="triple"><div><label>像素块</label><input id="pixelBlock" type="number" min="1" value="8" /></div><div><label>目标宽</label><input id="pixelWidth" type="number" placeholder="原宽" /></div><div><label>目标高</label><input id="pixelHeight" type="number" placeholder="原高" /></div></div>
          <div class="actions">
            <button type="button" onclick="runPixelTool()">处理</button>
            <button class="secondary" type="button" onclick="downloadCanvas('pixelCanvas','pixel_tool.png')">下载 PNG</button>
          </div>
          <pre class="status" id="pixelStatus">等待图片。</pre>
        </div>
        <div class="preview-panel">
          <h2>处理结果</h2>
          <div class="media-frame canvas-stage"><canvas id="pixelCanvas"></canvas></div>
        </div>
      </section>
    </div>
  </div>
</main>
<script>
const TOOLS = [
  {id:'video', icon:'V', title:'视频转序列帧', desc:'复用当前后端抽帧、预览、帧表/WebP/GIF 导出'},
  {id:'clientVideo', icon:'R', title:'参考版视频转序列帧', desc:'纯浏览器 video + canvas 抽 PNG 帧和 Sprite Sheet'},
  {id:'spriteSplit', icon:'S', title:'Sprite Sheet 拆分', desc:'浏览器 canvas 等分切片，ZIP 打包 PNG 帧'},
  {id:'sheetCompose', icon:'C', title:'多图合成帧表', desc:'多张 PNG/JPG/WebP 排列成 Sprite Sheet'},
  {id:'stitch', icon:'+', title:'简单拼接', desc:'纵向、横向或居中叠放图片'},
  {id:'matte', icon:'M', title:'客户端抠图', desc:'颜色键、白底去除、羽化和边缘腐蚀'},
  {id:'pixel', icon:'P', title:'像素化 / 缩放', desc:'像素块化或按目标尺寸重采样'}
];
let sessionId = null;
const cropState = {x:0, y:0, w:0, h:0};
const sequencePlayback = {frames:[], index:0, timer:null, playing:false};
const clientFrames = {split:[], clientVideo:[]};
const objectUrls = new Set();

function $(id){ return document.getElementById(id); }
function numberValue(id, fallback=0){ const value = Number($(id).value); return Number.isFinite(value) ? value : fallback; }
function showTool(id){
  for (const tool of TOOLS) {
    $(`tool-${tool.id}`).classList.toggle('active', tool.id === id);
    const button = document.querySelector(`[data-tool="${tool.id}"]`);
    if (button) button.classList.toggle('active', tool.id === id);
  }
}
function renderToolNav(){
  const grid = $('toolGrid');
  grid.replaceChildren(...TOOLS.map(tool => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-card ${tool.id === 'video' ? 'active' : ''}`;
    button.dataset.tool = tool.id;
    button.onclick = () => showTool(tool.id);
    button.innerHTML = `<span class="tool-icon">${tool.icon}</span><span><strong>${tool.title}</strong><small>${tool.desc}</small></span>`;
    return button;
  }));
}
async function api(path, options={}) {
  const res = await fetch(path, {headers:{'content-type':'application/json'}, ...options});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function show(data){ $('status').textContent = JSON.stringify(data,null,2); }
let busyCount = 0;
function setBusy(active, message='处理中，请稍候……'){
  busyCount += active ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  $('busy').textContent = message;
  $('busy').classList.toggle('active', busyCount > 0);
  document.querySelectorAll('#tool-video button').forEach(button => button.disabled = busyCount > 0);
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
function setStatus(id, data){ $(id).textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2); }
function trackUrl(url){ objectUrls.add(url); return url; }
function revokeTracked(url){ if (url && objectUrls.has(url)) { URL.revokeObjectURL(url); objectUrls.delete(url); } }
function fileToDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function loadImageFromFile(file){
  return new Promise((resolve, reject) => {
    const url = trackUrl(URL.createObjectURL(file));
    const image = new Image();
    image.onload = () => resolve({image, url});
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = url;
  });
}
async function loadImagesFromFiles(files){
  const items = [];
  for (const file of files) items.push({file, ...(await loadImageFromFile(file))});
  return items;
}
function canvasToBlob(canvas){
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas 导出失败')), 'image/png'));
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
async function downloadCanvas(canvasId, filename){
  const canvas = $(canvasId);
  if (!canvas || !canvas.width || !canvas.height) return;
  downloadBlob(await canvasToBlob(canvas), filename);
}
function drawCoverToCanvas(image, canvas, smoothing=true){
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = smoothing;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(image,0,0);
  return ctx;
}

const dropzone = $('dropzone');
const fileInput = $('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', async event => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  if (event.dataTransfer.files.length) await uploadFile(event.dataTransfer.files[0]);
});
fileInput.addEventListener('change', async () => {
  if (fileInput.files.length) await uploadFile(fileInput.files[0]);
});
$('count').addEventListener('input', updateGridFromCount);
$('cropEnabled').addEventListener('change', () => {
  $('videoPreview').classList.toggle('crop-active', $('cropEnabled').value === 'true');
  if ($('cropEnabled').value === 'true' && !cropState.w) resetCropBox();
  updateCaptureCropInput();
});
$('captureCrop').addEventListener('change', applyCaptureCropInput);
$('previewFps').addEventListener('input', () => {
  updateSequenceStatus();
  if (sequencePlayback.playing) startSequencePlayback();
});
$('fadePercent').addEventListener('input', updateFadeSummary);
$('fadeSpeed').addEventListener('input', updateFadeSummary);
$('fadePreset').addEventListener('change', updateFadeSummary);
$('advancedTiming').addEventListener('change', toggleAdvancedTiming);
async function uploadFile(file){
  return withBusy('正在上传文件……', async () => {
    const dataUrl = await fileToDataUrl(file);
    const base64 = String(dataUrl).split(',')[1];
    const data = await api('/api/uploads',{method:'POST',body:JSON.stringify({filename:file.name,data_base64:base64})});
    $('source').value = data.path;
    const lower = file.name.toLowerCase();
    const player = $('videoPlayer');
    if (/\.(png|webp|jpe?g)$/i.test(lower)) {
      $('kind').value = 'framesheet';
      player.pause();
      player.removeAttribute('src');
      $('videoPreview').style.display = 'none';
      $('cropEnabled').value = 'false';
      $('videoPreview').classList.remove('crop-active');
      return {提示:'已上传帧表，请确认网格后点击“载入帧表”。', upload:data};
    }
    $('kind').value = 'video';
    player.src = data.url;
    $('videoPreview').style.display = 'block';
    player.load();
    player.onloadedmetadata = () => {
      if (Number.isFinite(player.duration)) $('timingDuration').value = String(Math.round(player.duration * 100) / 100);
      updateVideoTimePreview();
      resetCropBox();
    };
    return {提示:'已上传视频，请设置帧数/时间范围后点击“创建并抽帧”。', upload:data};
  });
}
function formatClock(seconds){
  if (!Number.isFinite(seconds)) return '--:--';
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}
function videoWholeSecond(value){ return Math.max(0, Math.round(Number(value) || 0)); }
function updateVideoTimePreview(){
  const player = $('videoPlayer');
  const current = videoWholeSecond(player.currentTime);
  const duration = Number.isFinite(player.duration) ? videoWholeSecond(player.duration) : null;
  $('videoTime').textContent = `当前 ${formatClock(current)} / ${formatClock(duration)}（${current} 秒 / ${duration === null ? '--' : duration} 秒）`;
}
function readSecondsRange(){
  const match = $('seconds').value.trim().match(/^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/);
  return match ? {start:Number(match[1]), end:Number(match[2])} : {start:null, end:null};
}
function setRangePoint(point){
  const current = videoWholeSecond($('videoPlayer').currentTime);
  const range = readSecondsRange();
  const start = point === 'start' ? current : (range.start ?? 0);
  const end = point === 'end' ? current : (range.end ?? Math.max(current, start + 1));
  $('seconds').value = `${Math.min(start, end)}-${Math.max(start, end)}`;
}
['timeupdate','seeking','loadedmetadata','durationchange'].forEach(name => $('videoPlayer').addEventListener(name, updateVideoTimePreview));
function displayedVideoRect(){
  const player = $('videoPlayer');
  const shell = $('videoPreview').getBoundingClientRect();
  const rect = player.getBoundingClientRect();
  return {left:rect.left - shell.left, top:rect.top - shell.top, width:rect.width, height:rect.height};
}
function resetCropBox(){
  const rect = displayedVideoRect();
  cropState.x = Math.round(rect.width * .1);
  cropState.y = Math.round(rect.height * .1);
  cropState.w = Math.round(rect.width * .8);
  cropState.h = Math.round(rect.height * .8);
  renderCropBox();
  updateCaptureCropInput();
}
function renderCropBox(){
  const rect = displayedVideoRect();
  const box = $('cropBox');
  box.style.left = `${rect.left + cropState.x}px`;
  box.style.top = `${rect.top + cropState.y}px`;
  box.style.width = `${cropState.w}px`;
  box.style.height = `${cropState.h}px`;
}
function updateCaptureCropInput(){
  if ($('cropEnabled').value !== 'true') return;
  const player = $('videoPlayer');
  const rect = displayedVideoRect();
  const sx = (player.videoWidth || rect.width) / Math.max(1, rect.width);
  const sy = (player.videoHeight || rect.height) / Math.max(1, rect.height);
  const left = Math.max(0, Math.round(cropState.x * sx));
  const top = Math.max(0, Math.round(cropState.y * sy));
  const right = Math.max(left + 1, Math.round((cropState.x + cropState.w) * sx));
  const bottom = Math.max(top + 1, Math.round((cropState.y + cropState.h) * sy));
  $('captureCrop').value = `${left},${top},${right},${bottom}`;
}
function applyCaptureCropInput(){
  const parts = $('captureCrop').value.split(',').map(value => Number(value.trim()));
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return;
  $('cropEnabled').value = 'true';
  $('videoPreview').classList.add('crop-active');
}
function makeCropDraggable(){
  const box = $('cropBox');
  let drag = null;
  box.addEventListener('pointerdown', event => {
    const resizing = event.offsetX > box.clientWidth - 18 && event.offsetY > box.clientHeight - 18;
    drag = {x:event.clientX, y:event.clientY, start:{...cropState}, resizing};
    box.setPointerCapture(event.pointerId);
  });
  box.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const rect = displayedVideoRect();
    if (drag.resizing) {
      cropState.w = Math.max(24, Math.min(rect.width - cropState.x, drag.start.w + dx));
      cropState.h = Math.max(24, Math.min(rect.height - cropState.y, drag.start.h + dy));
    } else {
      cropState.x = Math.max(0, Math.min(rect.width - cropState.w, drag.start.x + dx));
      cropState.y = Math.max(0, Math.min(rect.height - cropState.h, drag.start.y + dy));
    }
    renderCropBox();
    updateCaptureCropInput();
  });
  box.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('resize', () => { if ($('videoPreview').style.display !== 'none') renderCropBox(); });
}
function updateGridFromCount(){
  const count = Math.max(1, Math.round(Number($('count').value) || 1));
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  $('grid').value = `${cols}x${rows}`;
}
async function createSession(){
  return withBusy('正在创建会话并抽取视频帧……', async () => {
    const session = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'video'})});
    sessionId = session.id;
    const payload = {
      source:$('source').value,
      count:Number($('count').value),
      seconds:$('seconds').value || null,
      decode_size:$('decodeSize').value || null
    };
    const crop = $('cropEnabled').value === 'true' ? $('captureCrop').value.split(',').map(item => Number(item.trim())) : null;
    if (crop && crop.length === 4 && crop.every(Number.isFinite)) payload.crop = crop;
    const captured = await api(`/api/sessions/${sessionId}/capture`,{method:'POST',body:JSON.stringify(payload)});
    await updateVisual(false);
    await renderPreview();
    return captured;
  });
}
async function loadFramesheet(){
  return withBusy('正在载入帧表……', async () => {
    const session = await api('/api/sessions',{method:'POST',body:JSON.stringify({kind:'framesheet', source:$('source').value, grid:$('grid').value})});
    sessionId = session.id;
    await updateVisual(false);
    await renderPreview();
    return session;
  });
}
function visualPayload(){
  const payload = {
    remove_background:$('removeBg').value === 'true',
    background_tolerance:Number($('bgTolerance').value),
    fade:$('fadePreset').value === 'none' ? '100' : $('fadePreset').value
  };
  const keyColor = $('keyColor').value.trim();
  if (keyColor) payload.key_color = keyColor.split(',').map(item => Number(item.trim()));
  const outW = Number($('outW').value);
  const outH = Number($('outH').value);
  if (Number.isFinite(outW) && Number.isFinite(outH) && outW > 0 && outH > 0) payload.output_size = [outW, outH];
  return payload;
}
function updateFadeSummary(){
  $('fadeSummary').textContent = `透明淡出：中心 ${$('fadePercent').value || 80}% 保持不透明，边缘衰减速度 ${$('fadeSpeed').value || 1}；当前预设 ${$('fadePreset').value}`;
}
function toggleAdvancedTiming(){
  setStatus('status', {提示:$('advancedTiming').value === 'true' ? '高级模式已显示占位；当前节奏应用仍使用模板。' : '高级模式已隐藏。'});
}
function addSpeedKeyframe(){
  $('speedKeyframes').value = JSON.stringify([{time:1,before:0.5,after:2}], null, 2);
}
function resetSpeedKeyframes(){
  $('speedKeyframes').value = '[]';
}
async function updateVisual(refresh=true){
  if (!sessionId) return null;
  const data = await api(`/api/sessions/${sessionId}/visual`,{method:'PATCH',body:JSON.stringify(visualPayload())});
  if (refresh) await renderPreview();
  return data;
}
async function applySemanticTiming(){
  if (!sessionId) return;
  return withBusy('正在应用节奏并刷新预览……', async () => {
    const data = await api(`/api/sessions/${sessionId}/timing`,{method:'PATCH',body:JSON.stringify({preset:$('preset').value})});
    await renderPreview();
    return data;
  });
}
async function renderPreview(){
  if (!sessionId) return;
  return withBusy('正在生成预览（序列帧）……', async () => {
    const fps = readPreviewFps();
    const data = await api(`/api/sessions/${sessionId}/preview-frames?fps=${fps}`);
    loadSequenceFrames(data.frames || []);
    startSequencePlayback();
    return data;
  });
}
function readPreviewFps(){
  const fps = Math.round(Number($('previewFps').value || 12));
  return Math.max(1, Math.min(60, Number.isFinite(fps) ? fps : 12));
}
function loadSequenceFrames(frames){
  stopSequencePlayback();
  sequencePlayback.frames = frames.map(url => `${url}?t=${Date.now()}`);
  sequencePlayback.index = 0;
  if (sequencePlayback.frames.length) $('preview').src = sequencePlayback.frames[0];
  updateSequenceStatus();
}
function updateSequenceStatus(){
  const total = sequencePlayback.frames.length;
  const current = total ? sequencePlayback.index + 1 : 0;
  $('playbackStatus').textContent = `序列帧 ${current} / ${total} · ${readPreviewFps()} fps${sequencePlayback.playing ? ' · 播放中' : ''}`;
}
function showSequenceFrame(index){
  if (!sequencePlayback.frames.length) return updateSequenceStatus();
  sequencePlayback.index = ((index % sequencePlayback.frames.length) + sequencePlayback.frames.length) % sequencePlayback.frames.length;
  $('preview').src = sequencePlayback.frames[sequencePlayback.index];
  updateSequenceStatus();
}
function stopSequencePlayback(){
  if (sequencePlayback.timer) clearInterval(sequencePlayback.timer);
  sequencePlayback.timer = null;
  sequencePlayback.playing = false;
  updateSequenceStatus();
}
function startSequencePlayback(){
  if (!sequencePlayback.frames.length) return;
  stopSequencePlayback();
  sequencePlayback.playing = true;
  sequencePlayback.timer = setInterval(() => showSequenceFrame(sequencePlayback.index + 1), 1000 / readPreviewFps());
  updateSequenceStatus();
}
function toggleSequencePlayback(){ sequencePlayback.playing ? stopSequencePlayback() : startSequencePlayback(); }
function resetSequencePlayback(){ stopSequencePlayback(); showSequenceFrame(0); }
async function exportOutput(format){
  if (!sessionId) return;
  return withBusy(`正在导出 ${format === 'framesheet' ? '帧表' : format.toUpperCase()}……`, async () => {
    const body = {format, duration_ms:Number($('duration').value), lossless:true};
    if ($('columns').value) body.columns = Number($('columns').value);
    if ($('outDir').value) body.out_dir = $('outDir').value;
    return await api(`/api/sessions/${sessionId}/export`,{method:'POST',body:JSON.stringify(body)});
  });
}

$('clientVideoFile').addEventListener('change', () => {
  const file = $('clientVideoFile').files[0];
  if (file) loadClientVideo(file);
});
$('clientVideoPlayer').addEventListener('loadedmetadata', updateClientVideoMeta);
$('clientVideoPlayer').addEventListener('timeupdate', updateClientVideoMeta);
function loadClientVideo(file){
  const previous = $('clientVideoPlayer').dataset.url;
  revokeTracked(previous);
  const url = trackUrl(URL.createObjectURL(file));
  const video = $('clientVideoPlayer');
  video.dataset.url = url;
  video.src = url;
  video.load();
  clientFrames.clientVideo = [];
  $('clientVideoThumbs').replaceChildren();
  const sheet = $('clientVideoSheet');
  sheet.width = 0;
  sheet.height = 0;
  setStatus('clientVideoStatus', {状态:'已载入视频', 文件:file.name, 提示:'设置 FPS、时间范围和尺寸后点击提取序列帧。'});
}
function updateClientVideoMeta(){
  const video = $('clientVideoPlayer');
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration && !$('clientVideoEnd').value) $('clientVideoEnd').placeholder = String(Math.round(duration * 100) / 100);
  $('clientVideoMeta').textContent = video.videoWidth
    ? `当前 ${formatClock(video.currentTime)} / ${formatClock(duration)} · ${video.videoWidth}×${video.videoHeight}`
    : '等待视频。';
}
function setClientRangePoint(point){
  const current = Math.round($('clientVideoPlayer').currentTime * 100) / 100;
  if (point === 'start') $('clientVideoStart').value = String(current);
  else $('clientVideoEnd').value = String(current);
}
function clientVideoRange(video){
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const start = Math.max(0, Math.min(duration, numberValue('clientVideoStart', 0)));
  const rawEnd = $('clientVideoEnd').value ? numberValue('clientVideoEnd', duration) : duration;
  const end = Math.max(start, Math.min(duration, rawEnd || duration));
  return {start, end, duration};
}
function clientVideoTimes(video){
  const {start, end} = clientVideoRange(video);
  const fps = Math.max(1, Math.min(60, numberValue('clientVideoFps', 12)));
  const maxFrames = Math.max(1, numberValue('clientVideoMaxFrames', 300));
  const step = 1 / fps;
  const times = [];
  for (let time = start; time <= end + 0.0001 && times.length < maxFrames; time += step) {
    times.push(Math.min(end, time));
  }
  if (!times.length) times.push(start);
  return times;
}
function seekVideo(video, time){
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      reject(new Error('视频 seek 失败'));
    };
    video.addEventListener('seeked', done, {once:true});
    video.addEventListener('error', fail, {once:true});
    if (Math.abs(video.currentTime - time) < 0.004) setTimeout(done, 0);
    else video.currentTime = time;
  });
}
function applyCanvasKey(canvas, key, tolerance, feather){
  if (!key) return;
  const target = hexToRgb(key);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0,0,canvas.width,canvas.height);
  const data = imageData.data;
  const soft = Math.max(1, feather);
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt((data[index] - target[0])**2 + (data[index + 1] - target[1])**2 + (data[index + 2] - target[2])**2);
    const alpha = distance <= tolerance ? 0 : distance >= tolerance + soft ? 255 : Math.round(((distance - tolerance) / soft) * 255);
    data[index + 3] = Math.min(data[index + 3], alpha);
  }
  ctx.putImageData(imageData,0,0);
}
async function extractClientVideoFrames(){
  const video = $('clientVideoPlayer');
  if (!video.src || !video.videoWidth) {
    setStatus('clientVideoStatus', {状态:'失败', 错误:'请先选择并加载视频。'});
    return;
  }
  const times = clientVideoTimes(video);
  const outW = Math.max(1, numberValue('clientVideoW', video.videoWidth));
  const outH = Math.max(1, numberValue('clientVideoH', video.videoHeight));
  const key = $('clientVideoKey').value.trim();
  const tolerance = numberValue('clientVideoTol', 42);
  const feather = numberValue('clientVideoFeather', 38);
  const thumbs = $('clientVideoThumbs');
  thumbs.replaceChildren();
  clientFrames.clientVideo = [];
  setStatus('clientVideoStatus', {状态:'处理中', 预计帧数:times.length, 输出:`${outW}x${outH}`});
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = outW;
  frameCanvas.height = outH;
  const frameCtx = frameCanvas.getContext('2d');
  for (let index = 0; index < times.length; index++) {
    await seekVideo(video, times[index]);
    frameCtx.clearRect(0,0,outW,outH);
    frameCtx.drawImage(video,0,0,outW,outH);
    applyCanvasKey(frameCanvas, key, tolerance, feather);
    const copy = document.createElement('canvas');
    copy.width = outW;
    copy.height = outH;
    copy.getContext('2d').drawImage(frameCanvas,0,0);
    const blob = await canvasToBlob(copy);
    clientFrames.clientVideo.push({name:`frame_${String(index).padStart(4,'0')}.png`, blob, canvas:copy});
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    wrap.appendChild(copy.cloneNode(true));
    wrap.querySelector('canvas').getContext('2d').drawImage(copy,0,0);
    thumbs.appendChild(wrap);
    if (index % 8 === 0 || index === times.length - 1) {
      setStatus('clientVideoStatus', {状态:'处理中', 已完成:index + 1, 总数:times.length, 当前秒:Math.round(times[index] * 100) / 100});
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  renderClientVideoSheet();
  setStatus('clientVideoStatus', {状态:'完成', 帧数:clientFrames.clientVideo.length, 输出:`${outW}x${outH}`, 提示:'可下载 PNG ZIP 或 Sprite Sheet。'});
}
function renderClientVideoSheet(){
  const frames = clientFrames.clientVideo;
  const sheet = $('clientVideoSheet');
  if (!frames.length) {
    sheet.width = 0;
    sheet.height = 0;
    return;
  }
  const cols = Math.max(1, numberValue('clientVideoCols', 4));
  const rows = Math.ceil(frames.length / cols);
  const cellW = frames[0].canvas.width;
  const cellH = frames[0].canvas.height;
  sheet.width = cols * cellW;
  sheet.height = rows * cellH;
  const ctx = sheet.getContext('2d');
  ctx.clearRect(0,0,sheet.width,sheet.height);
  frames.forEach((frame, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    ctx.drawImage(frame.canvas, col * cellW, row * cellH);
  });
}

async function splitSpriteSheet(){
  const file = $('splitFile').files[0];
  if (!file) return;
  const {image, url} = await loadImageFromFile(file);
  $('splitSourcePreview').src = url;
  const cols = Math.max(1, numberValue('splitCols', 1));
  const rows = Math.max(1, numberValue('splitRows', 1));
  const frameW = Math.floor(image.naturalWidth / cols);
  const frameH = Math.floor(image.naturalHeight / rows);
  const thumbs = $('splitThumbs');
  thumbs.replaceChildren();
  clientFrames.split = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const canvas = document.createElement('canvas');
      canvas.width = frameW;
      canvas.height = frameH;
      canvas.getContext('2d').drawImage(image, col * frameW, row * frameH, frameW, frameH, 0, 0, frameW, frameH);
      const blob = await canvasToBlob(canvas);
      clientFrames.split.push({name:`frame_${String(clientFrames.split.length).padStart(3,'0')}.png`, blob});
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      wrap.appendChild(canvas);
      thumbs.appendChild(wrap);
    }
  }
  setStatus('splitStatus', {状态:'完成', 帧数:clientFrames.split.length, 单帧:`${frameW}x${frameH}`});
}
async function composeSpriteSheet(){
  const files = Array.from($('composeFiles').files || []);
  if (!files.length) return;
  const images = await loadImagesFromFiles(files);
  const cols = Math.max(1, numberValue('composeCols', 4));
  const gap = Math.max(0, numberValue('composeGap', 0));
  const pad = Math.max(0, numberValue('composePad', 0));
  const crop = {
    top:numberValue('composeCropTop', 0),
    bottom:numberValue('composeCropBottom', 0),
    left:numberValue('composeCropLeft', 0),
    right:numberValue('composeCropRight', 0)
  };
  const cells = images.map(({image}) => ({
    image,
    sx:Math.max(0, crop.left),
    sy:Math.max(0, crop.top),
    sw:Math.max(1, image.naturalWidth - crop.left - crop.right),
    sh:Math.max(1, image.naturalHeight - crop.top - crop.bottom)
  }));
  const cellW = Math.max(...cells.map(item => item.sw));
  const cellH = Math.max(...cells.map(item => item.sh));
  const rows = Math.ceil(cells.length / cols);
  const canvas = $('composeCanvas');
  canvas.width = pad * 2 + cols * cellW + Math.max(0, cols - 1) * gap;
  canvas.height = pad * 2 + rows * cellH + Math.max(0, rows - 1) * gap;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  cells.forEach((item, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const dx = pad + col * (cellW + gap) + Math.floor((cellW - item.sw) / 2);
    const dy = pad + row * (cellH + gap) + Math.floor((cellH - item.sh) / 2);
    ctx.drawImage(item.image, item.sx, item.sy, item.sw, item.sh, dx, dy, item.sw, item.sh);
  });
  setStatus('composeStatus', {状态:'完成', 图片数:files.length, 输出:`${canvas.width}x${canvas.height}`, 列数:cols, 行数:rows});
}
async function stitchImages(){
  const files = Array.from($('stitchFiles').files || []);
  if (!files.length) return;
  const images = await loadImagesFromFiles(files);
  const mode = $('stitchMode').value;
  let width;
  let height;
  if (mode === 'vertical') {
    width = Math.max(...images.map(item => item.image.naturalWidth));
    height = images.reduce((sum, item) => sum + item.image.naturalHeight, 0);
  } else if (mode === 'horizontal') {
    width = images.reduce((sum, item) => sum + item.image.naturalWidth, 0);
    height = Math.max(...images.map(item => item.image.naturalHeight));
  } else {
    width = Math.max(...images.map(item => item.image.naturalWidth));
    height = Math.max(...images.map(item => item.image.naturalHeight));
  }
  const canvas = $('stitchCanvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,width,height);
  let x = 0;
  let y = 0;
  for (const {image} of images) {
    if (mode === 'vertical') {
      ctx.drawImage(image, Math.floor((width - image.naturalWidth) / 2), y);
      y += image.naturalHeight;
    } else if (mode === 'horizontal') {
      ctx.drawImage(image, x, Math.floor((height - image.naturalHeight) / 2));
      x += image.naturalWidth;
    } else {
      ctx.drawImage(image, Math.floor((width - image.naturalWidth) / 2), Math.floor((height - image.naturalHeight) / 2));
    }
  }
  setStatus('stitchStatus', {状态:'完成', 图片数:files.length, 模式:mode, 输出:`${width}x${height}`});
}
async function runMatte(){
  const file = $('matteFile').files[0];
  if (!file) return;
  const {image, url} = await loadImageFromFile(file);
  $('matteSourcePreview').src = url;
  const canvas = $('matteCanvas');
  const ctx = drawCoverToCanvas(image, canvas);
  const imageData = ctx.getImageData(0,0,canvas.width,canvas.height);
  const data = imageData.data;
  const mode = $('matteMode').value;
  const target = hexToRgb($('matteColor').value);
  const tolerance = numberValue('matteTolerance', 72);
  const feather = Math.max(1, numberValue('matteFeather', 54));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const distance = mode === 'white'
      ? Math.sqrt((255-r)**2 + (255-g)**2 + (255-b)**2)
      : Math.sqrt((target[0]-r)**2 + (target[1]-g)**2 + (target[2]-b)**2);
    let alpha = distance <= tolerance ? 0 : distance >= tolerance + feather ? 255 : Math.round(((distance - tolerance) / feather) * 255);
    if (mode === 'chroma' && alpha > 0 && target[1] >= target[0] && target[1] >= target[2]) {
      const gray = Math.round(r * .2126 + g * .7152 + b * .0722);
      data[i+1] = Math.round(g * .55 + gray * .45);
    }
    data[i+3] = Math.min(data[i+3], alpha);
  }
  ctx.putImageData(imageData,0,0);
  erodeAlpha(canvas, Math.max(0, numberValue('matteErode', 1)));
  setStatus('matteStatus', {状态:'完成', 算法:mode, 输出:`${canvas.width}x${canvas.height}`});
}
function hexToRgb(value){
  const raw = String(value || '#00ff00').replace('#','');
  const normalized = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw.padEnd(6, '0').slice(0,6);
  return [0,2,4].map(index => parseInt(normalized.slice(index,index+2),16) || 0);
}
function pickMatteColor(event){
  const img = event.currentTarget;
  if (!img.src) return;
  const rect = img.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img,0,0);
  const x = Math.floor((event.clientX - rect.left) / rect.width * img.naturalWidth);
  const y = Math.floor((event.clientY - rect.top) / rect.height * img.naturalHeight);
  const [r,g,b] = ctx.getImageData(Math.max(0,x), Math.max(0,y), 1, 1).data;
  $('matteColor').value = `#${[r,g,b].map(v => v.toString(16).padStart(2,'0')).join('')}`;
}
function erodeAlpha(canvas, passes){
  if (!passes) return;
  const ctx = canvas.getContext('2d');
  let current = ctx.getImageData(0,0,canvas.width,canvas.height);
  for (let pass = 0; pass < passes; pass++) {
    const next = new ImageData(new Uint8ClampedArray(current.data), current.width, current.height);
    for (let y = 0; y < current.height; y++) {
      for (let x = 0; x < current.width; x++) {
        const index = (y * current.width + x) * 4;
        let minAlpha = current.data[index + 3];
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx >= 0 && nx < current.width && ny >= 0 && ny < current.height) minAlpha = Math.min(minAlpha, current.data[(ny * current.width + nx) * 4 + 3]);
        }
        next.data[index + 3] = minAlpha;
      }
    }
    current = next;
  }
  ctx.putImageData(current,0,0);
}
async function runPixelTool(){
  const file = $('pixelFile').files[0];
  if (!file) return;
  const {image} = await loadImageFromFile(file);
  const canvas = $('pixelCanvas');
  const mode = $('pixelMode').value;
  const targetW = Math.max(1, numberValue('pixelWidth', image.naturalWidth));
  const targetH = Math.max(1, numberValue('pixelHeight', image.naturalHeight));
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,targetW,targetH);
  if (mode === 'pixelate') {
    const block = Math.max(1, numberValue('pixelBlock', 8));
    const temp = document.createElement('canvas');
    temp.width = Math.max(1, Math.ceil(targetW / block));
    temp.height = Math.max(1, Math.ceil(targetH / block));
    const tctx = temp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(image,0,0,temp.width,temp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp,0,0,targetW,targetH);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image,0,0,targetW,targetH);
  }
  setStatus('pixelStatus', {状态:'完成', 模式:mode, 输出:`${canvas.width}x${canvas.height}`});
}

function makeCrcTable(){
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();
function crc32(bytes){
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value){ return new Uint8Array([value & 255, (value >>> 8) & 255]); }
function u32(value){ return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]); }
function concatBytes(parts){
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
async function makeZip(files){
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    const local = concatBytes([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    locals.push(local);
    const central = concatBytes([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = concatBytes([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)]);
  return new Blob([...locals, ...centrals, end], {type:'application/zip'});
}
async function downloadClientFramesZip(key){
  const frames = clientFrames[key] || [];
  if (!frames.length) return;
  downloadBlob(await makeZip(frames), `${key}_frames.zip`);
}

renderToolNav();
makeCropDraggable();
updateGridFromCount();
updateSequenceStatus();
</script>
</body>
</html>"""


__all__ = ["INDEX_HTML"]
