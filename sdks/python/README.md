# cdnpanel (Python SDK)

```python
import os
from cdnpanel import CdnClient, CdnApiError

cdn = CdnClient("https://cdn.example.com", api_key=os.environ["CDN_API_KEY"])
f = cdn.upload_path("logo.png", visibility="PUBLIC")
print(f["url"])
print(cdn.list_and_search_files(query={"tag": "release:v2"}))
```

Endpoint methods are generated from the OpenAPI document by `npm run sdk:generate` in the repository root.
