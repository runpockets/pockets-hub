# Pockets Hub

The curated repository index for [Pockets](https://github.com/runpockets/pockets).

Each Pocket lives in its own independent GitHub repository. This repository only maintains `catalog.json`, which Pockets fetches to populate the **Pockets Hub** section on the **New pocket** screen. Each card's title, version, and description are pulled directly from the listed repo's live `pocket.yaml`.

## Submitting a Pocket

1. Make sure your public GitHub repository has:
   - A valid `pocket.yaml` (`pockets.dev/v1alpha1`) with a real description (not the starter placeholder), declared `previewApis`, and declared `runtimeVariables`.
   - A root `Containerfile` ending with a non-root `USER` (no `USER root`, no `curl | sh`, no `ADD http(s)://`, no hardcoded `ENV` secrets).
   - Root `README.md` and `LICENSE` files, no symlinks, and no committed `.env`/credential files.
2. You can test your folder locally with:
   ```sh
   node scripts/validate-catalog.mjs --local /path/to/your-pocket
   ```
3. Open a Pull Request adding your repository to `catalog.json` with `"verified": false`:
   ```json
   {
     "repo": "your-username/your-pocket",
     "verified": false
   }
   ```
   Or submit via the **Submit a Pocket** issue form.

Automated CI validates every pull request against the strict validator in `scripts/validate-catalog.mjs` before maintainer review.
