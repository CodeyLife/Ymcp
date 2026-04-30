"""Tiny localhost-only WebUI fallback for Ymcp workflow menu choices."""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from ymcp.contracts.common import HandoffOption


MIN_TIMEOUT_SECONDS = 30
DEFAULT_TIMEOUT_SECONDS = 600
MAX_TIMEOUT_SECONDS = 86_400
LOGGER = logging.getLogger('ymcp.menu_webui')


def _browser_open_enabled() -> bool:
    value = os.environ.get('YMCP_MENU_OPEN_BROWSER')
    if value is None:
        return True
    return value.strip().lower() not in {'0', 'false', 'no', 'off'}


def clamp_timeout(value: int | None) -> int:
    if value is None:
        return DEFAULT_TIMEOUT_SECONDS
    return max(MIN_TIMEOUT_SECONDS, min(MAX_TIMEOUT_SECONDS, int(value)))


@dataclass
class MenuSession:
    id: str
    token: str
    source_workflow: str
    summary: str
    options: list[HandoffOption]
    expires_at: float
    selected_option: str | None = None
    created_at: float = field(default_factory=time.time)

    @property
    def expired(self) -> bool:
        return time.time() > self.expires_at


class MenuSessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, MenuSession] = {}

    def create(self, *, source_workflow: str, summary: str, options: list[HandoffOption], timeout_seconds: int | None = None) -> MenuSession:
        session = MenuSession(
            id=secrets.token_urlsafe(12),
            token=secrets.token_urlsafe(24),
            source_workflow=source_workflow,
            summary=summary,
            options=options,
            expires_at=time.time() + clamp_timeout(timeout_seconds),
        )
        with self._lock:
            self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> MenuSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None and session.expired:
                self._sessions.pop(session_id, None)
                return None
            return session

    def select(self, session_id: str, token: str, selected_option: str) -> MenuSession:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.expired:
                raise KeyError('menu session not found or expired')
            if not secrets.compare_digest(session.token, token):
                raise PermissionError('invalid menu session token')
            values = {option.value for option in session.options}
            if selected_option not in values:
                raise ValueError(f'invalid selected option: {selected_option}')
            session.selected_option = selected_option
            return session


STORE = MenuSessionStore()
_SERVER_LOCK = threading.Lock()
_SERVER: ThreadingHTTPServer | None = None
_BASE_URL: str | None = None


INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ymcp Menu</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background:#101218; color:#edf1ff; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; }
    main { width:min(760px, calc(100vw - 32px)); background:#171c2a; border:1px solid #2b3040; border-radius:16px; padding:22px; }
    h1 { margin:0 0 8px; font-size:22px; }
    .summary { color:#c8d3ff; white-space:pre-wrap; line-height:1.5; }
    .option { width:100%; margin-top:12px; padding:14px; border-radius:12px; border:1px solid #3a4260; background:#20283a; color:#edf1ff; text-align:left; cursor:pointer; }
    .option:hover { border-color:#7aa2ff; }
    .recommended { color:#71f2b5; font-size:12px; margin-left:8px; }
    .description { color:#aab5d6; margin-top:4px; font-size:13px; }
    .status { margin-top:14px; color:#9fb3ff; }
  </style>
</head>
<body>
<main>
  <h1 id="title">Ymcp 下一步</h1>
  <div class="summary" id="summary"></div>
  <div id="options"></div>
  <div class="status" id="status"></div>
</main>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
async function api(path, options={}) {
  const res = await fetch(path, {headers:{'content-type':'application/json', 'x-ymcp-menu-token':token}, ...options});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
async function load() {
  const parts = location.pathname.split('/').filter(Boolean);
  const id = parts[parts.length - 1];
  const data = await api(`/api/menu/${id}`);
  document.getElementById('title').textContent = `Ymcp menu · ${data.source_workflow}`;
  document.getElementById('summary').textContent = data.summary;
  document.getElementById('options').innerHTML = data.options.map(option => `
    <button class="option" data-value="${option.value}">
      <strong>${option.title}</strong>${option.recommended ? '<span class="recommended">推荐</span>' : ''}
      <div class="description">${option.description}</div>
    </button>`).join('');
  for (const button of document.querySelectorAll('.option')) {
    button.onclick = async () => {
      const selected_option = button.dataset.value;
      await api(`/api/menu/${id}/select`, {method:'POST', body:JSON.stringify({selected_option})});
      document.getElementById('status').textContent = `已选择：${selected_option}。可以返回 MCP 宿主继续。`;
      for (const item of document.querySelectorAll('.option')) item.disabled = true;
    };
  }
  if (data.selected_option) document.getElementById('status').textContent = `已选择：${data.selected_option}`;
}
load().catch(error => { document.getElementById('status').textContent = String(error); });
</script>
</body>
</html>"""


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('content-type', 'application/json; charset=utf-8')
    handler.send_header('content-length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _session_payload(session: MenuSession) -> dict[str, Any]:
    return {
        'id': session.id,
        'source_workflow': session.source_workflow,
        'summary': session.summary,
        'options': [option.model_dump(mode='json') for option in session.options],
        'selected_option': session.selected_option,
        'expires_at': session.expires_at,
    }


def create_menu_app(store: MenuSessionStore = STORE) -> type[BaseHTTPRequestHandler]:
    class MenuHandler(BaseHTTPRequestHandler):
        server_version = 'YmcpMenu/1.0'

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _token(self) -> str:
            query_token = parse_qs(urlparse(self.path).query).get('token', [''])[0]
            return self.headers.get('x-ymcp-menu-token') or query_token

        def _read_json(self) -> dict[str, Any]:
            raw = self.rfile.read(int(self.headers.get('content-length', '0') or '0'))
            return json.loads(raw.decode('utf-8')) if raw else {}

        def _authorized_session(self, session_id: str) -> MenuSession:
            session = store.get(session_id)
            if session is None:
                raise KeyError('menu session not found or expired')
            if not secrets.compare_digest(session.token, self._token()):
                raise PermissionError('invalid menu session token')
            return session

        def do_GET(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                parts = [unquote(part) for part in parsed.path.strip('/').split('/') if part]
                if len(parts) == 2 and parts[0] == 'menu':
                    self.send_response(200)
                    body = INDEX_HTML.encode('utf-8')
                    self.send_header('content-type', 'text/html; charset=utf-8')
                    self.send_header('content-length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if len(parts) == 3 and parts[:2] == ['api', 'menu']:
                    _json_response(self, 200, _session_payload(self._authorized_session(parts[2])))
                    return
                _json_response(self, 404, {'error': 'not found'})
            except PermissionError as exc:
                _json_response(self, 403, {'error': str(exc)})
            except Exception as exc:
                _json_response(self, 400, {'error': str(exc)})

        def do_POST(self) -> None:  # noqa: N802
            try:
                parts = [unquote(part) for part in urlparse(self.path).path.strip('/').split('/') if part]
                payload = self._read_json()
                if len(parts) == 4 and parts[:2] == ['api', 'menu'] and parts[3] == 'select':
                    session = store.select(parts[2], self._token(), str(payload.get('selected_option', '')))
                    _json_response(self, 200, _session_payload(session))
                    return
                _json_response(self, 404, {'error': 'not found'})
            except PermissionError as exc:
                _json_response(self, 403, {'error': str(exc)})
            except Exception as exc:
                _json_response(self, 400, {'error': str(exc)})

    return MenuHandler


def ensure_menu_server(host: str = '127.0.0.1', port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    global _SERVER, _BASE_URL
    with _SERVER_LOCK:
        if _SERVER is not None and _BASE_URL is not None:
            return _SERVER, _BASE_URL
        server = ThreadingHTTPServer((host, port), create_menu_app())
        base_url = f'http://{server.server_address[0]}:{server.server_address[1]}'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _SERVER = server
        _BASE_URL = base_url
        return server, base_url


def create_menu_session_url(*, source_workflow: str, summary: str, options: list[HandoffOption], timeout_seconds: int | None = None, open_browser: bool | None = None) -> tuple[MenuSession, str]:
    _server, base_url = ensure_menu_server()
    session = STORE.create(source_workflow=source_workflow, summary=summary, options=options, timeout_seconds=timeout_seconds)
    url = f'{base_url}/menu/{session.id}?token={session.token}'
    should_open_browser = _browser_open_enabled() if open_browser is None else open_browser
    if should_open_browser:
        try:
            webbrowser.open(url, new=2)
        except Exception as exc:
            LOGGER.warning('failed to open menu WebUI fallback browser: %s', exc)
    return session, url


__all__ = [
    'MenuSession',
    'MenuSessionStore',
    'STORE',
    'clamp_timeout',
    'create_menu_app',
    'create_menu_session_url',
    'ensure_menu_server',
]
