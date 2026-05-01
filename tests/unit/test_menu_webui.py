import json
import urllib.error
import urllib.request

from ymcp.contracts.common import HandoffOption
from ymcp.web.menu_app import INDEX_HTML, MenuSessionStore, clamp_timeout, create_menu_app
from http.server import ThreadingHTTPServer
import threading


def _server():
    store = MenuSessionStore()
    session = store.create(
        source_workflow='yplan',
        summary='规划完成',
        options=[HandoffOption(value='ydo', title='进入 ydo', description='执行', recommended=True)],
        timeout_seconds=1,
    )
    server = ThreadingHTTPServer(('127.0.0.1', 0), create_menu_app(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, session


def _json(url, *, token=None, payload=None):
    headers = {'content-type': 'application/json'}
    if token:
        headers['x-ymcp-menu-token'] = token
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(url, data=data, headers=headers, method='POST' if payload is not None else 'GET')
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode('utf-8'))


def test_timeout_clamp_bounds():
    assert clamp_timeout(1) == 30
    assert clamp_timeout(None) == 600
    assert clamp_timeout(999999) == 86400


def test_handoff_option_title_defaults_to_value():
    option = HandoffOption(value='fix_webui', description='修复 WebUI')
    assert option.title == 'fix_webui'


def test_menu_webui_attempts_to_close_after_selection():
    assert 'setTimeout(() => window.close(), 500)' in INDEX_HTML
    assert '如果浏览器阻止自动关闭' in INDEX_HTML
    assert '返回 Trae' in INDEX_HTML


def test_menu_webui_renders_summary_and_description_as_safe_markdown():
    assert 'function renderMarkdown(markdown)' in INDEX_HTML
    assert 'function escapeHtml(value)' in INDEX_HTML
    assert "renderMarkdownInto(document.getElementById('summary'), data.summary)" in INDEX_HTML
    assert "renderMarkdownInto(description, option.description || '')" in INDEX_HTML
    assert "title.textContent = option.title || option.value || ''" in INDEX_HTML
    assert "options.replaceChildren(...data.options.map(renderOption))" in INDEX_HTML
    assert "document.getElementById('summary').textContent = data.summary" not in INDEX_HTML
    assert '${option.description}' not in INDEX_HTML


def test_menu_webui_exposes_free_user_input_control():
    assert 'id="userInput"' in INDEX_HTML
    assert 'id="submitInput"' in INDEX_HTML
    assert '提交输入给大模型' in INDEX_HTML
    assert "api(`/api/menu/${id}/input`" in INDEX_HTML
    assert "body:JSON.stringify({user_input})" in INDEX_HTML
    assert '请输入内容后再提交。' in INDEX_HTML


def test_menu_webui_markdown_supports_common_llm_output_shapes():
    assert '<h${level}>' in INDEX_HTML
    assert '<strong>$1</strong>' in INDEX_HTML
    assert '<em>$1</em>' in INDEX_HTML
    assert '<code>$1</code>' in INDEX_HTML
    assert '<blockquote>' in INDEX_HTML
    assert '<pre><code>' in INDEX_HTML
    assert "listType = nextType" in INDEX_HTML
    assert 'sanitizeUrl(href)' in INDEX_HTML


def test_menu_webui_requires_token_and_accepts_legal_selection():
    server, session = _server()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        try:
            _json(f'{base}/api/menu/{session.id}')
            raise AssertionError('expected unauthorized request to fail')
        except urllib.error.HTTPError as exc:
            assert exc.code == 403

        data = _json(f'{base}/api/menu/{session.id}', token=session.token)
        assert data['options'][0]['value'] == 'ydo'
        selected = _json(f'{base}/api/menu/{session.id}/select', token=session.token, payload={'selected_option': 'ydo'})
        assert selected['selected_option'] == 'ydo'
    finally:
        server.shutdown()


def test_menu_webui_accepts_free_user_input_with_token():
    server, session = _server()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        data = _json(f'{base}/api/menu/{session.id}/input', token=session.token, payload={'user_input': ' 请修改计划 '})
        assert data['user_input'] == '请修改计划'
        assert data['selected_option'] is None
    finally:
        server.shutdown()


def test_menu_webui_rejects_blank_user_input():
    server, session = _server()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        try:
            _json(f'{base}/api/menu/{session.id}/input', token=session.token, payload={'user_input': '   '})
            raise AssertionError('expected blank input to fail')
        except urllib.error.HTTPError as exc:
            assert exc.code == 400
    finally:
        server.shutdown()


def test_menu_webui_rejects_invalid_option_and_unknown_endpoint():
    server, session = _server()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        try:
            _json(f'{base}/api/menu/{session.id}/select', token=session.token, payload={'selected_option': 'shell'})
            raise AssertionError('expected invalid option to fail')
        except urllib.error.HTTPError as exc:
            assert exc.code == 400
        try:
            _json(f'{base}/api/command', token=session.token)
            raise AssertionError('expected unknown endpoint to fail')
        except urllib.error.HTTPError as exc:
            assert exc.code == 404
    finally:
        server.shutdown()
