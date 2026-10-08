"""Official Python SDK for the CDNPanel API.

    from cdnpanel import CdnClient
    cdn = CdnClient("https://cdn.example.com", api_key=os.environ["CDN_API_KEY"])
    f = cdn.upload_path("logo.png", visibility="PUBLIC")
    print(f["url"])
"""

import os
from typing import Any, Optional

from ._core import CdnApiError
from ._generated import CdnClient as _Generated

__all__ = ["CdnClient", "CdnApiError"]
__version__ = "2.0.0"


class CdnClient(_Generated):
    def upload_path(self, path: str, folder_id: Optional[str] = None, visibility: Optional[str] = None, chunk_threshold: int = 64 * 1024 * 1024) -> Any:
        """Uploads a local file, using resumable chunked uploads for large files."""
        size = os.path.getsize(path)
        name = os.path.basename(path)
        if size <= chunk_threshold:
            fields = {k: v for k, v in {"folder_id": folder_id, "visibility": visibility}.items() if v}
            with open(path, "rb") as fh:
                return self.upload_a_file(files={"file": (name, fh.read())}, fields=fields)
        body = {"filename": name, "size": size, "folder_id": folder_id}
        if visibility:
            body["visibility"] = visibility
        session = self.start_a_chunked_resumable_upload(body=body)
        with open(path, "rb") as fh:
            for i in range(session["total_chunks"]):
                self.upload_a_chunk(session["id"], data=fh.read(session["chunk_size"]), query={"index": i})
        return self.complete_a_chunked_upload(session["id"])
