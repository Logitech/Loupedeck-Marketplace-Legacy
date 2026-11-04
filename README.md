# Loupedeck Legacy Marketplace

Static archive of the discontinued Loupedeck marketplace for software version 5.8 or older, hosted on GitHub Pages + GitHub Releases.

- **[notice.html](notice.html)** — Discontinuation notice and redirect target for `marketplace.loupedeck.com`. Links to archived packages and latest software downloads.
- **[index.html](index.html)** — Searchable listing of all legacy plugins, profiles and icon packs available for manual download.
- **[signin/loupedeck-account-notice.html](signin/loupedeck-account-notice.html)** — Loupedeck Account retirement notice for sign-in surfaces. Points users to the static Legacy Marketplace.
- **[account-notice.html](account-notice.html)** — Redirect target for the discontinued `account.loupedeck.com` account-management website. Explains that account details no longer need updating and directs users with account problems to create a new account in the Loupedeck Software desktop client.

## Account website redirect and HTTPS

After this page is published to GitHub Pages, its URL will be:

https://logitech.github.io/Loupedeck-Marketplace-Legacy/account-notice.html

GitHub Pages serves the `github.io` site over HTTPS. The current Pages configuration publishes `main` from the repository root and has HTTPS enforcement enabled. The notice uses local images and fonts and HTTPS links, so it introduces no mixed content. No custom domain or certificate is needed for the destination URL above.

The redirect from `https://account.loupedeck.com/` must be configured separately on the service handling that hostname. This repository only provides the destination page; publishing it does not change the account website or its DNS.

1. Publish and verify the destination page and its assets over HTTPS.
2. Keep a valid TLS certificate for `account.loupedeck.com` on the redirecting service. TLS negotiation happens before the browser can receive an HTTP redirect, so the old hostname still needs HTTPS support. The account site currently sends an HSTS header, which also requires browsers to use HTTPS on later visits.
3. Redirect account-management web requests to the fixed destination URL above, initially with HTTP `302` while validating the change. Discard incoming query strings rather than forwarding account-related values to the static site. Redirect HTTP requests as well, if that listener is available.
4. Check both the website and desktop client's account-management links, including existing bookmarks to account-management subpages. Keep account creation and authentication endpoints used by the desktop client available during this first step.
5. Once validated, use HTTP `301` if the redirect should be permanent.

A DNS CNAME alone cannot redirect to an HTML path. Pointing the account hostname directly at GitHub Pages would instead require custom-domain configuration and certificate provisioning, and a separate way to route requests to the notice. Keeping an HTTPS redirect service for the account hostname avoids changing the existing Pages domain.
