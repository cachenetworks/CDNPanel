"""Runtime core of the CDNPanel Python SDK (standard library only)."""

import json
import time
import uuid
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

_IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE"}


class CdnApiError(Exception):
    """Raised for non-2xx responses. ``code`` is the stable machine-readable error code."""

    def __init__(self, status: int, code: str, message: str, request_id: Optional[str] = None, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.details = details


class CdnCore:
    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0, retries: int = 2, user_agent: str = "cdnpanel-python/2.0"):
        if not base_url or not api_key:
            raise ValueError("base_url and api_key are required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries
        self.user_agent = user_agent

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
        files: Optional[Dict[str, Any]] = None,
        fields: Optional[Dict[str, str]] = None,
        data: Optional[bytes] = None,
        raw_response: bool = False,
    ) -> Any:
        url = self.base_url + path
        if query:
            clean = {k: ("true" if v is True else "false" if v is False else v) for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urlencode(clean)
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json", "User-Agent": self.user_agent}
        payload: Optional[bytes] = None
        if files is not None:
            payload, content_type = _multipart(files, fields or {})
            headers["Content-Type"] = content_type
        elif data is not None:
            payload = data
            headers["Content-Type"] = "application/octet-stream"
        elif body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        attempts = self.retries + 1 if method in _IDEMPOTENT else 1
        for attempt in range(1, attempts + 1):
            try:
                with urlopen(Request(url, data=payload, headers=headers, method=method), timeout=self.timeout) as res:
                    raw = res.read()
                    if raw_response:
                        return raw
                    return json.loads(raw) if raw else None
            except HTTPError as err:
                if (err.code == 429 or err.code >= 500) and attempt < attempts:
                    time.sleep(float(err.headers.get("Retry-After") or 0.25 * 2**attempt))
                    continue
                try:
                    e = json.loads(err.read()).get("error", {})
                except Exception:
                    e = {}
                raise CdnApiError(err.code, e.get("code", "http_error"), e.get("message", f"HTTP {err.code}"), e.get("request_id"), e.get("details")) from None
            except URLError:
                if attempt >= attempts:
                    raise
                time.sleep(0.25 * 2**attempt)
        return None


def _multipart(files: Dict[str, Any], fields: Dict[str, str]):
    """files: {"file": ("name.png", b"bytes")} — fields are sent first, as the API requires."""
    boundary = f"----cdnpanel{uuid.uuid4().hex}"
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (filename, content) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        parts.append(content if isinstance(content, bytes) else content.read())
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"
