from __future__ import annotations

from pathlib import PurePosixPath
import re

from ymcp.capabilities import prompt_content
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.imagegen import ImagegenArtifacts, ImagegenRequest, ImagegenResult
from ymcp.contracts.workflow import WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk


def _slugify(value: str) -> str:
    slug = re.sub(r'[^a-zA-Z0-9._-]+', '-', value.strip().lower()).strip('-._')
    return slug[:64] or 'asset'


def _asset_slug(request: ImagegenRequest) -> str:
    if request.asset_slug and request.asset_slug.strip():
        return _slugify(request.asset_slug)
    return _slugify(request.brief)


def _output_root(request: ImagegenRequest, slug: str) -> str:
    if request.output_root and request.output_root.strip():
        return request.output_root.strip().replace('\\', '/')
    return str(PurePosixPath('output') / 'imagegen' / slug)


def _task_arguments(request: ImagegenRequest, output_root: str, frames_dir: str) -> str:
    lines = [
        request.brief.strip(),
        '',
        f'Output root: {output_root}',
        f'Frames directory: {frames_dir}',
    ]
    if request.dimensions:
        lines.append(f'Dimensions: {request.dimensions.strip()}')
    if request.frame_count is not None:
        lines.append(f'Frame count: {request.frame_count}')
    lines.append(f'Transparent output: {str(request.transparent).lower()}')
    if request.transparent:
        lines.extend([
            '',
            'Transparent / background removal workflow:',
            '- Render the source subject on a perfectly flat solid chroma-key background.',
            '- Use #00ff00 by default; use #ff00ff when the subject is green or green-adjacent.',
            '- Keep the background uniform: no shadows, gradients, texture, reflections, or floor plane.',
            '- Call remove_chroma_key from ymcp.tools.imagegen.local_frame_workflow to create alpha PNG/WebP output.',
            '- Save the transparent final image as final.png and transparent sequence frames under transparent_frames/ when frame-level transparency is needed.',
            '- Do not use white or black as fake transparency; validate alpha contains transparent pixels before reporting completion.',
            '- Run validate_frame_sequence on the transparent frames and sprite sheet after generation.',
        ])
    return '\n'.join(lines)


