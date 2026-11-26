# Verified references

Checked on **2026-11-26** before implementation. Only official vendor documentation is used here; no provider terms are reproduced as legal advice.

## Chrome / Edge extensions

- Manifest file format: <https://developer.chrome.com/docs/extensions/reference/manifest>
  - Confirmed: Manifest V3 only (`manifest_version: 3`); `background.service_worker`, `host_permissions`, `permissions`, `options_ui`, `content_security_policy`, `minimum_chrome_version` are supported keys.
- MV3 migration and service-worker lifecycle: <https://developer.chrome.com/docs/extensions/develop/migrate>
  - Consequence: the service worker can stop at any time; state is checkpointed in IndexedDB and `chrome.alarms` is used, never an in-memory job.
- Chrome Web Store publishing and policies: <https://developer.chrome.com/docs/webstore/publish>, <https://developer.chrome.com/docs/webstore/program-policies/policies>
- Edge porting and publishing:
  - <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension>
  - <https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension>
  - <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/manifest-v3>

## Search provider

- Brave Web Search API get-started: <https://api-dashboard.search.brave.com/app/documentation/web-search/get-started>
  - Confirmed endpoint: `GET https://api.search.brave.com/res/v1/web/search`.
  - Confirmed auth header: `X-Subscription-Token`.
  - Confirmed parameters used: `q`, `count` (max 20), `safesearch`, `text_decorations`, `spellcheck`.
  - Confirmed response shape: `web.results[]` with `title`, `url`, `description`; `web` may be absent for some query types, which is treated as an empty result set.
- Brave authentication guide: <https://api-dashboard.search.brave.com/documentation/guides/authentication>
- Bing Search API retirement (why the retired Bing Web Search API is not used): <https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement>

The provider adapter is replaceable. Terms, pricing, quotas, and data-processing terms must be re-checked by the operator before public distribution.

## LinkedIn boundaries

- LinkedIn User Agreement: <https://www.linkedin.com/legal/user-agreement>
- LinkedIn prohibited software/extensions: <https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions>

Product consequence: no LinkedIn host permission, cookies, login automation, scraping, CAPTCHA solving, IP rotation, or unofficial APIs. Only public URLs returned by a licensed provider are displayed.

## Browser/runtime facts verified during implementation

- Chrome 158 branded builds ignored `--load-extension` for local unpacked testing; **Chrome for Testing 158.0.8127.88** loaded the unpacked extension and ran the end-to-end smoke test.
- `chrome.runtime.getContexts` (Chrome 116+) is used to focus an existing workspace tab without requesting the `tabs` permission; the manifest therefore sets `minimum_chrome_version` to 116 and falls back to `chrome.tabs.create`.
- Chrome for Testing headless mode supports extensions with `--load-extension`; the real browser test exercised the full UI and service worker.
- `npm` install scripts for esbuild were approved by the environment; the local production and development builds use the installed esbuild binary.
