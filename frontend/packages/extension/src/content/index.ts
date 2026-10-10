import {
  CONTENT_TO_PAGE,
  DAPP_CHANNEL,
  ProviderErrors,
  isDappResponse,
  isPageRequest,
  type DappRequest,
  type DappResponse,
  type PageResponse,
} from '../dapp/protocol';

// Isolated-world relay between the page's provider and the background. It adds nothing: the
// background reads the requesting origin from `sender`, so a page cannot claim to be another site.

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !isPageRequest(event.data)) return;
  const { id, method, params } = event.data;
  const request: DappRequest = { channel: DAPP_CHANNEL, method, params };

  chrome.runtime
    .sendMessage(request)
    .then((response: unknown) => reply(id, isDappResponse(response) ? response : { ok: false, error: ProviderErrors.internal }))
    // Extension reloaded or worker unavailable.
    .catch(() => reply(id, { ok: false, error: ProviderErrors.disconnected }));
});

function reply(id: number, response: DappResponse): void {
  const message: PageResponse = { target: CONTENT_TO_PAGE, id, response };
  window.postMessage(message, window.location.origin);
}
