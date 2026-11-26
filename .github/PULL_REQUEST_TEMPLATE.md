## Submit a Pocket to Pockets Hub

- **Repository (`owner/repo`):** `owner/repo`
- **What does this Pocket do?** (1–2 sentences)
- **Screenshot(s):** (optional, helpful for review)

### Submission checklist
- [ ] Added my repo to `catalog.json` with `"verified": false` (only maintainers grant `Verified`)
- [ ] Repository is public with `pocket.yaml`, `Containerfile`, `README.md`, and `LICENSE` at its root
- [ ] `Containerfile` runs as a non-root `USER` (no `USER root`, no `curl | sh`, no hardcoded secrets)
- [ ] All external API hosts are declared under `previewApis` and all configurable keys/secrets under `runtimeVariables`
- [ ] Tested locally in Pockets (both Live Preview and Build & start)
