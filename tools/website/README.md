# Static Loupedeck website

`website/` is a standalone, English-only replacement for the main WordPress site. It contains three pages: Home, historical Products and Downloads. Support links to the existing static Support Center. There is no shop, account surface, language selector, newsletter, tracking, third-party script or build step.

The root marketplace archive and existing account/sign-in notices remain separate from this website. All browser assets are local. Source references are in [SOURCES.md](SOURCES.md).

## Preview and check

From the repository root, using Python 3 and Node.js 20 or later:

```sh
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/website/`. Relative navigation supports both the `/website/` preview and deployment at a domain root. To preview the latter, add `--directory website` to the server command.

```sh
node tools/website/check-site.mjs
node tools/website/check-site.mjs --online
```

The first command checks local files, fragments, fonts and installer links. The optional online check verifies public HTTPS URLs, support-page fragments and installer sizes. CI runs the local check and packages the website without changing hosting.

## Installers

The website retains the four installers offered by the current Downloads page: 6.4.1 and 5.9.1 for Windows/macOS. The production links use existing copies on `support.loupedeck.com`, served through S3/CloudFront, rather than HubSpot or a devops hostname. All four mirror URLs and their sizes were checked on November 6, 2026.

`installers.json` records filenames, source URLs, mirrored URLs, sizes and SHA-256 checksums calculated from downloaded mirror copies. These are preservation checksums, not vendor-published checksums or a verification of installer signatures. Neither installer version supports Loupedeck Original; the original Downloads page specifies 5.1 or earlier, and that limitation remains prominent.

To prepare an optional GitHub Release archive:

```sh
node tools/website/archive-installers.mjs
```

This downloads about 940 MB into the gitignored `working/website-installers/`, verifies sizes and checksums, and writes `SHA256SUMS.txt` and `archive-record.json`. It reuses complete files and replaces incomplete `.partial` downloads on retry. It neither runs installers nor publishes anything. The large binaries belong in GitHub Releases or object storage rather than Git history.

If publishing a release later, use a dedicated tag such as `software-installers`, upload the four exact filenames and checksum file, then update the four HTML URLs and `installers.json` to the chosen permanent URLs. Keep `originalUrl` as provenance. Re-run the online check after updating links. Existing marketplace releases remain independent.

## Deploying loupedeck.com

Deploy **the contents of `website/`** as the document root on static hosting, such as the existing S3/CloudFront setup used for Support. This requires directory-index handling for `/products/` and `/downloads/`. On S3, a REST origin does not automatically map subdirectories to `index.html`; use a CloudFront function that rewrites those two paths to their index files, or use a suitable website origin. Serve `.woff2` as `font/woff2`, HTML as `text/html`, and images/CSS with their normal content types.

Keep HTML cache lifetimes short during cutover. Unknown paths should return HTTP 404 rather than serving the homepage with HTTP 200. This site is ordinary multi-page HTML and needs no SPA fallback.

The existing GitHub Pages publication serves the marketplace from the repository root. Keeping its current configuration will make the new site available at the repository's `/website/` path after it is merged and published. Changing that Pages source to `website/`, or adding an apex-domain `CNAME`, would also change the existing marketplace publication. A separate static-host deployment of `website/` preserves both destinations.

The `Static website checks` workflow uploads the deployment folder as an artifact; it performs no deployment and needs no production credentials. A future deployment job can consume this artifact or upload `website/` directly. Do not upload `tools/`, `working/`, or installer binaries as website assets.

The domain/hosting owner handles DNS, certificates for both `loupedeck.com` and `www.loupedeck.com`, and HTTP redirects. A DNS CNAME cannot redirect URLs or select a repository subfolder. Configure the preferred HTTPS hostname and preserve paths when redirecting the other hostname.

## Redirect plan

Preserve `/`, `/products/` and `/downloads/`. Normalize the latter two without trailing slashes to their trailing-slash URLs. Configure the following redirects at the hosting edge (not inside HTML); begin with 302 while checking the cutover, then use 301 for permanent redirects.

| Old route | Destination |
| --- | --- |
| `/products/loupedeck-plus/` | `/products/#loupedeck-plus` |
| `/products/loupedeck-ct/` | `/products/#loupedeck-ct` |
| `/products/loupedeck-live/` | `/products/#loupedeck-live` |
| `/products/loupedeck-live-s/` | `/products/#loupedeck-live-s` |
| `/support/` | `https://support.loupedeck.com/` |
| `/shop/` and former shop subpages | `/` |
| `/blog/important-update-end-of-loupedeck-sales-and-future-development-plans/` | `/#retirement-title` |
| `/blog/` | `/` |
| `/us/`, `/uk/`, `/de/`, `/jp/` | `/` |

For localized subpages, map verified former product/download paths to the corresponding English destination. Export remaining WordPress URLs before shutdown; additional content-specific redirects, including older announcements and legal pages, can then be assigned deliberately. Unknown retired pages should return 404 or 410 rather than silently becoming the homepage.

Discard query strings when redirecting removed shop or account surfaces. The separate `account.loupedeck.com` hostname can use the existing repository `account-notice.html` as its fixed destination, as described in the root README. This website does not change account, authentication or desktop-software services.

Before retiring WordPress, verify the new site and its local assets over HTTPS, installer availability, both domain certificates, the redirect rules, and the intended retirement wording. The March 28, 2025 sales-end date comes from the published announcement; the new pages make no promises about future software development or support duration.
