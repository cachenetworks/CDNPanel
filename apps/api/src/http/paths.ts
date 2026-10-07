/** True for CDN file-delivery URLs (everything outside the API, health and spec routes). */
export function isDeliveryPath(url: string): boolean {
  return !url.startsWith('/api/') && !url.startsWith('/health') && !url.startsWith('/openapi.json');
}