def build_imagegen(request: ImagegenRequest) -> ImagegenResult:
    slug = _asset_slug(request)
    output_root = _output_root(request, slug)
    frames_dir = str(PurePosixPath(output_root) / 'frames')
    sprite_path = str(PurePosixPath(output_root) / 'sprite.png')
    preview_path = str(PurePosixPath(output_root) / 'preview.gif')
    script_path = str(PurePosixPath(output_root) / 'generate.py')
    expected_artifacts = [sprite_path, preview_path]
    transient_artifacts = [script_path, frames_dir]
    required_imports = [
        'from PIL import Image, ImageDraw',
        'from ymcp.tools.imagegen.local_frame_workflow import ensure_output_dirs, frame_path, save_sprite_sheet, save_gif, validate_frame_sequence',
    ]
    postprocess_steps: list[str] = []
    validation_steps = [
        f'Run the generated script and confirm it writes {request.frame_count or "the requested number of"} temporary frames before cleanup.',
        'Open generated frames with Pillow before cleanup and confirm every frame has the requested dimensions.',
        'Confirm sprite.png exists and its dimensions match columns * frame width by rows * frame height.',
        'Confirm preview.gif exists and each frame replaces the previous frame instead of accumulating; use save_gif(..., disposal=2) or animated WebP if GIF transparency is unsuitable.',
        'Do not report completion until validation output is read and all checks pass.',
    ]
    cleanup_steps = [
        'After validation, delete temporary frames/ and any other per-frame working directories.',
        'Keep only final framesheet and animation preview files in suggested_output_root unless the caller explicitly asks to keep sources.',
    ]
    completion_criteria = [
        'sprite.png exists under suggested_output_root.',
        'preview.gif exists under suggested_output_root and does not visually accumulate prior frames.',
        'No per-frame PNG sequence directories remain in the final deliverable unless explicitly requested.',
    ]
    if request.transparent:
        transparent_frames_dir = str(PurePosixPath(output_root) / 'transparent_frames')
        transient_artifacts.append(transparent_frames_dir)
        required_imports[1] += ', remove_chroma_key'
        postprocess_steps = [
            'Render source frames on a perfectly flat #00ff00 chroma-key background unless the subject uses green; use #ff00ff for green subjects.',
            'Keep the key background uniform with no shadows, gradients, texture, reflections, floor plane, or key-colored subject details.',
            'Use ymcp.tools.imagegen.local_frame_workflow.remove_chroma_key with auto_key="border", soft_matte=True, transparent_threshold=12, opaque_threshold=220, and spill_cleanup=True.',
            f'Save frame-level alpha output temporarily under {transparent_frames_dir} while composing final assets.',
            'Build sprite.png and preview.gif from transparent frames, not from the chroma-key source frames.',
            'Use save_gif(..., disposal=2) for GIF previews so frames do not stack on top of each other.',
        ]
        validation_steps.extend([
            f'Before cleanup, run validate_frame_sequence("{transparent_frames_dir}", expected_count=<requested>, expected_size=(width, height), require_transparency=True, sprite_path="{sprite_path}", sprite_columns=<columns>).',
            'Confirm alpha extrema include 0; white, black, or chroma-key colored backgrounds do not satisfy transparency.',
        ])
        cleanup_steps.insert(0, 'After sprite/GIF validation, delete transparent_frames/ as well as source frames/.')
        completion_criteria.extend([
            'sprite.png is built from transparent_frames/ and preserves alpha.',
            'transparent_frames/ is used only as a temporary working directory and is removed from final output.',
        ])

    skill_content = prompt_content('imagegen', _task_arguments(request, output_root, frames_dir))

    return ImagegenResult(
        status=ToolStatus.NEEDS_INPUT,
        summary='请将 skill_content 作为本地 imagegen 工作流指导：编写或调整 Python/Pillow 脚本，生成临时序列帧，验证后只保留最终 framesheet 和动画效果文件。若 transparent=true，必须使用纯色 chroma-key 背景并通过本地 remove_chroma_key 生成 alpha，再用 save_gif(..., disposal=2) 避免 GIF 帧叠加。yimggen 不调用远程图片 API、不执行任意脚本，也不替代宿主完成本地运行。',
        assumptions=[
            '图片生成采用本地 Python + Pillow 序列帧工作流。',
            'Pillow 是可选依赖；实际运行脚本前应安装 ymcp[imagegen]。',
            '默认最终交付只保留 sprite.png 和 preview.gif；逐帧 PNG 目录属于临时工作产物。',
        ],
        next_actions=[
            build_next_action('编写生成脚本', '根据 skill_content 在输出目录中创建或调整 generate.py；透明素材必须导入并调用 remove_chroma_key。', owner='assistant'),
            build_next_action('本地运行并验证', '运行 generate.py，生成临时 frames/transparent_frames、sprite 和 preview；用 validate_frame_sequence 与 Pillow 检查尺寸、透明像素和 GIF disposal。', owner='host'),
            build_next_action('清理临时帧', '验证通过后删除每帧 PNG 目录，只保留 sprite.png 和 preview.gif 等最终交付文件。', owner='assistant'),
        ],
        risks=[
            build_risk('透明 GIF 对 alpha 支持有限，若仍出现边缘或叠帧问题，应同时导出 animated WebP 作为更可靠预览。', '默认 GIF 使用 disposal=2；复杂透明动画可优先查看 WebP。'),
            build_risk('本地 Pillow 适合程序化图像、sprite、简单插画和动画；不承诺照片级语义生成。', '若需求超出可脚本化范围，应回到需求澄清或改用项目允许的其他资产来源。'),
        ],
        meta=build_meta(
            'yimggen',
            'ymcp.contracts.imagegen.ImagegenResult',
            host_controls=['display', 'prompt guidance', 'local filesystem execution'],
            required_host_action=HostActionType.AWAIT_INPUT,
        ),
        artifacts=ImagegenArtifacts(
            skill_content=skill_content,
            suggested_output_root=output_root,
            frames_dir=frames_dir,
            expected_artifacts=expected_artifacts,
            transient_artifacts=transient_artifacts,
            required_imports=required_imports,
            postprocess_steps=postprocess_steps,
            validation_steps=validation_steps,
            cleanup_steps=cleanup_steps,
            completion_criteria=completion_criteria,
            workflow_state=WorkflowState(
                workflow_name='yimggen',
                current_phase='local_imagegen_guidance',
                readiness='needs_input',
                evidence_gaps=[],
                current_focus='author_run_validate_cleanup_local_pillow_script',
            ),
        ),
    )
