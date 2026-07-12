# VitalSage landing page

Static landing page for [VitalSage](https://github.com/marinaageeva14/vitalsage) — vanilla HTML/CSS/JS, deployed to GitHub Pages at `https://marinaageeva14.github.io/vitalsage-site/`.

The "Analyze any website" demo fetches lab data from the Google PageSpeed API in the visitor's browser, applies VitalSage's rule-based thresholds, and renders one report per selected network profile in the same format as the VitalSage CLI's HTML report.

## Deployment

Deploys automatically on every push to `main` via `.github/workflows/deploy-pages.yml`.

One-time repository setup:

1. **Settings → Pages → Source: GitHub Actions** (not "Deploy from a branch").
2. **Settings → Secrets and variables → Actions → New repository secret** — name `PSI_API_KEY`, value: your PageSpeed API key. The workflow injects it into `config.js` at deploy time so the key never lives in the git history.
3. In Google Cloud Console, restrict the key (**Credentials → your key → Website restrictions**) to:
   - `https://marinaageeva14.github.io/*`
   - `http://localhost:*/*` (for local testing)

   Any key shipped to a browser is visible to visitors — the referrer restriction is what makes a copied key useless anywhere else.

Without a key the demo falls back to Google's shared keyless quota (usually exhausted), a paste-your-own-key prompt, and a sample report.

## Local development

Any static server works:

```bash
python3 -m http.server 4173
# → http://localhost:4173
```

To test real analyses locally, paste a PageSpeed API key into the prompt shown on quota errors (stored in `localStorage` only).
